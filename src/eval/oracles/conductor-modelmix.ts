/**
 * conductor-modelmix —— ④ model-mix sweep spec (SDD D3, 2026-07-21)。
 *
 * 复刻 Cursor《agent-swarm economics》: 固定任务, 跑 {conductorModel × leafModel} 网格, 量
 * quality × cost, 读 knee。**单轮全网格 sweep** (非收窄 tournament, INV-4): 省 expand, 出整表。
 * measure 串行 (INV-1: 并行争 provider 限流污染读数); 内部重复 R 次取**中位** (LLM 非确定, 单发是噪音)。
 *
 * 2026-07-26 改造 (owner 指派, 五条):
 *   ① prompt 档进候选轴 (`--profiles full,lean`) —— 此前要 A/B prompt 只能改代码跑两次, 不可复现;
 *   ② score 换 firstShotPass —— finalPass 被 heal 拉饱和 (k3 的 full/lean 都是 1.000, 判据分不开);
 *   ③ fixture 默认 large —— medium 只有 3 模块, 早已饱和;
 *   ④ detail 加图形状三量 (depth / maxWidth / orphans) —— conductor 的产物是图, 而 prompt 里
 *      "wide and shallow"/"no consumer → don't build" 此前没有任何指标能量到;
 *   ⑤ R 默认 3 且报中位 + 附 spread —— token/墙钟是重尾, 均值会被单次长尾拽走。
 *
 * 消费: 经 fusang xihe-tournament.ts 跑 —
 *   bun run $FUSANG_HOME/scripts/xihe-tournament.ts src/eval/oracles/conductor-modelmix.ts \
 *     [--r 3] [--fixture large|medium] [--profiles full,lean] [--skip C1,C5]
 * default export = (opts) => TournamentSpec。leaderboard 全表读 cost-at-quality
 * (score 只为排序, 真信息在 detail; INV-4 不取单冠军)。
 */
import { $ } from 'bun';
// ⚠ 必须先注册 provider: inproc leaf 走 callModel, 而 callModel 的 registry 要 bootstrap 才有
// 'mimo'/'deepseek' 等自有 provider (kimi/openai-codex 走 pi 通道自注册, 所以只挂 inproc 那半边)。
// 2026-07-26 全栈首轮就是栽在这: contract 节点 (inproc) 抛 "provider 'mimo' not registered",
// 整张图级联 skip, 6 次跑全废 —— 而且 agent-leaf-prompt 的固定图里没有 inproc leaf, 所以从没暴露。
import { bootstrapModelRuntime } from '../../model/bootstrap';
import { runExecutorDag } from '../../harness/executor-dag';
import { createAgentLeafRunner } from '../../harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../../harness/command-leaf';
import { computeCost } from '../../model/cost-ledger';
import { scoreRun, type OracleProbe, type RunMetrics } from '../scorer';
import { createMediumFixture } from '../tasks/medium';
import { createLargeFixture } from '../tasks/large';

/** fixture 选择: medium (3 模块, 默认) | large (12 模块难度梯度, 高分辨率)。 */
type FixtureSize = 'medium' | 'large';
function fixtureFor(size: FixtureSize) {
  return size === 'large' ? createLargeFixture() : createMediumFixture();
}

/** 结构化子集 (避免跨仓 import fusang 的 TournamentSpec 类型; 字段与其一致)。 */
interface Candidate<C> { label: string; config: C; }
interface TournamentSpec<C> {
  name: string;
  seed(): Candidate<C>[];
  measure(c: Candidate<C>): Promise<{ score: number; detail?: unknown }>;
  direction?: 'max' | 'min';
  concurrency?: number;
  cooldownMs?: number;
  maxRounds?: number;
}

interface MixConfig {
  conductorModel: string;
  leafModel: string;
  /** conductor prompt 档 (2026-07-26 加轴)。省略 = 引擎按座位模型档自选 (S-P)。 */
  profile?: 'full' | 'lean';
}

