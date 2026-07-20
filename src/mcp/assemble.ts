/**
 * src/mcp/assemble —— omd MCP 工具面装配 (SDD 2026-07-19 omd-mcp-server, P1 期 v1 工具面)。
 *
 * 把 src/mcp/tools/* 的纯函数工厂接上生产接缝 (纯组装, 零业务逻辑; 逻辑全在被注入的接缝里):
 *   - dag 四工具: 真引擎 {runExecutorDag, runExecutorDagWithPlan} + 新 RunRegistry + cwd。
 *     engine config 与 execute-extension 已解析形状同款: conductor/leaf/agent 模型从 env 角色矩阵读
 *     (OMD_ITER_* > runtime 坐标 OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL —— 解析序镜像
 *     resolveConductorDefault, 但 env 可注入故此处自带纯函数版),
 *     agentRunner = createAgentLeafRunner({cwd, hashlineEdit:true}) (tui 同款真改文件叶子),
 *     commandRunner = tui 同款白名单 (D-10: fail-closed 闸在引擎层, 入口不新增权限)。
 *   - memory 两工具: createOmdMemory (OMD_MEMORY_PATH ?? .omd/memory.db + UNIVERSAL_SAFEGUARD, 同 tui 默认;
 *     写入仍过 validateFactWrite 校验闸, D-5)。
 *   - research 工具: 现有 researchFanout 接缝 (harness/research/fanout) 适配成 MCP 三段返回
 *     {runId, reportPath, summary} (报告全文落盘 .omd/research/, D-8 宽出)。
 *   - fleet 四工具: createFleetTools (dag_review/slim/deepen 异步子进程 + dream_consolidate 同步泵;
 *     spawn 接缝默认 Bun.spawn, dream 接缝注入; runRegistry/cwd 同现有)。
 *   - runs 工具: createRunsTools (dag_runs 同步列表: 内存 registry ∪ 磁盘 continuity 合并去重)。
 *
 * 可测: 全部 deps 可选覆盖 (测试传 fake 引擎/内存记忆/fake research, 零网络零磁盘)。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OmdMcpTool } from './server';
import { RunRegistry } from './run-registry';
import { CheckpointManager } from '../harness/continuity/checkpoint-manager';
import { createDagTools, type DagEngine } from './tools/dag-tools';
import { createMemoryTools } from './tools/memory';
import { createPathfinderTools, type PathfinderToolDeps } from './tools/pathfinder';
import { createDagResearchTool, type ResearchFanout } from './tools/research';
import { createFleetTools, type SpawnFn } from './tools/fleet';
import { effectiveFanout, resolveProviderCap } from '../harness/fleet';
import { createRunsTools } from './tools/runs';
import { runExecutorDag, runExecutorDagWithPlan } from '../harness/executor-dag';
import type { ExecutorDagConfig } from '../harness/executor-dag-types';
import { createAgentLeafRunner } from '../harness/agent-leaf';
import { createCommandLeafRunner } from '../harness/command-leaf';
import type { AgentLeafRunner, CommandLeafRunner } from '../harness/leaf-runners';
import { createOmdMemory, type OmdMemory } from '../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../memory/safeguards/namespaces';
import {
  researchFanout as runResearchFanout,
  type ResearchFanoutResult,
} from '../harness/research/fanout';
import {
  DEFAULT_COUNCIL_DEEP_CRITERIA,
  DEFAULT_COUNCIL_DEEP_FRAMINGS,
  DEFAULT_COUNCIL_DEEP_LENSES,
} from '../harness/plan/best-of-n';
import type { DreamPump } from '../harness/learning/types';

/** 生产引擎接缝 (真 DAG 引擎)。 */
const PROD_ENGINE: DagEngine = { runExecutorDag, runExecutorDagWithPlan };

