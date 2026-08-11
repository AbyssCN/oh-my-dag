/**
 * src/harness/goal/delta-compare.test —— D-1 mode 感知基线 delta 比对 (INV-2 反向自检)。
 *
 * SDD: docs/plan/2026-08-10-cairness-distill-comparison.md, D-1 + G-1 + G-2。
 * 落点说明: 同 anchor-check.test 的最小解释 —— 测试随新闸同置 (src/harness/goal/**),
 * 不碰 src/eval/** 红线。
 *
 * INV-2 证伪方式 (逐条写进各 test): 每条已知违规样本 = 「基线 pass → 跑后 fail」的
 * 新失败转换 (G-1 主路)。闸若缺失或判零 delta, 本次跑批引入的失败会被当老账 ——
 * 断言 `red === true` + `newFailures` 点名, 即当场证伪。阴性对照:
 * 老失败单列不红 (INV-4) / changed-only 缺席不判 new-failure / 完全相同报告零 delta (G-2)。
 *
 * 退出码语义 (INV-1): 闸红 = 非零退出码 —— 本函数面以 `red` 布尔承载, `red === true`
 * 即「该红了」, 断言等价于断言退出码非零; run-goal 挂点消费同一布尔。
 */
import { describe, expect, test } from 'bun:test';
import {
  compareVerifyReports,
  summarizeDelta,
  type VerifyReport,
} from './delta-compare';

/** 快速造一份报告: full 模式, 逐 id:status。 */
const full = (...steps: [string, 'pass' | 'fail' | 'warning'][]): VerifyReport => ({
  mode: 'full',
  steps: steps.map(([id, status]) => ({ id, status })),
});
/** changed-only 模式 (只列有变化的步)。 */
const changedOnly = (...steps: [string, 'pass' | 'fail' | 'warning'][]): VerifyReport => ({
  mode: 'changed-only',
  steps: steps.map(([id, status]) => ({ id, status })),
});

describe('D-1 delta 比对 — G-1 主路: 只把新引入失败判红', () => {
  test('G-1: 基线 pass → 跑后 fail → new-failure, 红, 点名新失败', () => {
    // 证伪: 若实现不判红 / 不挂 delta → 本次跑批引入的失败被当老账, 闸形同虚设 (G-1 主路)。
    const r = compareVerifyReports(full(['accept', 'pass']), full(['accept', 'fail']));
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['accept']);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass', after: 'fail' }]);
    expect(r.total).toBe(1);
  });

  test('G-1: 基线 fail → 跑后 fail → unchanged-failure, 不红 (老失败单列, INV-4 不混算)', () => {
    // 证伪: 若实现把老失败判红 → 存量语料首跑全红, 新引入失败与引擎回归混算。
    const r = compareVerifyReports(full(['accept', 'fail']), full(['accept', 'fail']));
    expect(r.red).toBe(false);
    expect(r.newFailures).toEqual([]);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'unchanged-failure', before: 'fail', after: 'fail' }]);
  });

  test('G-1: 基线 fail → 跑后 pass → fixed, 不红', () => {
    const r = compareVerifyReports(full(['accept', 'fail']), full(['accept', 'pass']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'fixed', before: 'fail', after: 'pass' }]);
  });

  test('G-1: 基线 warning → 跑后 fail → new-failure 红 (恶化 = 新失败)', () => {
    const r = compareVerifyReports(full(['accept', 'warning']), full(['accept', 'fail']));
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['accept']);
  });

  test('G-1: 基线 pass → 跑后 warning → new-warning, 不红 (警告非阻断)', () => {
    const r = compareVerifyReports(full(['accept', 'pass']), full(['accept', 'warning']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'new-warning', before: 'pass', after: 'warning' }]);
  });
});

