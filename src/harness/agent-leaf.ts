/**
 * src/harness/agent-leaf —— 双模 leaf 的 **agent 模式** runner(executor-dag 的 `executor:'agent'` 节点用)。
 *
 * inproc leaf = 单发 callModel(无工具,生成/研究/判断)。
 * agent  leaf = 这里 —— 起一个**带工具的子 agent**(read / write / edit / ls / grep / bash),**能真改文件**。
 * 二者经 primitives 的 LeafFn 统一(mimo-leaf 契约 INV-5: 同一原语既驱动 callModel 也驱动 spawn_agent)。
 *
 * scope 原子化(契约 §granularity): 每个 agent leaf 应锁定**一个原子产物**(如一个文件),并行 leaf 改
 * 不重叠文件 = 天然原子;冲突走 DAG 依赖串行。cwd = 工作根,工具直接落盘。
 *
 * ## 2026-08-01: 从 `pi-coding-agent` 搬到 `pi-agent-core` 的 `runAgentLoop`
 *
 * 此前这里靠 `createAgentSession` —— 那是 **CLI 包**的高层门面 (steering 队列 / 可变会话状态 /
 * extension 运行时 / 资源加载器), 而 leaf 要的只是「给一段 prompt, 带工具跑到底, 返消息」。
 * 为了那一个循环, headless 的 MCP 路径整个挂在一个交互式前端上, 并且被迫用它的形状表达纪律:
 *
 *   · **有界性靠外面的秒表**: 高层 `prompt()` 没有 maxTurns 也不收 signal, 跑飞了只能 SIGKILL,
 *     于是有了 `runScopedSession` 那套 timeout+heartbeat+abort 的疤。低层循环原生收 `AbortSignal`
 *     且有 `shouldStopAfterTurn`(「turn 之间优雅停」)—— 有界性现在长在循环里, **不是外挂**。
 *   · **闸靠 extension 从外面贴**: 危险命令 / 凭证 basename 拒此前是 `tool-gate` 贴在通用工具上的,
 *     贴漏了就是 `cat .env` 那个洞。现在工具是我们自己的 (`agent-tools.ts`), **闸长在工具里**。
 *   · **静默吞错**: `createAgentSession` 失败返 0-token 空文本、不上抛 HTTP 状态 (C-5b 那道 loud-error
 *     闸就是为它加的)。低层循环把 `stopReason:'error'` 连同 `errorMessage` 原样交回 → 直接抛得出真因。
 *
 * 换来的代价是系统提示与工具集要自己拼 —— 而那恰恰是想要的: 见 `buildLeafSystemPrompt`。
 */
import {
  runAgentLoop,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  findTurnStartIndex,
  formatSize,
  serializeConversation,
  truncateTail,
  DEFAULT_MAX_LINES,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type Entry,
} from '@earendil-works/pi-agent-core';
// 0.84 起 `runAgentLoop` 第 6 参 streamFn **必填** (0.81.0 breaking: "made low-level loop stream
// functions required")。0.80 省略时的内部默认就是这个 `streamSimple` —— 显式传 = 行为等价。
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseModelRef } from './fleet';
/**
 * D-7 leaf 侧 MCP 策略真源: 授权清单非空 → {allow}, 否则 deny —— 执行叶子不声明不授权
 * (chat 座位的 'allow' 缺省不传染叶子)。装配闭包与接线测试共用这一个函数, 禁复刻。
 */
export function leafMcpPolicy(mcpAllow?: string[]): { sideEffects: { allow: string[] } | 'deny' } {
  return mcpAllow && mcpAllow.length > 0 ? { sideEffects: { allow: mcpAllow } } : { sideEffects: 'deny' };
}

import { LEAF_HARNESS_CORE } from './harness-prompts';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';
import { createMcpClientTools } from '../mcp/client/meta-tools';
import type { McpPoolDeps } from '../mcp/client/pool';
import type { McpCallLedger } from '../mcp/client/call-ledger';
import { createHashlineCustomTools, hashlinePatchPaths } from './hashline';
import { createDriftTracker, type DriftDetectorConfig } from './hooks/drift-detector';
import { createSandboxedLeafRunner } from './hooks/sandboxed-leaf';
import { logger } from '../logger';
import { callModel } from '../model';
import { resolvePiApiKey, resolvePiModel } from '../model/pi-transport';
import { CLAUDE_SDK_PROVIDER, effortOf } from '../model/claude-sdk-complete';
import { officialAdvisorModelId, runSdkAgentLoop } from './claude-sdk-loop';
import { createAdvisorTool, createTranscriptRecorder } from './advisor-tool';
import { promptVersionOfText } from '../model/langfuse';
import type { ModelUsage } from '../model/types';
import type { ThinkingLevel } from '../model/role-models';
import { isStrongCoord } from '../model/model-ratings';

/**
 * Tool-routing guideline (TR-INV-5, docs/plan/omd-tool-routing-contract.md) —— 治弱模型 matching:
 * 重叠区 (查代码 read/bash/codegraph · 改文件 write/edit/hashline) 选错 = 烧 token + 易幻觉。
 * 双段 (用于X / 不要用于Y) + 两步法。字节稳定 (prepend prompt, cache 友好)。
 */
const TOOL_ROUTING_GUIDELINE = `<tool-routing weak-model="true">
选工具前先一句话说"用 X 因为 Y"(两步法)。重叠区按下表选, 选错=烧 token+易幻觉:
- 查符号定义/调用链/谁引用/impact/跨文件结构 → codegraph (bash: \`codegraph query|context|callers|impact <sym>\`, 结构化抗幻觉, 比 grep 准)
- 查字面字符串/配置值/任意文本 → bash ugrep (不要用 codegraph: 它只懂符号不懂任意文本)
- 理解一段逻辑 → read 按行号段 (不要整文件读进 context: 烧 token)
- 新建文件 → write; 改已存在文件 → hashline_edit(若有)/edit (不要用 write 覆写已存在文件: 最高腐烂风险)
</tool-routing>
<evidence-grounding weak-model="true">
R6 铁律 (写代码前的事实核验, 与 omd 同纪律): 任何 repo-specific identifier —— 模型坐标 (provider:model) /
表名·列名 / 函数·类·类型名 / env 变量 / 枚举·常量值 —— 写进代码前**必须**先用 codegraph / ugrep
对**本仓**核实"确实存在 + 拼写准确", 禁止凭"看起来合理"猜。即便你以为知道也要查: 你的训练记忆 ≠ 这个仓库的
真实命名。猜错 identifier 会**编译通过但运行时静默失效** (如价表用错模型坐标 → 永远 unpriced)。
</evidence-grounding>`;

/**
 * leaf 承重纪律核 (omd 方法论下放 leaf, GP-8 token 预算: 紧凑非全 220 行)。
 * 默认注入所有 agent-leaf —— 治"裸跑执行器无纪律"(dogfood 暴露 leaf 只有 tool-routing 时易出
 * identifier 猜测/糊代码)。字节稳定 (cache 友好)。R6 在 TOOL_ROUTING 的 evidence-grounding 块, 此处引不重复。
 */
const DISCIPLINE_CORE = `<discipline weak-model="true">
你是 omd 的执行叶子 —— 有纪律的工程师, 不糊代码。承重铁律:
- 验证>信任 (GP-1/2): 改完必让 tsc/lint/test 绿才算完; 任一 gate 红 → 停, 修好再走, 不绕过不假装完成。
- 无根因不修 (GP-4): bug 先复现→定根因→改, 不靠加 try/catch 挡; 同一处试 3 次没成 → 停 (那是 drift, 别猜着重试)。
- 证据核验 (R6): 见上 evidence-grounding —— repo identifier 写前必查, 禁猜。
- think-in-code: 答案是一个数/一张 <20 行小表 → 写脚本 print, 不把 N 个文件读进 context 烧 token。
- 反 slop: 不套三方模板 / 不照抄热门范式 / 不"先跑起来再说"妥协 / 不为测试写测试; 只做真问题的正解。
- 北欧 taste: 命名·结构·注释密度跟周围代码一致, 不留"这里先这样凑合"。
- 卡住自检 (3 次失败触发): ①真复现了吗 ②抓的是根因还是症状 ③同类先例查了吗 (recall/codegraph) ④换个认知 mode。仍卡 → 输出"卡在哪 + 已试什么", 别空转烧 token。
</discipline>`;

/**
 * **强模型档** (2026-07-26, 同 conductor S-P 的判据): 上面两块都标了 weak-model="true" —— 它们是给
 * mimo 档执行体写的脚手架。而卡级路由已经能把 agent leaf 钉到 SOTA 上 (frontend-impl → k3),
 * 那些叶子在吃「选工具前先说用 X 因为 Y」这种对它冗余的叮嘱。
 *
 * 这一档只留强模型**推导不出来的**两类:① 本仓环境事实 (codegraph 存在 / hashline 强制 / 工具分工);
 * ② 房规红线 (验证>信任、无根因不修、identifier 必查、反 slop) —— 模型再强也不自带我们的红线。
 * 砍掉的是: 两步法自述、逐条工具对照表、卡住自检四步、think-in-code 提醒。
 */
const STRONG_MODEL_CORE = `<house-rules>
本仓环境: 查符号/调用链用 codegraph (bash), 查任意文本用 ugrep; 改已存在文件走 hashline_edit (内置 edit 已禁用), 新建用 write。
红线: ① 改完 tsc/test 必须绿才算完, 红了就停下修, 不绕过不假装完成。② bug 先定根因再改, 不加 try/catch 挡症状。
③ 任何 repo identifier (模型坐标/表名/函数名/env 名) 写进代码前先在**本仓**核实存在与拼写 —— 猜错会编译通过但静默失效。
④ 不套模板不照抄范式, 命名与注释密度跟周围代码一致。
</house-rules>`;

