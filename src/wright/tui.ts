/**
 * wright 终端前端 (V2.0 ControllerSkeleton 交付物) —— 交互式 wright on MiMo, 带灵魂。
 *
 *   bun run wright                 # 交互式 TUI, MiMo + wright 身份
 *   bun run wright -p "<task>"     # print 模式 (pi 原生 -p), 单轮非交互
 *   bun run wright --model <p>/<m> # 覆盖 baked MiMo (透传 pi 的 model 选择)
 *
 * 机制 (SDD §4 V2.0): 包 pi-coding-agent 的 main(), 注入两样东西 —
 *   ① ctrl.toExtensionFactories() → 灵魂经 before_agent_start append 进每轮 systemPrompt (唯一干净注入口)。
 *   ② ctrl.toModelArgs()          → `--provider/--model` 透传部署默认模型 (用户未显式指定时才注入)。
 * **不 bake 任何模型** (the owner 锁): 模型来自 env (XIHE_RUNTIME_*) 或部署默认, controller 缺则抛错。
 * 灵魂 + tool 闸 + 经济层 hooks 后续都挂在 WrightController 字段上, 此前端不变。
 */
import { main } from '@earendil-works/pi-coding-agent';
import { WrightController } from './controller';
import { ensureMimoApiKey } from './mimo-env';
import { createCgAuditExtension } from './cg-audit-extension';
import { createIterateExtension } from './iterate-extension';
import { resolveVerification } from './verifier';
import { createModelRouterFromEnv } from './model-router';
import { createPlanExtension } from './plan';
import { createHashlineExtension } from './hashline';
import { createConfigExtension } from './config-extension';
import { createMcpStackFromConfig, createOutputSandboxExtension, createOutputStore } from './mcp';
import { createWebStackFromEnv, createWebExtension } from './web';
import { fetchWithFallback } from './web/web-extension';
import { CleaningFetchProvider } from './web/clean';
import { createCodeExtension, type ToolMap } from './code';
import { createCostExtension } from './cost-extension';
import { logger } from '../logger';
import { registerProvidersFromEnv } from '../model/providers';
import { resolveHashlineEdit } from './tui-config';
import { readUserProfile, DEFAULT_USER_PROFILE_PATH } from './user-profile';
import { createWrightMemory } from './memory';
import { createPruneScheduler } from './memory/prune-scheduler';
import { createMemoryExtension } from './memory-extension';
import { createRecallExtension } from './recall-extension';
import { SkillRegistry } from './skills/registry';
import { syncSkillsToRegistry } from './skills/scanner';
import { createSkillFlywheelExtension } from './skills/flywheel-extension';
import { createSkillMiner } from './skills/skill-miner';
import { createSkillMineScheduler } from './skills/skill-mine-scheduler';
import { createBehavioralGroundingExtension } from './behavioral-grounding-extension';
import { createGroundingGateExtension } from './weak';
import { createEventStore } from './learning/event-store';
import { createSignalBus } from './learning/signal-bus';
import { createDreamPump } from './learning/dream-pump';
import { createDreamPumpScheduler } from './learning/pump-scheduler';
import { createConfidenceScheduler } from './learning/confidence-scheduler';
import { createToolFailureSignalExtension } from './learning/tool-failure-signal';
import { createUserCorrectionSignalExtension } from './learning/user-correction-signal';
import { LiveDreamModel } from '../dream/model-live';
import { UNIVERSAL_SAFEGUARD } from '../memory/safeguards/namespaces';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// wright 的对话模型 (= 你在 TUI 里对话的主 agent / 设计大脑, **不是** executor leaf —— leaf 模型
// per-dispatch 在 fleet/executor-dag 选)。**不 bake 任何模型** (the owner 锁): 纯跟 env (XIHE_RUNTIME_*)
// 走; 缺则 WrightController 构造抛错 (fail-fast, 提示设 env)。OUR 部署默认落 .env (照 .env.example 设)。
const envProvider = process.env.XIHE_RUNTIME_PROVIDER;
const envModel = process.env.XIHE_RUNTIME_MODEL;

// 用户没显式选模型 (--model / --provider) 才注入 env 默认 flags; 否则尊重用户覆盖。
const userArgs = process.argv.slice(2);
const userPickedModel = userArgs.includes('--model') || userArgs.includes('--provider');

