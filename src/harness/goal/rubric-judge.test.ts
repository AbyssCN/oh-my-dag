/**
 * goal/rubric-judge.test —— **R-2**:rubric 逐条判官,以及那道「冻检查不许恒绿」的闸。
 *
 * ## 承重的那一条
 *
 * `presented` **必须由判官回显重建**,不是把冻结那份喂回去。喂回去的话
 * `verifyFrozen(checklist, presented)` 就是自己比自己 —— **永远绿**,而它要抓的正是
 * 「判官漏判/改写/多编了条目」和「提示词把 checklist 截断了」这两种**验收步上的静默移球门**。
 *
 * ★J-3 就是这条闸的证伪:判官漏回显一条 ⇒ `presented` 与冻结份对不上 ⇒ 冻检查判红。
 * 把 `judgeRubric` 里的 `presented` 改成 `spec.items`,★J-3 当场变绿(闸失效)。
 *
 * | | 钉什么 |
 * |---|---|
 * | J-1 | 正常回显 ⇒ `presented` 逐字节等于冻结份,冻检查过;`traces` 逐条带 pass/reason |
 * | J-2 | 缺 generate/model ⇒ 返 `null`(整格缺席, 不编空 traces) + 钉住下游那道「零痕迹不许判成通过」 |
 * | J-3 | ★ 判官**漏一条** ⇒ `presented` 与冻结份不一致 ⇒ 冻检查判红(闸真的会红) |
 * | J-4 | ★ 判官**改写了 requirement** ⇒ 同上判红(改写也是漂) |
 * | J-5 | 判词不是 JSON / schema 不合 ⇒ 返 `null`,不抛 |
 * | J-6 | prompt 里写死了「原样回显」「逐条覆盖」「reason 不许空」三条硬要求 |
 * | J-7 | `maxFailures` 默认 **0**(全过才算过)—— 母契约未决项取最保守端 |
 */
import { describe, expect, test } from 'bun:test';
import { judgeRubric, rubricJudgePrompt, DEFAULT_RUBRIC_MAX_FAILURES } from './rubric-judge';
import { freezeRubric, verifyFrozen, settleRubric } from './rubric-spec';
import type { GenerateFn } from '../dag/types';

const SPEC = freezeRubric([
  { id: 'a', requirement: '有一个 README' },
  { id: 'b', requirement: 'README 里写了怎么跑测试' },
]);

/** 造一个回什么就是什么的 fake generate。 */
const fakeGen = (text: string): GenerateFn => (async () => ({ text, usage: { in: 1, out: 1 } })) as unknown as GenerateFn;

const twoItems = (over: Partial<{ id: string; requirement: string }>[] = [{}, {}]) =>
  JSON.stringify({
    items: [
      { id: 'a', requirement: '有一个 README', pass: true, reason: '证据里有 README.md', ...over[0] },
      { id: 'b', requirement: 'README 里写了怎么跑测试', pass: false, reason: '没看到跑测试那段', ...over[1] },
    ],
  });

describe('R-2 rubric 逐条判官', () => {
  test('★ J-1: 正常回显 ⇒ presented 与冻结份一致 (冻检查过), traces 逐条齐', async () => {
    const out = await judgeRubric(SPEC, '证据: 仓里有 README.md', { generate: fakeGen(twoItems()), model: 'p:m' });
    expect(out).not.toBeNull();
    expect(verifyFrozen(SPEC, out!.presented).ok, '正常回显不该判漂').toBe(true);
    expect(out!.traces).toHaveLength(2);
    expect(out!.traces[0]).toEqual({ itemId: 'a', pass: true, reason: '证据里有 README.md' });
    expect(out!.traces[1]!.pass).toBe(false);
  });

  test('★ J-2: 缺 generate/model ⇒ null (整格缺席, 交给调用方 fail-open, 不冒充判过)', async () => {
    expect(await judgeRubric(SPEC, 'x', {})).toBeNull();
    expect(await judgeRubric(SPEC, 'x', { model: 'p:m' })).toBeNull();
    // ⚠ 这里原本断言「空 traces 会被 settle 读成全过」—— **写错了, 实测是抛错**:
    // `rubric-spec.ts:116` 早就有「零痕迹不许判成通过」那道守卫。顺手把它钉住,
    // 因为它正是"返 null 而不是返空 traces"这条选择在下游的保险。
    expect(() => settleRubric([], { maxFailures: 0 })).toThrow('零痕迹不许判成通过');
  });

  test('★ J-3 (承重): 判官漏回显一条 ⇒ presented 与冻结份不一致 ⇒ 冻检查**判红**', async () => {
    const oneItem = JSON.stringify({ items: [{ id: 'a', requirement: '有一个 README', pass: true, reason: 'ok' }] });
    const out = await judgeRubric(SPEC, 'x', { generate: fakeGen(oneItem), model: 'p:m' });
    expect(out).not.toBeNull();
    const frozen = verifyFrozen(SPEC, out!.presented);
    expect(frozen.ok, '漏一条却判没漂 —— 那说明 presented 是把冻结份喂回去的, 闸恒绿').toBe(false);
  });

  test('★ J-4 (承重): 判官改写了 requirement ⇒ 同样判红 (改写也是漂)', async () => {
    const rewritten = twoItems([{ requirement: '有一个 readme 文件' }, {}]); // 大小写 + 措辞都变了
    const out = await judgeRubric(SPEC, 'x', { generate: fakeGen(rewritten), model: 'p:m' });
    expect(verifyFrozen(SPEC, out!.presented).ok).toBe(false);
  });

  test('★ J-5: 判词不是 JSON / schema 不合 ⇒ null, 不抛', async () => {
    expect(await judgeRubric(SPEC, 'x', { generate: fakeGen('我觉得都挺好的'), model: 'p:m' })).toBeNull();
    // reason 为空串 ⇒ schema 拒 (没理由的 yes/no 是投票不是判词)
    const emptyReason = JSON.stringify({ items: [{ id: 'a', requirement: '有一个 README', pass: true, reason: '' }] });
    expect(await judgeRubric(SPEC, 'x', { generate: fakeGen(emptyReason), model: 'p:m' })).toBeNull();
  });

  test('★ J-6: prompt 把三条硬要求写死了 (回显 / 逐条覆盖 / reason 不许空)', () => {
    const p = rubricJudgePrompt(SPEC, '证据');
    expect(p).toContain('原样回显');
    expect(p).toContain('逐条覆盖');
    expect(p).toContain('`reason` 不许为空');
    // 两条要求都进了 prompt (漏了就等于判官没看见那一条)
    for (const i of SPEC.items) expect(p).toContain(i.requirement);
  });

  test('★ J-7: maxFailures 默认 0 —— 全过才算过 (母契约未决项取最保守端)', () => {
    expect(DEFAULT_RUBRIC_MAX_FAILURES).toBe(0);
    const traces = [{ itemId: 'a', pass: true, reason: 'r' }, { itemId: 'b', pass: false, reason: 'r' }];
    expect(settleRubric(traces, { maxFailures: DEFAULT_RUBRIC_MAX_FAILURES }).pass).toBe(false);
    // 放宽到 1 就会过 —— 钉住这个默认值真的在起作用, 不是摆设
    expect(settleRubric(traces, { maxFailures: 1 }).pass).toBe(true);
  });
});
