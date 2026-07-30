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
 *   - fleet 五工具: createFleetTools (dag_review/slim/deepen/debug 异步子进程 + dream_consolidate 同步泵;
 *     spawn 接缝默认 Bun.spawn, dream 接缝注入; runRegistry/cwd 同现有)。
 *   - runs 工具: createRunsTools (dag_runs 同步列表: 内存 registry ∪ 磁盘 continuity 合并去重)。
 *
 * 可测: 全部 deps 可选覆盖 (测试传 fake 引擎/内存记忆/fake research, 零网络零磁盘)。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { OmdMcpTool } from './server';
import { RunRegistry } from './run-registry';
import { CheckpointManager } from '../harness/continuity/checkpoint-manager';
import { HudMirror } from '../hud/mirror';
import { createDagTools, type DagEngine } from './tools/dag-tools';
import { createMemoryTools } from './tools/memory';
import { createPathfinderTools, type PathfinderToolDeps } from './tools/pathfinder';
import { createDagResearchTool, type ResearchFanout } from './tools/research';
import { createGoalTool } from './tools/goal';
import { runGoal } from '../harness/goal/run-goal';
import { createFleetTools, type SpawnFn } from './tools/fleet';
import { effectiveFanout, resolveProviderCap } from '../harness/fleet';
import { createRunsTools } from './tools/runs';
import { createConfigTools } from './tools/config-tools';
import { createComposeTools } from './tools/compose';
import { createWebTools, createDistillTools } from './tools/web';
import { createPlansTool } from './tools/plans';
import { createModelRouterFromEnv } from '../harness/model-router';
import { createModelQueryExpander, createWebStackFromEnv, retrieveWeb } from '../harness/web';
import { researchWebFanout } from '../harness/research/web-fanout';
import type { ResearchLeafRunner } from '../harness/leaf-runners';
import { createModelSourceDistiller } from '../harness/web/distill-source';
import { createChallengerDistiller } from '../harness/web/distill-challenger';
import { createPlanLedger, type PlanLedger } from '../harness/plan-ledger';
import { createDagRecorder, type DagRecorder } from '../harness/dag-record';
import { createRunStore } from './run-store';
import { runExecutorDag, runExecutorDagWithPlan } from '../harness/executor-dag';
import type { ExecutorDagConfig } from '../harness/executor-dag-types';
import type { ConductorPlan } from '../harness/conductor-plan';
import { prunePass } from '../harness/plan-passes/prune-pass';
import { dedupPass } from '../harness/plan-passes/dedup-pass';
import { stampPass } from '../harness/plan-passes/stamp-pass';
import { evidencePass } from '../harness/plan-passes/evidence-pass';
import { loadAgentTemplates } from '../harness/agent-templates';
import { modelFamily } from '../model/channels';
import { isStrongCoord } from '../model/model-ratings';
import { assertSeatsUsable } from '../model/role-fallback';
import {
  resolveRoleModelConfigured,
  resolveMultimodalPool,
  resolveSeatThinking,
  resolveConfiguredPools,
  type OmdNode,
  type ThinkingLevel,
} from '../model/role-models';
import { createAgentLeafRunner } from '../harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../harness/command-leaf';
import type { AgentLeafRunner, CommandLeafRunner } from '../harness/leaf-runners';
import { createOmdMemory, type OmdMemory } from '../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../memory/safeguards/namespaces';
import {
  researchFanout as runResearchFanout,
  type ResearchFanoutResult,
  type ResearchLens,
} from '../harness/research/fanout';
import {
  DEFAULT_COUNCIL_DEEP_CRITERIA,
  DEFAULT_COUNCIL_DEEP_FRAMINGS,
  DEFAULT_COUNCIL_DEEP_LENSES,
} from '../harness/plan/best-of-n';
import { authorFanoutSpec } from '../harness/research/author-spec';
import { logger } from '../harness/logger';
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
  /** research-kind leaf 执行器 (默认 createDefaultResearchRunner: 真 web; 无 search key → 不挂)。 */
  researchRunner?: ResearchLeafRunner;
  /** engine config 追加覆盖 (在 env 角色矩阵解析结果之上, caller 显式指定优先)。 */
  configOverrides?: Partial<ExecutorDagConfig>;
  /** pathfinder 工具接缝覆盖 (测试传 fake executeSlice/dispatchFrontier)。 */
  pathfinder?: Partial<Pick<PathfinderToolDeps, 'executeSlice' | 'dispatchFrontier'>>;
  /** fleet spawn 接缝 (测试注入 fake; 生产默认 Bun.spawn)。 */
  spawn?: SpawnFn;
  /** dream pump 接缝 (dream_consolidate; 省略 → 该工具回 isError 不炸)。 */
  dream?: DreamPump;
  /** plan-memory 账本接缝 (测试注入 :memory:; 默认 .omd/plan-ledger.db)。 */
  ledger?: PlanLedger;
  /** DAG 运行留痕接缝 (测试注入 :memory:; 默认 .omd/dag-runs.db)。 */
  recorder?: DagRecorder;
}