/** assemble 的可选依赖覆盖 —— 省略任何一项 = 该项用生产默认。 */
export interface AssembleOmdMcpDeps {
  /** env 注入 (默认 process.env) —— 角色矩阵解析可测, 测试不必污染进程 env。 */
  env?: NodeJS.ProcessEnv;
  /** 工作目录 (默认 process.cwd()): 工具作用域 + agent/command runner 基准 + 报告落盘根 (D-10)。 */
  cwd?: string;
  /** DAG 引擎接缝 (默认真 runExecutorDag/runExecutorDagWithPlan)。 */
  engine?: DagEngine;
  /** run 注册表 (默认新 RunRegistry, 纯内存; 三段式 runId 生命周期的载体, D-3)。 */
  runRegistry?: RunRegistry;
  /** 记忆接缝 (默认 createOmdMemory tui 同款路径 + UNIVERSAL_SAFEGUARD, D-5 共库)。 */
  memory?: OmdMemory;
  /** research 接缝 (默认 createDefaultResearchFanout: 真 researchFanout + 报告落盘)。 */
  researchFanout?: ResearchFanout;
  /** agent-kind leaf 执行器 (默认 createAgentLeafRunner({cwd, hashlineEdit:true}))。 */
  agentRunner?: AgentLeafRunner;
  /** command-kind leaf 执行器 (默认 tui 同款白名单 bun/tsc/npx, 180s 超时)。 */
  commandRunner?: CommandLeafRunner;
  /** engine config 追加覆盖 (在 env 角色矩阵解析结果之上, caller 显式指定优先)。 */
  configOverrides?: Partial<ExecutorDagConfig>;
  /** pathfinder 工具接缝覆盖 (测试传 fake executeSlice/dispatchFrontier/watchAfkResults)。 */
  pathfinder?: Partial<Pick<PathfinderToolDeps, 'executeSlice' | 'dispatchFrontier' | 'watchAfkResults'>>;
  /** fleet spawn 接缝 (测试注入 fake; 生产默认 Bun.spawn)。 */
  spawn?: SpawnFn;
  /** dream pump 接缝 (dream_consolidate; 省略 → 该工具回 isError 不炸)。 */
  dream?: DreamPump;
}

/** runtime 模型坐标 (OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL); 未配 → '' (镜像 resolveConductorDefault)。 */
function runtimeCoord(env: NodeJS.ProcessEnv): string {
  const provider = env.OMD_RUNTIME_PROVIDER?.trim();
  const model = env.OMD_RUNTIME_MODEL?.trim();
  return provider && model ? `${provider}:${model}` : '';
}

/**
 * env 角色矩阵 → engine config 的模型三件套 (纯函数, 导出供测试):
 *   conductorModel = OMD_ITER_CONDUCTOR_MODEL > runtime 坐标 (D-8: conductor 默认 = runtime 同款);
 *   leafModel      = OMD_ITER_LEAF_MODEL      > runtime 坐标;
 *   agentLeafModel = OMD_ITER_AGENT_MODEL     > runtime 坐标 (解析不出则省略 = 引擎内回退 leafModel)。
 * 全空 → 空串: dag 工具 handler 会给出明确的 isError (conductorModel/leafModel required), 非 crash。
 */
export function resolveEngineModels(env: NodeJS.ProcessEnv): {
  conductorModel: string;
  leafModel: string;
  agentLeafModel?: string;
} {
  const runtime = runtimeCoord(env);
  const conductorModel = env.OMD_ITER_CONDUCTOR_MODEL?.trim() || runtime;
  const leafModel = env.OMD_ITER_LEAF_MODEL?.trim() || runtime;
  const agentLeafModel = env.OMD_ITER_AGENT_MODEL?.trim() || runtime;
  return {
    conductorModel,
    leafModel,
    ...(agentLeafModel ? { agentLeafModel } : {}),
  };
}

/** 生产 memory 接缝 (tui 默认同款): OMD_MEMORY_PATH ?? .omd/memory.db + UNIVERSAL_SAFEGUARD。 */
function createDefaultMemory(env: NodeJS.ProcessEnv): OmdMemory {
  const memoryPath = env.OMD_MEMORY_PATH ?? '.omd/memory.db';
  mkdirSync(dirname(memoryPath), { recursive: true });
  return createOmdMemory({ path: memoryPath, safeguard: UNIVERSAL_SAFEGUARD });
}

/**
 * 生产 research 接缝 (导出 = 可测 seam): question → 真 researchFanout (council-deep 默认镜头集)
 * → 报告全文落盘 .omd/research/<runId>.md → {runId, reportPath, summary} (D-8 宽出: summary =
 * 统计 + final 前 600 字符, 全量只在落盘文件)。
 *
 * 旗标全是真旋钮 (直接改 fanout 配置形状, 无装饰参数):
 *   k              = 广度: 取前 k 个镜头 (clamp 1..镜头总数, 默认全取);
 *   super=true     = 深档: 全 M framing × 全 K 评判维度; 默认快档 (单 framing, 全评判);
 *   council=false  = 无 judge panel: 单 correctness 维度; 默认全评判 panel。
 */
