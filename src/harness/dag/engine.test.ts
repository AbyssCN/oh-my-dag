/**
 * executor-dag 引擎核心测试 (SDD v2 dag-engine-fusion-refactor S1)。
 * 覆盖: G-1 ready-set 调度回归 · G-4 quorum fail-skip (D-7v2) · G-11v2 零回归。
 * 全部经 runExecutorDagWithPlan (预构造 plan, 跳过 conductor) + 注入 fake generate — 零真实 LLM。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlameVerdict, runExecutorDagWithPlan } from './engine';
import { ModelError } from '../../model';
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import { registerProvider } from '../../model/providers';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './types';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { DEFAULT_FANIN_MIN_CHARS, FANIN_SUMMARY_SYSTEM, composeAnchorBlock } from '../fanin-summary';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** content → 文本 (D-14v2 后 content 可为 ContentPart[]; fake 断言用 text parts 拼接)。 */
const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id (`[omd leaf: <id>]` 行)。 */
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

/**
 * fake generate: 按节点 id 记录调用/并发/prompt; goal 含 "FAIL" 的节点抛错 (→ failedFromThrow 隔离)。
 */
function makeGenerate(opts: { delayMs?: number } = {}): {
  generate: GenerateFn;
  calls: string[];
  prompts: Record<string, string>;
  maxActive: () => number;
} {
  const calls: string[] = [];
  const prompts: Record<string, string> = {};
  let active = 0;
  let peak = 0;
  const generate: GenerateFn = async (req) => {
    const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(prompt);
    calls.push(id);
    prompts[id] = prompt;
    active++;
    peak = Math.max(peak, active);
    if (opts.delayMs) await sleep(opts.delayMs);
    active--;
    if (prompt.includes('FAIL')) throw new Error(`节点 ${id} 注入失败`);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, calls, prompts, maxActive: () => peak };
}

function makeConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    ...extra,
  };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

describe('G-1 ready-set 调度 (回归)', () => {
  test('A settle 后 B/C 并发 (maxActive ≥ 2)', async () => {
    const { generate, calls, maxActive } = makeGenerate({ delayMs: 25 });
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
    expect(r.results.B!.status).toBe('done');
    expect(r.results.C!.status).toBe('done');
    expect(calls[0]).toBe('A'); // A 先于 B/C
    expect(maxActive()).toBeGreaterThanOrEqual(2); // B/C 并发在飞
  });

  test('maxFanout=1 严格串行且按拓扑序', async () => {
    const { generate, calls, maxActive } = makeGenerate({ delayMs: 5 });
    await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['B'] },
      }),
      makeConfig(generate, { maxFanout: 1 }),
    );
    expect(maxActive()).toBe(1);
    expect(calls).toEqual(['A', 'B', 'C']);
  });
});