/**
 * engine config 的模型三件套 —— **全部经单一 resolver** (INV-MODEL-1, P0 2026-07-28)。
 *
 * 此前这里是第 5 套并行解析器: OMD_ITER_* > OMD_RUNTIME_* > config。那个序把 env 排在 config
 * **之上**, 于是"改了 .omd/config.json 却还是老 conductor" —— 同一个座位在引擎路与 dag_run 路
 * 解出两个答案。现在 OMD_ITER_* 是座位链里的 env 别名、OMD_RUNTIME_* 是 defaultModel 层,
 * 两条路同解。resolveNode 仍可注入 (测试)。
 *
 * @throws {SeatUnresolvedError} conductor/leaf/agent 任一座位一层都没配 (INV-MODEL-5 计划期响亮失败)。
 */
export function resolveEngineModels(
  env: NodeJS.ProcessEnv,
  resolveNode: typeof resolveRoleModelConfigured = resolveRoleModelConfigured,
): {
  conductorModel: string;
  leafModel: string;
  agentLeafModel?: string;
} {
  return {
    conductorModel: resolveNode('conductor', { env }).model,
    leafModel: resolveNode('leaf', { env }).model,
    agentLeafModel: resolveNode('agent', { env }).model,
  };
}

/** 生产 memory 接缝 (tui 默认同款): OMD_MEMORY_PATH ?? .omd/memory.db + UNIVERSAL_SAFEGUARD。 */
function createDefaultMemory(env: NodeJS.ProcessEnv): OmdMemory {
  const memoryPath = env.OMD_MEMORY_PATH ?? '.omd/memory.db';
  mkdirSync(dirname(memoryPath), { recursive: true });
  return createOmdMemory({ path: memoryPath, safeguard: UNIVERSAL_SAFEGUARD });
}

/**
 * 生产 research **节点**执行器 (D-6, P1): `executor:'research'` 节点经此跑 —— **真 web**
 * (researchWebFanout: 检索 → 抓正文 → 蒸馏 → 多镜头扇出判优), 不是 dag_research 那条纯模型档。
 *
 * 为什么不复用 agent 节点带 web 工具: agent 节点的 `DEFAULT_EXTENSION_DIRS=[]` 没有 web,
 * 拿到的"引用"来自模型记忆 = 假 grounded (本 SDD D-6 的实证)。
 *
 * 无搜索 provider (零 TAVILY/ANYSEARCH/SEARXNG) → 返 undefined = **不挂 runner**,
 * research 节点因此响亮失败, 而不是静默退化成没有 web 的 leaf。
 */