/**
 * **本次调用拼在节点 prompt 之前的那一段**(节点无关的脚手架)。抽成纯函数有两个用处:
 * ① runner 拿它拼 prompt;② 观测面拿它的哈希当 `promptVersion`。
 *
 * 为什么 promptVersion 只能是**这一段**:版本要能分组比较,而整条 prompt 里含本节点的 goal
 * 与上游材料,逐节点都不同 —— 哈希整条会得到"每个节点一个版本",等于没有版本。
 *
 * 档位判据原样保留(TR-INV-5 / 强模型档):强模型只吃 house-rules,弱模型吃全量脚手架,
 * 两个开关仍是硬关(纯命令叶可全关)。**拼法保持字节稳定**——改这里 = 全 leaf cache 失效。
 */
export function agentScaffold(opts: {
  profile: 'auto' | 'weak' | 'strong' | 'off';
  model: string;
  toolRouting: boolean;
  disciplineCore: boolean;
  /**
   * harness 补焊块 (LEAF_HARNESS_CORE: 三层真源/绿≠对/脏场景枚举/? 阀)。默认 **false** ——
   * 开它 = 换尺子 (全 leaf cache 失效 + eval 读数不可比), 上线必须走 A/B, 不默认漂。
   * 'off' 档不受此开关影响 (裸基线保持纯净, A/B 的对照臂不能被染指)。
   */
  harnessCore?: boolean;
}): string {
  const { profile, model, toolRouting, disciplineCore } = opts;
  const harness = opts.harnessCore ?? false;
  if (profile === 'off') return '';
  if (
    profile === 'strong' ||
    (profile === 'auto' && isStrongCoord(model) && (toolRouting || disciplineCore || harness))
  ) {
    // 强模型档: 补焊块的四条全是「模型再强也不自带」类 (同 house-rules 的入选判据), 开则跟在房规后。
    return harness ? `${STRONG_MODEL_CORE}\n\n${LEAF_HARNESS_CORE}` : STRONG_MODEL_CORE;
  }
  // 承重纪律核走 tool-routing 之前 (元规则 → 补焊 → 工具细则 → 任务)。
  return [disciplineCore ? DISCIPLINE_CORE : '', harness ? LEAF_HARNESS_CORE : '', toolRouting ? TOOL_ROUTING_GUIDELINE : '']
    .filter(Boolean)
    .join('\n\n');
}

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect, ShellRun } from './leaf-runners';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect, ShellRun } from './leaf-runners';