describe('G-4 quorum fail-skip (D-7v2)', () => {
  test("单依赖链: A 失败 → B/C 级联 skipped, 零执行零 token", async () => {
    const { generate, calls } = makeGenerate();
    const events: DagNodeEvent[] = [];
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '会 FAIL 的根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['B'] },
      }),
      makeConfig(generate, { onNodeEvent: (e) => events.push(e) }),
    );
    expect(r.results.A!.status).toBe('failed');
    expect(r.results.B!.status).toBe('skipped');
    expect(r.results.C!.status).toBe('skipped');
    expect(r.results.B!.output).toContain('quorum');
    expect(r.results.B!.usage).toEqual({ in: 0, out: 0 });
    // ⚠ 2026-08-26: 断言从「calls 恰为 ['A']」改成「B/C 不在 calls 里」。
    // 本条要验的是**级联 skip**(注释原话: B/C 从未调模型), A 被调几次不是它的射程;
    // 而 engine 的缺省重试预算现在会给**抛错**补一次 (budgetFor —— 429/网络那类是
    // generate 抛出来的, 见 node-failure.ts:10), 于是 A 出现两次。
    // 代价说明白: 原断言顺带也锁住了「A 只跑一次」, 改后不再锁 —— 那一格由
    // node-retry.test.ts 的三条专用用例覆盖, 不靠这里兼职。
    expect(calls).not.toContain('B');
    expect(calls).not.toContain('C');
    expect(calls.every((c) => c === 'A'), '除 A 外不该有任何节点被调').toBe(true);
    // skipped 节点不发 start, 只发 settle(status:'skipped')
    expect(events.filter((e) => e.type === 'start').map((e) => (e as { id: string }).id)).toEqual(['A']);
    const settles = events.filter((e) => e.type === 'settle') as Array<{ id: string; status: string }>;
    expect(settles.find((e) => e.id === 'B')?.status).toBe('skipped');
    expect(settles.find((e) => e.id === 'C')?.status).toBe('skipped');
  });

  test("多依赖 fan-in 缺省 'all' [S3 片 3 / D-6, JOIN_ALL_DONE_DEFAULT]: 1/3 sibling 失败, synth 摘成 skipped", async () => {
    // S3 片 3 / D-6 / INV-7 第一条 GWT (引擎端到端镜像): 缺省翻 'all' 之后,
    // 多依赖里挂一个 → synth 直接被摘, runner 不被调 (与 dag-scheduler.test.ts:248 同形)。
    const { generate, calls } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲' },
        s2: { goal: '乙 FAIL' },
        s3: { goal: '丙' },
        synth: { goal: '合成', depends_on: ['s1', 's2', 's3'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.s2!.status).toBe('failed');
    expect(r.results.synth!.status).toBe('skipped');
    // synth 零执行零 token (与 G-4 第一条用例如出一辙: 缺 A 的输入 = 拿 [failed] 文本当正文纯浪费)
    expect(calls).not.toContain('synth');
  });

  test("显式 requires:'any' 仍走老路 (逃生门) [S3 片 3 / INV-7 第二条 GWT 引擎端到端]", async () => {
    // 翻缺省不毁逃生门: 显式 'any' 下 synth 仍照跑, 看见 s2 的失败占位 (注入失败) —
    // 这是 best-of-N 那种「允许带失败兄弟继续跑」场景的合法出口。
    const { generate, prompts, calls } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲' },
        s2: { goal: '乙 FAIL' },
        s3: { goal: '丙' },
        synth: { goal: '合成', depends_on: ['s1', 's2', 's3'], requires: 'any' },
      }),
      makeConfig(generate),
    );
    expect(r.results.s2!.status).toBe('failed');
    expect(r.results.synth!.status).toBe('done');
    expect(calls).toContain('synth');
    expect(prompts.synth).toContain('out:s1');
    expect(prompts.synth).toContain('out:s3');
    expect(prompts.synth).toContain('注入失败'); // s2 失败占位注入, 非静默
  });

  test("多依赖全失败: 'any' 也 skipped", async () => {
    const { generate, calls } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲 FAIL' },
        s2: { goal: '乙 FAIL' },
        synth: { goal: '合成', depends_on: ['s1', 's2'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.synth!.status).toBe('skipped');
    // 同上: 只锁「synth 从未被调」, 不锁 s1/s2 各跑几次 (抛错补一次重试)。
    expect(calls).not.toContain('synth');
    expect(new Set(calls)).toEqual(new Set(['s1', 's2']));
  });

  test('requires:K — done 依赖不足 K → skipped; 达到 K → 跑', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        g1: { goal: '候选1' },
        g2: { goal: '候选2 FAIL' },
        g3: { goal: '候选3 FAIL' },
        judge3: { goal: '判3', depends_on: ['g1', 'g2', 'g3'], requires: 3 },
        judge1: { goal: '判1', depends_on: ['g1', 'g2', 'g3'], requires: 1 },
      }),
      makeConfig(generate),
    );
    expect(r.results.judge3!.status).toBe('skipped');
    expect(r.results.judge1!.status).toBe('done');
  });

  test("requires:'all' 显式覆盖多依赖缺省", async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲' },
        s2: { goal: '乙 FAIL' },
        strict: { goal: '严合成', depends_on: ['s1', 's2'], requires: 'all' },
      }),
      makeConfig(generate),
    );
    expect(r.results.strict!.status).toBe('skipped');
  });
});

