/**
 * src/harness/agent-leaf —— 双模 leaf 的 **agent 模式** runner(executor-dag 的 `executor:'agent'` 节点用)。
 *
 * inproc leaf = 单发 callModel(无工具,生成/研究/判断)。
 * agent  leaf = 这里 —— 起一个**带工具的 pi 子 agent**(read / edit / write / bash),**能真改文件**。
 * 二者经 primitives 的 LeafFn 统一(mimo-leaf 契约 INV-5: 同一原语既驱动 callModel 也驱动 spawn_agent)。
 *
 * scope 原子化(契约 §granularity): 每个 agent leaf 应锁定**一个原子产物**(如一个文件),并行 leaf 改
 * 不重叠文件 = 天然原子;冲突走 DAG 依赖串行。cwd = 工作根,工具直接落盘。
 *
 * ⚠ usage(in/out)pi AgentSession 当前不向上吐 → 暂记 {0,0}(V2-ECON 账本缺口, 与 PiRuntime 同)。
 */
import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat'; // 0.80: 目录读挪 /compat
import { runScopedSession } from '../runtime/pi-runtime';
import { parseModelRef } from './fleet';
import { createHashlineCustomTools } from './hashline';
import { createDriftDetectorHook, type DriftDetectorConfig } from './hooks/drift-detector';
import { logger } from '../logger';
import { createKimiOAuthExtension } from '../model/kimi-oauth';
import type { ModelUsage } from '../model/types';
import type { ThinkingLevel } from '../runtime/types';

/**
 * 默认零嵌入扩展 (2026-07-19 删 pi-rtk-optimizer/pi-lsp: 二者非依赖, 每次 spawn 都 WARN 未装;
 * 输出压缩由 caveman 路由承担, 符号导航由 codegraph 承担 — 均已在编)。
 * 要挂 pi 扩展包的宿主经 opts.extensionDirs 显式传目录。
 *
 * 注: caveman (输出压缩) **不在这里** —— 它要 per-leaf 路由 (创意节点关/干活节点开, 全局扩展做不到),
 * 故走 executor-dag 的 caveman 路由 (per-leaf prompt 注入, src/harness/caveman.ts)。pi-caveman 扩展只给
 * 交互式 omd TUI (/caveman 命令 + 全局 config)。
 */
const DEFAULT_EXTENSION_DIRS: string[] = [];

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

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from './leaf-runners';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from './leaf-runners';

export interface AgentLeafRunnerOpts {
  /** 工具落盘的工作根。默认 process.cwd()。每个 agent leaf 应被 scope 到此根下的原子产物。 */
  cwd?: string;
  /** thinking 档位。默认 medium。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * 工具白名单(CC frontmatter 风格)。**省略 = pi 默认全工具(含 read/edit/write/bash, 能改文件)。**
   * 给则限定(如只读 ['read','bash'] 用于研究型 agent leaf)。
   */
  tools?: string[];
  /**
   * 嵌入的 pi 扩展包目录 (经 additionalExtensionPaths 加载)。默认 `[]` 零嵌入 —— 宿主要挂
   * pi 扩展包时显式传绝对目录数组。
   */
  extensionDirs?: string[];
  /**
   * 自定义工具 (与内置工具并存)。如 hashline_read/hashline_edit (行锚定 patch, 治弱模型 edit 腐烂)。
   * 经 createHashlineCustomTools() 造。省略 = 仅内置工具。
   */
  customTools?: ToolDefinition[];
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
   * agent loop 有界超时 (ms): 弱模型 (DeepSeek) loop 偶尔写完产物后空转不退出 (pi 无 maxTurns,
   * prompt() 永不 resolve → 外部 SIGKILL)。超时 → session.abort() settle 流, 返已累积输出 (产物多已落盘)。
   * 默认 240_000 (4min, 原子叶子充裕上界)。0/省略 = 不限 (慎用)。
   */
  leafTimeoutMs?: number;
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
   * drift 检测 hook (代码级 spinning 防护): agent-leaf 是 headless 工具循环 = spin 高发面,
   * 默认开 (low-invasive: 仅同调用同参重复 ≥阈值才经 context 注 stuck-checklist)。false 关; 对象调阈值。
   */
  driftDetector?: DriftDetectorConfig | false;
}

/**
 * 造一个真 agent-leaf runner: 每次调用起一个一次性带工具子 session, 跑完 dispose。
 * 这是 omd 本体「真能干活(改文件)」的执行底座 —— 不再只是单发文本。
 */
