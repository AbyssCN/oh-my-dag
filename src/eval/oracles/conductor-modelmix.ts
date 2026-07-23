/**
 * conductor-modelmix —— ④ model-mix sweep spec (SDD D3, 2026-07-21)。
 *
 * 复刻 Cursor《agent-swarm economics》: 固定任务, 跑 {conductorModel × leafModel} 网格, 量
 * quality × cost, 读 knee。**单轮全网格 sweep** (非收窄 tournament, INV-4): 省 expand, 出整表。
 * measure 串行 (INV-1: 并行争 provider 限流污染读数); 内部重复 R 次取均值 (LLM 非确定, 单发是噪音)。
 *
 * 消费: 经 fusang xihe-tournament.ts 跑 —
 *   bun run $FUSANG_HOME/scripts/xihe-tournament.ts src/eval/oracles/conductor-modelmix.ts [--r 3]
 * default export = (opts) => TournamentSpec。每候选 detail 带 4 量 (firstShot/final/heal/cost),
 * leaderboard 全表读 cost-at-quality (score=finalPass 只为排序, 真信息在 detail; INV-4 不取单冠军)。
 */
import { $ } from 'bun';
import { runExecutorDag } from '../../harness/executor-dag';
import { createAgentLeafRunner } from '../../harness/agent-leaf';
import { createCommandLeafRunner } from '../../harness/command-leaf';
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

interface MixConfig { conductorModel: string; leafModel: string; }

/** 锁定的 4 格网格 (SDD D3; C1/C2/C3 固定 leaf=ds-flash 为干净 conductor 轴, C5 独立组合)。 */
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
    const agentRunner = createAgentLeafRunner({ cwd: fx.root, hashlineEdit: true, leafTimeoutMs }); // thinkingLevel 默认 xhigh
    const commandRunner = createCommandLeafRunner({ allowlist: ['bun', 'tsc', 'npx'], cwd: fx.root, timeoutMs: 600_000 });
    const dagConfig = {
      conductorModel: config.conductorModel,
      leafModel: config.leafModel,
      agentLeafModel: config.leafModel,
      agentRunner,
      commandRunner,
      maxFanout: 8,
      warmThenFanout: true,
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
      throw new Error(`[eval 泄漏] leaf 改了 worktree 外的真源码: ${leaked.join(', ')} — 隔离破了, 别用这次读数; git checkout 还原`);
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

/** 均值聚合 R 次测量 (variance)。 */
function avg(runs: Array<RunMetrics & { costUsd: number; unpriced: boolean }>): { score: number; detail: unknown } {
  const n = runs.length;
  const mean = (f: (r: (typeof runs)[number]) => number) => runs.reduce((s, r) => s + f(r), 0) / n;
  const unpriced = runs.some((r) => r.unpriced); // 任一坐标无价 → costUsd 被低估 (F2)
  return {
    score: mean((r) => r.finalPass), // 排序键 = 质量; 真信息全在 detail (INV-4)
    detail: {
      runs: n,
      firstShotPass: +mean((r) => r.firstShotPass).toFixed(3),
      finalPass: +mean((r) => r.finalPass).toFixed(3),
      healRounds: +mean((r) => r.healRounds).toFixed(2),
      leafTokens: Math.round(mean((r) => r.usage.leavesIn + r.usage.leavesOut)),
      nodeCount: +mean((r) => r.nodeCount).toFixed(1),
      costUsd: +mean((r) => r.costUsd).toFixed(4),
      unpriced, // true = 上面 costUsd 不完整 (有坐标不在 cost-ledger 价表)
    },
  };
}

/** default export: (opts) => TournamentSpec。opts.r = 每候选重复次数 (默认 1; 真跑设 3, SDD D3)。 */
export default function conductorModelmixSpec(opts: Record<string, string> = {}): TournamentSpec<MixConfig> {
  const R = Math.max(1, Number.parseInt(opts.r ?? '1', 10) || 1);
  const size: FixtureSize = opts.fixture === 'large' ? 'large' : 'medium';
  // leafTimeout: agent-leaf wall-clock 上界 (ms)。默认 30min (远宽于旧 240s), '0'=不限。
  const leafTimeoutMs = opts.leafTimeout != null && opts.leafTimeout !== ''
    ? Math.max(0, Number.parseInt(opts.leafTimeout, 10) || 0)
    : 1_800_000;
  // --skip C1,C5 = 排除 label 含这些子串的格 (如 C1 opus 缺 anthropic 凭证时先跳)。
  const skip = (opts.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const grid = skip.length ? GRID.filter((c) => !skip.some((s) => c.label.includes(s))) : GRID;
  return {
    name: 'conductor-modelmix',
    seed: () => grid,
    async measure(c) {
      const runs: Array<RunMetrics & { costUsd: number; unpriced: boolean }> = [];
      for (let i = 0; i < R; i++) runs.push(await measureOnce(c.config, size, leafTimeoutMs));
      return avg(runs);
    },
    direction: 'max',
    concurrency: 1, // INV-1: 串行, 并行争 provider 限流
    maxRounds: 1, // INV-4: 单轮全网格 sweep, 不收窄
  };
}