// 用户静态档案 (user.md): 部署入口读文件, 传 controller 整段注入 (controller 保持纯不读盘)。
const userProfile = readUserProfile(process.env.XIHE_USER_PROFILE ?? DEFAULT_USER_PROFILE_PATH);

// 复利自学习闭环 (Phase 0): runtime 信号持久层 + 总线。drift-detector 检出 spinning → onSpinning
// → bus.emit → runtime_events SQLite。dream-pump (下方, 需 memory) 增量 consolidate 成 wright.* fact。
// 路径 XIHE_RUNTIME_EVENTS_PATH (默认 .wright/runtime-events.db); 与 memory.db 同目录但独立表空间。
const eventStore = createEventStore({ path: process.env.XIHE_RUNTIME_EVENTS_PATH ?? '.wright/runtime-events.db' });
const signalBus = createSignalBus(eventStore);
const runtimeSessionId = `tui-${process.pid}`;

// 抗幻觉 grounding 软提示 = 通用 (model-agnostic), 由 controller 默认挂, 此处无需门控。
// 交互 wright 显式开 drift-detector (元认知安全网, opt-in 非全局默认 — 见 hooks/index.ts)。
// onSpinning: 检出 spinning → 发 drift_stuck 信号给 bus (复利自学习入口, 学成 wright.limit blindspot)。
// onRecovered: 卡住后打破循环继续推进 → 发 hard_problem 信号 (producer #5, clean_completion/hard_problem
//   的正解): 难题已解开, payload 带 {卡在什么, 怎么逃出} → dream 学成 wright.pattern (worked 食材喂 miner)。
const ctrl = new WrightController({
  provider: envProvider,
  model: envModel,
  userProfile: userProfile ?? undefined,
  hookConfig: {
    driftDetector: {
      onSpinning: ({ sig, sameCount }) =>
        signalBus.emit({ sessionId: runtimeSessionId, type: 'drift_stuck', payload: { sig, sameCount } }),
      onRecovered: ({ stuckSig, escapeSigs }) =>
        signalBus.emit({ sessionId: runtimeSessionId, type: 'hard_problem', payload: { stuckSig, escapeSigs } }),
    },
  },
});

// env 桥: MIMO_API_KEY → pi-ai 期望的 XIAOMI_TOKEN_PLAN_AMS_API_KEY (仅 ams region key)。
ensureMimoApiKey(ctrl.provider);

// 注册 callModel 的 provider (mimo + deepseek from env) → /cg /audit 的 conductor/inproc-leaf 可解析。
registerProvidersFromEnv();

// 跨模型校验 + conductor 静默升级 (verifier.ts)。verifier 默认 resolveRoleModel('verifier')=deepseek
// (跨 conductor 避盲点); 升级模型 = XIHE_CONDUCTOR_ESCALATION_MODEL (没设 / provider 未注册 → 不升级,
// 维持弱 conductor —— the owner: 没配 SOTA API 就维持弱)。XIHE_VERIFY=0 全关。
const verification = resolveVerification({ enabled: process.env.XIHE_VERIFY !== '0' });

// B-2 executor 选型 bandit: 从 XIHE_ROUTER_POOL_INPROC/AGENT 读候选池 (逗号分隔, pool[0]=静态默认)。
// 未配 pool → no-op = 静态 (零回归)。配 ≥2 模型 → ε-greedy 学 + verifier reward 回更, .wright/model-router.db 持久。
const router = createModelRouterFromEnv();

// /cg /audit slash 命令 (cgRetrieve/secAudit 封装 + dag-record 留痕)。模型 env 可覆盖, 默认 DeepSeek (全可靠)。
const cgAuditExt = createCgAuditExtension({
  conductorModel: process.env.XIHE_CG_CONDUCTOR_MODEL ?? 'deepseek:deepseek-v4-flash',
  leafModel: process.env.XIHE_CG_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash',
  agentLeafModel: process.env.XIHE_CG_AGENT_MODEL ?? 'deepseek:deepseek-v4-flash',
  verification,
  router,
});