describe('D-23 per-channel 并发闸', () => {
  test('渠道 cap=1 → 同渠道节点串行, 未列渠道不限', async () => {
    const { generate, maxActive } = makeGenerate({ delayMs: 20 });
    await runExecutorDagWithPlan(
      plan({
        a: { goal: '甲', model: 'slowchan:m1' },
        b: { goal: '乙', model: 'slowchan:m1' },
        c: { goal: '丙', model: 'freechan:m2' },
      }),
      makeConfig(generate, { channelFanout: { slowchan: 1 } }),
    );
    // slowchan 两节点串行 → 全局并发峰值 ≤ 2 (1 slowchan + 1 freechan); 无闸时应为 3。
    expect(maxActive()).toBeLessThanOrEqual(2);
  });

  test('channelFanout 未配 → 行为不变 (全并发)', async () => {
    const { generate, maxActive } = makeGenerate({ delayMs: 20 });
    await runExecutorDagWithPlan(
      plan({
        a: { goal: '甲', model: 'slowchan:m1' },
        b: { goal: '乙', model: 'slowchan:m1' },
        c: { goal: '丙', model: 'freechan:m2' },
      }),
      makeConfig(generate),
    );
    expect(maxActive()).toBe(3);
  });
});

describe('D-8v2 primitive 候选池轮转', () => {
  test('parallel primitive 的 goals 按 candidates 跨池轮转; 未配则全走 leafModel', async () => {
    const models: string[] = [];
    const generate: GenerateFn = async (req) => {
      models.push(req.model);
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      plan({
        p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['甲', '乙', '丙'] } },
      }),
      makeConfig(generate, { primitiveCandidates: ['famA:m1', 'famB:m2'] }),
    );
    expect(models.sort()).toEqual(['famA:m1', 'famA:m1', 'famB:m2']); // 3 路轮转 2 候选
    models.length = 0;
    await runExecutorDagWithPlan(
      plan({ p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['甲', '乙'] } } }),
      makeConfig(generate),
    );
    expect(new Set(models)).toEqual(new Set(['test:leaf'])); // 池未配 → 零回归
  });
});

describe('G-10 attach_media 多模态媒体管道 (D-14v2)', () => {
  /** 前驱输出带真实存在的图片路径 → 下游 attach_media 节点收到 ContentPart[] (text + data-URI 图)。 */
  test('前驱产截图路径 → 媒体经 content parts 注入, usage 走 provider 真值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-media-'));
    const shot = join(dir, 'ui-variant-a.png');
    writeFileSync(shot, Buffer.from('fake-png-bytes'));
    const userContents: Array<string | ContentPart[]> = [];
    const generate: GenerateFn = async (req) => {
      const c = req.messages.find((m) => m.role === 'user')!.content;
      userContents.push(c);
      const id = leafId(contentText(c));
      if (id === 'render') return { text: `截图已产出: ${shot}`, usage: { in: 1, out: 1 } };
      return { text: `findings:${id}`, usage: { in: 7, out: 3 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({
        render: { goal: '渲染并截图' },
        review: { goal: 'UI/UX 审查', depends_on: ['render'], attach_media: true },
      }),
      makeConfig(generate),
    );
    expect(r.results.review!.status).toBe('done');
    const reviewContent = userContents.find((c) => Array.isArray(c)) as ContentPart[];
    expect(reviewContent).toBeDefined();
    // text part 在前 (带 leaf prompt), 图 part 是 data URI (png mime + base64 本体)。
    expect(reviewContent[0]!.type).toBe('text');
    const img = reviewContent.find((p) => p.type === 'image_url') as Extract<ContentPart, { type: 'image_url' }>;
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(img.image_url.url.split(',')[1]!, 'base64').toString()).toBe('fake-png-bytes');
    // usage 计费: provider 返回值直通账本 (图片 token 由 provider 计入 in)。
    expect(r.results.review!.usage).toEqual({ in: 7, out: 3 });
  });

  test('fail-closed: 前驱无可用图片 → 节点 failed (拒绝无图多模态审查静默文本化)', async () => {
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      calls.push(id);
      return { text: id === 'a' ? '截图在 /no/such/shot.png' : 'x', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({
        a: { goal: '前驱, 提到不存在的截图路径' },
        see: { goal: '看图', depends_on: ['a'], attach_media: true },
      }),
      makeConfig(generate),
    );
    expect(r.results.see!.status).toBe('failed');
    expect(r.results.see!.output).toContain('attach_media 无可用媒体');
    expect(r.results.see!.output).toContain('/no/such/shot.png');
    expect(calls).toEqual(['a']); // see 未调模型 (零 token)
  });

  test('零回归: 无 attach_media → user content 仍是纯 string', async () => {
    const contents: Array<string | ContentPart[]> = [];
    const generate: GenerateFn = async (req) => {
      contents.push(req.messages.find((m) => m.role === 'user')!.content);
      return { text: '含个路径 /tmp/x.png 也不该触发', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] } }),
      makeConfig(generate),
    );
    expect(contents.every((c) => typeof c === 'string')).toBe(true);
  });
});

