/**
 * agent-leaf-prompt —— agent leaf 的 prompt 档 × 模型 sweep (2026-07-26, owner 指派)。
 *
 * 为什么要它: `agent-leaf.ts` 里两块注入 (TOOL_ROUTING_GUIDELINE + DISCIPLINE_CORE, 共 ~1.3k 字符)
 * 和 2026-07-26 新加的 STRONG_MODEL_CORE (~0.3k) 之间的取舍, 目前是**有理有据的推断, 不是实测结论**。
 * conductor 那边的 full/lean 至少还跑过一轮 A/B; agent leaf 这边一轮都没跑过。
 *
 * 与 conductor-modelmix 的区别: 那个量"图画得对不对", 这个量"**一片叶子干活干得好不好**" ——
 * 所以不经 conductor 分解 (它会引入图形状这个混淆变量), 而是拿**同一张手写 plan** 喂进
 * runExecutorDagWithPlan, 只把 agent leaf 的 prompt 档当自变量。
 *
 * 三个自变量之外的东西全钉死: 同一 fixture worktree · 同一 plan · 同一 oracle (tsc+test) ·
 * 同一 hashline 编辑模式 · 同一超时。
 *
 * 消费 (同 conductor-modelmix, 经 fusang xihe-tournament.ts):
 *   bun run $FUSANG_HOME/scripts/xihe-tournament.ts src/eval/oracles/agent-leaf-prompt.ts \
 *     [--r 3] [--fixture large|medium] [--models mimo:mimo-v2.5-pro,kimi-coding:k3] \
 *     [--profiles auto,weak,strong,off]
 *
 * INV (与 modelmix 同族):
 *  - 串行测量 (并行争 provider 限流会污染墙钟与失败率读数)。
 *  - oracle 只认 tsc/test, 不用 LLM 当裁判。
 *  - worktree 隔离 + 泄漏护栏: 跑完主树若冒出 worktree 外的新脏文件 → 响亮报错废读数。
 *  - 报中位 + 附 spread (token/墙钟重尾)。
 *  - **每个模型带一个 control 格** (复制首档): 它与原格的差就是噪声地板, 效应必须大过它才可信。
 *
 * 首轮实测 (2026-07-26, mimo-pro × k3 × {auto,weak,strong} × R=3, medium fixture) 的两条结论:
 *   ① **pass 在 medium 上饱和** —— 18/18 全绿, 质量维度判不出差 (与 conductor eval 同病)。
 *      要读质量差得上 large 或更难的 fixture。
 *   ② **R=3 的噪声地板 ≈ 20~40%** —— 同配置重复格的 token 中位差 19% (mimo) / 39% (k3)。
 *      所以那轮**不足以支持** "STRONG_MODEL_CORE 更省" 的结论, 也不足以否定它。要读出 20-30%
 *      的效应, R 得到 8~10, 或换更长的任务把单次相对方差压下去。
 * 详见 docs/eval-findings.md。
 */
import { $ } from 'bun';
// ⚠ 必须先注册 provider: inproc leaf 走 callModel, 而 callModel 的 registry 要 bootstrap 才有
// 'mimo'/'deepseek' 等自有 provider (kimi/openai-codex 走 pi 通道自注册, 所以只挂 inproc 那半边)。
// 2026-07-26 全栈首轮就是栽在这: contract 节点 (inproc) 抛 "provider 'mimo' not registered",
// 整张图级联 skip, 6 次跑全废 —— 而且 agent-leaf-prompt 的固定图里没有 inproc leaf, 所以从没暴露。
import { bootstrapModelRuntime } from '../../model/bootstrap';
import { runExecutorDagWithPlan } from '../../harness/dag/engine';
import type { ConductorPlan } from '../../harness/conductor-plan';
import { createAgentLeafRunner } from '../../harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../../harness/command-leaf';
import { createMediumFixture } from '../tasks/medium';
import { createLargeFixture } from '../tasks/large';

type PromptProfile = 'auto' | 'weak' | 'strong' | 'off';
type FixtureSize = 'medium' | 'large';

interface LeafConfig {
  model: string;
  profile: PromptProfile;
}

