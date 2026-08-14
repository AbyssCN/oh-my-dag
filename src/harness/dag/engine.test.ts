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
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import { registerProvider } from '../../model/providers';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './types';
import { CheckpointManager } from '../continuity/checkpoint-manager';

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
    expect(calls).toEqual(['A']); // B/C 从未调模型
    // skipped 节点不发 start, 只发 settle(status:'skipped')
    expect(events.filter((e) => e.type === 'start').map((e) => (e as { id: string }).id)).toEqual(['A']);
    const settles = events.filter((e) => e.type === 'settle') as Array<{ id: string; status: string }>;
    expect(settles.find((e) => e.id === 'B')?.status).toBe('skipped');
    expect(settles.find((e) => e.id === 'C')?.status).toBe('skipped');
  });

  test("多依赖 fan-in 缺省 'any': 1/3 sibling 失败, synth 照跑且见失败占位", async () => {
    const { generate, prompts } = makeGenerate();
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
    expect(r.results.synth!.status).toBe('done');
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
    expect(calls.sort()).toEqual(['s1', 's2']);
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

describe('G-21 强化: escalation patch 模式 (S3.6)', () => {
  // 升级闸要求 provider 已注册 (escalationProviderReady) → 注册假 provider (fake generate, 零真调用)。
  registerProvider('escx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  /** verifier 首轮 fail 点名 b → patch 模式改 b.goal → 未补丁节点 a 按构造复用 (零重跑)。 */
  test('补丁采纳: 未补丁节点字节不动 → D-21 复用按构造成立', async () => {
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        return { text: '{"patch": {"b": {"goal": "修好的乙"}}}', usage: { in: 5, out: 5 } };
      }
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      calls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    let verifyCount = 0;
    const verifier = async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => {
      verifyCount++;
      return verifyCount === 1
        ? { pass: false, reason: '节点 b 输出不合格', usage: { in: 1, out: 1 } }
        : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] } }),
      makeConfig(generate, { verifier, conductorEscalationModel: 'escx:strong' }),
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    // a 只跑一次 (轮 2 语义指纹命中 → 零 LLM 注入), b 补丁后重跑 → 两次
    expect(calls.filter((c) => c === 'a').length).toBe(1);
    expect(calls.filter((c) => c === 'b').length).toBe(2);
    expect(r.results.a!.skipped).toBe(true); // 轮 2 的 a = 复用注入
    expect(r.results.a!.output).toBe('out:a');
    expect(r.results.b!.status).toBe('done');
    // 补丁 conductor 用量入账
    expect(r.usage.conductor.in).toBeGreaterThanOrEqual(5);
  });

  /** 执行层散雾 (S3.6 升格): findings 说「缺 X」→ 补丁在上轮图上**长出新下游子图**, 未动部分全复用。 */
  test('补丁加节点: 上轮图长出新下游子图, 旧节点零重跑 (add 语义)', async () => {
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        // 审核缺审查节点 → 补丁只加一个下游 review 节点, 不动 a/b
        return { text: '{"patch": {"review": {"goal": "补交叉审查", "depends_on": ["b"]}}}', usage: { in: 5, out: 5 } };
      }
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      calls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    let verifyCount = 0;
    const verifier = async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => {
      verifyCount++;
      return verifyCount === 1
        ? { pass: false, reason: '缺交叉审查节点', usage: { in: 0, out: 0 } }
        : { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] } }),
      makeConfig(generate, { verifier, conductorEscalationModel: 'escx:strong' }),
    );
    expect(r.verification!.pass).toBe(true);
    // a/b 各只跑一次 (轮 2 按构造复用), 新 review 节点跑一次且吃到 b 的上轮输出
    expect(calls.filter((c) => c === 'a').length).toBe(1);
    expect(calls.filter((c) => c === 'b').length).toBe(1);
    expect(calls.filter((c) => c === 'review').length).toBe(1);
    expect(r.results.a!.skipped).toBe(true);
    expect(r.results.b!.skipped).toBe(true);
    expect(r.results.review!.status).toBe('done');
  });

  test('fail-open: 补丁始终无效 → 回退整图重规划 (CONDUCTOR 全量 prompt), 补丁 token 不丢账', async () => {
    const sysSeen: string[] = [];
    const fullPlanJson = JSON.stringify({
      name: 'replanned',
      nodes: { a: { goal: '甲' }, b: { goal: '乙v2', depends_on: ['a'] } },
    });
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        sysSeen.push('patch');
        return { text: 'garbage not a patch', usage: { in: 3, out: 3 } };
      }
      if (sys.includes('CONDUCTOR')) {
        sysSeen.push('conductor');
        return { text: fullPlanJson, usage: { in: 10, out: 10 } };
      }
      return { text: 'out', usage: { in: 1, out: 1 } };
    };
    let verifyCount = 0;
    const verifier = async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => {
      verifyCount++;
      return verifyCount === 1
        ? { pass: false, reason: 'b 不合格', usage: { in: 0, out: 0 } }
        : { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] } }),
      makeConfig(generate, { verifier, conductorEscalationModel: 'escx:strong', maxPlanRetries: 1 }),
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    // 补丁试过 (maxPlanRetries+1 = 2 次) 后回退全量 conductor
    expect(sysSeen).toEqual(['patch', 'patch', 'conductor']);
    // 补丁尝试 3+3 ×2 + conductor 10 全入账
    expect(r.usage.conductor.in).toBe(16);
    expect(r.usage.conductor.out).toBe(16);
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