/** 锁定的 4 格网格 (SDD D3; C1/C2/C3 固定 leaf=ds-flash 为干净 conductor 轴, C5 独立组合)。 */
/**
 * prompt 档 A/B 轴 (2026-07-26): 此前 grid 只有 {conductorModel × leafModel} —— 要 A/B prompt
 * 只能改代码跑两次, **不可复现**, 而 2026-07-25 的 full/lean 裁决正是这么做的。
 * 现在档位是候选的一维: `--profiles full,lean` 把每个模型格展开成两格, 同一轮 sweep 内对照。
 */
function withProfiles(grid: Candidate<MixConfig>[], profiles: Array<'full' | 'lean'>): Candidate<MixConfig>[] {
  if (profiles.length === 0) return grid;
  return grid.flatMap((c) =>
    profiles.map((profile) => ({ label: `${c.label} [${profile}]`, config: { ...c.config, profile } })),
  );
}

const GRID: Candidate<MixConfig>[] = [
  { label: 'C1 opus/ds-flash', config: { conductorModel: 'anthropic:claude-opus-4-8', leafModel: 'deepseek:deepseek-v4-flash' } },
  { label: 'C2 mimo-pro/ds-flash', config: { conductorModel: 'mimo:mimo-v2.5-pro', leafModel: 'deepseek:deepseek-v4-flash' } },
  { label: 'C3 ds-flash/ds-flash', config: { conductorModel: 'deepseek:deepseek-v4-flash', leafModel: 'deepseek:deepseek-v4-flash' } },
  // leaf 走 mimo-platform (models.json 正门, agent-leaf 唯一能用的 mimo 注册; 'mimo:' 只在 callModel/conductor 栈可用)。
  { label: 'C5 kimi-k3/mimo-platform-us', config: { conductorModel: 'kimi-coding:k3', leafModel: 'mimo-platform:mimo-v2.5-pro-ultraspeed' } },
];

const HEAL_TASK = (digest: string): string =>
  `修复以下验证错误。只改必要文件让 tsc/test 转绿, 不加新功能, 不改契约语义。\n\n===== 错误 =====\n${digest}`;

/** 在 worktree 里跑 oracle 命令闸 (INV-6: 客观分只来自 tsc+test, 不用 LLM verifier)。 */
function worktreeProbe(root: string, testPaths: string[]): OracleProbe {
  return {
    tsc: async () => {
      const r = await $`bun run tsc --noEmit`.cwd(root).nothrow().quiet();
      const out = r.stdout.toString() + r.stderr.toString();
      return out.split('\n').filter((l) => /error TS/.test(l) && !l.includes('node_modules'));
    },
    test: async () => {
      const r = await $`bun test ${testPaths}`.cwd(root).nothrow().quiet();
      return r.stdout.toString() + r.stderr.toString();
    },
  };
}

/** 主树里 `.omd` 外的脏文件集 (F1 泄漏护栏: eval 绝不能改 worktree 外的真源码)。 */
async function dirtyRealFiles(): Promise<Set<string>> {
  const out = await $`git status --porcelain`.nothrow().quiet();
  return new Set(
    out.stdout
      .toString()
      .split('\n')
      .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
      .filter((p) => p && !p.startsWith('.omd/')),
  );
}