interface Candidate<C> { label: string; config: C; }
interface TournamentSpec<C> {
  name: string;
  seed(): Candidate<C>[];
  measure(c: Candidate<C>): Promise<{ score: number; detail?: unknown }>;
  direction?: 'max' | 'min';
  concurrency?: number;
  maxRounds?: number;
}

const DEFAULT_MODELS = ['mimo:mimo-v2.5-pro', 'kimi-coding:k3'];
const DEFAULT_PROFILES: PromptProfile[] = ['auto', 'weak', 'strong', 'off'];

/**
 * 固定的手写 plan —— **这是本 eval 的对照组核心**: 图形状不再是变量, 每个候选跑的是同一张图。
 * 一个 agent 叶子实现 fixture 要求的模块, 一个 command 叶子跑闸 (依赖它)。
 */
function fixedPlan(oracleCmd: string): ConductorPlan {
  return {
    name: 'agent-leaf-prompt-ab',
    nodes: {
      impl: {
        goal: '按 spec 实现缺失/损坏的模块, 让 tsc 与测试全绿。只改必要文件, 不加新功能, 不改契约语义。',
        executor: 'agent',
        output_type: 'file',
      },
      gate: { goal: '跑类型与测试闸', executor: 'command', command: oracleCmd, depends_on: ['impl'] },
    },
    outputs: ['gate'],
  } as unknown as ConductorPlan;
}

/** 主树里 `.omd` 外的脏文件集 (泄漏护栏, 与 modelmix 同源)。 */
async function dirtyRealFiles(): Promise<Set<string>> {
  const out = await $`git status --porcelain`.nothrow().quiet();
  return new Set(
    out.stdout.toString().split('\n')
      .map((l) => (l.slice(3).split(' -> ').pop() ?? '').trim())
      .filter((p) => p && !p.startsWith('.omd/')),
  );
}

interface LeafRun {
  /** 闸绿 = 1 (客观, 零 LLM 裁判)。 */
  pass: number;
  /** 真写入磁盘的文件数 —— "done 但没产物" 在这里现形。 */
  filesTouched: number;
  /** 工具调用次数 —— prompt 档影响的**路由效率**代理量 (档位教的就是"别拿 grep 当 codegraph 用")。 */
  toolCalls: number;
  /** 该叶子是否被心跳闸判停摆 (弱模型空转的直接读数)。 */
  stalled: number;
  leafIn: number;
  leafOut: number;
  wallMs: number;
}

