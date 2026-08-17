/**
 * src/harness/seat-usage-coverage —— 归座规则覆盖闸。
 *
 * 这条闸钉的是:**新增/删除归座规则时覆盖面不许静默变化**。
 *
 * 两套真源是各自独立维护的 —— `seats.ts` 的 `SEATS` 数组(注册了哪些座位)与
 * `seat-usage.ts` 的 `TRACE_SEAT_RULES`(哪些 trace 标签归到哪个座)分别演化。
 * 任何一边动,另一边没跟上就会让某些座位既不在归座规则里、也没列入
 * `KNOWN_UNATTRIBUTABLE`,默默消失在台账之外 —— 这条闸在那种 drift 发生时报红。
 *
 * **证伪动作(亲手验过本闸真会红再交付)**:
 *   ① 删 `src/model/seat-usage.ts` 的 `TRACE_SEAT_RULES` 里 `[/^conductor:/, 'conductor']`
 *      这条 → unaccounted 集合断言红(多出 `'conductor'`,用例②挂);
 *      `conductor` 是单规则座位,删它集合立刻少一项,unaccounted 集合变大。
 *   ② 从 `src/model/seats.ts` 的 `SEATS` 数组里摘掉 `gate` →
 *      issue 八座 ALL_SEAT_IDS 注册断言红(gate 不再是注册座位,用例①挂)。
 *
 * **不**改任何既有文件(本闸只读两套真源做纯符号集合断言);
 * **不**落盘、**不**读 JSONL、**不**调模型、**不**联网。
 */
import { describe, expect, test } from 'bun:test';
import { ALL_SEAT_IDS } from '../model/seats';
import { KNOWN_UNATTRIBUTABLE, SEAT_USAGE_RULE_SEATS } from '../model/seat-usage';

// 实装冻结决策钉死的 issue 八座 —— conductor / escalation / gate / judge /
// verifier / agent / lens / leaf。detector **不是**注册座位(seats.ts 里没有),
// 它的模型调用借 leaf 桶(`traceName` 走 `^primitive-leaf:` / `^omd-leaf$` 等归 leaf 的规则),
// 所以清单上 detector 的位置由 leaf 顶替 —— 这条在注释里说清,不靠读者推理。
const ISSUE_EIGHT: readonly string[] = [
  'conductor',
  'escalation',
  'gate',
  'judge',
  'verifier',
  'agent',
  'lens',
  'leaf', // 顶替 detector:detector 的 send 都借 leaf 桶
];

// 勘察预期 —— 写死,不许从 ALL_SEAT_IDS 推出来:这条闸要的就是写死,否则
// SEATS 新加座位时这组会被牵着改,闸就失去「drift 必报」的意义。
const EXPECTED_UNACCOUNTED: readonly string[] = ['fusion', 'graft', 'overflow', 'continuity'];

describe('seat-usage coverage —— issue 八座必须全部注册', () => {
  test('★ issue 八座集合 ⊆ ALL_SEAT_IDS', () => {
    const registered = new Set(ALL_SEAT_IDS);
    // 证伪方式: 从 src/model/seats.ts 的 SEATS 数组里删掉 'gate'(或任一 issue 八座之一)→
    // 这条 assertEvery 立刻红;register 集合里少了那座,差集非空。
    const missing = ISSUE_EIGHT.filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });
});

describe('seat-usage coverage —— 机械对账(unaccounted 不许变)', () => {
  test('★ ALL_SEAT_IDS \\ (SEAT_USAGE_RULE_SEATS ∪ KNOWN_UNATTRIBUTABLE) === 写死的期望集', () => {
    const accounted = new Set<string>([...SEAT_USAGE_RULE_SEATS, ...KNOWN_UNATTRIBUTABLE]);
    const unaccounted = ALL_SEAT_IDS.filter((id) => !accounted.has(id));
    // 证伪方式: 删 src/model/seat-usage.ts 的 TRACE_SEAT_RULES 里
    // `[/^conductor:/, 'conductor']` 这一条(单规则座位,删一条集合立刻少一项)
    // → unaccounted 多出 'conductor',数组断言红;这是单规则座位,删一条必红。
    expect([...unaccounted].sort()).toEqual([...EXPECTED_UNACCOUNTED].sort());
  });
});