export function createDefaultResearchFanout(deps: { cwd: string; env: NodeJS.ProcessEnv }): ResearchFanout {
  const { cwd, env } = deps;
  return async ({ question, council, super: superMode, k }) => {
    const runId = randomUUID();
    const runtime = runtimeCoord(env);
    // 模型解析同角色矩阵; 终兜底镜像 councilDeepPlan 的既有默认 (env 未配时的仓内行为)。
    const lensModel = env.OMD_ITER_LEAF_MODEL?.trim() || runtime || 'deepseek:deepseek-v4-flash';
    const reasonModel = env.OMD_ITER_CONDUCTOR_MODEL?.trim() || runtime || 'deepseek:deepseek-v4-pro';

    const lenses = [...DEFAULT_COUNCIL_DEEP_LENSES];
    const lensCount = k === undefined ? lenses.length : Math.max(1, Math.min(Math.trunc(k), lenses.length));
    const framings = superMode ? [...DEFAULT_COUNCIL_DEEP_FRAMINGS] : DEFAULT_COUNCIL_DEEP_FRAMINGS.slice(0, 1);
    const criteria =
      council === false ? DEFAULT_COUNCIL_DEEP_CRITERIA.slice(0, 1) : [...DEFAULT_COUNCIL_DEEP_CRITERIA];

    const result = await runResearchFanout({
      question,
      groundTruth: question,
      lenses: lenses.slice(0, lensCount),
      synthesisFramings: [...framings],
      judgeCriteria: [...criteria],
      lensModel,
      reasonModel,
    });

    const reportDir = join(cwd, '.omd', 'research');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${runId}.md`);
    writeFileSync(reportPath, renderResearchReport(question, runId, result));

    const summary =
      `leafCount=${result.leafCount} cost=$${result.costStats.totalUsd.toFixed(4)} ` +
      `(cache 省 $${result.costStats.totalSavingsUsd.toFixed(4)})\n` +
      result.final.slice(0, 600);
    return { runId, reportPath, summary };
  };
}

/** 研究报告全文 (零丢失, D-8: 客户端上下文只拿 summary, 细节自己 Read 落盘文件)。 */
function renderResearchReport(question: string, runId: string, result: ResearchFanoutResult): string {
  const sections = [
    `# omd research — ${question}`,
    '',
    `- runId: ${runId}`,
    `- leafCount: ${result.leafCount}`,
    `- cost: $${result.costStats.totalUsd.toFixed(4)} (cache 省 $${result.costStats.totalSavingsUsd.toFixed(4)})`,
    '',
    '## 最终方案',
    '',
    result.final,
    '',
    '## 镜头冠军',
    '',
    ...result.lensChampions.map((c) => `### ${c.key}\n\n${c.text}`),
    '',
    '## 融合分析 (共识/矛盾/缺口/洞察/盲点)',
    '',
    result.fusionAnalysis,
    '',
    '## judge 评审',
    '',
    ...result.judgeCritiques.map((c) => `### ${c.key}\n\n${c.text}`),
    '',
  ];
  return sections.join('\n');
}

/**
 * 装配 v1 全工具面 (12 工具): dag_run/dag_run_plan/dag_status/dag_result + dag_research +
 * memory_recall/memory_remember + dag_review/dag_slim/dag_deepen/dream_consolidate + dag_runs。
 * 纯组装: 解析 deps → 调各工厂 → 拍平返回。
 */