describe('G-11v2 零回归', () => {
  test('全绿链行为不变: 状态/输出/用量账本', async () => {
    const { generate, prompts } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
    expect(r.results.B!.status).toBe('done');
    expect(prompts.B).toContain('out:A'); // 前驱输出注入
    expect(r.usage.leavesIn).toBe(2);
    expect(r.usage.leavesOut).toBe(2);
    expect(r.levels).toEqual([['A'], ['B']]);
  });

  test('幻象 dep (引用不存在 id) 视为已满足, 不进 quorum 分母', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '根', depends_on: ['ghost'] } }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
  });
});

// ── D-6: executor:'research' 节点 (INV-GOAL-2 真 web / INV-GOAL-4 内环有界) ────────
describe("executor:'research' 节点 (D-6)", () => {
  const researchPlan = (extra: Record<string, unknown> = {}) =>
    plan({
      R: { goal: 'omd 的 DAG 引擎怎么做增量复用', executor: 'research', ...extra },
      S: { goal: '据研究写结论', depends_on: ['R'] },
    });

  test('有 sources → done, 输出进下游 fan-in, reportPath 记进 filesTouched', async () => {
    const { generate, prompts } = makeGenerate();
    let got: unknown;
    const r = await runExecutorDagWithPlan(
      researchPlan(),
      makeConfig(generate, {
        researchRunner: async (input) => {
          got = input;
          return {
            text: '研究终稿: 语义 Merkle 跳未变节点',
            usage: { in: 100, out: 50 },
            sources: ['https://example.com/a', 'https://example.com/b'],
            reportPath: '.omd/research/xyz.md',
          };
        },
      }),
    );
    expect(r.results.R!.status).toBe('done');
    expect(r.results.R!.kind).toBe('research');
    expect(r.results.R!.sources).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(r.results.R!.filesTouched).toEqual(['.omd/research/xyz.md']);
    // 下游拿到的是研究终稿 (真进 fan-in, 不是空转)
    expect(prompts.S).toContain('语义 Merkle');
    // 问题 = 节点 goal; 内环轮数缺省 1 (有界)
    expect((got as { question: string }).question).toContain('增量复用');
    expect((got as { rounds: number }).rounds).toBe(1);
  });

  // INV-GOAL-2: 零来源 = 没有任何真抓取痕迹 → 那份"终稿"是模型记忆里的引用, 判 failed 比放行更安全。
  test('零 sources → failed (假 grounded 不许过闸), 下游级联跳过', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      researchPlan(),
      makeConfig(generate, {
        researchRunner: async () => ({ text: '看起来很像研究的一段话', usage: { in: 1, out: 1 }, sources: [] }),
      }),
    );
    expect(r.results.R!.status).toBe('failed');
    expect(r.results.R!.output).toContain('零来源');
    expect(r.results.S!.status).toBe('skipped');
  });

  // 与"写文件节点无 agentRunner → failed"同一条纪律: 不静默降级成没有 web 的 inproc。
  test('无 researchRunner → failed (不降级 inproc)', async () => {
    const { generate, calls } = makeGenerate();
    const r = await runExecutorDagWithPlan(researchPlan(), makeConfig(generate));
    expect(r.results.R!.status).toBe('failed');
    expect(r.results.R!.output).toContain('researchRunner');
    expect(calls).not.toContain('R'); // 没有偷偷走 inproc 生成
  });

  test('node.research 旋钮透传 (k / rounds = 内环的界)', async () => {
    const { generate } = makeGenerate();
    let got: { k?: number; rounds?: number } = {};
    await runExecutorDagWithPlan(
      researchPlan({ research: { k: 3, rounds: 2 } }),
      makeConfig(generate, {
        researchRunner: async (input) => {
          got = input;
          return { text: 'x', usage: { in: 1, out: 1 }, sources: ['https://e.com'] };
        },
      }),
    );
    expect(got.k).toBe(3);
    expect(got.rounds).toBe(2);
  });

  test('上游输出当 groundTruth 注入 (防幻觉锚)', async () => {
    const { generate } = makeGenerate();
    let got: { groundTruth?: string } = {};
    await runExecutorDagWithPlan(
      plan({
        A: { goal: '仓内事实' },
        R: { goal: '研究问题', executor: 'research', depends_on: ['A'] },
      }),
      makeConfig(generate, {
        researchRunner: async (input) => {
          got = input;
          return { text: 'x', usage: { in: 1, out: 1 }, sources: ['https://e.com'] };
        },
      }),
    );
    expect(got.groundTruth).toContain('out:A');
  });
});