/** 单次测量一个候选 (建 worktree → 跑 DAG+heal → 打分 → 算成本 → 清理)。 */
async function measureOnce(config: MixConfig, size: FixtureSize, leafTimeoutMs: number): Promise<RunMetrics & { costUsd: number; unpriced: boolean }> {
  const before = await dirtyRealFiles(); // F1 泄漏护栏: run 前基线
  const fx = await fixtureFor(size);
  try {
    // leafTimeoutMs: agent-leaf 硬 wall-clock 上界 (默认 240s 会掐死重建大模块的廉价叶 → 假 empty-done floor,
    // 2026-07-23 Nick 定: 廉价模型忠实执行长任务是设计前提, 除非空转不该掐; 0 = 不限)。命令叶 (tsc/test) 独立放宽到 10min。
    // sandboxRoot=fx.root: 事前 block 写穿 worktree (治 2026-07-23 隔离漏; F1 事后闸仍留作 bash 逃逸兜底)。
    const agentRunner = createAgentLeafRunner({ cwd: fx.root, hashlineEdit: true, leafTimeoutMs, sandboxRoot: fx.root }); // thinkingLevel 默认 xhigh
    const commandRunner = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: fx.root, timeoutMs: 600_000 });
    const dagConfig = {
      conductorModel: config.conductorModel,
      leafModel: config.leafModel,
      agentLeafModel: config.leafModel,
      agentRunner,
      commandRunner,
      maxFanout: 8,
      warmThenFanout: true,
      ...(config.profile ? { conductorPromptProfile: config.profile } : {}),
      oracleCmd: fx.oracleCmd,
      leafSystemPrefix: fx.spec,
    } as Parameters<typeof runExecutorDag>[1];

    const metrics = await scoreRun(fx.spec, { maxHeal: 1 }, {
      runDag: (task) => runExecutorDag(task, dagConfig),
      probe: worktreeProbe(fx.root, fx.testPaths),
      fixTaskFor: HEAL_TASK,
    });

    // F1 泄漏护栏: run 后主树若冒出新的 worktree 外真源改动 = leaf 逃出隔离改了真码 → 响亮报错、废读数。
    const leaked = [...(await dirtyRealFiles())].filter((p) => !before.has(p));
    if (leaked.length) {
      throw new Error(`[eval 泄漏] leaf 改了 worktree 外的真源码: ${leaked.join(', ')} — 废读数。\n` +
        `若你在 eval 运行期间编辑了本仓, 这是**误报** (护栏分不清 leaf 逃逸与人手编辑); ` +
        `纪律: eval 跑起来之后别碰工作树。真逃逸则 git checkout 还原。`);
    }

    // 成本: conductor + leaves 分别按坐标计价 (leaf 用量已含 agent 节点, 见 executor-dag:637 + B 修)。
    // F2: computeCost 对不在 DEFAULT_PRICES 的坐标 fail-open 返 costUsd=0 + unpriced=true —— 带出 unpriced,
    // 别让"没价"看着像"免费"(kimi-coding:k3 / mimo-platform:* 当前无价 → C5 的 $0 是假象)。
    const cc = computeCost({ in: metrics.usage.conductorIn, out: metrics.usage.conductorOut }, config.conductorModel);
    const lc = computeCost(
      { in: metrics.usage.leavesIn, out: metrics.usage.leavesOut, cacheHit: metrics.usage.leavesCacheHit },
      config.leafModel,
    );
    return { ...metrics, costUsd: cc.costUsd + lc.costUsd, unpriced: cc.unpriced || lc.unpriced };
  } finally {
    await fx.cleanup();
  }
}

/**
 * 聚合 R 次测量。**报中位不报均值** (2026-07-26): token / 墙钟是重尾分布 —— 实测同一模型同一设置
 * 下 completion token 在 183↔433 之间跳, 一次长尾就把均值拽走, 中位不受影响。
 *
 * **score = firstShotPass 而不是 finalPass** (2026-07-26): heal 会把强弱两边都拉到 1.000
 * (2026-07-25 的 k3 full/lean 就是 1.000 对 1.000, 判据自己饱和了)。conductor 的职责是**一次画对**,
 * 所以排序键取 heal 前的首刀过测率; finalPass 仍在 detail 里, 没丢。
 */