describe('blame-scoped 定点重跑 (SDD 2026-08-10-blame-scoped-node-retry)', () => {
  registerProvider('blamex', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
  const escConfig = (generate: GenerateFn, verifier: NonNullable<ExecutorDagConfig['verifier']>) =>
    makeConfig(generate, { verifier, conductorEscalationModel: 'blamex:strong' });

  test('G-1: 带责备集打回 → 闭包外节点 100% 指纹复用零 LLM, 台账可读出 reuseHits', async () => {
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)));
    expect(r.verification!.pass).toBe(true);
    // 闭包外 survey: 仅轮 1 一次 LLM; 轮 2 零调用注入上轮输出 (skipped = 复用注入标记, 同 G-21)
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1);
    expect(r.results.survey!.skipped).toBe(true);
    expect(r.results.survey!.status).toBe('done');
    // 闭包内 draft + 下游 polish: 各重跑一次 (轮 1 + 轮 2)
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    expect((r.reusedNodes ?? []).sort()).toEqual(['survey']);
    expect(r.usage.leavesIn).toBe(5); // 3 (轮 1) + 2 (轮 2 仅闭包内) — survey 零增量
    // 台账 (契约 f): blameSize / closureSize / reuseHits / rerunWallMs 可读出
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    expect(ledger!.blameSize).toBe(1);
    expect(ledger!.closureSize).toBe(2); // draft ∪ downstream(draft) = {draft, polish}
    expect(ledger!.reuseHits).toBe(1); // 闭包外且指纹命中 = survey
    expect(ledger!.rerunWallMs).toBeGreaterThanOrEqual(0);
    // D-3 (SDD 2026-08-11-l2-diff-replan): 补丁一击即中 → mode='patch', token 就是补丁那次调用
    expect(ledger!.replanMode).toBe('patch');
    expect(ledger!.replanTokens).toEqual({ in: 5, out: 5, cacheHit: 0 });
  });

  /** D-1 请求侧差量 (SDD 2026-08-11-l2-diff-replan G-1): 闭包节点全文 + 闭包外单行清单, 严格小于整图 JSON。
   * 用比 blameGraphPlan 更宽的图: draft 无下游依赖者 → 闭包严格 = {draft}, note_a..d 均闭包外
   * (闭包外节点数量放大, 差量省字节的效果才不被「闭包占了大半图」盖掉)。
   */
  test('D-1: 补丁请求闭包节点全文 + 闭包外单行清单, 字节数严格小于整图 JSON', async () => {
    const wideBlamePlan = plan({
      survey: { goal: '勘察仓内事实, 覆盖若干背景细节以撑起整图字节数' },
      draft: { goal: '草稿', depends_on: ['survey'] },
      note_a: { goal: '独立备注甲, 与 draft 无依赖关系, 纯闭包外填充节点' },
      note_b: { goal: '独立备注乙, 与 draft 无依赖关系, 纯闭包外填充节点' },
      note_c: { goal: '独立备注丙, 与 draft 无依赖关系, 纯闭包外填充节点' },
      note_d: { goal: '独立备注丁, 与 draft 无依赖关系, 纯闭包外填充节点' },
    });
    const patchPrompts: string[] = [];
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        const userC = req.messages.find((m) => m.role === 'user')?.content;
        patchPrompts.push(typeof userC === 'string' ? userC : '');
        return { text: JSON.stringify({ patch: SAME_DRAFT_PATCH }), usage: { in: 5, out: 5 } };
      }
      const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(prompt);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(wideBlamePlan, escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)));
    expect(r.verification!.pass).toBe(true);
    expect(patchPrompts).toHaveLength(1);
    const req = patchPrompts[0]!;
    // 闭包节点 (仅 draft, 无下游依赖者) 全文入请求
    expect(req).toContain('"草稿"');
    // 闭包外 4 个 note 节点只以 `id: goal首行` 单行清单出现, 不带全文对象 (字节冻结, D-2 前置证据)
    for (const id of ['survey', 'note_a', 'note_b', 'note_c', 'note_d']) {
      expect(req).toMatch(new RegExp(`${id}: `));
      expect(req).not.toMatch(new RegExp(`"${id}":\\s*\\{`));
    }
    // 差量请求严格小于整图 JSON (G-1 字面判据): 对照基线 = 改前 tryPatchReplan 发的整图请求体
    // (同一 {name,nodes} 外壳 + 同一 JSON.stringify(_, null, 1) 格式; 剥掉 PLAN_BOUNDARY 与判词
    // 后缀 —— 二者对差量/整图两种请求体一视同仁, 唯一变量是差量 vs 整图)。
    const requestBody = req.slice(PLAN_BOUNDARY.length).split('\n\n[verification failure]')[0]!;
    const fullBody = JSON.stringify({ name: 'test-plan', nodes: wideBlamePlan.nodes }, null, 1);
    expect(requestBody.length).toBeLessThan(fullBody.length);
  });

  /** D-2 越界机器闸 (SDD 2026-08-11-l2-diff-replan G-2): 补丁 touch 闭包外节点 → 拒且回落整图。 */
  test('D-2: 补丁 touch 闭包外节点 → 越界闸拒 → 回落整图, 台账 replanMode=full 补丁 token 不丢账', async () => {
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        // 越界: 判词只责备 draft (闭包={draft,polish}), 补丁却 touch 闭包外的 survey
        return { text: JSON.stringify({ patch: { survey: { goal: '篡改的勘察' } } }), usage: { in: 4, out: 4 } };
      }
      if (sys.includes('CONDUCTOR')) {
        return {
          text: JSON.stringify({
            name: 'replanned',
            nodes: {
              survey: { goal: '勘察仓内事实' },
              draft: { goal: '草稿v2', depends_on: ['survey'] },
              polish: { goal: '打磨', depends_on: ['draft'] },
            },
          }),
          usage: { in: 10, out: 10 },
        };
      }
      const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(prompt);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      makeConfig(generate, { verifier: makeBlameVerifier(BLAME_FENCE_DRAFT), conductorEscalationModel: 'blamex:strong', maxPlanRetries: 1 }),
    );
    expect(r.verification!.pass).toBe(true);
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    // 越界补丁 (maxPlanRetries+1=2 次尝试) 全被闸拒 → 回落整图 conductor
    expect(ledger!.replanMode).toBe('full');
    // 补丁尝试的 token (2×{4,4}) + 整图重灌 ({10,10}) 全入账, 回落不丢补丁那段花费
    expect(ledger!.replanTokens).toEqual({ in: 4 * 2 + 10, out: 4 * 2 + 10, cacheHit: 0 });
  });

  test('G-2: 反馈只进被责备节点重跑 prompt; 非责备节点 prompt 与上轮逐字节相同 (D-3)', async () => {
    const { generate, promptLog } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)));
    expect(r.verification!.pass).toBe(true);
    const surveyPrompts = promptLog.filter((p) => p.id === 'survey').map((p) => p.prompt);
    const draftPrompts = promptLog.filter((p) => p.id === 'draft').map((p) => p.prompt);
    // 闭包外节点不重跑 → 不存在第二份 prompt; 其轮 2 输入面逐字节未变 ⟸ 指纹命中 (skipped=true):
    // 复用节点引擎不建 prompt, 字节级证据落在指纹上 — 共享祖先 spec 若被碰, 指纹必变、必重跑 → 本行红。
    expect(surveyPrompts).toHaveLength(1);
    expect(r.results.survey!.skipped).toBe(true);
    // 被责备节点: 重跑 prompt 带冻结的 append 段 (契约 e): \n\n---\n[verifier 打回 · 第 N 轮]\n{reason}\n
    expect(draftPrompts).toHaveLength(2);
    expect(draftPrompts[0]!).not.toContain('verifier 打回');
    expect(draftPrompts[1]!).toMatch(/---\n\[verifier 打回 · 第 \d+ 轮\]\n草稿验收段判卷命令不合格/);
  });

  test('G-3: 散文打回 (无围栏) → 现行整轮路径行为不变 (SDD INV-1), 台账 blameSize=0', async () => {
    const { generate, calls } = makeBlameGenerate({ draft: { goal: '草稿v2', depends_on: ['survey'] } });
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      escConfig(generate, makeBlameVerifier('草稿输出不合格 (纯散文, 不指认节点)')),
    );
    expect(r.verification!.pass).toBe(true);
    // 与现行引擎同构 (同 G-21 既有用例形状): 未变节点 D-21 复用, 变化节点重跑, polish 因前驱失效重跑
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1);
    expect(r.results.survey!.skipped).toBe(true);
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    // 解析失败走整轮: 台账记 blameSize: 0 (契约 f: 不新增分支)
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    expect(ledger!.blameSize).toBe(0);
  });

  test('G-4: blame 节点进 poisoned 集 → 指纹与上轮完全相同也不得复用 (D-4 回归)', async () => {
    // 轮 2 补丁把 draft 重写为与轮 1 逐字节相同 → 指纹相同; 若毒集闸失效, computeReuse 必当复用 —
    // 断言它仍重跑 = 闸活着 (毒集压过指纹, 这是「打回节点不得复用」的可执行判)。
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)));
    expect(r.verification!.pass).toBe(true);
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    expect(r.results.draft!.status).toBe('done'); // 重跑产物, 非上轮注入
    expect(r.reusedNodes ?? []).not.toContain('draft');
    expect(r.reusedNodes ?? []).not.toContain('polish');
  });

  test('反向自检 oracle: 只有草稿错、勘察正确; 勘察重跑即红 (G-1 负控 / SDD G-5)', async () => {
    // 已知样本: survey(勘察) 正确、draft(草稿) 错 → 判词只责备 draft → survey 必须零重跑。
    // 若勘察节点发生重跑 → 本测试红 (ground truth 可人工核对: 勘察没错, 重跑即实现错)。
    // 证伪方式: 「若 INV-1 被破 (出现第二套匹配让错指节点也'复用'), 或闭包过滤失效, 本测试绿 → 实现错」
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)));
    expect(r.verification!.pass).toBe(true);
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1);
    expect(r.results.survey!.skipped).toBe(true);
    expect(r.results.survey!.status).toBe('done');
    expect(r.results.survey!.output).toBe('out:survey'); // 上轮正确产出原样注入
    // 负控: 判词把勘察也点进 blame → 勘察语义未变也在闭包内 → 毒集压过指纹, 必须重跑
    const fenceBoth =
      '勘察也被点名。\n```blame\n[{"node": "draft", "reason": "草稿错"}, {"node": "survey", "reason": "勘察被误点"}]\n```\n';
    const { generate: g2, calls: c2 } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r2 = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(g2, makeBlameVerifier(fenceBoth)));
    expect(r2.verification!.pass).toBe(true);
    expect(c2.filter((c) => c === 'survey')).toHaveLength(2);
    expect(r2.reusedNodes ?? []).not.toContain('survey');
  });
  test('G-5: 畸形 blame 围栏 → fail-open 现行整轮路径 (零闭包语义), 已知良好调查节点零重跑', async () => {
    // INV-2 反向 oracle (必需注释): survey(勘察) 是本测试图的**已知良好节点**, 轮 2 补丁不改它 —
    // 它**任何一次重跑都让本测试 (G-5) 红**。为什么: 畸形围栏必须 fail-open (SDD Non-goals:
    // 责备集解析失败永远回退现行整轮), 整轮路径下 survey 语义未变 → D-21 指纹复用 → 零 LLM 注入
    // (skipped=true)。若实现把坏 JSON 误当有效责备集 (或解析失败后仍猜一个闭包把 survey 卷进去),
    // survey 必重跑 → G-5 红。即以「已知良好调查节点零重跑」钉死 fail-open 边界。
    const { generate, calls } = makeBlameGenerate({ draft: { goal: '草稿v2', depends_on: ['survey'] } });
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      escConfig(generate, makeBlameVerifier('不合格。\n```blame\n[{not valid json}]\n```\n')),
    );
    expect(r.verification!.pass).toBe(true);
    // 围栏坏 = 视同散文 (G-3 同形): 无闭包语义, 台账 blameSize/closureSize 均为 0 (不猜, 不新增分支)
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1); // 已知良好节点零重跑 (反向 oracle)
    expect(r.results.survey!.skipped).toBe(true);
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2); // 补丁改了 draft → 重跑
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2); // draft 指纹变 → 前驱失效重跑
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    expect(ledger!.blameSize).toBe(0);
    expect(ledger!.closureSize).toBe(0);
  });

  test('D-1: 结构化责备集解析 — node+artifact 条目经引擎 API 面解出; 引擎只吃 node 条目 (artifact 保留槽不接线)', async () => {
    // parseBlameVerdict 从引擎再导出面取 (契约 §10) — 单一实现 (blame.ts), 无第二套解析。
    // 契约 (b): 条目 node|artifact 二选一; artifact 是保留槽 (resolveBlameEntries 冻死不复活) —
    // 引擎侧 `'node' in e` 过滤后只数 node 条目。混合责备: node 驱动定点闭包, artifact 被丢弃 (不猜映射)。
    const fenceMixed =
      '草稿验收不合格。\n```blame\n' +
      '[{"node": "draft", "reason": "草稿错"}, {"artifact": "out:draft", "reason": "产物也错"}]\n```\n';
    expect(parseBlameVerdict(fenceMixed)).toEqual([
      { node: 'draft', reason: '草稿错' },
      { artifact: 'out:draft', reason: '产物也错' },
    ]);
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(blameGraphPlan(), escConfig(generate, makeBlameVerifier(fenceMixed)));
    expect(r.verification!.pass).toBe(true);
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1);
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    const ledger = readBlameRetry(r);
    expect(ledger!.blameSize).toBe(1); // 台账只数 node 条目
    expect(ledger!.closureSize).toBe(2); // {draft, polish}
  });

  test('D-1 fail-open: 纯 artifact 责备集 (无 node 条目) → 引擎侧过滤后空 → 视同散文整轮 (INV-1)', async () => {
    // artifact→node 映射 (resolveBlameEntries) 是冻结死码 — 引擎 `'node' in e` 过滤掉全部条目 →
    // inGraph 空 → closure null → fail-open 整轮 (与 G-3 散文同形): 台账 blameSize/closureSize 0, 无定点语义。
    // 若实现复活 artifact→node 映射让纯 artifact 打回也定点, 本测试红 = 契约冻结外的新行为。
    const fenceArtifactOnly = '产物验收不合格。\n```blame\n[{"artifact": "out:draft", "reason": "产物错"}]\n```\n';
    const { generate, calls } = makeBlameGenerate({ draft: { goal: '草稿v2', depends_on: ['survey'] } });
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      escConfig(generate, makeBlameVerifier(fenceArtifactOnly)),
    );
    expect(r.verification!.pass).toBe(true);
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1); // 已知良好节点零重跑
    expect(r.results.survey!.skipped).toBe(true);
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2); // 补丁改了 draft → 重跑
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    expect(ledger!.blameSize).toBe(0);
    expect(ledger!.closureSize).toBe(0);
  });

  test('G-1 精确闭包: blame draft → 恰 {draft, polish, publish} 失效; 非闭包 research 节点 100% 复用零重抓 (必需注释)', async () => {
    // 必需注释 (SDD G-5 证伪方式, 落到 research 节点): research 是**已知正确的调研节点**
    // (executor:'research', 真 web 抓取 — 实测一次 104s+token) — 它**任何一次重跑都让本测试红**。
    // 为什么: 判词只责备 draft → 失效闭包必须恰为 {draft, polish, publish}; research 在图外、语义未变 →
    // D-21 指纹复用 (skipped=true, 零 LLM 零 re-fetch)。若实现把闭包算错 / 复用判定分叉 (INV-2) /
    // 毒集误伤 research → 它必重跑 → 本测试红。即以「正确 research 节点零重跑」钉死精确闭包边界。
    const researchCalls: string[] = [];
    let researchRunnerCount = 0;
    const { generate, calls } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(
      plan({
        survey: { goal: '勘察仓内事实' },
        research: { goal: '调研正确事实', executor: 'research' },
        draft: { goal: '草稿', depends_on: ['survey'] },
        polish: { goal: '打磨', depends_on: ['draft'] },
        publish: { goal: '发布', depends_on: ['polish'] },
      }),
      makeConfig(generate, {
        verifier: makeBlameVerifier(BLAME_FENCE_DRAFT),
        conductorEscalationModel: 'blamex:strong',
        researchRunner: async (input) => {
          researchRunnerCount++;
          researchCalls.push(input.question);
          return { text: '研究终稿: 正确事实', usage: { in: 100, out: 50 }, sources: ['https://example.com/ok'] };
        },
      }),
    );
    expect(r.verification!.pass).toBe(true);
    // 精确闭包 {draft, polish, publish}: 各重跑一次 (轮 1 + 轮 2)
    expect(calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(calls.filter((c) => c === 'polish')).toHaveLength(2);
    expect(calls.filter((c) => c === 'publish')).toHaveLength(2);
    // 闭包外: survey 轮 2 零 LLM; research 轮 2 零 LLM **且零 re-fetch** (researchRunner 只进一次)
    expect(calls.filter((c) => c === 'survey')).toHaveLength(1);
    expect(r.results.survey!.skipped).toBe(true);
    expect(researchRunnerCount).toBe(1);
    expect(researchCalls).toEqual(['调研正确事实']); // 轮 1 只问一次, 轮 2 复用不再问
    expect(r.results.research!.skipped).toBe(true);
    expect(r.results.research!.status).toBe('done');
    expect(r.results.research!.output).toBe('研究终稿: 正确事实'); // 上轮正确产出原样注入
    expect(r.results.research!.usage).toEqual({ in: 0, out: 0 }); // 复用零计费
    expect((r.reusedNodes ?? []).sort()).toEqual(['research', 'survey']);
    // 台账: closureSize 恰为 3 (不是整图 5), reuseHits 恰为 2 (survey + research)
    const ledger = readBlameRetry(r);
    expect(ledger).toBeDefined();
    expect(ledger!.blameSize).toBe(1);
    expect(ledger!.closureSize).toBe(3);
    expect(ledger!.reuseHits).toBe(2);
  });

  test('INV-1: 复用判定全仓唯一 — dag 引擎无第二套指纹/匹配实现 (SDD INV-2)', async () => {
    // 语义键单一真源 = plan-passes/semantic-key.ts (nodeFieldsKey → merkleFingerprints → computeReuse,
    // D-20 判重与 D-21 跨轮复用同吃, 其头注释自述「单一真源」)。确定性回归: 引擎不得自带第二套
    // 「语义字段序列化 / 指纹 / 匹配」实现 —— 出现 = 复用判定分叉 = 打回定点与判重各说各话。
    const engineSrc = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
    // ① 引擎文件内不得定义键/指纹/匹配函数 (三个特征符号, 定义即第二套实现)。
    expect(engineSrc).not.toMatch(/\bfunction\s+(nodeFieldsKey|merkleFingerprints|computeReuse)\s*\(/);
    // ② 复用机器进口唯一: 名字带 semantic 的 import 只许指向单一真源 (多一条 = 平行实现, 红)。
    const semanticImports = [...engineSrc.matchAll(/^import\b[^\n]*\bfrom\s*'([^']*semantic[^']*)'/gm)].map((m) => m[1]!);
    expect(semanticImports).toEqual(['../plan-passes/semantic-key']);
    // ③ 真源自身: nodeFieldsKey 恰好定义一次 (单一真源, 不复制)。
    const keySrc = readFileSync(new URL('../plan-passes/semantic-key.ts', import.meta.url), 'utf8');
    expect((keySrc.match(/export function nodeFieldsKey/g) ?? []).length).toBe(1);
  });

  // ── D-6 同因熔断 (SDD 2026-08-11-inner-loop-v2, O-2 聚类定 P0) ──────────────
  // 反向自检 (实跑过): 删掉 engine.ts 的 `if (blameKey === lastBlameKey)` 分支 → 本用例
  // 变成跑满 maxEscalations 轮 (circuitBroken 恒 undefined) → 断言 circuitBroken===true 当场红。
  test('D-6: 连续两轮同一根因 → 熔断停止重试, 标 circuitBroken, 不跑满 maxEscalations', async () => {
    let vcount = 0;
    const stubbornVerifier: NonNullable<ExecutorDagConfig['verifier']> = async () => {
      vcount++;
      return { pass: false, reason: '草稿验收段判卷命令不合格 (第 X 轮同一根因)', usage: { in: 1, out: 1 } };
    };
    const { generate } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      makeConfig(generate, { verifier: stubbornVerifier, conductorEscalationModel: 'blamex:strong', maxEscalations: 3 }),
    );
    expect(r.verification!.circuitBroken).toBe(true);
    expect(r.verification!.pass).toBe(false);
    expect(vcount).toBeLessThan(4); // 熔断提前停 → verifier 调用数 < 首+3
  });

  test('D-6 零回归: maxEscalations=1 (缺省) 时熔断永不触发', async () => {
    const { generate } = makeBlameGenerate(SAME_DRAFT_PATCH);
    const r = await runExecutorDagWithPlan(
      blameGraphPlan(),
      escConfig(generate, makeBlameVerifier(BLAME_FENCE_DRAFT)),
    );
    expect(r.verification!.circuitBroken).toBeUndefined();
    expect(r.verification!.pass).toBe(true);
  });
});