// ── SDD 2026-08-10-blame-scoped-node-retry: blame-scoped 定点重跑 (切片 3+4+5 接线) ──────────
// 契约: design-contract (d)(e)(f) + SDD G-1..G-5。样本图沿用 SDD 词汇:
//   survey(勘察, 正确) ← draft(草稿, 错) ← polish(打磨, draft 下游)。
// 判词带 ```blame 围栏责备 draft → 闭包 = {draft, polish}; survey = 闭包外 → 必须 100% 指纹复用。
// 实装已由兄弟切片落地 (blame.ts 解析 / engine.ts 接线 / types.ts 台账), 本组用例为确定性回归 — 断言不为迁就实现而改。

/** 责备集打回判词: 散文 + ```blame 围栏 (契约 (b): 围栏内为 BlameEntry[] JSON, 围栏外散文原样保留)。 */
const BLAME_FENCE_DRAFT =
  '草稿段验收不合格。\n```blame\n[{"node": "draft", "reason": "草稿验收段判卷命令不合格"}]\n```\n';

/**
 * 契约 (f) 冻结的台账类型 BlameRetryLedger (字段名冻结如上)。
 * 结果面字段名未冻结 → 按契约字面取 `blameRetry` (与 claimCheck/artifactMove 同款 camelCase 读数位;
 * 若切片 5 落成别的字段名, 这是唯一要对齐的接缝, 测试会以「undefined」显式红掉而不是静默)。
 */
type BlameRetryLedger = {
  blameSize: number;
  closureSize: number;
  reuseHits: number;
  rerunWallMs: number;
  replanMode: 'patch' | 'full';
  replanTokens: { in: number; out: number; cacheHit?: number };
};
const readBlameRetry = (r: Awaited<ReturnType<typeof runExecutorDagWithPlan>>): BlameRetryLedger | undefined =>
  (r as unknown as { blameRetry?: BlameRetryLedger }).blameRetry;

/** verifier 首轮 fail (reason = 打回判词, 可带责备围栏) → 次轮 pass (与 G-21 既有夹具同构)。 */
const makeBlameVerifier = (reason: string): NonNullable<ExecutorDagConfig['verifier']> => {
  let n = 0;
  return async () => {
    n++;
    return n === 1
      ? { pass: false, reason, usage: { in: 1, out: 1 } }
      : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  };
};

/** fake generate: REPLAN-PATCH 返回轮 2 补丁; leaf 按 id 记调用序 + prompt 全文 (跨轮字节比较用)。 */
const makeBlameGenerate = (round2Patch: Record<string, unknown>) => {
  const calls: string[] = [];
  const promptLog: Array<{ id: string; prompt: string }> = [];
  const generate: GenerateFn = async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    if (sys.includes('REPLAN-PATCH')) {
      return { text: JSON.stringify({ patch: round2Patch }), usage: { in: 5, out: 5 } };
    }
    const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(prompt);
    calls.push(id);
    promptLog.push({ id, prompt });
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, calls, promptLog };
};

/** 样本图 (SDD 词汇): survey 正确、draft 错、polish 是 draft 下游。 */
const blameGraphPlan = () =>
  plan({
    survey: { goal: '勘察仓内事实' },
    draft: { goal: '草稿', depends_on: ['survey'] },
    polish: { goal: '打磨', depends_on: ['draft'] },
  });