export interface AgentLeafRunnerOpts {
  /** 工具落盘的工作根。默认 process.cwd()。每个 agent leaf 应被 scope 到此根下的原子产物。 */
  cwd?: string;
  /** thinking 档位。默认 xhigh (agent leaf 改文件/工具循环, 质量优先; 见下方赋值处注)。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * 工具白名单(CC frontmatter 风格)。**省略 = 全套自有工具(read/write/edit/ls/grep/bash, 能改文件)。**
   * 给则限定(如只读 ['read','grep','bash'] 用于研究型 agent leaf)。
   */
  tools?: string[];
  /**
   * 自定义工具 (与内置工具并存)。如 hashline_read/hashline_edit (行锚定 patch, 治弱模型 edit 腐烂)。
   * 经 createHashlineCustomTools() 造。省略 = 仅内置工具。
   */
  customTools?: AnyOmdTool[];
  /**
   * 注入 tool-routing guideline (TR-INV-5, 弱模型 matching 治理: 查代码/改文件重叠区路由 + 两步法)。
   * 默认 true。纯研究型只读 leaf 或纯命令执行 leaf 可关 (省那几行 token)。
   */
  toolRouting?: boolean;
  /**
   * 注入 leaf 承重纪律核 (GP-1/2/4 + 反 slop + taste + think-in-code + 卡住自检, DISCIPLINE_CORE)。
   * 默认 true (治裸跑执行器无纪律)。纯命令执行 leaf 可关 (省 token)。
   */
  disciplineCore?: boolean;
  /**
   * 注入 harness 补焊块 (LEAF_HARNESS_CORE: 三层真源/绿≠对/脏场景枚举/? 阀 —— fleet-playbook
   * ✅ 表里 DISCIPLINE_CORE 未覆盖的四条)。默认 **false**: 开它 = 换 leaf prompt 尺子
   * (cache 面全失效 + eval 读数不可比), 默认接线前必须走 A/B 读数。
   */
  harnessCore?: boolean;
  /**
   * prompt 档强制覆盖 (eval 用)。缺省 `'auto'` = 按本次 leaf 的模型档自选 (强模型走
   * STRONG_MODEL_CORE, 其余走全量脚手架)。**A/B 必须能把档位固定住**, 否则换模型时档位跟着变,
   * 量到的差是"模型 × 档位"的混合效应, 分不清是哪一半 —— 这正是 conductor 那轮 A/B 的教训。
   *   'weak'   = 恒发 TOOL_ROUTING + DISCIPLINE_CORE
   *   'strong' = 恒发 STRONG_MODEL_CORE
   *   'off'    = 两块都不发 (裸 prompt 基线)
   */
  promptProfile?: 'auto' | 'weak' | 'strong' | 'off';
  /**
   * 总墙钟**兜底**上限 (ms)。默认 3_600_000 (1h)。0 = 不设。
   *
   * ⚠ 这不是"叶子该跑多久"的策略, 是**跑飞了的最后一道刹车**。「这个叶子还活着吗」由
   * {@link idleTimeoutMs} 回答 —— 那条按**有没有在动**判, 不按跑了多久判。
   *
   * 2026-08-01 从 240s 提到 1h (owner): 4 分钟是一条**伪装成安全网的策略** —— 它真正在执行的是
   * "不许一个叶子干超过 4 分钟的活", 而那不是超时该表达的东西。生产 MCP 路径本来就传 1h
   * (`assemble.ts` 的 `OMD_LEAF_TIMEOUT_MS ?? 3_600_000`), 只有 TUI / sec-audit / review 这几个
   * 不传的调用点在吃 240s —— 同一个叶子在两条路上两个寿命, 也是一种"配了不生效"。
   *
   * 实现仍是两级: `shouldStopAfterTurn` 轮间优雅停 (产物完整保留) + `AbortSignal` 单轮硬兜底。
   */
  leafTimeoutMs?: number;
  /**
   * **进展看门狗** (ms): 连续这么久**一个循环事件都没有**、且**没有工具在跑** → 判 provider 挂起,
   * abort 并标 `stalled`。默认 180_000 (3min)。0 = 关。
   *
   * ## 为什么换掉原来那条 (2026-08-01)
   *
   * 老判据是「启动后 45s 内**累积文本**不足 32 字节 → 判死」。两个毛病, 第二个是致命的:
   *   ① 只在**启动那一次**看一眼 —— 中途才挂起的 provider 它抓不到;
   *   ② **只数 `text_delta`**。模型在推理时发的是 `thinking_delta`, 对这条判据完全隐形。
   *      worker 档提到 xhigh (deepseek 上 = `reasoning_effort: max`) 之后, 一个正常思考 50 秒的
   *      叶子会被当成挂死杀掉 —— 判据把"在想"读成了"没反应"。
   *
   * 新判据只问一件事: **它还在动吗**。任何循环事件都算动 (文本增量 / **推理增量** / 工具开始或结束 /
   * 轮边界), 来一个就重置窗口。**工具在飞时不计时** —— 一条跑 10 分钟的 `bun test` 期间本来就没有
   * 事件, 那是正当工作不是挂起。
   *
   * 于是「没跑起来」与「跑得久」第一次分得开: 前者是**零事件**, 后者是**事件一直来**。
   * 真死的 provider 仍在 3 分钟内被抓到, 真在干活的叶子想跑多久跑多久。
   */
  idleTimeoutMs?: number;
  /**
   * 角色 persona 前缀 (P1 三层角色): **设计型/推理型** leaf 传 TASTE_CORE 或
   * composeTastePersona(role) 拔高品味判断; 纯执行型 leaf 省略 = 最小思考忠实执行。
   * 字节稳定 (prepend, cache 友好)。
   */
  persona?: string;
  /**
   * 开 hashline 编辑模式 (治弱模型改文件错位/腐烂): 自动注入 hashline_read/hashline_edit
   * (scope 到 cwd) **并排除内置 `edit`** —— 强制走行锚定 patch。read/write/bash 保留 (新建文件仍用 write)。
   * 与显式 `customTools` 合并。默认 false (现存审计型 leaf 不需, 不平白加 token)。
   * 编辑型 leaf (DeepSeek/MiMo 改代码) 应开。
   */
  hashlineEdit?: boolean;
  /**
   * advisor 坐标(resolveSeatAdvisor('agent') 的产物,省略 = 无)。按座位通道分派:
   * claude-code 座 → 官方 server tool(settings.advisorModel,配对由 CLI/API 校验);
   * pi 座 → 内部升档 tool(advisor-tool.ts,本次运行注入工具面)。NOTES 2026-08-10。
   */
  advisor?: string;
  /**
   * 测试接缝:claude-code 订阅通道的 SDK query 替身(真 SDK 要真订阅 + claude CLI)。生产不传。
   */
  sdkQueryFn?: import('./claude-sdk-loop').SdkQueryFn;
  /**
   * 碰撞台账写入面 (SDD S3, 只记不拦)。给了才记; **缺省零行为变化**。
   * `session` 是 runner 级兜底; 引擎侧 runId 只在调用期可知 (runner 跨 run 复用) →
   * 运行时以 `AgentLeafInput.touchSession` 覆盖 (经 AsyncLocalStorage 按调用落, 见装配处注)。
   * 隔离档 (bwrap) 下 worker 进程同样收到 (leaf-worker 桥接)。
   */
  touch?: { session: string };
  /**
   * 外部 MCP 工具授权兜底 (SDD D-7): runner 级缺省 allow 清单; 运行时以
   * `AgentLeafInput.mcpAllow` 覆盖 (经 AsyncLocalStorage 按调用落, 同 touchSession)。
   * 省略 = deny 全部副作用类 MCP 工具 (leaf 不声明不授权)。
   */
  mcpAllow?: string[];
  /**
   * 测试注入 (同 sdkQueryFn 纪律): 外部 MCP pool 的 transport / 台账 —— 进程内测试换
   * InMemory linked pair + ':memory:' ledger; 生产省略 (stdio 子进程 + cwd 懒落库)。
   */
  mcpDeps?: { poolDeps?: McpPoolDeps; ledger?: McpCallLedger };
  /**
   * drift 检测 (代码级 spinning 防护): agent-leaf 是 headless 工具循环 = spin 高发面,
   * 默认开 (low-invasive: 仅同调用同参重复 ≥阈值才经 transformContext 注 stuck-checklist)。
   * false 关; 对象调阈值。
   */
  driftDetector?: DriftDetectorConfig | false;
  /**
   * 上下文预算线 (GP-8): 估算上下文占到模型窗口的这个比例时触发**压缩**。默认 0.85。
   * 压缩不成才优雅停。设 1 以上 = 既不压也不停 (不建议 —— 撞窗口是整轮硬失败)。
   */
  contextBudgetRatio?: number;
  /**
   * 上下文压缩 (auto-compaction)。默认 **开**。
   *
   * 老的 `createAgentSession` 自带这个能力 (pi `compaction.enabled ?? true`), 搬到低层循环时
   * 一度只留了"到线就优雅停" —— 那保住了产物却**没保住活**: 叶子会在没干完的时候交卷,
   * 而且不报错、下游看不出来。这正是 §8.5「静默失败」那一族的形状, 所以补回来。
   *
   * 与 pi 的两处**刻意不同**:
   *   ① 摘要走本仓 `callModel` 而不是 pi 的 `models.completeSimple` —— 压缩也是一次真调用,
   *      得上成本账本、吃熔断与重试预算。走 pi 那条会让它在账上**完全隐形**。
   *   ② **第一条消息逐字保留**。对一个 DAG 叶子来说那不是"对话开头", 是**契约**;
   *      把它摘要掉等于让叶子忘了自己被要求做什么。pi 不知道这件事, 我们知道。
   *
   * false = 关 (回到"到线就停")。
   */
  compaction?: boolean;
  /** 压缩后保留的近期上下文 token 预算。默认 20000 (同 pi `keepRecentTokens`)。 */
  compactionKeepRecentTokens?: number;
  /**
   * 写沙箱根 (2026-07-23): 设则挂 sandbox-guard hook —— 任何结构化写 (write/edit/hashline_edit) 解析到
   * 此根子树外 **事前 block** (治 leaf 用绝对路径写穿隔离; eval worktree 必设 = fx.root)。省略 = 不沙箱
   * (真 DAG 跑默认信任 cwd; 需要硬隔离的场景显式设)。不拦 bash 写逃逸 (需容器级)。
   */
  sandboxRoot?: string;
  /**
   * debug 事件汇 (2026-07-23): 设则把循环**全部**事件转发给它 (tool_call 参数 / 工具结果 / 消息),
   * 用于捕获 leaf transcript 挖 empty-done 根因。省略 = 不转发 (零开销)。仅排障用, 非生产热路径。
   */
  onEvent?: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * 造一个真 agent-leaf runner: 每次调用起一个一次性带工具子 session, 跑完 dispose。
 * 这是 omd 本体「真能干活(改文件)」的执行底座 —— 不再只是单发文本。
 */
/**
 * pi session token 口径 → ModelUsage 口径 (2026-07-28 修, 纯函数便于单测)。
 *
 * pi 的 `tokens.input` 是**不含缓存命中**的增量; 而 ModelUsage 契约要求 `in` = 总 prompt token 且
 * **cacheHit ⊆ in** (见 model/types.ts)。直接照搬两字段会让 cacheHit 远大于 in —— 工具循环里缓存前缀
 * 被复用几十轮, 实测 cacheHit/in 到过 **2082%**。后果不止读数难看: 成本账按
 * `(in − cacheHit)×全价 + cacheHit×10%` 折算, in 偏小会算出**负成本**。故这里把 cacheRead 补回 in。
 */
export function mapSessionUsage(tokens?: { input?: number; output?: number; cacheRead?: number }): ModelUsage {
  if (!tokens) return { in: 0, out: 0 };
  const cacheHit = tokens.cacheRead ?? 0;
  return { in: (tokens.input ?? 0) + cacheHit, out: tokens.output ?? 0, cacheHit };
}

/**
 * 项目上下文文件 (AGENTS.md / CLAUDE.md) —— 从 cwd 逐级往上收, **外层在前**。
 *
 * 此前这一段是 pi `DefaultResourceLoader` 顺手做的, 搬家后要自己做。刻意保留而不是省掉:
 * agent leaf 干的是在**别人的仓库里改代码**, 而那些文件正是那个仓库对"该怎么改"的说明书;
 * 省掉它等于让每个 leaf 从零猜项目约定。每级只取第一个命中 (AGENTS 优先于 CLAUDE, 同 pi)。
 */
const CONTEXT_FILE_NAMES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
// (chat conductor 复用同一条向上走的加载路 → export;两处各读一份会漂)。

export function loadProjectContext(cwd: string, maxDepth = 8): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  let dir = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);
  for (let i = 0; i < maxDepth; i++) {
    for (const name of CONTEXT_FILE_NAMES) {
      const full = join(dir, name);
      try {
        found.unshift({ path: full, content: readFileSync(full, 'utf-8') });
        break; // 每级只取第一个命中
      } catch {
        /* 没有就没有 —— 上下文缺席不是错误 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * leaf 的**系统提示**。搬家前这一段由 pi CLI 的 `buildSystemPrompt` 拼, 里面有大半页
 * 「你在 pi 里面工作 / pi 的文档在这些路径 / 被问到 extension 时去读 docs/extensions.md」——
 * 对一个只负责写一个文件的 DAG 叶子来说, 那是纯噪声还占着最贵的那段缓存前缀。
 *
 * 现在只留三样**模型自己推不出来**的: ① 它是什么(一个有界的执行叶子, 不是聊天助手);
 * ② 有哪些工具、各自干什么(工具自带 `promptSnippet`, 加一个工具不必再改这里);
 * ③ 工作根在哪 + 这个仓库自己的说明书。
 *
 * ⚠ **字节稳定**: 这段是每个 leaf 请求的最前缀, 改它 = 全 leaf prompt-cache 失效
 * (实测宽扇出命中 84~98%, 那是真钱)。cwd 与项目上下文随环境变是没办法的事, 排在后面;
 * 前面那两段对同一批 leaf 逐字相同。
 */
export function buildLeafSystemPrompt(opts: {
  cwd: string;
  tools: readonly AnyOmdTool[];
  contextFiles?: readonly { path: string; content: string }[];
}): string {
  const snippets = opts.tools
    .filter((t) => t.promptSnippet)
    .map((t) => `- ${t.promptSnippet}`)
    .join('\n');
  const guidelines = [...new Set(opts.tools.flatMap((t) => t.promptGuidelines ?? []))]
    .map((g) => `- ${g}`)
    .join('\n');
  const parts = [
    '你是 omd 的一个**执行叶子**: 拿到一个有界目标, 用下面的工具把它做完, 然后停。' +
      '不寒暄、不复述任务、不问"要不要我继续" —— 没有人在对面等着回话。' +
      '做完把**关键结论与改了哪些文件**写在最后一条消息里 (下游节点只看得到那条)。',
    `可用工具:\n${snippets || '(无)'}`,
  ];
  if (guidelines) parts.push(`工具守则:\n${guidelines}`);
  parts.push(`工作根: ${opts.cwd.replace(/\\/g, '/')} (相对路径都对它解析)`);
  for (const f of opts.contextFiles ?? []) {
    parts.push(`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`);
  }
  return parts.join('\n\n');
}

/**
 * 压缩摘要的 system 段。**不接着干活、不回答记录里的问题** —— 这两条是摘要器最容易跑偏的地方
 * (给它一段"干到一半"的记录, 模型的默认反应是继续干)。pi 的同款提示词没从包入口导出, 这里自己写,
 * 顺便按叶子的场景写具体了。
 */
const LEAF_SUMMARY_SYSTEM =
  '你是上下文压缩器。读下面这段执行记录, 按要求产出一份结构化摘要。' +
  '**不要继续这段工作、不要回答记录里出现的任何问题、不要调用工具** —— 只输出摘要本身。';

/**
 * 压缩的**切点计算** (纯函数, 与那一次模型调用分开 —— 会静默出错的是这一半)。
 * 返回保留段的起始下标; 压不动返 null。
 *
 * ## 切点为什么必须落在 assistant 上
 *
 * 叶子的 transcript 形状是 `user(契约) → assistant(toolCall) → toolResult → assistant(toolCall) → …`。
 * 从中间随便切一刀, 保留段很可能以一条 **toolResult 开头** —— 那条 toolResult 的 toolCall 已经被
 * 摘要掉了, provider 会因为"孤儿工具结果"直接拒。所以按 token 预算算出候选切点后, 要落到一条
 * **assistant** 上: assistant 是一轮的开始, 它后面跟着的 toolResult 都在保留段里, 不会成孤儿。
 *
 * ⚠ 方向是**往回找**不是往后找 (2026-08-01 实测撞出来的): 往后找在"最后一条 toolResult 单独就
 * 超预算"时会一路推出末尾 → 永远压不动。实测形态就是这个 —— 读一个 200 行文件的结果比 keep 预算
 * 还大, 于是每一轮都判"压不下去"然后优雅停, 活干不完。往回找则宁可**多留一点**:
 * 保留段只会 ≥ 预算, 而"多留"的代价是少省一点 token, "少留"的代价是请求直接被拒 —— 不对称。
 *
 * 往回找不到 assistant (第一轮就撞线, 前面只有契约) → 不压, 返 null。
 *
 * 摘要以一条 **user 消息**插在保留段之前 —— 与 pi 压缩产出的形状一致
 * (`compactionSummary` 也是转成 user 消息)。
 */
export function planLeafCompaction(messages: AgentMessage[], keepRecentTokens: number): number | null {
  if (messages.length < 4) return null; // 短到没什么可压的
  // 从末尾往回攒够 keepRecentTokens → 候选切点。
  let acc = 0;
  let cut = messages.length;
  while (cut > 1 && acc < keepRecentTokens) {
    cut--;
    acc += estimateTokens(messages[cut]!);
  }
  // 往回退到最近一条 assistant (见上方切点注: 方向不能反)。
  while (cut > 1 && (messages[cut] as { role?: string }).role !== 'assistant') cut--;
  if (cut <= 1 || (messages[cut] as { role?: string }).role !== 'assistant') return null; // 没东西可摘要
  return cut;
}

/**
 * 切点落在**轮内**时,这一轮是从哪条消息开始的 —— pi 的 **split-turn 检测**
 * (`findTurnStartIndex`,原样引用不手搓)。返回轮首下标;轮首就是首条或找不到 → `null`。
 *
 * ## 为什么只借这一半,而不是把整个 `findCutPoint` 换过来
 *
 * 实测(2026-08-09,六种超预算形状 · 同一 `keepRecentTokens=20000` 下逐形状对比):
 *
 * | 形状 | omd `planLeafCompaction` 保留 | pi `findCutPoint` 保留 |
 * |---|---|---|
 * | 单轮 30 次串行工具调用 | 21064 tok | 18954 tok(split=true) |
 * | **每条结果都比预算大** | **20107 tok** | **120637 tok = 全量** |
 * | 单轮 一批 20 个并发结果 | null(压不动) | 全量(split=false) |
 *
 * pi 的切点是**往后**找的,于是"末尾一条工具结果单独就超预算"时它退回 `cutPoints[0]`、
 * 保留段等于全量 —— 正是 2026-08-01 实测把 omd 的搜索方向定成**往回找**的那条形态。
 * 换过去会让 `leaf-compaction.test.ts` 的「最后一条 toolResult 单独就超预算」当场红。
 * 同一批形状里 pi 也**没有**救回 omd 判 null 的两种(并发工具批 / 每条结果都比预算大):
 * 两边都只能保留全量 ⇒ **「压不动」不是切点能修的**,那两种的解法是截断工具结果本身。
 *
 * 真正 pi 有而 omd 没有的是 **split-turn 判定**:omd 的切点恒落在 assistant 上,于是它
 * **从不**切在轮边界 —— 每一刀都切在轮内,而"这一轮问的是什么"就此只活在通用历史摘要里。
 * 「首条逐字保留」对**叶子**是对的(叶子只有一轮,首条就是契约),对**多轮 chat** 是错的:
 * 首条是最老那一问。实测 S4(三轮闲聊 + 最后一轮 20 次工具调用):切点 30,而轮首在 9,
 * 逐字留下的却是下标 0 那条。`findTurnStartIndex` 补的就是这一句。
 */
function findTurnHeadIndex(messages: AgentMessage[], cut: number): number | null {
  // pi 的切点族吃 `Entry[]`,而**轮内**压缩那条路手上只有 `AgentMessage[]`(条目还没写进会话)⇒
  // 现造一层只读投影。`findTurnStartIndex` 只读 `type` 与 `message.role`,其余字段填得能过型即可。
  const entries: Entry[] = messages.map((message, i) => ({
    type: 'message' as const,
    id: `m${i}`,
    parentId: i === 0 ? null : `m${i - 1}`,
    seq: i,
    timestamp: 0,
    message,
  }));
  const idx = findTurnStartIndex(entries, cut, 0);
  return idx > 0 ? idx : null; // -1 = 没找到; 0 = 轮首就是首条, 已经逐字留着了
}

/**
 * 保留段里**单条工具结果**被截断时贴的标记。给人读、也给测试断言 ——
 * 保留段中出现"看着完整、其实缺了开头"的结果是**静默**的,必须自带痕迹。
 */
export const TOOL_RESULT_TRUNCATION_MARK = '[omd 压缩截断]';

/**
 * 触发截断的比值:保留段 > `keepRecentTokens × 这个数` 才动手。
 *
 * 取 **1.5** 是因为它是既有判据里**已经写死**的那条上界(`chat/compaction.test.ts`
 * 「压缩后落在 [keep, keep×1.5)」)—— 用同一个数意味着:**只有既有判据已经判红的形状才会被截断**,
 * 判据判绿的一律一个字不动。换个新数就等于新增一批"以前合格、现在被动了"的场景。
 */
export const COMPACTION_RETAINED_TOLERANCE = 1.5;

/**
 * 单条结果截完之后的**字节下限**。预算被 N 条并发结果均分,N 大时每份会摊到几十字节 ——
 * 那种长度的尾巴读不出任何结论,不如宁可超一点预算。2000 字节 ≈ 500 token ≈ 一屏。
 */
export const MIN_TOOL_RESULT_BYTES = 2_000;

/**
 * token 预算 → 字节上界的换算。pi 的 `estimateTokens` 口径是 **chars/4**,而 `truncateTail`
 * 卡的是 **utf8 字节**。ASCII 下二者相等(字节 = 字符),CJK 下 1 字符 = 3 字节 ⇒ 同样的字节上限
 * 换来的 token **更少**。所以用 4 换算恒是**上界**,不会算漏。
 */
const BYTES_PER_TOKEN = 4;

/** 把一条工具结果的 text 块截成尾部;没有一块需要截 → null(调用方据此判"没动过")。 */
function truncateToolResultTail(msg: AgentMessage, maxBytes: number): AgentMessage | null {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  let changed = false;
  const next = content.map((block) => {
    const b = block as { type?: string; text?: string };
    if (b.type !== 'text' || typeof b.text !== 'string') return block; // 图片块原样带过
    if (Buffer.byteLength(b.text, 'utf8') <= maxBytes) return block;
    // 留**尾**不留头: 工具结果的结论在尾 (bash 的报错/退出行、测试的汇总行、grep 的最后一批命中)。
    const t = truncateTail(b.text, { maxBytes, maxLines: DEFAULT_MAX_LINES });
    if (!t.truncated) return block;
    changed = true;
    return {
      ...b,
      text:
        `${TOOL_RESULT_TRUNCATION_MARK} 原 ${formatSize(t.totalBytes)} / ${t.totalLines} 行, ` +
        `只留末尾 ${formatSize(t.outputBytes)} —— 开头已丢弃, 需要的话重新跑一次工具取那一段。\n${t.content}`,
    };
  });
  return changed ? ({ ...(msg as object), content: next } as AgentMessage) : null;
}

/**
 * **保留段里的巨型工具结果截断**(2026-08-09)—— 「压不动」的真解。
 *
 * ## 为什么切点修不了「压不动」
 *
 * 两边(omd 往回找 / pi 往后找)的合法切点都**排除 toolResult**:切在它上面就是孤儿结果、
 * provider 直接 400。于是「一批并发结果」或「单条结果比预算还大」时,任何切法都得把那一整批
 * 整个保留 —— 保留段的下限就是那一批的大小,与切点无关(实测表在 `findTurnHeadIndex` 注里:
 * 单轮 20 个并发结果, omd 返 null、pi 保留全量)。**能动的只剩结果内容本身。**
 *
 * ## 三条边界(都是"别把零行为变化搞成有行为变化"的那一类)
 *
 * 1. **只在压缩里调用** —— 正常轮走不到这里,一条消息都不动。
 * 2. **保留段没超太多就一个字不动**(`COMPACTION_RETAINED_TOLERANCE`):既有形状全部落在这条线下,
 *    所以既有测试一行不用改。撑爆预算的**不是**工具结果时(纯对话)也返 null —— 截了也没用。
 * 3. **预算按条均分**:单条上限 = 结果那部分预算 ÷ 结果条数。定值上限(如 pi 的 `DEFAULT_MAX_BYTES`
 *    = 50KB)挡不住这个形状 —— 20 条各 24KB 每条都在 50KB 之下,合起来 120k token 照样撑爆。
 *
 * @param retained 保留段(含逐字留下的首条)。
 * @param opts.tolerance 覆盖触发比值;`opts.minBytes` 覆盖单条下限。默认见上方两个常量。
 * @returns 截过的新数组;没触发/没得截 → `null`(调用方原样用旧的,**不是**返回一份"看着一样"的拷贝)。
 */
export function truncateOversizedToolResults(
  retained: AgentMessage[],
  keepRecentTokens: number,
  opts: { tolerance?: number; minBytes?: number } = {},
): AgentMessage[] | null {
  const tolerance = opts.tolerance ?? COMPACTION_RETAINED_TOLERANCE;
  const total = retained.reduce((n, m) => n + estimateTokens(m), 0);
  if (total <= keepRecentTokens * tolerance) return null;
  const targets = retained.flatMap((m, i) => ((m as { role?: string }).role === 'toolResult' ? [i] : []));
  if (targets.length === 0) return null;
  const resultTokens = targets.reduce((n, i) => n + estimateTokens(retained[i]!), 0);
  // 结果之外的部分(契约/轮首/assistant)是**不能截**的 ⇒ 先扣掉, 剩下的才是结果能吃的预算。
  const budgetTokens = Math.max(0, keepRecentTokens - (total - resultTokens));
  const maxBytes = Math.max(
    opts.minBytes ?? MIN_TOOL_RESULT_BYTES,
    Math.floor((budgetTokens * BYTES_PER_TOKEN) / targets.length),
  );
  const out = [...retained];
  let changed = false;
  for (const i of targets) {
    const t = truncateToolResultTail(retained[i]!, maxBytes);
    if (t) {
      out[i] = t;
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * 切不出点、但**截断本身**就把上下文压下来了时用的摘要文本。
 *
 * 为什么不返 `null` 了事:这条路上「没东西可摘要」是真的(契约之后只有一轮),但
 * 「压不动」不再是真的 —— 结果截完就在预算内。返 null 会让调用方去优雅停,活干不完,
 * 而那正是这次要修的病。摘要位上写清楚"这次省的是哪来的",别让读的人以为摘要器出了空。
 */
export const TRUNCATION_ONLY_SUMMARY =
  '(这次压缩没有可摘要的历史 —— 切不出摘要点。省下来的空间全部来自把超大工具结果截成尾部, ' +
  `被截的每一条自己带 ${TOOL_RESULT_TRUNCATION_MARK} 标记。)`;

/**
 * 摘要器的两段提示词。**默认是叶子口径**;chat conductor 走同一条压缩路但换措辞
 * (它压的是一段对话,不是"干到一半的执行记录")—— 见 `opts.prompt`。
 *
 * ⚠ 为什么是**换措辞**而不是各写一套压缩:会静默出错的是**切点**那一半
 * (切出孤儿 toolResult → provider 直接 400),而切点逻辑两边一模一样。
 * 复制一份出去,`planLeafCompaction` 的每次修正都要记得改两处 —— 本仓已经吃过那个形状。
 */
export interface CompactionPrompt {
  system: string;
  instruction: string;
}

const LEAF_COMPACTION_PROMPT: CompactionPrompt = {
  system: LEAF_SUMMARY_SYSTEM,
  instruction:
    '上面是一个执行叶子干到一半的记录, 上下文快满了要压缩。请写一份**接手用**的摘要, 覆盖:\n' +
    '① 已经改/建了哪些文件, 各自改成了什么样 (路径逐字);\n' +
    '② 跑过哪些验证命令、结论是什么 (通过/失败, 失败的错在哪);\n' +
    '③ 已经排除掉的做法与原因 (防止接手的人重走一遍);\n' +
    '④ **还没做完的部分**, 以及下一步该做什么。\n' +
    '只输出摘要本身, 不要复述任务、不要寒暄、不要接着干活。',
};

/**
 * 压缩的结构化结果(2026-08-09)。
 *
 * `messages` 是**拼好的新上下文**(与本函数此前的返回值逐字相同,叶子那条路只用它);
 * `summary` / `retainedTail` 是给**存储层**的:pi 的 `compaction` 条目存的正是这两件,
 * 投影时自己拼回 `[摘要, ...retainedTail]`(`harness/session/context.js`)。
 *
 * ⚠ 两种拼法有一处**次序差**:这里的 `messages` 是 `[首条, 摘要, ...尾]`(首条逐字在前),
 * 而 pi 的投影是 `[摘要, 首条, ...尾]` —— 内容一条不少,首条与摘要谁先谁后不同。
 * 之所以不去改 pi:那是它的条目语义(摘要即截断点),而首条在不在才是 omd 在意的那件事。
 */
export interface LeafCompaction {
  messages: AgentMessage[];
  summary: string;
  /** 摘要之后原样留着的消息 —— **含逐字保留的首条**(见上方次序差那条)。 */
  retainedTail: AgentMessage[];
}

export async function compactLeafContext(opts: {
  messages: AgentMessage[];
  model: string;
  keepRecentTokens: number;
  signal?: AbortSignal;
  /** 省略 → 叶子口径。chat conductor 传自己那一套(切点逻辑不变)。 */
  prompt?: CompactionPrompt;
  /**
   * 摘要那一次模型调用。省略 → 真 `callModel`(**账本挂在它出口上**,换掉默认值
   * 等于把这次花的钱从账上抹掉)。只有测试该传:全局 provider 注册表是跨测试文件
   * 共享的可变状态,靠它做隔离单文件绿、全量红(2026-08-07 实测)。
   */
  callModelFn?: typeof callModel;
}): Promise<LeafCompaction | null> {
  const { messages, model, keepRecentTokens, signal } = opts;
  const prompt = opts.prompt ?? LEAF_COMPACTION_PROMPT;
  const call = opts.callModelFn ?? callModel;
  const cut = planLeafCompaction(messages, keepRecentTokens);
  if (cut === null) {
    /**
     * 切不出点(契约之后只有一轮 / 短到没得摘要),而这一轮的**工具结果本身**撑爆了预算 ——
     * 此前这里直接返 null = 调用方优雅停,活干不完。截断是这个形状唯一动得了的东西,
     * 而且**不花一次模型调用**:没有历史要摘要,也就没有要付钱的地方。
     */
    const truncated = truncateOversizedToolResults(messages, keepRecentTokens);
    if (!truncated) return null; // 真的压不动: 没超太多, 或撑爆预算的不是工具结果
    logger.info(
      { model, msgs: truncated.length, before: messages.reduce((n, m) => n + estimateTokens(m), 0),
        after: truncated.reduce((n, m) => n + estimateTokens(m), 0) },
      '[agent-leaf] 切不出摘要点 → 只截断超大工具结果 (零模型调用)',
    );
    return {
      messages: [
        truncated[0]!,
        {
          role: 'user' as const,
          content: `${COMPACTION_SUMMARY_PREFIX}${TRUNCATION_ONLY_SUMMARY}${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: Date.now(),
        },
        ...truncated.slice(1),
      ],
      summary: TRUNCATION_ONLY_SUMMARY,
      retainedTail: truncated,
    };
  }

  const toSummarize = messages.slice(1, cut);
  if (toSummarize.length === 0) return null;
  const transcript = serializeConversation(convertToLlm(toSummarize));

  let summary: string;
  try {
    const res = await call({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\n${prompt.instruction}` },
      ],
      model,
      // 压缩是记账内的一次真调用, 但它是**辅助工序**: 关思考、限输出, 别让它比正活还贵。
      thinkingLevel: 'off',
      maxTokens: 4096,
      ...(signal ? { signal } : {}),
    });
    summary = res.text.trim();
  } catch (err) {
    // 压不动不是致命错: 调用方回落"优雅停", 已落盘的产物照样交。
    logger.warn({ model, err: (err as Error).message }, '[agent-leaf] 上下文压缩失败 → 回落优雅停');
    return null;
  }
  if (!summary) return null;
  const head = messages[0]!; // 契约逐字留着 (见 opts.compaction 注)
  const tail = messages.slice(cut);
  /**
   * **split-turn**(2026-08-09):切点落在轮内时,这一轮**自己的请求**也被摘要吃掉了,
   * 而逐字保留的首条是最老那一问 —— 于是保留段读起来是"干到一半的活",却没有"要干什么"。
   * 把轮首逐字接在摘要后面补上这一句。
   *
   * 与 pi 的做法差在哪:pi 是**再花一次模型调用**把轮前缀压成 `## Original Request /
   * ## Early Progress / ## Context for Suffix` 三段(`TURN_PREFIX_SUMMARIZATION_PROMPT`,
   * **没从包入口导出**,`dist/index.d.ts` 里查不到 ⇒ 想"配它的摘要段"只能自己再写一份措辞)。
   * 逐字留一条比摘要它更省(零额外调用)也更准 —— 请求是要被**照着执行**的东西,不该转述。
   * 叶子那边轮首恒为下标 0 ⇒ 这一段对叶子是 no-op(实测 S1/S3/S6 轮首均为 0)。
   */
  const turnHead = findTurnHeadIndex(messages, cut);
  const kept = turnHead === null ? tail : [messages[turnHead]!, ...tail];
  /**
   * **保留段的工具结果截断**(2026-08-09):切点排除 toolResult ⇒ 一批巨型结果只能整批保留,
   * 保留段可以比预算大好几倍而切点无能为力。超得太多才动手(见 `truncateOversizedToolResults`
   * 的三条边界),所以既有形状全部走 `?? retained` 这条、一个字不变。
   *
   * ⚠ 只截**保留段**,不截送去摘要的那一段:摘要那次调用收到什么原文,压缩前后必须一样,
   * 否则这次改动就顺手改了摘要质量,而读数上分不出是哪一半带来的。
   */
  const retained = [head, ...kept];
  const finalRetained = truncateOversizedToolResults(retained, keepRecentTokens) ?? retained;
  return {
    messages: [
      finalRetained[0]!,
      {
        role: 'user' as const,
        content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
        timestamp: Date.now(),
      },
      ...finalRetained.slice(1),
    ],
    summary,
    retainedTail: finalRetained,
  };
}

/** 一条 AgentMessage 里的 assistant 文本 (thinking / toolCall 块不算)。chat agent 复用 → export。 */
export function assistantText(msg: AgentMessage): string {
  if ((msg as { role?: string }).role !== 'assistant') return '';
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function createAgentLeafRunner(opts: AgentLeafRunnerOpts = {}): AgentLeafRunner {
  // sandboxRoot 设 → subprocess-per-leaf under bwrap: 整个 leaf 进程关进只见 worktree 的文件系统视图
  // (cwd=worktree, 主 repo 物理不可见) → 所有命令通道 (bash / 模型幻觉的 shell / 未来工具) + git-show
  // oracle 泄漏一次性全封, 不逐工具打地鼠。前置委托: 下面 in-process 装配 (工具/hook/循环) 全不需要。
  if (opts.sandboxRoot) return createSandboxedLeafRunner(opts);
  const cwd = opts.cwd ?? process.cwd();
  // 缺省档按**通道**分 (2026-08-10 owner): 同一个默认值在两种计价下经济学相反, 不能共用。
  //   pi 通道 → xhigh (owner 锁, 定价前提 = deepseek flash per-token 便宜档, xhigh 几乎白送;
  //     agent leaf 改文件/工具循环质量优先, 数量少于 inproc fan-out)。inproc leaf 才走 high。
  //   claude-code 订阅通道 → medium (owner 裁: effort 花的是与交互同池的窗口额度, xhigh 默认
  //     会把 flash 时代的定价惯性带进订阅池 —— 与 dream 座位那次「pro 惯性」同族)。
  // 显式 opts.thinkingLevel 恒覆盖两者 (A/B 必须能钉档位)。
  const thinkingLevel = opts.thinkingLevel ?? 'xhigh';
  const sdkThinkingLevel = opts.thinkingLevel ?? 'medium';

  // 工具集: 自有六件 + hashline (开则注入并**排除内置 edit**, 强制行锚定 patch) + 调用方自定。
  // 建一次复用整 runner: hashline 的快照 store 要跨 read/edit 共享, 而 runner 的 cwd 是固定的。
  //
  // SDD S3 碰撞台账会话 (只记不拦): 同一 runner 跨 run/跨节点复用 (MCP 长驻进程), runId 只在调用期
  // 可知 → session 不能烤进工具闭包, 得按调用落。AsyncLocalStorage: 每次调用一个独立 async 上下文
  // (下方 wrapper 用 run() 开, 不用 enterWith —— enterWith 会改到调用方的共享上下文, 并发节点互踩)。
  // per-call 状态 (碰撞台账 session + MCP 授权清单) 落**同一个** ALS: 装配期闭包只挂 getter,
  // 调用期由下方 wrapper 的 run() 写入 —— 并发调用各一个上下文互不串 (enterWith 会串, 见下)。
  const touchSessionStore = new AsyncLocalStorage<{ session?: string; mcpAllow?: string[] } | undefined>();
  const touchOpt = opts.touch; // const 让闭包里的收窄成立 (getter 里引用 touchOpt.session)
  const baseTools = createOmdAgentTools({
    cwd,
    ...(touchOpt ? { touch: { session: () => touchSessionStore.getStore()?.session ?? touchOpt.session } } : {}),
  });
  const hashlineTools = opts.hashlineEdit ? createHashlineCustomTools({ cwd }) : [];
  // 外部 MCP 双 meta-tool (SDD D-8): 零注册 → [] (meta-tools.ts:72-73) → 工具面与 prompt 前缀
  // 与接线前字节零变化 (I-1)。策略按调用求值 (getter 读 ALS): per-run 授权清单非空 → {allow},
  // 否则 deny —— leaf 是执行叶子, 不声明即不授权 (chat 座位的 'allow' 缺省不传染叶子)。
  const mcpTools = createMcpClientTools({
    cwd,
    session: () => touchSessionStore.getStore()?.session ?? touchOpt?.session,
    policy: () => leafMcpPolicy(touchSessionStore.getStore()?.mcpAllow ?? opts.mcpAllow),
    ...(opts.mcpDeps?.poolDeps ? { poolDeps: opts.mcpDeps.poolDeps } : {}),
    ...(opts.mcpDeps?.ledger ? { ledger: opts.mcpDeps.ledger } : {}),
  });
  const excluded = new Set(opts.hashlineEdit ? ['edit'] : []);
  const allowlist = opts.tools ? new Set(opts.tools) : null;
  const tools = [...baseTools, ...hashlineTools, ...mcpTools, ...(opts.customTools ?? [])].filter(
    (t) => !excluded.has(t.name) && (!allowlist || allowlist.has(t.name)),
  );

  // 项目说明书读一次复用整 runner (cwd 固定; 一次 fan-out 里几十个 leaf 不该各读一遍盘)。
  const contextFiles = loadProjectContext(cwd);
  const systemPrompt = buildLeafSystemPrompt({ cwd, tools, contextFiles });

  const runOnce = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const { prompt, model } = input;
    const { provider, modelId } = parseModelRef(model);
    // Claude 订阅通道 (NOTES 2026-08-10): claude-code:* 不在两栈, 循环走 SDK (下方调用点分派)。
    // ⚠ sandboxRoot 模式下 claude CLI 的凭证目录 (~/.claude) 不在 bwrap 视图里 —— 订阅座位
    // 暂不支持沙箱叶, 要用得先把凭证挂载进视图 (二期, 见 NOTES)。
    const isSdkChannel = provider === CLAUDE_SDK_PROVIDER;
    // 坐标解析与单发通道 (`callModel`) 走**同一个** resolver —— 两栈各解析一次正是"座位在这条路上
    // 能解出来、在那条路上解不出来"的来源。
    const piModel = isSdkChannel ? null : resolvePiModel(provider, modelId);
    if (!piModel && !isSdkChannel) {
      throw new Error(
        `[agent-leaf] 坐标 '${model}' 解析不出模型: provider '${provider}' 既不在自有 registry 也不在 pi-ai 目录。`,
      );
    }
    // prompt 档随**本次 leaf 的模型档**分派 (同 conductor S-P): 强模型只吃 house-rules,
    // 弱模型吃全量脚手架。opts 的两个开关仍是硬关 (纯命令叶可全关)。
    const wantRouting = opts.toolRouting ?? true;
    const wantDiscipline = opts.disciplineCore ?? true;
    const profile = opts.promptProfile ?? 'auto';
    const scaffold = agentScaffold({
      profile,
      model,
      toolRouting: wantRouting,
      disciplineCore: wantDiscipline,
      harnessCore: opts.harnessCore ?? false,
    });
    const disciplined = scaffold ? `${scaffold}\n\n${prompt}` : prompt;
    // persona 刻意**不进** promptVersion: 它是每个节点自己的角色设定, 属于"这一发在干什么"
    // 而不是"引擎这一版怎么包装" —— 混进来会让版本逐节点漂, 也就分不了组。
    const promptVersion = promptVersionOfText(scaffold);
    const routedPrompt = opts.persona ? `<persona>\n${opts.persona}\n</persona>\n\n${disciplined}` : disciplined;

    // advisor(NOTES 2026-08-10):pi 座内部升档 —— 本次运行注入无参 advisor 工具,prompt 面按
    // 本次工具面重建(创建期缓存的 systemPrompt 不含它)。claude-code 座走官方(settings.advisorModel
    // 在下方 SDK 分支下发),不注内部工具。recorder 挂 emit 链 —— 与 filesTouched 同一条事件流。
    const advisorRecorder = opts.advisor && !isSdkChannel ? createTranscriptRecorder() : null;
    const runTools = advisorRecorder
      ? [...tools, createAdvisorTool({ advisor: opts.advisor!, seatCoord: model, transcript: () => advisorRecorder.serialize() })]
      : tools;
    const runSystemPrompt = advisorRecorder ? buildLeafSystemPrompt({ cwd, tools: runTools, contextFiles }) : systemPrompt;

    // filesTouched 采集 (2026-07-20 修产物闸冤杀): start 记 toolCallId→path 候选,
    // end 且 !isError 才计入 (失败的写不算产物)。
    // 此前 runner 从不填 filesTouched → executor-dag 产物闸把真交付的文件节点全判 failed (恒空 = "谎报完工")。
    const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'hashline_edit']);
    // D-12 读采集: **与写监听同一形状** (start 记候选 → end 且 !isError 才计入)。
    // 词表与 `agent-tools.ts` 的工具集对齐: 单文件读的入口只有 read 与 hashline_read 两个。
    // `grep`/`ls` 刻意不收: 它们是**检索**不是消费 (一次 grep 命中十个文件不等于依赖那十个),
    // 收进来会把 artifact-lint 淹在噪声里。`bash` 里的 cat 收不到 —— 与写侧漏 bash 重定向同一条边界。
    const FILE_READ_TOOLS = new Set(['read', 'hashline_read']);
    const touched = new Set<string>();
    const readPaths = new Set<string>();
    // bash 痕迹采集 (2026-08-05)。配对逻辑抽成纯件 (见 createShellRunCollector) —— 它是这条链上
    // 唯一有判断的地方 (缺退出码不许编 0 · 闸拒的命令也要记), 留在闭包里就只能"接上了"而验不了。
    const shell = createShellRunCollector();
    // §8.5 效果指标: 写**之前**先按住内容, 写完再比 —— 「写完了」和「写变了」是两个数。
    // 快照只在 start 时取一次: end 时原文已经没了, 事后补不出来 (这是为什么它必须挂在这条链上,
    // 而不能做成一个跑完之后扫一遍盘的脚本)。
    const writeEffects: FileWriteEffect[] = [];
    const snapByCall = new Map<string, Map<string, FileSnapshot>>();
    let toolCalls = 0; // 工具调用计数 (prompt 档的路由效率读数, 见 AgentLeafResult.toolCalls)。
    let pendingTools = 0; // 在飞工具数 —— >0 时看门狗不计时 (跑 10 分钟的 bun test 是正当工作)
    let streamedChars = 0; // 已流出的正文字节数 (只作读数, 不再当判据)
    // toolCallId → 候选写路径 (可多: hashline_edit 一个 patch 多 section 多文件)。end 且 !isError 才计入。
    const pathByCall = new Map<string, string[]>();
    const readByCall = new Map<string, string>();

    // drift 检测 (默认开): **每个 leaf 一份** ring/flag —— 跨 leaf 复用会把别人的工具序列算进自己的环。
    const drift =
      opts.driftDetector === false
        ? null
        : createDriftTracker(typeof opts.driftDetector === 'object' ? opts.driftDetector : {});

    const emit = (e: AgentEvent): void => {
      // **进展信号**: 任何事件都算"它还在动" —— 包括 `thinking_delta` (模型在推理)。
      // 老判据只数 text_delta, 于是"在想"被读成"没反应"; effort 提到 max 之后那是必然误杀。
      noteProgress();
      advisorRecorder?.note(e);
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        streamedChars += e.assistantMessageEvent.delta.length;
      } else if (e.type === 'tool_execution_start') {
        toolCalls++;
        pendingTools++;
        drift?.note(e.toolName, e.args);
        const args = (e.args ?? {}) as { path?: unknown; patch?: unknown };
        if (FILE_WRITE_TOOLS.has(e.toolName)) {
          // hashline_edit 路径嵌在 patch 头 (`¶PATH#TAG`), 不是顶层 path —— 必须解析 patch, 否则漏记 → 假 empty-done。
          const paths =
            e.toolName === 'hashline_edit' && typeof args.patch === 'string'
              ? hashlinePatchPaths(args.patch)
              : typeof args.path === 'string' && args.path.trim()
                ? [args.path]
                : [];
          if (paths.length) {
            pathByCall.set(e.toolCallId, paths);
            // 写前快照。读盘失败 (权限 / 目录 / 竞态) 一律当"此前不存在" —— 本采集 fail-open,
            // 它是读数不是闸, 绝不能因为量不出来就把一次真的写判没了。
            const snaps = new Map<string, FileSnapshot>();
            for (const p of paths) snaps.set(p, snapshotFile(cwd, p));
            snapByCall.set(e.toolCallId, snaps);
          }
        } else if (FILE_READ_TOOLS.has(e.toolName)) {
          if (typeof args.path === 'string' && args.path.trim()) readByCall.set(e.toolCallId, args.path);
        }
        shell.note(e);
      } else if (e.type === 'tool_execution_end') {
        pendingTools = Math.max(0, pendingTools - 1);
        shell.note(e); // ⚠ 在 `!isError` 之外记 —— 理由见 createShellRunCollector 的注
        if (!e.isError) {
          const ps = pathByCall.get(e.toolCallId);
          if (ps) {
            const snaps = snapByCall.get(e.toolCallId);
            for (const p of ps) {
              touched.add(p);
              const before = snaps?.get(p);
              if (!before) continue; // 没取到快照 (理论上不会) → 不编一个效果数出来
              writeEffects.push(diffWriteEffect(p, before, snapshotFile(cwd, p)));
            }
          }
          // 读失败 (文件不存在等) 不算读过 —— 同"失败的写不算产物"。
          const rp = readByCall.get(e.toolCallId);
          if (rp) readPaths.add(rp);
        }
      }
      // debug 事件汇 (opt-in): 转发全部事件抓 transcript。回调抛错不许打断循环。
      if (opts.onEvent) {
        try {
          opts.onEvent(e as unknown as { type: string; [k: string]: unknown });
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '[agent-leaf] onEvent 回调抛错 (已吞, 不打断循环)');
        }
      }
    };

    // ── 有界性 (两级) ────────────────────────────────────────────────────────────
    // ① shouldStopAfterTurn: 超时/上下文预算到了 → 在**轮之间**优雅停, 已落盘的产物完整保留。
    // ② AbortSignal: 单轮自己跑过头 (provider 挂着不返) 的硬兜底。
    // 此前这两件事都只能靠外部秒表 + SIGKILL —— 高层 prompt() 既没有 maxTurns 也不收 signal。
    const timeoutMs = opts.leafTimeoutMs ?? 3_600_000;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 180_000;
    const budgetRatio = opts.contextBudgetRatio && opts.contextBudgetRatio > 0 ? opts.contextBudgetRatio : 0.85;
    const wantCompaction = opts.compaction !== false;
    const keepRecentTokens = opts.compactionKeepRecentTokens ?? 20_000;
    let compactions = 0;
    /**
     * **压缩当轮, provider 用量这个锚是失效的** (2026-08-01 实测抓到, 差点让整个压缩变成空转)。
     *
     * `estimateContextTokens` 优先拿**最后一条 assistant 自报的 usage** 当基数 —— 那是最准的,
     * 因为它是 provider 真数出来的。但压缩删掉的是它**前面**的消息, 而那条 assistant 对象没变、
     * 它自报的 usage 仍然是压缩前那个大数。于是压完再问一次"还超不超", 答案永远是"超" ——
     * 压缩照跑、照付钱, 然后照样停。实测就是这样: `before 3112 → after 3112`, msgs 5→4。
     *
     * 锚只失效**一轮**: 下一次 provider 应答会带来新的 usage。所以这里用"置位-消费"而不是长期开关。
     */
    let usageAnchorStale = false;
    const pureEstimate = (msgs: AgentMessage[]): number =>
      msgs.reduce((n, msg) => n + estimateTokens(msg), 0);
    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    let stalled = false;
    let contextExhausted = false;
    const hardTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
    // 进展看门狗: **滚动**窗口 (每来一个事件就重置), 不是启动时看一眼。
    // 工具在飞 → 不判死, 只把窗口往后推 (工具执行期间本来就没有事件)。
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimeoutMs <= 0) return;
      idleTimer = setTimeout(() => {
        if (pendingTools > 0) {
          armIdle(); // 有工具在跑 = 在干活, 续窗口
          return;
        }
        stalled = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    function noteProgress(): void {
      if (idleTimer) clearTimeout(idleTimer);
      armIdle();
    }
    armIdle();

    const context: AgentContext = {
      systemPrompt: runSystemPrompt,
      messages: [],
      tools: runTools,
    };
    const config: AgentLoopConfig = {
      // SDK 通道不消费本 config (调用点分派), 空断言只为类型 —— pi 路上方已保证非空。
      model: piModel!,
      convertToLlm,
      // thinking: 'off' = 不发该字段 (与 pi-transport 同语义); 其余直映 pi 的 reasoning 档,
      // 由 pi 按模型 thinkingLevelMap 再夹一次 (它比我们更清楚自家目录里哪档存在)。
      ...(thinkingLevel !== 'off' ? { reasoning: thinkingLevel } : {}),
      // 凭证**每轮现取** (auth.json → env, 与单发通道同一条解析): OAuth token 会在长工具阶段中途过期,
      // 起跑时取一次的写法到那时就是 401。
      getApiKey: (p: string) => resolvePiApiKey(p),
      // drift 注入走 transformContext: 它只改**这一次请求**看到的消息, 不写回 context ——
      // 于是"检出 spin → 注一次"是天然的边沿行为, 不会在 transcript 里堆成 N 份 checklist。
      transformContext: async (messages: AgentMessage[]) => {
        const text = drift?.takeInjection();
        if (!text) return messages;
        logger.debug('[omd/drift] stuck-checklist injected via transformContext');
        return [...messages, { role: 'user' as const, content: text, timestamp: Date.now() }];
      },
      // ── 上下文压缩 (GP-8) ──────────────────────────────────────────────────
      // 顺序是**先压再判停**: 循环先调 prepareNextTurn 换上下文, 再拿换好的问 shouldStopAfterTurn。
      // 于是压缩成功 → 下一句判据自然就在线下, 不停; 压不动 (返 null / 压完还超) → 下一句接住停。
      // 不需要额外的"压过了没"标志位, 也就没有那个标志位漂掉的可能。
      ...(wantCompaction
        ? {
            prepareNextTurn: async ({ context: ctx }) => {
              const window = piModel?.contextWindow ?? 0;
              if (window <= 0) return undefined;
              const before = estimateContextTokens(ctx.messages).tokens;
              if (before < window * budgetRatio) return undefined;
              const compacted = await compactLeafContext({
                messages: ctx.messages,
                model,
                keepRecentTokens: keepRecentTokens,
                ...(controller.signal ? { signal: controller.signal } : {}),
              });
              if (!compacted) return undefined; // 压不动 → 交给 shouldStopAfterTurn 优雅停
              usageAnchorStale = true; // 见上方注: 这一轮不能再拿 provider 用量当基数
              const after = pureEstimate(compacted.messages);
              compactions++;
              logger.info(
                { model, window, before, after, msgs: `${ctx.messages.length}→${compacted.messages.length}` },
                '[agent-leaf] 上下文压缩 (auto-compaction) —— 接着干, 不是交卷',
              );
              return { context: { ...ctx, messages: compacted.messages } };
            },
          }
        : {}),
      shouldStopAfterTurn: ({ context: ctx }) => {
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          timedOut = true;
          return true;
        }
        // 压缩之后仍在线上 (或压根没开压缩) → 优雅停: 撞窗口是整轮硬失败, 而停下来还能交已有产物。
        // 刚压过的那一轮改用逐条估算 —— provider 自报的用量描述的是压缩**前**的上下文 (见 usageAnchorStale)。
        const window = piModel?.contextWindow ?? 0;
        const tokens = usageAnchorStale ? pureEstimate(ctx.messages) : estimateContextTokens(ctx.messages).tokens;
        usageAnchorStale = false;
        if (window > 0 && tokens >= window * budgetRatio) {
          contextExhausted = true;
          logger.warn({ model, window, compactions }, '[agent-leaf] 上下文预算到顶且压不下去 → 轮间优雅停 (GP-8)');
          return true;
        }
        return false;
      },
    };

    let messages: AgentMessage[];
    let sdkUsage: ModelUsage | null = null;
    try {
      if (isSdkChannel) {
        // Claude 订阅通道: 循环换 SDK, 其余机械原样 —— filesTouched/writeEffects/shellRuns/drift
        // 全挂在 emit 的 tool_execution_* 事件上, 桥发同形事件, 采集不知道循环换了。
        // 看门狗: onActivity 每条 SDK 流消息续窗 + includePartialMessages 让长思考轮也有增量
        // (否则 3min idle 会把「在想」判成「挂死」—— 2026-08-01 修过的同族错)。
        // 上下文压缩/轮间停不做 (SDK 自管); tolerateAbort: 超时/停摆 abort → 返已累积, 优雅停语义保留。
        const effort = effortOf(sdkThinkingLevel);
        const advisorModel = officialAdvisorModelId(opts.advisor, model);
        const out = await runSdkAgentLoop({
          prompt: routedPrompt,
          systemPrompt,
          tools,
          modelId,
          modelCoord: model,
          ...(effort ? { effort } : {}),
          ...(advisorModel ? { advisorModel } : {}),
          cwd,
          onEvent: emit,
          onActivity: noteProgress,
          includePartialMessages: true,
          signal: controller.signal,
          tolerateAbort: true,
          ...(opts.sdkQueryFn ? { sdkQueryFn: opts.sdkQueryFn } : {}),
          // P1 (owner 验收): leaf 的账在循环核 emit, 成败都记 (pi leaf 不 emit 是因为引擎侧
          // 有 usage 回传链; SDK 失败路直接 throw, 不在这记就是订阅额度账外)。
          ledger: { model, origin: 'engine' },
        });
        messages = [{ role: 'user', content: routedPrompt, timestamp: Date.now() } as AgentMessage, ...out.generated];
        // D2 (owner 验收): 逐消息 usage 折算 out 严重低估 —— totalUsage 取自 result.modelUsage 真源。
        sdkUsage = out.totalUsage;
      } else {
        messages = await runAgentLoop(
          [{ role: 'user', content: routedPrompt, timestamp: Date.now() }],
          context,
          config,
          emit,
          controller.signal,
          streamSimple,
        );
      }
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }

    const text = messages.map(assistantText).join('');
    // usage: 循环把每一轮的 assistant 消息连同 usage 一并交回 → 逐轮累加即整个 leaf 的账
    // (此前只能问 session 要一个汇总数)。口径换算见 mapSessionUsage。
    const totals = { input: 0, output: 0, cacheRead: 0 };
    for (const m of messages) {
      const u = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
      if (!u) continue;
      // cacheWrite 并进 input: 本仓价表无写价字段, 按全价计 (诚实近似, 不虚构字段; 同 pi-transport)。
      totals.input += (u.input ?? 0) + (u.cacheWrite ?? 0);
      totals.output += u.output ?? 0;
      totals.cacheRead += u.cacheRead ?? 0;
    }
    const usage = sdkUsage ?? mapSessionUsage(totals);

    // **响亮失败** (承 C-5b): 低层循环对 provider 错误不抛 —— 它把 `stopReason:'error'` 连同
    // errorMessage 放进最后一条 assistant 消息就返回了 (agent-loop.js 的 error 分支)。
    // 那正是 empty-done 伪装成功的入口, 所以这里**主动查**: 有真错就带着 provider 的原话抛,
    // 而不是像从前那样只能猜"疑 401/404/空响应"。
    const last = messages[messages.length - 1] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (last?.role === 'assistant' && last.stopReason === 'error') {
      throw new Error(
        `[agent-leaf] provider 报错 (model=${model}): ${last.errorMessage ?? '(无 errorMessage)'}`,
      );
    }
    // 零产出兜底: 没错误、没正文、没落盘、也不是被我们停下来的 → 仍然响亮失败
    // (executor-dag failedFromThrow 接住, 保留败因入 heal 回路), 不把 empty-done 当成功。
    // stalled / 超时 / 上下文到顶都**不在此列**: 它们有各自的语义, 由下游按语义判。
    if (!text.trim() && touched.size === 0 && !stalled && !timedOut && !contextExhausted) {
      throw new Error(
        `[agent-leaf] 0-token empty-done (model=${model}): 循环返回空文本、无文件写入、非停摆非超时 — ` +
          '疑 provider 静默失败 (空响应, 或 reasoning 截断吞了正文)。',
      );
    }
    if (stalled) {
      logger.warn(
        { idleTimeoutMs, outLen: streamedChars, toolCalls },
        '[agent-leaf] leaf 停摆 (看门狗: 连续无任何循环事件且无工具在跑 → 疑 provider 挂起)',
      );
    } else if (timedOut) {
      logger.warn({ timeoutMs, outLen: streamedChars }, '[agent-leaf] leaf 超时中止 (有界停, 返已累积输出)');
    }
    // spin 只在真卡过时带出去 —— 全 0 的字段进 JSON 只是噪声 (同 observations「缺席 ≠ 0」的口径)。
    const spinSummary = drift?.summary();
    return {
      text, usage, promptVersion, filesTouched: [...touched], filesRead: [...readPaths], cwd, toolCalls, stalled, writeEffects,
      ...(spinSummary && spinSummary.spinEvents > 0 ? { spin: spinSummary } : {}),
      // 一条都没跑 → **缺席**而不是 `[]`: 「这个 leaf 没用过 bash」与「这条采集没接」在读数上
      // 必须分得开 (同 spin / observations 那条口径)。
      ...(shell.runs().length ? { shellRuns: shell.runs() } : {}),
    };
  };

  // per-call 状态 (session + mcpAllow) 一次 run() 落进 ALS: 引擎侧 runId 与 node.mcp ∪ 模板卡
  // mcp 都只在调用期可知 (runner 跨 run/跨节点复用) → 不能烤进装配期。用 run() 开**独立 async
  // 上下文** —— 并发调用各一个上下文互不串。⚠ 不用 enterWith: 它在同步前缀里改的是**调用方
  // (引擎) 的共享上下文**, 并发节点会互相覆盖 (withScope 文档明说的坑); run() 的上下文随调用
  // 结束自动回收, 无需 exit。
  return async (input) => {
    if (opts.touch || input.mcpAllow !== undefined) {
      return touchSessionStore.run({ session: input.touchSession, mcpAllow: input.mcpAllow }, () => runOnce(input));
    }
    return runOnce(input);
  };
}

/** 一次写之前/之后的文件状态 —— §8.5 效果指标的原料。 */
export interface FileSnapshot {
  exists: boolean;
  /** 行数 (末尾无换行的最后一行也算一行; 不存在 = 0)。 */
  lines: number;
  /** 内容指纹。不存在 = null,于是"不存在 → 空文件"也判得出是变化。 */
  hash: string | null;
}

/**
 * 按住一个文件此刻的样子。**fail-open**: 读不到 (不存在 / 权限 / 是目录 / 竞态) 一律当"不存在",
 * 绝不抛 —— 本函数服务的是读数, 让它把一次真的写弄成异常, 是拿正确性换观测性。
 *
 * 二进制文件按字节读: 行数对 PNG 之类没有意义(会是个大数), 但 `noop` 仍然准, 而 noop 才是这条
 * 指标要抓的东西。这与 S1 语料里 `binary-claim` 那一段同一个取舍: 量不准的那一格明说, 别装准。
 */
/**
 * **bash 痕迹采集器** (2026-08-05) —— 把工具事件流配对成 {@link ShellRun}。
 *
 * 补的是「诚实自验在引擎记录里不存在」这个洞: agent 手里有 bash,「我跑了 `bun test`, 全过」
 * 是合法自验的主要形状, 而引擎此前只记 `toolCalls` 的**次数** —— 数不出跑的是什么、过没过。
 *
 * 抽成纯件是因为这里有**三个会静默错的判断**, 留在 runner 闭包里就只验得了"接上了":
 *   ① **命令与退出码分属两个事件** (start 带 args.command, end 带 result.details.exitCode),
 *      必须按 toolCallId 配对 —— 配错就是把 A 的退出码安到 B 头上。
 *   ② **退出码拿不到时不许编 0**。闸拒 (工具抛错, 压根没有 details) / 平台没给, 都是**缺席**;
 *      编个 0 出来就是把"没记"伪装成"跑通了", 而这条通道存在的意义正是分开这两者。
 *   ③ **闸拒的命令也要记**。写/读那两条采集只记成功是对的 (失败的写不是产物), 而这里记的是
 *      **动作发生过** —— 「跑了但被拒」与「压根没跑」是两件事, 只记成功就把它们抹平了。
 */
export function createShellRunCollector(): {
  note(e: { type: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean }): void;
  runs(): ShellRun[];
} {
  const out: ShellRun[] = [];
  const byCall = new Map<string, string>();
  return {
    note(e) {
      if (e.toolName !== 'bash' || !e.toolCallId) return;
      if (e.type === 'tool_execution_start') {
        const cmd = (e.args as { command?: unknown } | undefined)?.command;
        if (typeof cmd === 'string' && cmd.trim()) byCall.set(e.toolCallId, cmd.trim());
        return;
      }
      if (e.type !== 'tool_execution_end') return;
      const command = byCall.get(e.toolCallId);
      if (command === undefined) return; // 没见过 start (事件丢了) → 不编一条出来
      byCall.delete(e.toolCallId);
      const details = e.isError ? undefined : (e.result as { details?: { exitCode?: unknown } } | undefined)?.details;
      const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : undefined;
      out.push({ command, ...(exitCode === undefined ? {} : { exitCode }), ok: exitCode === 0 });
    },
    runs: () => out,
  };
}

/**
 * 两张快照 → 一条效果指标 (§8.5)。**纯函数**, 与读盘分开, 于是 noop 的判据本身可以被单独钉住 ——
 * 而它正是这条指标唯一容易搞错的地方: 直觉会写成 `lineDelta === 0`, 那是错的。
 */
export function diffWriteEffect(path: string, before: FileSnapshot, after: FileSnapshot): FileWriteEffect {
  return {
    path,
    lineDelta: after.lines - before.lines,
    // 判据是「内容变没变」而不是「delta 是不是 0」: 换掉同样多的行 delta=0 但不是 noop;
    // 新建空文件 lines 都是 0 但 exists 从 false 变 true, 也不是 noop。
    noop: before.exists === after.exists && before.hash === after.hash,
  };
}

export function snapshotFile(cwd: string, path: string): FileSnapshot {
  try {
    const full = isAbsolute(path) ? path : join(cwd, path);
    const buf = readFileSync(full);
    const text = buf.toString('utf-8');
    return {
      exists: true,
      lines: text === '' ? 0 : text.split('\n').length,
      hash: createHash('sha1').update(buf).digest('hex'),
    };
  } catch {
    return { exists: false, lines: 0, hash: null };
  }
}