// ── 执行段禁调研 (owner 2026-08-11 裁; 内环 v2 D-2 / 控制面 D-2③ 的接线那一半) ─────────
//
// 「执行期不调研」此前只是散文。这一族把它变成会红的闸: 执行段 (`goal-execute`) 的 conductor
// 画出 `executor:"research"` 子节点 → 整份子图当场拒; 契约段 (`goal-contract`) 照旧允许。
//
// **两臂只差一个变量**: plan.name。节点 id、子图 JSON、config 全部逐字相同 —— 差两个就分不清
// 是哪个在起作用 (仓规「单一变量」)。
describe('执行段禁调研 (段的分辨面 = plan.name)', () => {
  /** conductor 每次都吐这张图: 一个调研 + 一个照着实装。契约段合法, 执行段非法。 */
  const SUB_WITH_RESEARCH = JSON.stringify({
    name: 'sub',
    nodes: {
      dig: { goal: '查一下别人怎么做', executor: 'research' },
      impl: { goal: '照着实装', executor: 'agent', depends_on: ['dig'] },
    },
  });

  /** 两臂共用: 节点 id 恒为 'execute', 只有 plan.name 变。 */
  const segPlan = (name: string): ConductorPlan =>
    ({ name, nodes: { execute: { goal: '把这件事干完', executor: 'conductor' } } }) as ConductorPlan;

  function makeSegGenerate(): { generate: GenerateFn } {
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      // conductor 那一发 (规划请求带 PLAN_BOUNDARY 冻结前缀); 其余是 leaf。
      if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!)) {
        return { text: SUB_WITH_RESEARCH, usage: { in: 1, out: 1 } };
      }
      return { text: `out:${leafId(user)}`, usage: { in: 1, out: 1 } };
    };
    return { generate };
  }

  /** 真跑过几次 research —— 「拒在展开期」与「跑了才发现」的区别就在这个数上。 */
  const countingResearchRunner = (
    calls: { n: number },
  ): NonNullable<ExecutorDagConfig['researchRunner']> => async () => {
    calls.n++;
    return { text: '调研终稿', usage: { in: 1, out: 1 }, sources: ['https://example.com/a'] };
  };

  test('执行段: conductor 画出 research 子节点 → 子图整份被拒, 错误可教, research 一次都没跑', async () => {
    const { generate } = makeSegGenerate();
    const calls = { n: 0 };
    const r = await runExecutorDagWithPlan(
      segPlan('goal-execute'),
      makeConfig(generate, { researchRunner: countingResearchRunner(calls) }),
    );
    expect(r.results.execute!.status).toBe('failed');
    expect(r.results.execute!.output).toContain('forbidden'); // 状态出现在节点输出里 (可复盘)
    expect(r.results.execute!.output).toContain('执行段禁调研');
    expect(r.results.execute!.output).toContain('STALLED 开票交人'); // 教到"那该怎么办"
    expect(calls.n).toBe(0); // 拒在展开期 —— 不是跑完一轮调研再说
    // fail-closed: 合法的兄弟 (impl) 也不许溜进来跑
    expect(Object.keys(r.results).filter((k) => k.startsWith('execute::'))).toEqual([]);
  });

  test('**阴性对照** 契约段: 同一份子图照旧允许 research (契约期的调研是正当的, 且真跑了)', async () => {
    const { generate } = makeSegGenerate();
    const calls = { n: 0 };
    const r = await runExecutorDagWithPlan(
      segPlan('goal-contract'),
      makeConfig(generate, { researchRunner: countingResearchRunner(calls) }),
    );
    expect(r.results.execute!.status).toBe('done');
    expect(r.results.execute!.output).not.toContain('forbidden');
    expect(calls.n).toBe(1); // research 子节点真的跑了
  });

  // 反向自检 (实跑过, 2026-08-11):
  //   ① 把 engine.ts 的 `plan!.name === EXECUTE_SEGMENT_PLAN_NAME` 改成恒 true
  //      → 阴性对照那条当场红 (契约段的 research 被误伤: status failed, calls.n=0)。
  //   ② 把它改成恒 false (等于不传禁单, 即改动前的行为)
  //      → 上面那条执行段用例当场红 (status 变 done, calls.n=1 —— 调研照跑)。
  // 两条互为证伪, 任一方向的接线错误都留不住绿。
});

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