/** 轮 2 补丁: draft 与轮 1 **逐字节相同** (未补丁的 survey/polish 由 S3.6 原样保留)。 */
const SAME_DRAFT_PATCH = { draft: { goal: '草稿', depends_on: ['survey'] } };

describe('verifier 调不通 ≠ 执行失败 (2026-08-11 f3dd34b9 事故闸)', () => {
  registerProvider('vdownx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  test('verifier 抛错 → 判卷缺席记账不掀 run: 产出保全 + [verifier-error] 带原文 + 不进升级环', async () => {
    // 实测样本 f3dd34b9: opus 订阅通道连回三次散文, ModelError 裸穿 executePlan,
    // 已收敛的内环产出被掀成 infra-error 一行字。
    // 证伪 (实跑): 把 engine.ts runVerifier 的 try/catch 摘掉 → 本测试当场红
    // (整个 promise reject, 拿不到带 [verifier-error] 的结果对象)。
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const throwingVerifier: NonNullable<ExecutorDagConfig['verifier']> = async () => {
      throw new Error('invalid JSON: Unexpected identifier "blame"');
    };
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      makeConfig(generate, { verifier: throwingVerifier, conductorEscalationModel: 'vdownx:strong' }),
    );
    expect(r.verification!.pass).toBe(false); // fail-closed: 没被判过就不算过
    expect(r.verification!.reason).toContain('[verifier-error]');
    expect(r.verification!.reason).toContain('invalid JSON'); // 吞异常不吞证据: 错误原文在账上
    expect(r.verification!.escalated).toBe(false); // 判卷官坏了不开修复轮 (拿引擎故障当质量信号)
    // 产出保全: 三节点结果都在且各只跑一次 (没有被升级环二次重跑)
    expect(r.results.survey!.status).toBe('done');
    expect(r.results.draft!.status).toBe('done');
    expect(r.results.polish!.status).toBe('done');
    expect(calls.filter((c) => c === 'draft')).toHaveLength(1);
  });
});

/**
 * D-P 取消: **协作式停** —— 外层只翻标志位, 引擎在调度接缝上自己停, **不杀在飞节点**。
 *
 * 为什么补这一组 (2026-08-11, r1 裁决的尾巴): 这条不变量此前只活在注释里 ——
 * `engine.ts:3154` 接缝① 与 `dag-tools.ts:371` 的「不杀在飞节点」写得很清楚, 而
 * `cancelSignal` / `attachCancel` 在全仓**零测试断言**。一条承重不变量没有会红的闸,
 * 下一次有人为了"取消要更干脆"去 kill 在飞叶时, 没有任何东西会拦住他。
 *
 * ★ 证伪方式 (加闸时当场做过, 两条各自单独红过):
 *   · 「不杀在飞」那条 —— 把接缝① (engine.ts:3156) 的 `if (sched.runningCount === 0)` 去掉,
 *     让取消立刻 resolve 而不等在飞结清 → A 的 settle 赶不上, `results.A` 不再是 done → 红。
 *   · 「不派新活」那条 —— 把接缝① 整个 `if (isCancelled())` 块注释掉 → B 照跑,
 *     `calls` 变成 ['A','B'] → 红。
 */