export function createDefaultResearchRunner(deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 测试注入 (默认真 researchWebFanout)。 */
  _webFanout?: typeof researchWebFanout;
  /** 测试注入 (默认真 createWebStackFromEnv)。 */
  _webStack?: typeof createWebStackFromEnv;
}): ResearchLeafRunner | undefined {
  const { cwd, env } = deps;
  const stackFn = deps._webStack ?? createWebStackFromEnv;
  const fanoutFn = deps._webFanout ?? researchWebFanout;
  let stack: ReturnType<typeof createWebStackFromEnv>;
  try {
    stack = stackFn(env);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "[omd/mcp] 无 search provider → executor:'research' 节点不可用 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL)",
    );
    return undefined;
  }
  return async (input) => {
    const runId = randomUUID();
    const res = await fanoutFn(stack, input.question, {
      // council: 按问题自适应出镜头 (分解器职责); 显式 false = 固定档单维, 省一次 conductor 调用。
      council: input.council !== false,
      // deep 档: 种子作者化 (3-4 个互补角度各自检索) —— dag_research 的 super 旗标落到这里。
      ...(input.deep ? { authorSeeds: true, mode: 'aggregate' as const } : {}),
      conductorModel: resolveRoleModelConfigured('conductor', { env }).model,
      lensModel: resolveRoleModelConfigured('lens', { env }).model,
      reasonModel: resolveRoleModelConfigured('reason', { env }).model,
      expander: createModelQueryExpander({}),
      distiller: createModelSourceDistiller({}),
      // 内环的界 (INV-GOAL-4): 调用方给多少跑多少, 缺省单轮; schema 已钳 ≤4。
      rounds: input.rounds ?? 1,
      // 仓内腿默认开: research 的 leaf 是 inproc 看不见仓库, 轮间那次确定性检索是
      // "这个在我们仓里怎么实现的"唯一能落地的地方。
      repoCwd: cwd,
      ...(input.k ? { k: input.k } : {}),
      ...(input.groundTruth ? { anchors: [{ label: '上游节点产出', text: input.groundTruth }] } : {}),
      onWarn: (m: string) => logger.warn({ warn: m }, '[omd/research-node]'),
    });
    // INV-GOAL-2 的证据面 = **真抓到正文的** URL (搜到但没抓下来的不算痕迹)。
    // 三个来源都要算 —— 只数主检索会把多轮档的证据漏掉大半:
    //   ① 主检索  ② 种子 query 各自的检索 (deep 档)  ③ 轮 2+ 的 probe 补抓 (secondPass.probedUrls,
    // 那批是"上一轮冠军引用了但没读过"的缺料, 恰恰是多轮研究**新增**的证据)。
    const bodied = (r: { sources: { url: string; body?: string }[] }): string[] =>
      r.sources.filter((x) => x.body).map((x) => x.url);
    const sources = [
      ...new Set([
        ...bodied(res.retrieval),
        ...(res.seedRetrievals ?? []).flatMap(bodied),
        ...res.fanout.secondPass.flatMap((sp) => sp.probedUrls),
      ]),
    ];
    const reportDir = join(cwd, '.omd', 'research');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${runId}.md`);
    // 报告里把轮次留痕摊开 (哪一轮补了什么缺口、抓了哪几条) —— 多轮档的"第二轮到底干了什么"
    // 不该只活在日志里。
    const roundTrace = res.fanout.secondPass.length
      ? `\n## 轮次留痕 (共 ${res.fanout.roundsRun} 轮)\n\n${res.fanout.secondPass
          .map(
            (sp) =>
              `### 第 ${sp.round} 轮\n缺口: ${sp.gaps.map((g) => g.key).join(' · ') || '(无)'}\n补抓 (web): ${sp.probedUrls.map((u) => `\n  - ${u}`).join('') || ' (无)'}\n命中 (仓内): ${(sp.repoHits ?? []).map((h) => `\n  - ${h}`).join('') || ' (无)'}`,
          )
          .join('\n\n')}\n`
      : '';
    writeFileSync(
      reportPath,
      `${renderResearchReport(input.question, runId, res.fanout)}${roundTrace}\n## 来源 (真抓到正文)\n\n${sources.map((u) => `- ${u}`).join('\n')}\n`,
    );
    // usage = 整轮各模型 in/out 之和 (账本口径与 leaf 一致 —— 一个 research 节点是几十次调用)。
    const usage = Object.values(res.fanout.costStats.perModel).reduce(
      (acc, m) => ({ in: acc.in + m.in, out: acc.out + m.out }),
      { in: 0, out: 0 },
    );
    return { text: res.fanout.final, usage, sources, reportPath };
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
 * 装配 v1 全工具面: dag_run/dag_run_plan/dag_status/dag_result + dag_research +
 * memory_recall/memory_remember + dag_review/dag_slim/dag_deepen/dream_consolidate + dag_runs +
 * config 工具族 (omd_set_key/omd_apply_preset/omd_set_role/omd_config_status/omd_toggle_hud)。
 * 纯组装: 解析 deps → 调各工厂 → 拍平返回。
 */