/**
 * S1 埋点 (c): 内环跑完才发现超预算 —— 与「开轮前拦下」同一个 kind, 不同的证据文案。
 *
 * 为什么要单独钉这条: 2026-08-11 run d39b559e 内环跑 131.3min 而预算 90min,
 * `_loop-execute.json` 里 budget-exhausted 计数 = 0 —— 因为已有的预算闸只在**下一轮开跑前**查
 * (engine.ts:1730 `if (round > startRound)`), 单轮本身跑穿预算、当轮就收敛的场景一次都不查。
 * 这条闸补的正是"轮内跑完才发现超了"这一格 —— **只报不拦**, 判定/收敛结果一个字不改
 * (owner 冻结: 不许把判点搬进轮里, 不许提前 break, 不许改阈值)。
 *
 * ★ 证伪方式: 把新增的轮后留痕整段删掉 (或不写 journal) → journal.stop 缺席, 本条必红。
 */
describe('内环跑完才发现超预算 (只报不拦, S1 埋点)', () => {
  /** conductor 单轮就展开出的极简子图: 一个默认执行器 (leaf) 的叶子。 */
  const SUB_QUICK = JSON.stringify({
    name: 'sub',
    nodes: { step: { goal: '一步搞定' } },
  });

  test('★ 单轮本身跑穿 ms 预算 → journal 记一条 budget-exhausted, 证据文案区分「跑完才发现」', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-budget-'));
    try {
      const mgr = new CheckpointManager(root);
      const generate: GenerateFn = async (req) => {
        const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
        if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!)) {
          await sleep(60); // 这一轮自己就花掉 60ms, 远超下面 10ms 的预算上限
          return { text: SUB_QUICK, usage: { in: 1, out: 1 } };
        }
        return { text: `out:${leafId(user)}`, usage: { in: 1, out: 1 } };
      };
      const r = await runExecutorDagWithPlan(
        plan({ A: { goal: '单轮胖轮子, 轮内自己就超预算', executor: 'conductor', max_rounds: 1 } }),
        makeConfig(generate, {
          loopBudget: { ms: 10 },
          continuity: { manager: mgr, runId: 'r-budget-post', repoRoot: root },
        }),
      );
      // 只报不拦: 节点该怎么收敛还怎么收敛, 判定逻辑一个字没变。
      expect(r.results.A!.status).toBe('done');
      const journal = mgr.loadNodeLoopJournal('r-budget-post', 'A');
      expect(journal?.stop).toBeDefined();
      expect(journal!.stop!.kind).toBe('budget-exhausted');
      // 与「开轮前拦下」那条 (evidence: "预算用尽: 已花/已用 ... (第 N 轮后)") 刻意不同文案 ——
      // 这条是"这一轮已经真的跑完了才发现超" (atRound = 真正跑完的那一轮, 不是没开成的下一轮)。
      expect(journal!.stop!.evidence).toContain('跑完');
      expect(journal!.stop!.atRound).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 空转熔断 (spin-fused, 2026-08-14) ────────────────────────────────────────
// 反向自检: 把 engine.ts 里 `if (r.spinFused)` 那块删掉 → 第一条当场红 (熔断的 leaf 会被当
// 正常完成放行, 半截输出进下游 —— 正是 2026-08-13 夜 execute(conductor) 空转 1h51 的形状)。
describe('空转熔断 (drift fuse → 节点 spin-fused)', () => {
  test('★ agentRunner 报 spinFused → 节点 failed + failureKind spin-fused, 已落盘产物保留在 filesTouched', async () => {
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

// ── D-21 复用闸 (2026-08-14): replan 必须带复用 ─────────────────────────────
// 实测背景: f2af8514 execute 相位补丁失败落到整图重规划, conductor 把全部节点重写 →
// 指纹 0 命中 → 上轮 37 个 done 全部重烧 (35 节点 reused 0, 33.1M leaves-in 只换来 7 done)。
// 反向自检: 把 engine.ts planAndExecute 里 D-21 复用闸那块删掉 → 第一条当场红
// (零复用的重写图会被直接放行执行, 一次拒回都没有)。
describe('D-21 复用闸 (整图重规划零复用 → 拒回重问)', () => {
  const priorPlan: ConductorPlan = {
    name: 'prior',
    nodes: {
      a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] }, c: { goal: '丙' }, d: { goal: '丁' }, e: { goal: '戊' },
    },
  };
  const priorResults = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((id) => [
      id,
      { id, status: 'done', kind: 'inproc', output: `out:${id}`, deps: [], usage: { in: 1, out: 1 } },
    ]),
  ) as Record<string, import('./types').LeafResult>;
  const REWRITTEN = JSON.stringify({ name: 'rewrite', nodes: { x1: { goal: '全新1' }, x2: { goal: '全新2', depends_on: ['x1'] } } });
  const PRESERVED = JSON.stringify({
    name: 'fixed',
    nodes: {
      a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] }, c: { goal: '丙' }, d: { goal: '丁' }, e: { goal: '戊' },
      fix: { goal: '补一步', depends_on: ['e'] },
    },
  });
  const planMarker = PLAN_BOUNDARY.trim().split('\n')[0]!;

  test('★ 第一版整图重写零复用 → 拒回带上轮节点清单; 第二版保留节点 → 复用生效只跑新增', async () => {
    const planReqs: string[] = [];
    const leafCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(planMarker)) {
        planReqs.push(user);
        return { text: planReqs.length === 1 ? REWRITTEN : PRESERVED, usage: { in: 1, out: 1 } };
      }
      leafCalls.push(leafId(user));
      return { text: `out:${leafId(user)}`, usage: { in: 1, out: 1 } };
    };
    const { runExecutorDag } = await import('./engine');
    const r = await runExecutorDag('把失败的一步修好', makeConfig(generate), { plan: priorPlan, results: priorResults });
    expect(planReqs.length).toBe(2); // 第一版被拒, 重问了一次
    expect(planReqs[1]!).toContain('零复用'); // 拒回原因可教
    expect(planReqs[1]!).toContain('a, b, c, d, e'); // 带上轮节点清单
    expect(r.reusedNodes?.length ?? 0).toBe(5); // a–e 全复用
    expect(leafCalls).toEqual(['fix']); // 只有新增节点真跑了
  });

  test('重问后仍零复用 → fail-open 放行 (闸不许把 run 卡死), 全部重跑', async () => {
    let planCalls = 0;
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(planMarker)) {
        planCalls++;
        return { text: REWRITTEN, usage: { in: 1, out: 1 } };
      }
      return { text: `out:${leafId(user)}`, usage: { in: 1, out: 1 } };
    };
    const { runExecutorDag } = await import('./engine');
    const r = await runExecutorDag('修', makeConfig(generate), { plan: priorPlan, results: priorResults });
    expect(planCalls).toBe(2); // 拒回一次后放行
    expect(r.results.x1!.status).toBe('done');
    expect(r.reusedNodes?.length ?? 0).toBe(0);
  });

  test('上轮 done 不足阈值 (<4) → 闸不触发, 重写图直接放行 (小图重烧便宜, 不值一次重问)', async () => {
    let planCalls = 0;
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(planMarker)) {
        planCalls++;
        return { text: REWRITTEN, usage: { in: 1, out: 1 } };
      }
      return { text: `out:${leafId(user)}`, usage: { in: 1, out: 1 } };
    };
    const smallPrior = {
      plan: { name: 'p', nodes: { a: { goal: '甲' }, b: { goal: '乙' } } } as ConductorPlan,
      results: Object.fromEntries(
        ['a', 'b'].map((id) => [id, { id, status: 'done', kind: 'inproc', output: 'o', deps: [], usage: { in: 1, out: 1 } }]),
      ) as Record<string, import('./types').LeafResult>,
    };
    const { runExecutorDag } = await import('./engine');
    await runExecutorDag('修', makeConfig(generate), smallPrior);
    expect(planCalls).toBe(1);
  });
});