describe('D-P 取消 (协作式停, 不杀在飞节点)', () => {
  /** A 在飞时开火的取消: fake generate 进到 A 里先 abort, 再慢慢跑完自己那一发。 */
  function makeCancelDuring(nodeId: string): { generate: GenerateFn; calls: string[]; signal: AbortSignal } {
    const ac = new AbortController();
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      calls.push(id);
      if (id === nodeId) {
        ac.abort('测试取消');
        await sleep(20); // 取消已开火, 而这一发还在飞 —— 闸量的就是这 20ms 里它会不会被杀
      }
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    return { generate, calls, signal: ac.signal };
  }

  test('★ 在飞节点跑完不被杀: 取消落在 A 在飞时, A 仍 done 且产物完整', async () => {
    const { generate, signal } = makeCancelDuring('A');
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '根' }, B: { goal: '叶B', depends_on: ['A'] } }),
      makeConfig(generate, { cancelSignal: signal }),
    );
    // 在飞的那一发跑到自己结束 —— 产物/usage 一样不少 (这正是"不杀"的可观测形态)
    expect(r.results.A!.status).toBe('done');
    expect(r.results.A!.output).toContain('out:A');
    expect(r.results.A!.usage).toEqual({ in: 1, out: 1 });
  });

  test('★ 取消后不派新活: B 一次模型都没调, 且如实进 cancelled.notRun (不伪造结果)', async () => {
    const { generate, calls, signal } = makeCancelDuring('A');
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '根' }, B: { goal: '叶B', depends_on: ['A'] } }),
      makeConfig(generate, { cancelSignal: signal }),
    );
    expect(calls).toEqual(['A']); // B 从未起跑
    expect(r.cancelled).toBeDefined();
    expect(r.cancelled!.reason).toContain('测试取消'); // 取消理由如实带出, 不压成一句"已取消"
    expect(r.cancelled!.notRun).toContain('B'); // 未起跑的如实列出
    expect(r.results.B).toBeUndefined(); // 不伪造结果: 没跑就没有这一条
  });
});

describe('空转熔断 (drift fuse → 节点 spin-fused)', () => {
  test('★ agentRunner 报 spinFused → 节点 failed + failureKind spin-fused, 已存盘产物保留在 filesTouched', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({ W: { goal: '改文件', executor: 'agent' } }),
      makeConfig(generate, {
        agentRunner: async () => ({
          text: '半截产出',
          usage: { in: 1, out: 1 },
          filesTouched: ['src/x.ts'],
          spinFused: '空转熔断: 同签名重复 14 次 (阈值 12); 卡在 bash:python ingest.py',
        }),
      }),
    );
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('spin-fused');
    expect(r.results.W!.output).toContain('空转熔断');
    expect(r.results.W!.filesTouched).toEqual(['src/x.ts']);
  });

  test('没熔断 (spinFused 缺席) → 照旧 done, 零回归', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({ W: { goal: '改文件', executor: 'agent' } }),
      makeConfig(generate, {
        agentRunner: async () => ({ text: '完整产出', usage: { in: 1, out: 1 }, filesTouched: ['src/x.ts'] }),
      }),
    );
    expect(r.results.W!.status).toBe('done');
  });
});

