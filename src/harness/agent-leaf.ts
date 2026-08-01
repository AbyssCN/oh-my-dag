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
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseModelRef } from './fleet';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';
import { createHashlineCustomTools, hashlinePatchPaths } from './hashline';
import { createDriftTracker, type DriftDetectorConfig } from './hooks/drift-detector';
import { createSandboxedLeafRunner } from './hooks/sandboxed-leaf';
import { logger } from '../logger';
import { resolvePiApiKey, resolvePiModel } from '../model/pi-transport';
import { promptVersionOfText } from '../model/langfuse';
import type { ModelUsage } from '../model/types';
import type { ThinkingLevel } from '../runtime/types';
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
}): string {
  const { profile, model, toolRouting, disciplineCore } = opts;
  if (profile === 'off') return '';
  if (profile === 'strong' || (profile === 'auto' && isStrongCoord(model) && (toolRouting || disciplineCore))) {
    return STRONG_MODEL_CORE;
  }
  // 承重纪律核走 tool-routing 之前 (元规则 → 工具细则 → 任务)。
  return [disciplineCore ? DISCIPLINE_CORE : '', toolRouting ? TOOL_ROUTING_GUIDELINE : '']
    .filter(Boolean)
    .join('\n\n');
}

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect } from './leaf-runners';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect } from './leaf-runners';

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
   * prompt 档强制覆盖 (eval 用)。缺省 `'auto'` = 按本次 leaf 的模型档自选 (强模型走
   * STRONG_MODEL_CORE, 其余走全量脚手架)。**A/B 必须能把档位固定住**, 否则换模型时档位跟着变,
   * 量到的差是"模型 × 档位"的混合效应, 分不清是哪一半 —— 这正是 conductor 那轮 A/B 的教训。
   *   'weak'   = 恒发 TOOL_ROUTING + DISCIPLINE_CORE
   *   'strong' = 恒发 STRONG_MODEL_CORE
   *   'off'    = 两块都不发 (裸 prompt 基线)
   */
  promptProfile?: 'auto' | 'weak' | 'strong' | 'off';
  /**
   * agent loop 有界超时 (ms)。默认 240_000 (4min, 原子叶子充裕上界)。0/省略 = 不限 (慎用)。
   *
   * **两级实现** (2026-08-01 搬家后): ① `shouldStopAfterTurn` —— 超时后在**轮之间**优雅停,
   * 已跑完的工具与已落盘的产物完整保留; ② `AbortSignal` —— 单轮自己跑过头时的硬兜底
   * (流被 abort, `stopReason:'aborted'`)。此前只有 ② 的粗暴版 (外部 SIGKILL), 因为高层
   * `prompt()` 既无 maxTurns 也不收 signal。**有界性本身一步没少, 换的是它长在哪。**
   */
  leafTimeoutMs?: number;
  /**
   * 早期停摆闸 (issue #5): 启动后 heartbeatMs 内累积输出仍近零且无工具活动 → 判 provider 挂起,
   * 提前 abort 标 stall, 不白等满 leafTimeoutMs (K3 停摆实测: 240s 只累积 24 字节 → 前 30s 即可判死)。
   * 默认 45_000 (45s, 保守避误杀)。0 = 关。
   *
   * 搬家时**刻意留着**: 它治的是「provider 端排队/挂起」, 与「循环停不下来」是两回事 —— 后者被
   * signal + shouldStopAfterTurn 根治了, 前者没有; 删掉它只会让一个死 provider 白烧满 4 分钟墙钟。
   */
  heartbeatMs?: number;
  /** 停摆闸输出下限 (字节)。默认 32。 */
  heartbeatMinBytes?: number;
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
   * drift 检测 (代码级 spinning 防护): agent-leaf 是 headless 工具循环 = spin 高发面,
   * 默认开 (low-invasive: 仅同调用同参重复 ≥阈值才经 transformContext 注 stuck-checklist)。
   * false 关; 对象调阈值。
   */
  driftDetector?: DriftDetectorConfig | false;
  /**
   * 上下文预算闸 (GP-8): 估算上下文占到模型窗口的这个比例时, 在**轮之间**优雅停。
   * 默认 0.85。0/省略 = 用默认; 设 1 以上 = 关 (不建议 —— 撞窗口是硬失败, 停下来还能交已有产物)。
   */
  contextBudgetRatio?: number;
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