// /iterate slash 命令 (内层 DAG 外层 fixpoint 迭代: 跑→评→重画 直到收敛 + dag-record 留痕)。
const iterateExt = createIterateExtension({
  conductorModel: process.env.XIHE_ITER_CONDUCTOR_MODEL ?? 'deepseek:deepseek-v4-flash',
  leafModel: process.env.XIHE_ITER_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash',
  agentLeafModel: process.env.XIHE_ITER_AGENT_MODEL ?? 'deepseek:deepseek-v4-flash',
  // 未收敛多轮 → 轮级升级 conductor (同 /cg /audit 的升级模型; 没配 / provider 未注册 → 维持弱)。
  conductorEscalationModel: process.env.XIHE_CONDUCTOR_ESCALATION_MODEL,
});

// plan mode (P1 脊柱): shift+tab 进只读审议座舱, 默认 deepseek-v4-pro xhigh (env 可覆盖)。交互-TUI 专属。
const planExt = createPlanExtension({
  planModel: process.env.XIHE_PLAN_MODEL ?? 'deepseek:deepseek-v4-pro',
});

// hashline-in-TUI (V2-TOOLS): 注入 hashline_read/hashline_edit + block 原生 edit。**默认全开**
// (不按模型门控): hashline 改文件是 model-independent 净赢 (省 token + 防 mismatch/腐烂 + 链式连编)。
// XIHE_HASHLINE_TUI=0 给偏好 native edit 的人显式关。
const hashlineTui = resolveHashlineEdit({ envValue: process.env.XIHE_HASHLINE_TUI });
const hashlineExt = hashlineTui ? [createHashlineExtension({ cwd: process.cwd() })] : [];

// wright 自我记忆接进 TUI (the owner): `remember` 工具 → ValalMemory(SQLite, 经 validateFactWrite 闸) +
// 存储 emoji notify + human_verified 弹窗。路径 XIHE_MEMORY_PATH (默认 .wright/memory.db)。
const memoryPath = process.env.XIHE_MEMORY_PATH ?? '.wright/memory.db';
mkdirSync(dirname(memoryPath), { recursive: true });
// UNIVERSAL_SAFEGUARD: TUI wright 自我记忆 domain-free — 只收 user.*/wright.*, 拒会计 client.* 等。
const memory = createWrightMemory({ path: memoryPath, safeguard: UNIVERSAL_SAFEGUARD });
const memoryExt = createMemoryExtension({ memory });
// recall: ValalMemory 混合检索工具 (与 remember 配对; 复用同一 memory 实例)。卡住先 recall (元认知)。
// onMiss: 零命中 = 记忆覆盖缺口 → recall_miss 信号 (复利自学习 producer #3, 闸门 I 白名单)。
const recallExt = createRecallExtension({
  memory,
  onMiss: (query) => signalBus.emit({ sessionId: runtimeSessionId, type: 'recall_miss', payload: { query } }),
});
// tool_failure 信号 (producer #2): pi tool_result isError = 工具契约层失败 → 可学教训。观测-only。
const toolFailureSignalExt = createToolFailureSignalExtension({
  onFailure: (info) => signalBus.emit({ sessionId: runtimeSessionId, type: 'tool_failure', payload: info }),
});
// user_correction 信号 (producer #4, 最高价值): input 文本启发式检出用户纠正 (精度优先, 保守)。观测-only。
const userCorrectionSignalExt = createUserCorrectionSignalExtension({
  onCorrection: (info) => signalBus.emit({ sessionId: runtimeSessionId, type: 'user_correction', payload: info }),
});
// TTL GC: session_start 软删 idle>30d 的 tentative fact (live wright.memory 唯一无界增长源)。
// confident/human 永不动; 刻意只 prune 不 dedup (近义 tentative 已被 TTL+confidence 生命周期覆盖)。
const pruneSchedulerExt = createPruneScheduler({ memory });