export function assembleOmdMcpTools(deps: AssembleOmdMcpDeps = {}): OmdMcpTool[] {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const engine = deps.engine ?? PROD_ENGINE;
  // S2: registry 带上身份持久面 —— MCP server 是 stdio + 客户端消失即自杀, 「重启」是每次会话
  // 结束都发生的事。此前一重启就没人记得那个 runId 存在过 (而 checkpoint 一直在盘上), 于是
  // 「掉线了之后接着跑」缺的正是这一格。构造时 hydrate; 属主进程已死的 running 记录会被如实
  // 判成"被打断", 不会挂成一个永远在跑却没人跑它的幽灵。
  const runRegistry =
    deps.runRegistry ?? new RunRegistry(undefined, { store: createRunStore({ path: join(cwd, '.omd', 'runs.db') }) });
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
  // dag_research = **真 web** (与 executor:'research' 节点同一条管线, 不再有"纯模型档"分身)。
  // 此前这里是 createDefaultResearchFanout: groundTruth 直接等于 question, 零检索 —— 一个叫
  // research 的工具做的正是 D-6 判死的事 (拿模型记忆当调研)。无 search provider → 不挂 runner,
  // 工具响亮拒绝, 而不是静默降级成"看起来像调研的一段话"。
  const researchFanout: ResearchFanout =
    deps.researchFanout ??
    (async ({ question, council, super: superMode, k, rounds }) => {
      if (!researchRunner) {
        throw new Error(
          '[dag_research] 无 search provider → 没有 web 就没有调研 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL)。' +
            '要纯模型的多视角综合请用 dag_run, 别把它当调研。',
        );
      }
      const r = await researchRunner({
        question,
        ...(k ? { k } : {}),
        rounds: rounds ?? 1,
        ...(council === false ? { council: false } : {}),
        ...(superMode ? { deep: true } : {}),
      });
      return {
        runId: basename(r.reportPath ?? '', '.md'),
        reportPath: r.reportPath ?? '',
        summary: `${r.sources.length} 个来源真抓到正文\n${r.text.slice(0, 600)}`,
      };
    });
  // 长任务叶子超时: OMD_LEAF_TIMEOUT_MS 覆 240s 默认, 1h 兜底防泄漏 (session.abort 不杀子进程)。
  const leafTimeoutMs = (() => { const n = env.OMD_LEAF_TIMEOUT_MS ? Number.parseInt(env.OMD_LEAF_TIMEOUT_MS, 10) : NaN; return Number.isFinite(n) && n > 0 ? n : 3_600_000; })();
  const agentRunner = deps.agentRunner ?? createAgentLeafRunner({ cwd, hashlineEdit: true, leafTimeoutMs });
  const commandRunner =
    deps.commandRunner ??
    createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd, timeoutMs: 180_000 });
  // research 节点执行器 (D-6): web stack 带配额状态 → 装配期建一次复用 (同 router)。
  // 无 search provider → undefined = 不挂 → research 节点响亮失败 (见 createDefaultResearchRunner)。
  const researchRunner = deps.researchRunner ?? createDefaultResearchRunner({ cwd, env });

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
  // B-2 bandit 选型路由 (2026-07-21 MCP 接线 — 此前只 TUI 有, MCP 路径 dag_run 恒静态):
  // env pool (OMD_ROUTER_POOL_*) / config.multimodalPool ≥2 才真学; 未配 → no-op = 静态 (零回归)。
  // reward = leafCostReward (成本主信号, 质量走 verifier 闸) — 见 model-router ROUTER-5。
  const router = createModelRouterFromEnv(env);
  /**
   * engine config 基座 —— **每个 run 重算** (INV-MODEL-3 无 boot 冻结)。
   *
   * 这一段刻意住在函数里而不是装配期常量: MCP server 是长驻进程 (D-9), 装配期算一次就把座位/池
   * 冻在 boot 那一刻 —— `omd_set_role` / `omd models auto` 改完 config, 下一次 dag_run 仍用旧座,
   * 得杀进程重连才生效 (P0 前的真实症状)。router (bandit, 有状态) 与两个 runner 留在外面复用。
   */
  const buildDefaultConfig = (): Partial<ExecutorDagConfig> => {
    // engine config = 座位三件套 (conductor/leaf/agent, 单一 resolver) + 真改文件 runner 对。
    const models = resolveEngineModels(env);
    // 并发默认接 fleet 层 (此前断路 = 引擎全宽): min(effectiveFanout(env OMD_MAX_FANOUT/CPU 兜底),
    // agent 模型 provider 的并发池 cap)。工具参数 maxFanout 仍最高优先 (dag-tools 内覆盖)。
    const agentProvider = (models.agentLeafModel ?? models.leafModel ?? '').split(':')[0] ?? '';
    const defaultMaxFanout = Math.max(
      1,
      Math.min(effectiveFanout({}, env), agentProvider ? resolveProviderCap(agentProvider) : Number.MAX_SAFE_INTEGER),
    );
    // SDD v2 pass 管线接线 (顺序钉死 prune → dedup → stamp; 日志在接线层 — INV-8 pass 纯函数零 IO)。
    // S3 四池: strong=判/证, mid=执行主力, cheap=探索/机械, multimodal=多模态尺子 — 从 role 配置
    // 组装 (auto-assign 落的 .omd/config.json 经 resolveRoleModelConfigured 读)。裸 provider 坐标
    // (无 ':') 过滤掉 (stamp 要精确坐标); 池空 → stamp 恒等 (INV-9 配置不全零回归)。
    const roleCoord = (n: OmdNode): string => resolveRoleModelConfigured(n, { env }).model;
    const uniqCoords = (xs: string[]): string[] => [...new Set(xs.filter((x) => x.includes(':')))];
    // 显式池 (config.pools) 优先; 每档独立回落座位推导。座位推导下 mid/cheap 会恒等 (六个 worker
    // 座位同一个坐标) —— 想让 tier:'cheap' 真的便宜、想让 sibling 跨家族分散有对象, 就得显式配池。
    const cfgPools = resolveConfiguredPools();
    const stampPools = {
      strong: cfgPools.strong ?? uniqCoords([roleCoord('judge'), roleCoord('reason'), roleCoord('verifier')]),
      mid: cfgPools.mid ?? uniqCoords([roleCoord('leaf'), roleCoord('agent'), roleCoord('overflow')]),
      cheap: cfgPools.cheap ?? uniqCoords([roleCoord('lens'), roleCoord('expand'), roleCoord('distill')]),
      multimodal: cfgPools.multimodal ?? resolveMultimodalPool(),
      ...(cfgPools.multimodalStrong ? { multimodalStrong: cfgPools.multimodalStrong } : {}),
    };
    // 来源留痕 (2026-07-29): pools 是**第三条轴** —— 显式配的档位完全不问座位, env / --*-model /
    // config.models 都覆盖不了它。此前无任何读数, 只能靠 [cost] 行反推实际跑了谁 (实测踩过:
    // 12 个 OMD_* + 5 个旗标全设了却一个没生效, 因为叶子走的是 pools 不是座位)。
    logger.info(
      {
        strong: cfgPools.strong ? 'config.pools' : '座位推导',
        mid: cfgPools.mid ? 'config.pools' : '座位推导',
        cheap: cfgPools.cheap ? 'config.pools' : '座位推导',
        multimodal: cfgPools.multimodal ? 'config.pools' : '座位推导',
        coords: stampPools,
      },
      '[omd/mcp] stamp 池来源 — 标 config.pools 的档位**不经过座位链**, 座位覆盖对它无效',
    );
    const planFilters: Array<(p: ConductorPlan) => ConductorPlan> = [
      (p) => {
        const { plan, pruned } = prunePass(p);
        if (pruned.length) logger.info({ pruned }, '[omd/mcp] prune pass: 剪除死节点 (D-2/4v2)');
        return plan;
      },
      (p) => {
        const { plan, merged } = dedupPass(p);
        if (Object.keys(merged).length) logger.info({ merged }, '[omd/mcp] dedup pass: 语义指纹去重 (D-20)');
        return plan;
      },
      // S2 证据闸 (SDD 2026-07-25 skills-compile-evidence-gate)。**排在 stamp 之前**是刻意的:
      // 本 pass 会新增节点, 排在 stamp 后补挂的 attach_media 审查 leaf 拿不到多模态池模型 = 白补
      // (回流修正 SDD 的「链尾」写法, 理由见 evidence-pass.ts 文件头)。卡按调用时刻读盘 (与执行器同源)。
      (p) => {
        const { plan, patched, noCardHits, shape } = evidencePass(p, { templates: loadAgentTemplates({ root: cwd }) });
        if (patched.length) logger.info({ patched }, '[omd/mcp] evidence pass: 补挂 ui-pixels 证据链 (S2/D-2)');
        // D-11 挖矿日志: (goal, 图形状指纹, 无卡命中) —— S4 图形状挖矿与卡自扩的前置数据。
        // 三元组的 oracle 结果那一半在执行完成后由 run 汇总记 (规划期拿不到)。
        logger.info({ goal: plan.name, shape, noCardHits }, '[omd/mcp] evidence pass: 图形状指纹 (D-11 挖矿信号)');
        return plan;
      },
      (p) => {
        // templateHasModel: 卡真钉了模型才让 stamp 让路 (卡没钉 → 照常按 tier 选池, 否则 tier 是哑弹)。
        const tpls = loadAgentTemplates({ root: cwd });
        const { plan, stamped } = stampPass(p, {
          pools: stampPools,
          familyOf: modelFamily,
          templateHasModel: (name) => Boolean(tpls.get(name)?.model),
        });
        if (Object.keys(stamped).length) logger.info({ stamped }, '[omd/mcp] stamp pass: node.model 计划期分配 (D-16/17/22)');
        return plan;
      },
    ];
    // D-23 per-channel 并发闸: OMD_CHANNEL_FANOUT="mimo=8,opencode-go=4" (provider 前缀=并发上限)。
    const channelFanout: Record<string, number> = {};
    for (const pair of (env.OMD_CHANNEL_FANOUT ?? '').split(',')) {
      const [k, v] = pair.split('=');
      const n = Number.parseInt(v ?? '', 10);
      if (k?.trim() && Number.isFinite(n) && n > 0) channelFanout[k.trim()] = n;
    }
    // S-P conductor prompt 档位随**座位模型档**分派 (SDD 2026-07-25 S-P; 2026-07-25 A/B eval 裁决:
    // k3 上 full/lean 同分 1.000/1.000 且 firstShot 全过, lean 少 25% leaf token → 强 conductor 撤
    // 教练段 = harness 退役测试, 弱 conductor 保 full)。
    // 此前这里硬编码 `startsWith('kimi-coding:')` —— conductor 座 2026-07-25 已换 gpt-5.6-sol,
    // 那条判据当天就失效了 (SOTA 座位在吃给弱模型写的教练段)。改成按 AA intelligence 查档,
    // 换座位自动跟着走, 不用记得改这一行。
    //
    // maxTokens **不并进这张表** —— 它是另一根轴 (provider 的输出上限能力, 32768 只在 kimi 系实测过;
    // deepseek 系 ~8k 硬顶)。把"prompt 要不要教练段"和"能吐多少 token"混成一个条件是两次埋雷。
    const strongConductor = models.conductorModel ? isStrongCoord(models.conductorModel) : false;
    const conductorTuning: Partial<ExecutorDagConfig> = {
      ...(strongConductor ? { conductorPromptProfile: 'lean' as const } : {}),
      ...(models.conductorModel?.startsWith('kimi-coding:') ? { conductorMaxTokens: 32768 } : {}),
    };
    // S-T 座位推理档 (坐标 → 档): auto-assign 把「模型 + 推理档」成对落盘, 执行期按节点已钉的坐标反查。
    // 不在此加缓存 —— 底层 fileConfig 已按 mtime 缓存, 自己再存一层会在 `omd models auto` 重写 config
    // 后拿着旧档不放 (daemon 长活)。config 无该段 → 恒 undefined → 执行器回落原默认, 老 config 零变化。
    const seatThinking = (coord: string): ThinkingLevel | undefined => resolveSeatThinking(coord);
    const defaultConfig: Partial<ExecutorDagConfig> = {
      ...models,
      seatThinking,
      maxFanout: defaultMaxFanout,
      ...(Object.keys(kindFanout).length ? { kindFanout } : {}),
      agentRunner,
      commandRunner,
      ...(researchRunner ? { researchRunner } : {}),
      router,
      planFilters,
      // D-8v2: judge/parallel/tournament 的 attempts 候选池 = mid 执行主力池 (跨家族轮转)。
      ...(stampPools.mid.length >= 2 ? { primitiveCandidates: stampPools.mid } : {}),
      ...(Object.keys(channelFanout).length ? { channelFanout } : {}),
      ...conductorTuning,
      ...deps.configOverrides,
    };
    return defaultConfig;
  };

  // omd-hud 活体镜像: DAG 进度 (dag.json) + pathfinder 迷雾 (fog.json) 原子写 .omd/hud/,
  // statusline (scripts/omd-hud.ts) 数据源。dag + pathfinder 工具共用一个实例 (同 repoRoot)。
  const hudMirror = new HudMirror(cwd);

  // plan-memory Phase A 账本 (SDD 2026-07-21): 每个完成 run 记 family/版本/战绩, 纯记账零行为改变。
  // 证据门 (issue #10, 2026-08-11): omd_plans 显示任一 family runs≥3 ∧ ok率≥0.8 → 开 Phase B 召回闸。
  const ledger = deps.ledger ?? createPlanLedger({ path: join(cwd, '.omd', 'plan-ledger.db') });

  // DAG 运行留痕 (2026-08-02 接线): 每张跑完的图落 {拓扑层, 每节点 kind/status/deps, conductor+leaf
  // token, cacheHit} 进 `.omd/dag-runs.db`。**此前它只挂在 TUI 侧的 /cg /audit /iterate 上** ——
  // MCP 这条从来没接过, 于是生产路径上那个库恒空, 「一次 goal 多少钱」(上线闸 G3) 与「兄弟节点吃到
  // 多少前缀缓存」两个问题都查不到数据源, 而记录器本身早就写好了。
  const recorder = deps.recorder ?? createDagRecorder({ path: join(cwd, '.omd', 'dag-runs.db') });

  return [
    // continuity 恒开 (D-3): checkpoint 落 <cwd>/.omd/continuity/<runId>/, dag_run_plan resume 可续。
    ...createDagTools({ engine, runRegistry, cwd, defaultConfig: buildDefaultConfig, continuity: { manager: new CheckpointManager(cwd), repoRoot: cwd }, hudMirror, ledger, recorder }),
    createDagResearchTool(researchFanout),
    // 自主 goal 环 (P1 / INV-GOAL-1): buildDefaultConfig 传 thunk = 每次调用重解座位 (INV-MODEL-3)。
    // continuity 同 dag_run 恒开: 内层节点 checkpoint + **外层轮 journal** (INV-P2-6),
    // dag_goal resume=<runId> 才接得回轮次/毒集/复用源。
    createGoalTool({
      runGoal,
      runRegistry,
      cwd,
      buildConfig: buildDefaultConfig,
      continuity: { manager: new CheckpointManager(cwd), repoRoot: cwd },
      // 活体进度/HUD 与 dag_run 同一条线 (2026-07-30 补: goal 这条从 P1 起就漏了)。
      hudMirror,
      // 运行留痕与 dag_run 同一个实例 (2026-08-02 补: 与上面那条同一个形态的漏)。
      recorder,
    }),
    ...createMemoryTools({ memory, cwd }),
    // pathfinder 六件套 (TUI-less 决策地图: map/add/tickets/rule/deliver/prefetch, pull 式回流)。
    ...createPathfinderTools({
      cwd,
      env,
      models: resolveEngineModels(env),
      agentRunner,
      commandRunner,
      hudMirror,
      // 裁决增益: path_rule 成功后经同款 OmdMemory 写 omd.pattern fact (memory_recall 消费端可召回)。
      memory,
      ...deps.pathfinder,
    }),
    // fleet 四工具: review/slim/deepen 异步子进程 + dream_consolidate 同步泵。
    ...createFleetTools({ runRegistry, cwd, spawn: deps.spawn, dream: deps.dream }),
    // runs 工具: 内存 registry ∪ 磁盘 continuity 合并列表。
    ...createRunsTools({ runRegistry, cwd }),
    // config 工具族: set_key/apply_preset/set_role/config_status/toggle_hud (omd init 的 MCP 面, 即时生效)。
    ...createConfigTools({ cwd, router }),
    // 组合模式入口 (2026-07-26): 原语与图式递到图外, 让外部 SOTA agent 不必先出图就能用引擎能力。
    // runPlan 走同一条 runExecutorDagWithPlan —— 零新执行路径, stamp/闸/checkpoint 全部照旧。
    // omd_distill 不依赖 web provider (吃调用方给的文本) → **无条件挂**。
    ...createDistillTools({
      distill: async (lens, input) =>
        (lens === 'challenger' ? createChallengerDistiller() : createModelSourceDistiller())(input),
    }),
    // omd_web 要 search provider; 无则不挂 (与 TUI 同款优雅跳过, 不崩 boot)。
    ...(() => {
      try {
        const stack = createWebStackFromEnv(env);
        return createWebTools({
          cwd,
          retrieve: (query, o) => retrieveWeb(stack, query, o as Parameters<typeof retrieveWeb>[2]) as never,
        });
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[omd/mcp] 无 search provider → omd_web 不挂 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL 启用)');
        return [];
      }
    })(),
    ...createComposeTools({
      runPlan: (plan, config) =>
        engine.runExecutorDagWithPlan(plan, config as unknown as Parameters<typeof runExecutorDagWithPlan>[1]),
      baseConfig: () => buildDefaultConfig() as Record<string, unknown>,
    }),
    // plan-memory 账本可观测 (Phase A 证据门仪表, issue #10)。
    createPlansTool(ledger),
  ];
}