function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function agg(runs: Array<RunMetrics & { costUsd: number; unpriced: boolean }>): { score: number; detail: unknown } {
  const med = (f: (r: (typeof runs)[number]) => number) => median(runs.map(f));
  const unpriced = runs.some((r) => r.unpriced); // 任一坐标无价 → costUsd 被低估 (F2)
  return {
    score: med((r) => r.firstShotPass), // 排序键 = 首刀分解质量 (未被 heal 掩盖)
    detail: {
      runs: runs.length,
      firstShotPass: +med((r) => r.firstShotPass).toFixed(3),
      finalPass: +med((r) => r.finalPass).toFixed(3),
      healRounds: +med((r) => r.healRounds).toFixed(2),
      leafTokens: Math.round(med((r) => r.usage.leavesIn + r.usage.leavesOut)),
      conductorTokens: Math.round(med((r) => r.usage.conductorIn + r.usage.conductorOut)),
      nodeCount: +med((r) => r.nodeCount).toFixed(1),
      // 图形状: prompt 里 "wide and shallow" / "no consumer → don't build" 的可量化对应物。
      depth: +med((r) => r.shape.depth).toFixed(1),
      maxWidth: +med((r) => r.shape.maxWidth).toFixed(1),
      orphans: +med((r) => r.shape.orphans).toFixed(1),
      costUsd: +med((r) => r.costUsd).toFixed(4),
      unpriced, // true = 上面 costUsd 不完整 (有坐标不在 cost-ledger 价表)
      spread: { firstShot: runs.map((r) => +r.firstShotPass.toFixed(2)) }, // 方差可见, 别只看中位
    },
  };
}

/** default export: (opts) => TournamentSpec。opts.r = 每候选重复次数 (默认 1; 真跑设 3, SDD D3)。 */
export default function conductorModelmixSpec(opts: Record<string, string> = {}): TournamentSpec<MixConfig> {
  // R 默认 3 (2026-07-26): R=1/2 在重尾分布上读不出东西 —— 单发是噪音, 两发无法取中位。
  const R = Math.max(1, Number.parseInt(opts.r ?? '3', 10) || 3);
  // fixture 默认 large (2026-07-26): medium 只有 3 模块, finalPass 恒 1.000 已饱和, 判不出差。
  const size: FixtureSize = opts.fixture === 'medium' ? 'medium' : 'large';
  // --profiles full,lean → prompt 档进候选轴 (省略 = 不展开, 引擎按座位模型档自选)。
  const profiles = (opts.profiles ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is 'full' | 'lean' => x === 'full' || x === 'lean');
  // leafTimeout: agent-leaf wall-clock 上界 (ms)。默认 30min (远宽于旧 240s), '0'=不限。
  const leafTimeoutMs = opts.leafTimeout != null && opts.leafTimeout !== ''
    ? Math.max(0, Number.parseInt(opts.leafTimeout, 10) || 0)
    : 1_800_000;
  // --skip C1,C5 = 排除 label 含这些子串的格 (如 C1 opus 缺 anthropic 凭证时先跳)。
  const skip = (opts.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const base = skip.length ? GRID.filter((c) => !skip.some((s) => c.label.includes(s))) : GRID;
  const grid = withProfiles(base, profiles);
  return {
    name: 'conductor-modelmix',
    seed: () => grid,
    async measure(c) {
      bootstrapModelRuntime(); // 真跑前注册 provider (幂等); **不放 spec 构造里** —— 那会让
      // 单纯构造一个 spec 就污染全局 registry, 连累同进程里其它测试的回落行为 (2026-07-26 实测踩到)。
      const runs: Array<RunMetrics & { costUsd: number; unpriced: boolean }> = [];
      for (let i = 0; i < R; i++) runs.push(await measureOnce(c.config, size, leafTimeoutMs));
      return agg(runs);
    },
    direction: 'max',
    concurrency: 1, // INV-1: 串行, 并行争 provider 限流
    maxRounds: 1, // INV-4: 单轮全网格 sweep, 不收窄
  };
}