describe('crash 入账 (中途抛错也要写部分记录)', () => {
  registerProvider('crashx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });


  test('规划期就炸 (exec 从未赋值) → 不编空记录 (缺席 ≠ 0), 错误照抛', async () => {
    const generate: GenerateFn = async () => {
      throw new Error('规划期炸');
    };
    const recorded: unknown[] = [];
    let thrown: Error | null = null;
    try {
      const { runExecutorDag } = await import('../../../test/helpers/legacy-plan-entry');
      await runExecutorDag('任务', makeConfig(generate, { onComplete: async (r) => void recorded.push(r) }));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(recorded.length).toBe(0);
  });
});

// ── 写竞争硬闸接线 (2026-08-14): applyPlanFilters → serializeWriteRaces ─────────
describe('写竞争硬闸 (engine 接线: 竞写对被程序化串行化)', () => {
  test('★ 两节点声明写同一文件且无边 → 引擎补边, 执行严格有序 (不再并发)', async () => {
    const { generate } = makeGenerate();
    const root = mkdtempSync(join(tmpdir(), 'omd-race-'));
    let active = 0;
    let peak = 0;
    let runs = 0;
    const r = await runExecutorDagWithPlan(
      plan({
        w1: { goal: '写前半', executor: 'agent', output_path: 'docs/x.md' },
        w2: { goal: '写后半', executor: 'agent', output_path: 'docs/x.md' },
      }),
      makeConfig(generate, {
        agentRunner: async () => {
          active++;
          runs++;
          peak = Math.max(peak, active);
          await sleep(15);
          active--;
          mkdirSync(join(root, 'docs'), { recursive: true });
          writeFileSync(join(root, 'docs', 'x.md'), 'ok', 'utf8');
          return { text: 'ok', usage: { in: 1, out: 1 }, filesTouched: ['docs/x.md'], cwd: root };
        },
      }),
    );
    rmSync(root, { recursive: true, force: true });
    const w2Deps = r.plan.nodes.w2!.depends_on ?? [];
    const w1Deps = r.plan.nodes.w1!.depends_on ?? [];
    expect(w2Deps.includes('w1') || w1Deps.includes('w2')).toBe(true); // 一个方向被补上
    expect(runs).toBe(2);
    expect(peak).toBe(1); // 不再并发 —— 这就是硬闸买到的东西
  });
});

describe('S-33 集成接线: config.verifier 收到 artifactRoot (engine.ts 侧, 不是只在单测里手传)', () => {
  // 反向自检: 把 engine.ts 里 `artifactRoot: config.continuity?.repoRoot ?? process.cwd()` 那半句删掉 →
  // 这条断言会因 `seen` 停在 undefined 而红 (证伪 D-976/S-33 集成缺口: verifier.ts 的三态判据只在
  // `artifactRoot` 存在时生效, 引擎不传 = 终审三态永远沉默, 逐字节退化回旧行为但不报错——静默坑)。
  test('★ runExecutorDagWithPlan 真实调用链把 continuity.repoRoot 递给 verifier', async () => {
    const { generate } = makeGenerate();
    let seen: string | undefined;
    const verifier: NonNullable<ExecutorDagConfig['verifier']> = async (req) => {
      seen = req.artifactRoot;
      return { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
    };
    const root = mkdtempSync(join(tmpdir(), 'omd-s33-wiring-'));
    const mgr = new CheckpointManager(root);
    try {
      await runExecutorDagWithPlan(
        plan({ A: { goal: '单节点' } }),
        makeConfig(generate, { verifier, continuity: { manager: mgr, runId: 's33-wiring', repoRoot: root } }),
      );
      expect(seen).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('没配 continuity 时回落 process.cwd() (不是 undefined —— 否则三态闸悄悄失效)', async () => {
    const { generate } = makeGenerate();
    let seen: string | undefined;
    const verifier: NonNullable<ExecutorDagConfig['verifier']> = async (req) => {
      seen = req.artifactRoot;
      return { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
    };
    await runExecutorDagWithPlan(plan({ A: { goal: '单节点' } }), makeConfig(generate, { verifier }));
    expect(seen).toBe(process.cwd());
  });
});

// ── fan-in 硬上限 (爆窗闸, 2026-08-14) ──────────────────────────────────────
// 实测背景: kaupan-ala 首跑一个分析节点吃进 316KB 上游正文 → 窗口炸掉整图报废重派。
// 定向摘要的三条缝 (扇出<2 绕过 / 摘要失败回落全文 / creative 护全文) 共同下游 = 注入点,
// 兜底闸放在那里。反向自检: 把 engine.ts upstreamText 里 capFanin 那一步删掉 → 第一条当场红。
describe('fan-in 硬上限 (上游超长输出 → 截断 + 指针, 不再原样进 prompt)', () => {
  test('★ 线性链 (扇出1, 摘要不触发) 上游 30K 字符 → 下游 prompt 只见 24K + 响亮截断标注', async () => {
    const HUGE = 'x'.repeat(30_000);
    let bPrompt = '';
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(user);
      if (id === 'B') bPrompt = user;
      return { text: id === 'A' ? HUGE : 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '产大料' }, B: { goal: '吃上游', depends_on: ['A'] } }),
      makeConfig(generate),
    );
    expect(r.results.B!.status).toBe('done');
    expect(bPrompt).toContain('fan-in 硬上限'); // 截断必须响亮 (No-silent-caps)
    expect(bPrompt).toContain('30000'); // 全量多大要说出来
    expect(bPrompt.length).toBeLessThan(30_000); // 30K 原文没有整个进 prompt
  });

  test('上限内的上游原样直传 (零回归: 正常用法一个字不动)', async () => {
    const SMALL = 'y'.repeat(500);
    let bPrompt = '';
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(user);
      if (id === 'B') bPrompt = user;
      return { text: id === 'A' ? SMALL : 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      plan({ A: { goal: '产小料' }, B: { goal: '吃上游', depends_on: ['A'] } }),
      makeConfig(generate),
    );
    expect(bPrompt).toContain(SMALL);
    expect(bPrompt).not.toContain('fan-in 硬上限');
  });
});
