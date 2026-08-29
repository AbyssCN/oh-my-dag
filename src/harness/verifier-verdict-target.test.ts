/**
 * verifier 否决分型 —— INV-3 / GWT-3 (契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md` 切片 2)。
 *
 * 病例 (2026-08-29 晚 12 例 executable 真红逐例归因的 #6 / #7): leaf 写 shim 骗绿、leaf 写恒绿测试,
 * verifier 否决**判得对**, 但两类否决今天走同一条修复路 —— 正确出路是判据升级, 不是再烧一轮修实装。
 * 所以裁决必须自己说清打的是谁: `implementation` (产出没满足判据) 还是 `criterion` (判据本身量不出)。
 *
 * fail-open 的方向 (契约钉死): 缺席 / 非法值 ⇒ `implementation`。理由是老输出面 ——
 * 今天在跑的 verifier 只回 pass+reason, 它们必须继续按「实装错了」走原路, **现行为逐字节不变**。
 *
 * 边界诚实: 这里只钉「字段解析的分型规则 + 教法真在卷面上」。
 * 「模型是否判得准」是 LLM 行为面, 要 bench/probe 读数, 不在单测里装样子。
 *
 * 反向自检 (本片手做, 实跑过):
 *  · 把 verifier.ts schema 里的 `.catch('implementation')` 去掉 ⇒「乱值回落」那组当场红;
 *  · 把裁决归一化写成常量 `'criterion'` ⇒「显式 implementation 不被误改」当场红;
 *  · 删 prompt 里「打击对象」那一段 ⇒ 卷面那组当场红。
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultVerifier, VERIFIER_VERDICT_SCHEMA } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const plan: ConductorPlan = { name: 'p', nodes: { answer: { goal: '一句话回答', executor: 'leaf' } } };
const results: Record<string, LeafResult> = {
  answer: {
    id: 'answer', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 0, out: 0 },
  } as unknown as LeafResult,
};

/** 造一个「模型回什么就是什么」的 verifier: parsed 直接注入, 绕过模型层 schema —— 量的是裁决面自己的归一化。 */
function verifierReturning(parsed: unknown) {
  return createDefaultVerifier({
    verifierModel: 'fake:m',
    callModelFn: (async () => ({ text: '', parsed, usage: { in: 1, out: 1 } })) as never,
  });
}

/** 造一个记下卷面的 verifier (教法面用)。 */
function capturing() {
  let seen = '';
  const verifier = createDefaultVerifier({
    verifierModel: 'fake:m',
    callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
      seen = req.messages.map((m) => m.content).join('\n');
      return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
    }) as never,
  });
  return [verifier, () => seen] as const;
}

describe('否决分型 schema (VERIFIER_VERDICT_SCHEMA)', () => {
  test('GWT-3 正向: 只给 pass 与 reason 的旧输出 → target = implementation, 且 pass/reason 一字不动', () => {
    const r = VERIFIER_VERDICT_SCHEMA.safeParse({ pass: false, reason: '缺第 3 条要求' });
    expect(r.success).toBe(true);
    expect(r.data?.target).toBe('implementation');
    expect(r.data?.pass).toBe(false);
    expect(r.data?.reason).toBe('缺第 3 条要求');
  });

  test('GWT-3 反向: 显式 criterion 保留 —— 分型不是被默认值抹平的摆设', () => {
    const r = VERIFIER_VERDICT_SCHEMA.safeParse({ pass: false, reason: '判据恒绿', target: 'criterion' });
    expect(r.data?.target).toBe('criterion');
  });

  test('阴性半: 显式 implementation 不被误改成 criterion', () => {
    const r = VERIFIER_VERDICT_SCHEMA.safeParse({ pass: false, reason: '产出缺一节', target: 'implementation' });
    expect(r.data?.target).toBe('implementation');
  });

  test('乱值回落默认 (fail-open): 未知串 / null / 数字 / 大小写不符 一律 implementation, 且不拒解析', () => {
    for (const bad of ['garbage', 'IMPLEMENTATION', 'Criterion', null, 42, {}, []]) {
      const r = VERIFIER_VERDICT_SCHEMA.safeParse({ pass: false, reason: 'r', target: bad });
      expect(r.success).toBe(true);
      expect(r.data?.target).toBe('implementation');
    }
  });
});

describe('createDefaultVerifier 的裁决带分型', () => {
  test('模型只回 pass+reason → 裁决 target = implementation (老判卷官零改造照旧走修实装路)', async () => {
    const v = await verifierReturning({ pass: false, reason: '缺一节' })({ task: 't', plan, results });
    expect(v.target).toBe('implementation');
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('缺一节');
  });

  test('模型判 criterion → 裁决保留 criterion (切片 3 靠它转判据重建, 不许在这里被吞)', async () => {
    const v = await verifierReturning({ pass: false, reason: 'shim 骗绿', target: 'criterion' })({ task: 't', plan, results });
    expect(v.target).toBe('criterion');
  });

  test('模型回乱值 → 裁决回落 implementation (fail-open 在裁决面也成立, 不只在 schema)', async () => {
    const v = await verifierReturning({ pass: false, reason: 'r', target: '判据' })({ task: 't', plan, results });
    expect(v.target).toBe('implementation');
  });

  test('未结构化输出 (VER-1 保守 fail) → target = implementation, 判词逐字不变', async () => {
    const v = await verifierReturning(undefined)({ task: 't', plan, results });
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('verifier 未结构化输出 → 保守判不通过');
    expect(v.target).toBe('implementation');
  });

  test('零节点 (VER-2b) 与全 leaf 失败 (VER-2) 两条快路 → 同样 implementation, 判词逐字不变', async () => {
    const zero = await verifierReturning({ pass: true, reason: '不该被调到' })({ task: 't', plan, results: {} });
    expect(zero.reason).toBe('零节点产出 — 一个 leaf 都没跑完, 0 有效样本 ≠ 通过');
    expect(zero.target).toBe('implementation');

    const allFailed = await verifierReturning({ pass: true, reason: '不该被调到' })({
      task: 't',
      plan,
      results: { answer: { ...results.answer!, status: 'failed' } },
    });
    expect(allFailed.reason).toBe('所有 leaf 执行失败 — 计划无产出');
    expect(allFailed.target).toBe('implementation');
  });
});

describe('分型教法随卷', () => {
  test('卷面写明打击对象二选一 + criterion 的三种形态 + 拿不准取 implementation', async () => {
    const [verifier, seenPrompt] = capturing();
    await verifier({ task: '做一件事', plan, results });
    const paper = seenPrompt();
    expect(paper).toContain('打击对象');
    expect(paper).toContain('criterion');
    expect(paper).toContain('implementation');
    // criterion 的形态: 恒绿闸 / 可被 shim 游戏 / 判据命令指错路径 —— 一句话概括是「实装再对判据也量不出」。
    expect(paper).toContain('恒绿');
    expect(paper).toContain('shim');
    expect(paper).toContain('量不出');
    // 阴性半: 必须写明默认取 implementation, 否则「判据不好」会变成放过产出的万能借口。
    expect(paper).toContain('拿不准');
  });
});
