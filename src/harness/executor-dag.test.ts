/**
 * executor-dag 引擎核心测试 (SDD v2 dag-engine-fusion-refactor S1)。
 * 覆盖: G-1 ready-set 调度回归 · G-4 quorum fail-skip (D-7v2) · G-11v2 零回归。
 * 全部经 runExecutorDagWithPlan (预构造 plan, 跳过 conductor) + 注入 fake generate — 零真实 LLM。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './executor-dag';
import type { ConductorPlan } from './conductor-plan';
import type { ContentPart } from '../model/gateway';
import { registerProvider } from '../model/providers';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './executor-dag-types';

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