function loadProjectContext(cwd: string, maxDepth = 8): { path: string; content: string }[] {
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

/** 一条 AgentMessage 里的 assistant 文本 (thinking / toolCall 块不算)。 */
function assistantText(msg: AgentMessage): string {
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
  // agent leaf 默认 max thinking (the owner 锁): agent leaf 改文件/工具循环, 质量优先 (数量少于 inproc fan-out,
  // max 成本可控)。inproc leaf 才走 high (mass fan-out 省成本)。可经 opts 覆盖。
  const thinkingLevel = opts.thinkingLevel ?? 'xhigh';

  // 工具集: 自有六件 + hashline (开则注入并**排除内置 edit**, 强制行锚定 patch) + 调用方自定。
  // 建一次复用整 runner: hashline 的快照 store 要跨 read/edit 共享, 而 runner 的 cwd 是固定的。
  const baseTools = createOmdAgentTools({ cwd });
  const hashlineTools = opts.hashlineEdit ? createHashlineCustomTools({ cwd }) : [];
  const excluded = new Set(opts.hashlineEdit ? ['edit'] : []);
  const allowlist = opts.tools ? new Set(opts.tools) : null;
  const tools = [...baseTools, ...hashlineTools, ...(opts.customTools ?? [])].filter(
    (t) => !excluded.has(t.name) && (!allowlist || allowlist.has(t.name)),
  );

  // 项目说明书读一次复用整 runner (cwd 固定; 一次 fan-out 里几十个 leaf 不该各读一遍盘)。
  const contextFiles = loadProjectContext(cwd);
  const systemPrompt = buildLeafSystemPrompt({ cwd, tools, contextFiles });

  return async ({ prompt, model }) => {
    const { provider, modelId } = parseModelRef(model);
    // 坐标解析与单发通道 (`callModel`) 走**同一个** resolver —— 两栈各解析一次正是"座位在这条路上
    // 能解出来、在那条路上解不出来"的来源。
    const piModel = resolvePiModel(provider, modelId);
    if (!piModel) {
      throw new Error(
        `[agent-leaf] 坐标 '${model}' 解析不出模型: provider '${provider}' 既不在自有 registry 也不在 pi-ai 目录。`,
      );
    }
    // prompt 档随**本次 leaf 的模型档**分派 (同 conductor S-P): 强模型只吃 house-rules,
    // 弱模型吃全量脚手架。opts 的两个开关仍是硬关 (纯命令叶可全关)。
    const wantRouting = opts.toolRouting ?? true;
    const wantDiscipline = opts.disciplineCore ?? true;
    const profile = opts.promptProfile ?? 'auto';
    const scaffold = agentScaffold({ profile, model, toolRouting: wantRouting, disciplineCore: wantDiscipline });
    const disciplined = scaffold ? `${scaffold}\n\n${prompt}` : prompt;
    // persona 刻意**不进** promptVersion: 它是每个节点自己的角色设定, 属于"这一发在干什么"
    // 而不是"引擎这一版怎么包装" —— 混进来会让版本逐节点漂, 也就分不了组。
    const promptVersion = promptVersionOfText(scaffold);
    const routedPrompt = opts.persona ? `<persona>\n${opts.persona}\n</persona>\n\n${disciplined}` : disciplined;

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
    // §8.5 效果指标: 写**之前**先按住内容, 写完再比 —— 「写完了」和「写变了」是两个数。
    // 快照只在 start 时取一次: end 时原文已经没了, 事后补不出来 (这是为什么它必须挂在这条链上,
    // 而不能做成一个跑完之后扫一遍盘的脚本)。
    const writeEffects: FileWriteEffect[] = [];
    const snapByCall = new Map<string, Map<string, FileSnapshot>>();
    let toolCalls = 0; // 工具调用计数 (prompt 档的路由效率读数, 见 AgentLeafResult.toolCalls)。
    let toolActivity = false; // 任何工具调用 = 模型已应答 → 停摆闸豁免
    let streamedChars = 0; // 已流出的正文字节数 (停摆闸的另一半判据)
    // toolCallId → 候选写路径 (可多: hashline_edit 一个 patch 多 section 多文件)。end 且 !isError 才计入。
    const pathByCall = new Map<string, string[]>();
    const readByCall = new Map<string, string>();

    // drift 检测 (默认开): **每个 leaf 一份** ring/flag —— 跨 leaf 复用会把别人的工具序列算进自己的环。
    const drift =
      opts.driftDetector === false
        ? null
        : createDriftTracker(typeof opts.driftDetector === 'object' ? opts.driftDetector : {});

    const emit = (e: AgentEvent): void => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        streamedChars += e.assistantMessageEvent.delta.length;
      } else if (e.type === 'tool_execution_start') {
        toolCalls++;
        toolActivity = true;
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
      } else if (e.type === 'tool_execution_end') {
        toolActivity = true;
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
    const timeoutMs = opts.leafTimeoutMs ?? 240_000;
    const heartbeatMs = opts.heartbeatMs ?? 45_000;
    const heartbeatMinBytes = opts.heartbeatMinBytes ?? 32;
    const budgetRatio = opts.contextBudgetRatio && opts.contextBudgetRatio > 0 ? opts.contextBudgetRatio : 0.85;
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
    // 停摆闸 (issue #5): 一次性早检 —— provider 端排队/挂起时前 45s 就零/近零 token, 不必白等满硬超时。
    // 工具活动豁免 (合法慢叶子跑长 bash 时静默但已应答)。
    const stallTimer =
      heartbeatMs > 0
        ? setTimeout(() => {
            if (streamedChars < heartbeatMinBytes && !toolActivity) {
              stalled = true;
              controller.abort();
            }
          }, heartbeatMs)
        : null;

    const context: AgentContext = {
      systemPrompt,
      messages: [],
      tools,
    };
    const config: AgentLoopConfig = {
      model: piModel,
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
      shouldStopAfterTurn: ({ context: ctx }) => {
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          timedOut = true;
          return true;
        }
        // GP-8 上下文纪律: 撞窗口是硬失败 (整轮白丢), 而在窗口前停下来还能把已有产物交出去。
        const window = piModel.contextWindow;
        if (window > 0 && estimateContextTokens(ctx.messages).tokens >= window * budgetRatio) {
          contextExhausted = true;
          logger.warn({ model, window }, '[agent-leaf] 上下文预算到顶 → 轮间优雅停 (GP-8)');
          return true;
        }
        return false;
      },
    };

    let messages: AgentMessage[];
    try {
      messages = await runAgentLoop(
        [{ role: 'user', content: routedPrompt, timestamp: Date.now() }],
        context,
        config,
        emit,
        controller.signal,
      );
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      if (stallTimer) clearTimeout(stallTimer);
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
    const usage = mapSessionUsage(totals);

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
      logger.warn({ heartbeatMs, outLen: streamedChars }, '[agent-leaf] leaf 停摆 (窗口内近零输出+无工具活动, 疑 provider 挂起)');
    } else if (timedOut) {
      logger.warn({ timeoutMs, outLen: streamedChars }, '[agent-leaf] leaf 超时中止 (有界停, 返已累积输出)');
    }
    return { text, usage, promptVersion, filesTouched: [...touched], filesRead: [...readPaths], cwd, toolCalls, stalled, writeEffects };
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