describe('D-1 delta 比对 — mode 语义: changed-only / 缺席不冒充结论', () => {
  test('G-1: before changed-only 且某步缺席 → skipped, 不判 new-failure', () => {
    // 证伪: 若实现判 new-failure → 误伤 —— changed-only 基线没跑那步, 不能说是本次引入的失败。
    const r = compareVerifyReports(changedOnly(['a', 'fail']), full(['a', 'fail'], ['b', 'fail']));
    expect(r.red).toBe(false);
    expect(r.newFailures).toEqual([]);
    expect(r.steps).toEqual([
      { id: 'a', kind: 'unchanged-failure', before: 'fail', after: 'fail' },
      { id: 'b', kind: 'skipped', after: 'fail' },
    ]);
  });

  test('G-1: after 新出现的步 (before full) → newly-run, 不判 fixed', () => {
    // 证伪: 若实现判 fixed → 假阳性修复 —— 基线里没有它, 谈不上"修好"。
    const r = compareVerifyReports(full(['a', 'pass']), full(['a', 'pass'], ['b', 'pass']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'b', kind: 'newly-run', after: 'pass' }]);
  });

  test('G-1: after 新出现的步且跑后 fail (before full) → newly-run, 仍不红', () => {
    // 证伪: 若实现把 newly-run 判红 → changed-only 首跑全红 —— 基线里没有的步, 失败是
    // 基线覆盖之外的事实, 不是「新引入」(引入者是基线那份报告没有的步本身)。
    const r = compareVerifyReports(full(['a', 'pass']), full(['a', 'pass'], ['b', 'fail']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'b', kind: 'newly-run', after: 'fail' }]);
  });

  test('G-1: 两侧 full, 基线 pass 的步跑后缺席 → new-failure 红 (覆盖回退, fail-closed)', () => {
    // 证伪: 若实现把缺席当零 delta → 漏报 —— 「没被证明过就不算成」: 引擎没跑到 accept
    // 节点, 覆盖就回退了, 与 D-I 同一条纪律。
    const r = compareVerifyReports(full(['accept', 'pass']), full());
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['accept']);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass' }]);
  });

  test('G-1: 两侧 full, 基线 fail 的步跑后缺席 → skipped, 不红 (老失败消失不可证 fixed)', () => {
    // 证伪: 若实现判 new-failure → 老失败消失被误报成新失败; 若判 fixed → 没跑过就宣称修好。
    const r = compareVerifyReports(full(['accept', 'fail']), full());
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'skipped', before: 'fail' }]);
  });

  test('G-1: 一侧 changed-only 时 before-only 步 → skipped; before full 的 after-only 步 → newly-run', () => {
    // before 是 changed-only 时, 缺席无法比对 → skipped (那份报告本来就没枚举全部);
    // before 是 full 时基线枚举过全部, after 才出现的步 = 真新步 → newly-run (G-1 第三子句)。
    const r = compareVerifyReports(full(['a', 'pass']), changedOnly(['b', 'pass']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([
      { id: 'a', kind: 'skipped', before: 'pass' },
      { id: 'b', kind: 'newly-run', after: 'pass' },
    ]);
  });
});

describe('D-1 delta 比对 — G-2 反向: 相同报告零 delta, 退出码 0', () => {
  test('G-2: 两份完全相同的 full 报告 → 零 new-failure, 不红, steps 空', () => {
    // 证伪: 若实现把无变化跑批判红 → 每批都红, 闸失去"只报新失败"的意义。
    const r = compareVerifyReports(full(['a', 'pass'], ['b', 'pass']), full(['a', 'pass'], ['b', 'pass']));
    expect(r.red).toBe(false);
    expect(r.newFailures).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.total).toBe(2); // 零 delta 的步仍在报告里, 只是没变化
  });

  test('G-2: 空报告对空报告 → 零 delta', () => {
    const r = compareVerifyReports(full(), full());
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([]);
    expect(r.total).toBe(0);
  });

  test('G-2: 多步里混入一个 pass→fail → 只点那一个名, 其余不误伤', () => {
    const r = compareVerifyReports(
      full(['a', 'pass'], ['b', 'pass'], ['c', 'fail']),
      full(['a', 'pass'], ['b', 'fail'], ['c', 'fail']),
    );
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['b']);
    expect(r.steps).toEqual([
      { id: 'b', kind: 'new-failure', before: 'pass', after: 'fail' },
      { id: 'c', kind: 'unchanged-failure', before: 'fail', after: 'fail' },
    ]);
    expect(r.total).toBe(3);
  });
});

describe('D-1 summarizeDelta — 摘要进 run-goal 摘要行', () => {
  test('红 → 点名新失败 (run-goal 摘要 "D-1 delta: 新增失败 1 [accept]")', () => {
    const r = compareVerifyReports(full(['accept', 'pass']), full(['accept', 'fail']));
    expect(summarizeDelta(r)).toBe('新增失败 1 [accept]');
  });

  test('零 delta → "无变化"', () => {
    const r = compareVerifyReports(full(['accept', 'pass']), full(['accept', 'pass']));
    expect(summarizeDelta(r)).toBe('无变化');
  });

  test('有变更但不红 → 报变更步数不报"无变化"', () => {
    const r = compareVerifyReports(full(['accept', 'fail']), full(['accept', 'pass']));
    expect(summarizeDelta(r)).toBe('未新增失败 · 1 步变更');
  });
});