export function createAgentLeafRunner(opts: AgentLeafRunnerOpts = {}): AgentLeafRunner {
  const cwd = opts.cwd ?? process.cwd();
  // agent leaf 默认 max thinking (the owner 锁): agent leaf 改文件/工具循环, 质量优先 (数量少于 inproc fan-out,
  // max 成本可控)。inproc leaf 才走 high (mass fan-out 省成本)。可经 opts 覆盖。
  const thinkingLevel = opts.thinkingLevel ?? 'xhigh';
  const extensionDirs = opts.extensionDirs ?? DEFAULT_EXTENSION_DIRS;

  // hashline 编辑模式: 注入 hashline 工具 (共享快照, 建一次复用整 runner) + 排除内置 edit 强制走行锚定。
  const hashlineTools = opts.hashlineEdit ? createHashlineCustomTools({ cwd }) : [];
  const customTools = [...hashlineTools, ...(opts.customTools ?? [])];
  const excludeTools = opts.hashlineEdit ? ['edit'] : undefined;

  // drift 检测 (默认开): 建一次复用整 runner —— factory 内部是 per-session 闭包, 每 createAgentSession
  // 调它起一份新 ring/flag, 故跨 leaf 复用同一 factory 安全。agent-leaf = headless 工具循环 spin 高发面。
  const driftFactory =
    opts.driftDetector === false
      ? null
      : createDriftDetectorHook(typeof opts.driftDetector === 'object' ? opts.driftDetector : {});

  // resourceLoader 建一次复用 (reload 读盘, 别每 leaf 重建)。无 extensionDirs 且无 drift → 不建 (纯净 bare session)。
  let loaderPromise: Promise<DefaultResourceLoader> | null = null;
  const getLoader = (): Promise<DefaultResourceLoader> => {
    if (!loaderPromise) {
      loaderPromise = (async () => {
        const rl = new DefaultResourceLoader({
          cwd,
          agentDir: getAgentDir(),
          additionalExtensionPaths: extensionDirs,
          // drift-detector 经 in-code extensionFactories 注入 (与 opts.extensionDirs 的扩展包并存)。
          // kimi-coding OAuth 恒挂 (正门注册, 会话 ModelRegistry.refresh 清全局注册表后由它重放)。
          extensionFactories: [createKimiOAuthExtension(), ...(driftFactory ? [driftFactory] : [])],
        });
        await rl.reload();
        return rl;
      })();
    }
    return loaderPromise;
  };

  return async ({ prompt, model }) => {
    const { provider, modelId } = parseModelRef(model);
    const m = getModel(provider as Parameters<typeof getModel>[0], modelId as never);
    const resourceLoader = extensionDirs.length > 0 || driftFactory ? await getLoader() : undefined;
    const { session } = await createAgentSession({
      cwd,
      model: m,
      thinkingLevel,
      sessionManager: SessionManager.inMemory(),
      // 嵌入扩展 (caveman 压输出 + rtk 压工具输出) 经 resourceLoader 注入 agent leaf session。
      ...(resourceLoader ? { resourceLoader } : {}),
      // tools 省略 = pi 默认全工具(能改文件); 给则限定。
      ...(opts.tools ? { tools: opts.tools } : {}),
      // 自定义工具 (hashline 读改等), 与内置并存。
      ...(customTools.length > 0 ? { customTools } : {}),
      // hashline 模式排除内置 edit (强制行锚定路径)。
      ...(excludeTools ? { excludeTools } : {}),
    });
    // TR-INV-5: prepend tool-routing guideline (默认开) → 弱模型重叠区选对工具。
    // persona (P1 三层角色, 设计型 leaf 传 TASTE_CORE) 走最前 (角色框 → 工具路由 → 任务)。
    const tooled = (opts.toolRouting ?? true) ? `${TOOL_ROUTING_GUIDELINE}\n\n${prompt}` : prompt;
    // 承重纪律核 (默认开) 走 tool-routing 之前 (元规则 → 工具细则 → 任务)。
    const disciplined = (opts.disciplineCore ?? true) ? `${DISCIPLINE_CORE}\n\n${tooled}` : tooled;
    const routedPrompt = opts.persona ? `<persona>\n${opts.persona}\n</persona>\n\n${disciplined}` : disciplined;
    // 有界中止 (默认 4min): 治弱模型 loop 写完空转不退出 → 外部 SIGKILL 的 bug。
    const text = await runScopedSession(
      session as unknown as Parameters<typeof runScopedSession>[0],
      routedPrompt,
      { timeoutMs: opts.leafTimeoutMs ?? 240_000 },
    );
    // usage 暂不可见(pi 不向上吐 token 计数, = V2-ECON 缺口)。
    return { text, usage: { in: 0, out: 0 } };
  };
}

export type { AgentSession, ToolDefinition };