export function assembleOmdMcpTools(deps: AssembleOmdMcpDeps = {}): OmdMcpTool[] {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const engine = deps.engine ?? PROD_ENGINE;
  const runRegistry = deps.runRegistry ?? new RunRegistry();
  const memory = deps.memory ?? createDefaultMemory(env);
  // 记忆卫生 (TUI prune-scheduler parity — MCP 长驻进程 D-9): 默认 memory 时启动即 TTL 扫一次
  // + 每 6h 一次。注入 memory 的调用方 (测试/宿主) 自管卫生; OMD_MEMORY_PRUNE=0 关闭。
  // 定时器 unref: 不阻进程退出 (stdin EOF 干净退出语义不变)。prune 失败永不砖 server。
  if (!deps.memory && env.OMD_MEMORY_PRUNE !== '0') {
    const sweep = (): void => {
      try {
        memory.prune();
      } catch {
        /* 卫生失败不砖 */
      }
    };
    sweep();
    const timer = setInterval(sweep, 6 * 3600 * 1000);
    timer.unref?.();
  }
  const researchFanout = deps.researchFanout ?? createDefaultResearchFanout({ cwd, env });
  // 长任务叶子超时: OMD_LEAF_TIMEOUT_MS 覆 240s 默认, 1h 兜底防泄漏 (session.abort 不杀子进程)。
  const leafTimeoutMs = (() => { const n = env.OMD_LEAF_TIMEOUT_MS ? Number.parseInt(env.OMD_LEAF_TIMEOUT_MS, 10) : NaN; return Number.isFinite(n) && n > 0 ? n : 3_600_000; })();
  const agentRunner = deps.agentRunner ?? createAgentLeafRunner({ cwd, hashlineEdit: true, leafTimeoutMs });
  const commandRunner =
    deps.commandRunner ??
    createCommandLeafRunner({ allowlist: ['bun', 'tsc', 'npx'], cwd, timeoutMs: 180_000 });

  // engine config = env 角色矩阵三件套 + 真改文件 runner 对 (execute-extension 已解析形状同款)。
  const models = resolveEngineModels(env);
  // 并发默认接 fleet 层 (此前断路 = 引擎全宽): min(effectiveFanout(env OMD_MAX_FANOUT/CPU 兜底),
  // agent 模型 provider 的并发池 cap)。工具参数 maxFanout 仍最高优先 (dag-tools 内覆盖)。
  const agentProvider = (models.agentLeafModel ?? models.leafModel ?? '').split(':')[0] ?? '';
  const defaultMaxFanout = Math.max(
    1,
    Math.min(effectiveFanout({}, env), agentProvider ? resolveProviderCap(agentProvider) : Number.MAX_SAFE_INTEGER),
  );
  // per-kind 闸: **代码零默认** (无硬默认教义 — MCP 是中立基础设施, 不烤机器立场; ms02 等
  // 强机部署天然无限制)。弱机自己的约束写自己的 env: OMD_AGENT_FANOUT / OMD_COMMAND_FANOUT。
  const intEnv = (v: string | undefined): number | undefined => {
    const n = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const agentCap = intEnv(env.OMD_AGENT_FANOUT);
  const commandCap = intEnv(env.OMD_COMMAND_FANOUT);
  const kindFanout = {
    ...(agentCap ? { agent: agentCap } : {}),
    ...(commandCap ? { command: commandCap } : {}),
  };
  const defaultConfig: Partial<ExecutorDagConfig> = {
    ...models,
    maxFanout: defaultMaxFanout,
    ...(Object.keys(kindFanout).length ? { kindFanout } : {}),
    agentRunner,
    commandRunner,
    ...deps.configOverrides,
  };

  return [
    // continuity 恒开 (D-3): checkpoint 落 <cwd>/.omd/continuity/<runId>/, dag_run_plan resume 可续。
    ...createDagTools({ engine, runRegistry, cwd, defaultConfig, continuity: { manager: new CheckpointManager(cwd), repoRoot: cwd } }),
    createDagResearchTool(researchFanout),
    ...createMemoryTools({ memory, cwd }),
    // pathfinder 六件套 (TUI-less 决策地图: map/add/tickets/rule/deliver/prefetch, pull 式回流)。
    ...createPathfinderTools({
      cwd,
      env,
      models: resolveEngineModels(env),
      agentRunner,
      commandRunner,
      ...deps.pathfinder,
    }),
    // fleet 四工具: review/slim/deepen 异步子进程 + dream_consolidate 同步泵。
    ...createFleetTools({ runRegistry, cwd, spawn: deps.spawn, dream: deps.dream }),
    // runs 工具: 内存 registry ∪ 磁盘 continuity 合并列表。
    ...createRunsTools({ runRegistry, cwd }),
  ];
}
