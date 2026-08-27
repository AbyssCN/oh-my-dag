/**
 * 劣化自证闸 —— F2 片 2。
 *
 * 契约源:`docs/plan/2026-08-27-F2-rubric验收分型-执行契约.md` §INV-4 · §INV-5。
 *
 * ## 它是复用不是新造
 *
 * `acceptance-gate` 里早就有一道**判别力探针**:拿一份明显错的产物跑一遍验收命令,
 * 照样通过 = 对的答案和错的答案都满足它。本片做的是同一件事的另一种判法 ——
 * 「跑一条命令」换成「逐条判 yes/no」。语义、fail-open 口径、裁决形状全部照抄,不新造机制。
 *
 * ## INV-5:探针不认识分型
 *
 * `acceptance-gate.ts` 的文件头逐字写着「分型 → 本文件;本文件不认识分型」。
 * 所以本片加的函数只收**中性入参**(一组 id + yes/no),不 import 分型那一侧的任何东西,
 * 文件里也不出现任何分型 kind 字面量。把 checklist 拆成这个形状是**调用方**的活。
 *
 * ## 反向自检(每条真跑过一次)
 * · 把裁决改成恒返 `ok` → 「一条都没打红 → ring」当场红。
 * · 把「拿不到样本」改成硬拦(返 ring)→ 「fail-open 不拦」当场红。
 * · 把 `ring` 的判词去掉 → 「判词点名对与错都满足」当场红。
 */
import { describe, expect, test } from 'bun:test';
import {
  checklistDiscriminationVerdict,
  checklistDiscriminationReason,
  type ProbeItemOutcome,
} from './acceptance-gate';

const o = (id: string, pass: boolean): ProbeItemOutcome => ({ id, pass });

describe('劣化自证闸:RUBRIC_VACUOUS_REJECTED —— 打不红的 checklist 当场拒', () => {
  test('★ 劣化产物上一条都没被打红 → ring, 判词点名「对与错都满足」', () => {
    const v = checklistDiscriminationVerdict([o('r1', true), o('r2', true), o('r3', true)]);
    expect(v.status).toBe('ring');
    if (v.status === 'ring') {
      expect(v.why.length).toBeGreaterThan(0);
      expect(v.why).toContain('都满足');
    }
    // 改成恒返 ok 时这条当场红。
  });

  test('★ 劣化产物上有任意一条被打红 → ok (这份 checklist 分得出对错)', () => {
    expect(checklistDiscriminationVerdict([o('r1', true), o('r2', false), o('r3', true)]).status).toBe('ok');
    expect(checklistDiscriminationVerdict([o('r1', false)]).status).toBe('ok');
  });

  test('★ 全红也算 ok —— 探针只问「分不分得出」, 不问「分得多准」', () => {
    expect(checklistDiscriminationVerdict([o('r1', false), o('r2', false)]).status).toBe('ok');
  });
});

describe('劣化自证闸:fail-open —— 拿不到样本时不拦', () => {
  test('★ 样本缺席 (undefined) → fail_open 且带原样理由, 不是 ring', () => {
    const v = checklistDiscriminationVerdict(undefined);
    expect(v.status).toBe('fail_open');
    if (v.status === 'fail_open') expect(v.why.length).toBeGreaterThan(0);
    // 做成硬拦 (ring) 时这条当场红 —— 探针是加固不是前置条件。
  });

  test('★ 零条目 → 同样 fail_open, 不许静默判成 ok (仓规坑 ①: 没判 ≠ 判过了)', () => {
    const v = checklistDiscriminationVerdict([]);
    expect(v.status).toBe('fail_open');
  });
});

describe('劣化自证闸:string | null 包装与既有探针同形', () => {
  test('★ 通过探针 → null;判虚 → 一行拒因', () => {
    expect(checklistDiscriminationReason([o('r1', false)])).toBeNull();
    expect(checklistDiscriminationReason(undefined)).toBeNull(); // fail-open 也不拦
    const why = checklistDiscriminationReason([o('r1', true), o('r2', true)]);
    expect(typeof why).toBe('string');
    expect((why ?? '').length).toBeGreaterThan(0);
  });
});

describe('INV-5:探针不认识分型 (依赖方向单向)', () => {
  /**
   * ⚠ 判据在 RED 阶段被自己的前提咬了一次,原文记在这:
   *
   * 最初写的是「`acceptance-gate.ts` 里不出现 `'executable'` / `'exploratory'` / `'rubric'`
   * 任一字面量」。实测 `'exploratory'` **已经有 1 处** —— 但它是 `AcceptanceProbe` 那个
   * **探针裁决**联合的一格(「模型自己选的探索型,无探针无降级」),与分型联合是**两根轴**,
   * 只是恰好共用了这个词。这是 `CONTEXT.md` §1.2 那类一名多义,不是依赖方向反了。
   *
   * 改成判**真正的那件事**:不 import 分型那一侧,且不出现分型独有的 `'rubric'`。
   * (`'executable'` 同理不判 —— 它今天不在这个文件里,但将来若被别的轴借用,
   *  再多一条误报没有意义。判 import 才是判依赖方向。)
   */
  test('★ acceptance-gate 不 import 分型侧, 也不出现分型独有的 rubric 字面量', async () => {
    const src = await Bun.file('src/harness/goal/acceptance-gate.ts').text();
    expect(src).not.toContain('./classify-acceptance');
    expect(src).not.toContain('./rubric-spec');
    expect(src.includes("'rubric'")).toBe(false);
  });
});