async function measureOnce(cfg: LeafConfig, size: FixtureSize, leafTimeoutMs: number): Promise<LeafRun> {
  const before = await dirtyRealFiles();
  const fx = await (size === 'large' ? createLargeFixture() : createMediumFixture());
  const t0 = Date.now();
  try {
    const agentRunner = createAgentLeafRunner({
      cwd: fx.root,
      hashlineEdit: true,
      leafTimeoutMs,
      sandboxRoot: fx.root,
      ...(cfg.profile !== 'auto' ? { promptProfile: cfg.profile } : {}),
    });
    const commandRunner = createCommandLeafRunner({
      allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: fx.root, timeoutMs: 600_000,
    });
    const res = await runExecutorDagWithPlan(fixedPlan(fx.oracleCmd), {
      conductorModel: cfg.model, // 本 eval 不经 conductor; 仅作为 escalation 兜底坐标
      leafModel: cfg.model,
      agentLeafModel: cfg.model,
      agentRunner,
      commandRunner,
      leafSystemPrefix: fx.spec,
      maxFanout: 1,
    } as Parameters<typeof runExecutorDagWithPlan>[1]);

    const leaked = [...(await dirtyRealFiles())].filter((p) => !before.has(p));
    if (leaked.length) {
      throw new Error(`[eval 泄漏] agent leaf 改了 worktree 外的真源码: ${leaked.join(', ')} — 废读数。\n` +
        `若你在 eval 运行期间编辑了本仓, 这是**误报**: 护栏拿 git status 前后比对, 分不清 leaf 逃逸与人手编辑。\n` +
        `纪律: eval 跑起来之后别碰工作树 (改 .omd/ 除外, 它不在比对范围内)。`);
    }
    const impl = res.results.impl;
    const gate = res.results.gate;
    return {
      pass: gate?.status === 'done' ? 1 : 0,
      filesTouched: impl?.filesTouched?.length ?? 0,
      toolCalls: impl?.toolCalls ?? 0,
      stalled: impl?.output?.includes('停摆') || impl?.status === 'failed' ? 1 : 0,
      leafIn: res.usage.leavesIn,
      leafOut: res.usage.leavesOut,
      wallMs: Date.now() - t0,
    };
  } finally {
    await fx.cleanup();
  }
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

export default function agentLeafPromptSpec(opts: Record<string, string> = {}): TournamentSpec<LeafConfig> {
  const R = Math.max(1, Number.parseInt(opts.r ?? '3', 10) || 3);
  // fixture 默认 **medium** —— 与 conductor eval 相反, 刻意的: 那边是 conductor 分解 12 个模块
  // (要难度才不饱和); 这边是**一片叶子**独自吃下整个 fixture, large 的 12 模块单叶做不完, 量到的
  // 只会是超时率不是 prompt 档的差。
  const size: FixtureSize = opts.fixture === 'large' ? 'large' : 'medium';
  const leafTimeoutMs = opts.leafTimeout ? Math.max(0, Number.parseInt(opts.leafTimeout, 10) || 0) : 1_800_000;
  const models = (opts.models ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const profiles = (opts.profiles ?? '').split(',').map((s) => s.trim())
    .filter((s): s is PromptProfile => (DEFAULT_PROFILES as string[]).includes(s));

  const useProfiles = profiles.length ? profiles : DEFAULT_PROFILES;
  const useModels = models.length ? models : DEFAULT_MODELS;
  const grid: Candidate<LeafConfig>[] = useModels.flatMap((model) => [
    ...useProfiles.map((profile) => ({ label: `${model} [${profile}]`, config: { model, profile } })),
    // **噪声地板对照格** (2026-07-26 首轮实测倒逼加的): 复制第一个档再跑一遍, 同配置同样本量。
    // 它与原格的差 = 这次测量的噪声地板 —— 任何小于它的"效应"都不可读。
    // 首轮血的教训: 网格里恰好有两对同配置重复 (auto≡strong on k3 / auto≡weak on mimo),
    // 它们的 token 中位差了 39% 与 19%; 若没注意到, k3[strong] 那行 (37k token / 15 tool calls)
    // 看着就是漂亮的胜利, 实则读的是噪声。对照格从此是网格的一部分, 不靠运气。
    { label: `${model} [${useProfiles[0]}·control]`, config: { model, profile: useProfiles[0]! } },
  ]);

  return {
    name: 'agent-leaf-prompt',
    seed: () => grid,
    async measure(c) {
      bootstrapModelRuntime(); // 真跑前注册 provider (幂等); **不放 spec 构造里** —— 那会让
      // 单纯构造一个 spec 就污染全局 registry, 连累同进程里其它测试的回落行为 (2026-07-26 实测踩到)。
      const runs: LeafRun[] = [];
      for (let i = 0; i < R; i++) runs.push(await measureOnce(c.config, size, leafTimeoutMs));
      const med = (f: (r: LeafRun) => number) => median(runs.map(f));
      return {
        score: med((r) => r.pass), // 排序键 = 客观闸通过率
        detail: {
          runs: R,
          pass: +med((r) => r.pass).toFixed(2),
          filesTouched: +med((r) => r.filesTouched).toFixed(1),
          toolCalls: +med((r) => r.toolCalls).toFixed(1),
          stalledRate: +(runs.reduce((s, r) => s + r.stalled, 0) / R).toFixed(2),
          leafTokens: Math.round(med((r) => r.leafIn + r.leafOut)),
          wallSec: Math.round(med((r) => r.wallMs) / 1000),
          spread: { pass: runs.map((r) => r.pass), tokens: runs.map((r) => r.leafIn + r.leafOut) },
        },
      };
    },
    direction: 'max',
    concurrency: 1, // 串行: 并行争限流会污染墙钟与停摆读数
    maxRounds: 1, // 单轮全网格, 不收窄 (要的是整表, 不是冠军)
  };
}
