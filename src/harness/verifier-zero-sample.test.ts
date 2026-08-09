/**
 * verifier 的 **invalid ≠ 0 闸** (VER-2b): 零节点产出的跑永不算通过。
 *
 * ## 洞在哪
 *
 * VER-2 原本写的是 `leaves.length > 0 && 全部 failed → pass:false`。那个 `> 0` 让
 * **一个 leaf 都没跑完**的情形从闸边上溜过去 —— verifier 于是拿着一份 `plan: X · 0 nodes`
 * 的空摘要去问模型, 而 pass 是模型说了算 (`v.pass === true`)。一份什么都没有的摘要
 * 判成 pass 完全可能, 而那正是"什么都没量到"的绿。
 *
 * 同一条判据的另一半 `run-outcome.ts` 早就写对了 ——「空图不编 success, 什么都没跑与全跑过了
 * 不是一回事」。这条闸补的是 verifier 这一侧。
 *
 * ## 反向自检 —— 去掉闸, 这两条测试怎么红
 *
 * 把 `verifier.ts` 里 `leaves.length === 0` 那个提前返回删掉 (退回 `leaves.length > 0 &&` 的合写):
 * · 「零节点」那条从 `pass:false` 变成 **`pass:true`** —— 因为它会去调那个"睁眼说通过"的假模型,
 *   而这正是洞本身: 判词来自一个只看见 0 nodes 的模型;
 * · 「全 failed」那条**不会**变 —— 它是对照, 钉住 VER-2 原行为没被这次改动碰坏
 *   (两条判词还必须**不一样**: 「没跑」与「跑了全挂」是两件事, 合成一句就再也分不开了)。
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultVerifier } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: '做点什么', executor: 'leaf' } } };

/** 睁眼说通过的假模型 —— 闸若不在, 判词就由它给出。 */
let calls = 0;
const alwaysPass = createDefaultVerifier({
  verifierModel: 'fake:verifier',
  callModelFn: (async () => {
    calls++;
    return { text: '', parsed: { pass: true, reason: '看起来没问题' }, usage: { in: 1, out: 1 } };
  }) as never,
});

describe('verifier: 0 有效样本 ≠ 通过', () => {
  test('★ 零节点产出 → pass:false, 且**不烧那次调用** (证据不足到不必问模型)', async () => {
    calls = 0;
    const v = await alwaysPass({ task: 't', plan, results: {} });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('0 有效样本');
    expect(calls).toBe(0);
  });

  test('★ 对照: 跑了但全 failed 仍走 VER-2, 且判词与「没跑」分得开', async () => {
    calls = 0;
    const failed = {
      a: { id: 'a', status: 'failed', kind: 'inproc', output: '', deps: [], usage: { in: 0, out: 0 } },
    } as unknown as Record<string, LeafResult>;
    const v = await alwaysPass({ task: 't', plan, results: failed });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('所有 leaf 执行失败');
    expect(v.reason).not.toContain('0 有效样本');
    expect(calls).toBe(0);
  });
});