// 复利自学习闭环消费/驱动端 (复用同一 memory 实例):
//   ① dream-pump: agent_end 后增量 consolidate runtime 信号 → L2 wright.* fact (tentative)。dream 角色模型
//      经 resolveRoleModel('dream') 解析 (XIHE_DREAM_MODEL / .wright/config.json 可覆盖, 默认部署落 DeepSeek)。
//   ② behavioral-grounding: 每轮 context 检索 wright.* fact 注入行为 —— 置信路由隔离, 仅 agent_confident+
//      (tentative 排除: 单 session 学的 drift 不立刻驱动行为, 跨 session 复现升 confident 才注入)。
const dreamModel = new LiveDreamModel();
const dreamPump = createDreamPump({ store: eventStore, dream: dreamModel, memory, agentId: runtimeSessionId });
const pumpSchedulerExt = createDreamPumpScheduler({ pump: dreamPump });
// onGrounded: 留痕本轮注入的 confident fact identity → 熔断器 session 级归因 (升级后变坏可回滚)。
const behavioralGroundingExt = createBehavioralGroundingExtension({
  memory,
  onGrounded: (ids) => eventStore.recordGroundingApplied(runtimeSessionId, ids),
});
//   ③ confidence-scheduler: agent_end 后跑升级闸 (tentative→confident, 跨 session 复现的教训进 grounding)
//      + 熔断器 (升级后变坏回滚)。这是闭环"真闭"的开关 —— 没它 tentative 永不驱动行为。中道阈值 env 可调。
const confidenceSchedulerExt = createConfidenceScheduler({ memory, eventStore, sessionId: runtimeSessionId });

// grounding reactive 闸 (L2 硬闸的 reactive 半边, 配 GROUNDING_NUDGE 软提示): message_end 观测助手
// 输出, 无源法定数字按 severity 动作。**core 默认 EMPTY_LEXICON + 'annotate'** → domain-free inert,
// 通用部署不会因裸法定数字被拦。a sibling project 审计部署在自己入口注入 a sibling project + 'block'
// (+ D 的 RAG verifier), core tui 不 import domain 词表 (R5)。
const groundingGateExt = createGroundingGateExtension();

// skill 复利飞轮自驱动 (the owner 2026-06-03: 自动感知+暴露, 人只在 /skill-curate 最后确认):
//   route_hit 自动采集 (read SKILL.md → touchSkill) + session_start 暴露 optimize 建议 + /skill-curate 人工闸。
// 持久 substrate .wright/skills.db (XIHE_SKILL_DB 可覆盖); 启动 sync 项目 .claude/skills 给 baseline tier/desc。
const skillDbPath = process.env.XIHE_SKILL_DB ?? '.wright/skills.db';
mkdirSync(dirname(skillDbPath), { recursive: true });
const skillRegistry = new SkillRegistry({ path: skillDbPath });
try {
  syncSkillsToRegistry(process.env.XIHE_SKILLS_ROOT ?? '.claude/skills', { registry: skillRegistry });
} catch { /* 无 skills root 不阻断启动; route_hit 懒注册兜底 */ }
// 真 LLM episodic miner (Phase 2 闭环最后一段): agent_end 后挖已升 confident 的 wright.pattern → 起草候选
// skill 进 buffer; flywheel proposer 排空 buffer → 确认队 (起草→quarantine, 仍要人工确认 + eval 才启用)。
// 复用同一 memory (consolidated 层) + dream 角色模型 (起草轻量)。proposer 注入点见 flywheel SkillFlywheelOpts。
const skillMiner = createSkillMiner({ memory, registry: skillRegistry });
const skillMineSchedulerExt = createSkillMineScheduler({ miner: skillMiner });
const skillFlywheelExt = createSkillFlywheelExtension({
  registry: skillRegistry,
  proposer: () => skillMiner.takeCandidates(),
});

// /config (D60): 键盘选 daemon 角色模型 (dream/conductor/leaf) → 持久化 .wright/config.json
// (跨进程, daemon mtime 重读)。交互-TUI 专属, 不挂 headless agent-leaf。
const configExt = createConfigExtension();

// MCP 路由层 (D74 轴 A): 从 .wright/mcp-servers.json 装配 — 所有 MCP 收敛一个路由,
// LLM 只见菜单 + mcp_search/describe/call (完整 schema 藏隐藏索引), 加 MCP 不膨胀 context。
// `/mcp add` 运行中热加。空配置 (无文件) → 空栈, 仅注册 meta-tool + /mcp 命令 (无害)。
const { extension: mcpExt, router: mcpRouter } = await createMcpStackFromConfig();