// ── crash 入账 (记账完整性闸, 2026-08-14) ───────────────────────────────────
// 实测背景: f2af8514 终段崩掉 (infra-error), 该相位 usage 无记录 —— onComplete 只在正常返回
// 时触发。反向自检: 把 engine.ts runDagInternal 外包那层 try/catch 删掉 → 第一条当场红
// (onComplete 一次都不会被调, recorded 空)。
describe('crash 入账 (中途抛错也要写部分记录)', () => {
  registerProvider('crashx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  test('★ 升级重规划轮炸 → onComplete 收到部分记录 (round-1 usage 下限 + crash 原因), 错误照抛', async () => {
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes('[verification failure]')) throw new Error('炸在补丁轮');
      const id = leafId(user);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const recorded: import('./types').ExecutorDagResult[] = [];
    let thrown: Error | null = null;
    try {
      await runExecutorDagWithPlan(
        plan({ A: { goal: '甲' } }),
        makeConfig(generate, {
          verifier: async () => ({ pass: false, reason: '不合格', usage: { in: 1, out: 1 } }),
          conductorEscalationModel: 'crashx:strong',
          onComplete: async (r) => {
            recorded.push(r);
          },
        }),
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toContain('炸在补丁轮'); // 错误没有被吞
    expect(recorded.length).toBe(1); // 但账写上了
    expect(recorded[0]!.verification?.pass).toBe(false);
    expect(recorded[0]!.verification?.reason).toContain('crash 入账');
    expect(recorded[0]!.verification?.reason).toContain('炸在补丁轮');
    expect(recorded[0]!.results.A?.status).toBe('done'); // round-1 的执行产出保留在记录里
  });

  test('规划期就炸 (exec 从未赋值) → 不编空记录 (缺席 ≠ 0), 错误照抛', async () => {
    const generate: GenerateFn = async () => {
      throw new Error('规划期炸');
    };
    const recorded: unknown[] = [];
    let thrown: Error | null = null;
    try {
      const { runExecutorDag } = await import('./engine');
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
