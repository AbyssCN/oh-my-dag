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
 *
 * 可测: 全部 deps 可选覆盖 (测试传 fake 引擎/内存记忆/fake research, 零网络零磁盘)。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OmdMcpTool } from './server';
import { RunRegistry } from './run-registry';
import { createDagTools, type DagEngine } from './tools/dag-tools';
import { createMemoryTools } from './tools/memory';
import { createPathfinderTools, type PathfinderToolDeps } from './tools/pathfinder';
import { createDagResearchTool, type ResearchFanout } from './tools/research';
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
 * 装配 v1 全工具面 (7 工具): dag_run/dag_run_plan/dag_status/dag_result + dag_research +
 * memory_recall/memory_remember。纯组装: 解析 deps → 调各工厂 → 拍平返回。
 */
export function assembleOmdMcpTools(deps: AssembleOmdMcpDeps = {}): OmdMcpTool[] {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const engine = deps.engine ?? PROD_ENGINE;
  const runRegistry = deps.runRegistry ?? new RunRegistry();
  const memory = deps.memory ?? createDefaultMemory(env);
  const researchFanout = deps.researchFanout ?? createDefaultResearchFanout({ cwd, env });
  const agentRunner = deps.agentRunner ?? createAgentLeafRunner({ cwd, hashlineEdit: true });
  const commandRunner =
    deps.commandRunner ??
    createCommandLeafRunner({ allowlist: ['bun', 'tsc', 'npx'], cwd, timeoutMs: 180_000 });

  // engine config = env 角色矩阵三件套 + 真改文件 runner 对 (execute-extension 已解析形状同款)。
  const defaultConfig: Partial<ExecutorDagConfig> = {
    ...resolveEngineModels(env),
    agentRunner,
    commandRunner,
    ...deps.configOverrides,
  };

  return [
    ...createDagTools({ engine, runRegistry, cwd, defaultConfig }),
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
  ];
}