// MCP 轴 B 输出沙箱 (D74): tool_result hook 拦任意工具 >8KB 输出 → 存 FTS5, 只指针进 context;
// ctx_execute (子进程跑代码只回 stdout) + ctx_search (拉沙箱大输出相关块)。路径 .wright/mcp-outputs.db。
const outputSandboxExt = createOutputSandboxExtension({ store: createOutputStore({ path: '.wright/mcp-outputs.db' }) });

// web 搜索/抓取栈 (commit 079137e): web_search (多 key 轮换/聚合) + web_fetch (firecrawl/jina + trafilatura)。
// 无 search key (TAVILY/ANYSEARCH) → createWebStackFromEnv 抛 (池要 ≥1 provider) → 优雅跳过, web 工具不挂, 不崩 boot。
let webExt: ReturnType<typeof createWebExtension> | null = null;
let webStack: ReturnType<typeof createWebStackFromEnv> | null = null;
try {
  webStack = createWebStackFromEnv();
  webExt = createWebExtension({ stack: webStack });
} catch (e) {
  logger.warn({ err: (e as Error).message }, '[wright/web] 无 search key → web 工具禁用 (设 TAVILY_API_KEY/ANYSEARCH_API_KEY 启用)');
}

// code mode (一回合多工具编排 + 数据密集活省 token): `code` 工具在隔离子进程跑模型代码, 只回 stdout。
// 经临时 localhost 桥把编排工具暴露给子进程: mcp_call (永远在, router 总建) + web_search/web_fetch (有 key 才挂)。
// 子进程另有 Bun 原生 fetch/std 库。无编排工具时 code 仍可用 (纯计算 + 原生 fetch)。
const codeTools: ToolMap = {
  mcp_call: async (args) => {
    const a = (args ?? {}) as { name?: string; args?: Record<string, unknown> };
    if (!a.name) throw new Error('mcp_call 需要 {name, args}');
    const res = await mcpRouter.call(a.name, a.args ?? {});
    return typeof res === 'string' ? res : JSON.stringify(res);
  },
};
if (webStack) {
  const stack = webStack;
  codeTools.web_search = async (args) => {
    const a = (args ?? {}) as { query?: string; k?: number; mode?: 'failover' | 'rotate' | 'aggregate' };
    if (!a.query) throw new Error('web_search 需要 {query}');
    const r = await stack.searchPool.search(a.query, a.k ?? 5, { mode: a.mode });
    return JSON.stringify(r.results);
  };
  codeTools.web_fetch = async (args) => {
    const a = (args ?? {}) as { url?: string; clean?: boolean };
    if (!a.url) throw new Error('web_fetch 需要 {url}');
    const provs = a.clean
      ? stack.fetchProviders.map((fp) => new CleaningFetchProvider(fp, stack.cleaner))
      : stack.fetchProviders;
    const { result } = await fetchWithFallback(provs, a.url);
    return result.title ? `# ${result.title}\n\n${result.text}` : result.text;
  };
}
const codeExt = createCodeExtension({ tools: codeTools });

// V2-ECON 计量回路 (B-1): /cost 看子编排模型花费/token + budget 闸。limit 来自 XIHE_BUDGET_USD (省略=无限额)。
// ledger 经 attachLedger 订阅 callModel 观察者 → conductor/leaf/fanout/cg-audit 花费自动记账。
const { extension: costExt } = createCostExtension({
  limitUsd: process.env.XIHE_BUDGET_USD ? Number(process.env.XIHE_BUDGET_USD) : undefined,
});

const args = userPickedModel ? userArgs : [...ctrl.toModelArgs(), ...userArgs];

await main(args, {
  extensionFactories: [
    ...ctrl.toExtensionFactories(),
    cgAuditExt,
    iterateExt,
    planExt,
    ...hashlineExt,
    memoryExt,
    recallExt,
    toolFailureSignalExt,
    userCorrectionSignalExt,
    pruneSchedulerExt,
    behavioralGroundingExt,
    pumpSchedulerExt,
    confidenceSchedulerExt,
    groundingGateExt,
    skillMineSchedulerExt,
    skillFlywheelExt,
    configExt,
    mcpExt,
    outputSandboxExt,
    ...(webExt ? [webExt] : []),
    codeExt,
    costExt,
  ],
});
