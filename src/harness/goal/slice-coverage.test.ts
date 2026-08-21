/**
 * S-46 缺片闸 (`slice-coverage.ts`)。
 *
 * 现场重建在第一组:2026-08-21 P2 那跑的分解表 4 片,盘上只有切片 1 的两个文件。
 * 那一跑冻结判据绿、写穿核验 consistent、终态 done —— **判词里一个字看不出只做了 1/4**。
 * 本件钉的就是那句话必须出现。
 *
 * 反向自检 (逐条实测红过, 不是"应该会红"):
 *   - `kind` 的 `hit.length === 0` 改成 `< 0` → 「缺片」两条红 (闸恒绿);
 *   - `partial` 也算进 `missing` → 「部分产出不红」那条红 (假 major 复现);
 *   - `red` 改成恒 false → 「红旗真的升起来」那条红;
 *   - `verdict:'no-breakdown'` 改成 `'reconciled'` → 「判不了 ≠ 绿」那条红;
 *   - glob 那条: 把 `re.test(f)` 换成 `f === decl` → glob 组红。
 */
import { describe, expect, test } from 'bun:test';
import { coverSlices, describeSliceCoverage } from './slice-coverage';
import type { SddSlice } from './sdd-direct';

function slice(id: number, writeSet: string[], name = `切片${id}`): SddSlice {
  return { id, name, writeSet, deps: [], verify: `bun test x${id}` };
}

describe('S-46 缺片闸 (coverSlices)', () => {
  test('★ P2 现场: 4 片只落切片 1 → 红且点名缺的三片', () => {
    const slices = [
      slice(1, ['src/harness/dag/width.ts', 'src/harness/dag/width.test.ts']),
      slice(2, ['src/harness/dag/edge-missing.ts']),
      slice(3, ['src/harness/dag/edge-fake.ts']),
      slice(4, ['src/harness/dag/narrowed-by.ts']),
    ];
    const diff = ['src/harness/dag/width.ts', 'src/harness/dag/width.test.ts'];
    const r = coverSlices(slices, diff);
    expect(r.verdict).toBe('reconciled');
    expect(r.red).toBe(true);
    expect(r.missing).toEqual([2, 3, 4]);
    expect(r.partial).toEqual([]);
    // 判词必须点名,否则读者还得自己去比对分解表 (INV-1 不吞证据)
    expect(describeSliceCoverage(r)).toBe('缺片 3/4 [片 2, 3, 4]');
  });

  test('全片有产出 → 不红', () => {
    const slices = [slice(1, ['a/x.ts']), slice(2, ['b/y.ts'])];
    const r = coverSlices(slices, ['a/x.ts', 'b/y.ts', 'docs/无关.md']);
    expect(r.red).toBe(false);
    expect(r.missing).toEqual([]);
    expect(describeSliceCoverage(r)).toBe('2/2 片有产出');
  });

  test('部分产出**不红**(假 major 会让人把整条闸关掉 —— S-45 收窄买过的教训)', () => {
    const slices = [slice(1, ['a/x.ts', 'a/x.test.ts', 'a/z.ts'])];
    const r = coverSlices(slices, ['a/x.ts', 'a/x.test.ts']);
    expect(r.red).toBe(false); // ← 有产出就不红
    expect(r.partial).toEqual([1]);
    expect(r.missing).toEqual([]);
    expect(r.slices[0]!.kind).toBe('partial');
    // 不红但**必须印出来**: 不印 = 和"全做完了"在读数上不可分
    expect(describeSliceCoverage(r)).toBe('0/1 片有产出 · 部分产出 1 [片 1]');
  });

  test('判不了 ≠ 绿: 零切片走 no-breakdown, 不冒充「零缺片」(NULL≠0)', () => {
    const r = coverSlices([], ['a/x.ts']);
    expect(r.verdict).toBe('no-breakdown');
    expect(r.red).toBe(false);
    expect(describeSliceCoverage(r)).toBe('无分解表');
    // 与「真判过且零缺片」逐字不同 —— 两者混成一句就是 S-19 那族的病
    expect(describeSliceCoverage(coverSlices([slice(1, ['a/x.ts'])], ['a/x.ts']))).not.toBe('无分解表');
  });

  test('glob 写集按 write-set.ts 的同一份语义匹配(不是第二份实现)', () => {
    const slices = [slice(1, ['src/harness/session/**']), slice(2, ['src/model/*.ts'])];
    // 片1 命中 (`**` 跨目录); 片2 不命中 —— `*` 不跨 `/`, 深一层的文件不算
    const r = coverSlices(slices, ['src/harness/session/a/b/deep.ts', 'src/model/sub/nested.ts']);
    expect(r.slices[0]!.kind).toBe('produced');
    expect(r.missing).toEqual([2]);
  });

  test('命中的是**声明项**不是文件名: 一个 glob 落多个文件仍只算它自己一项', () => {
    const r = coverSlices([slice(1, ['src/x/**', 'src/y.ts'])], ['src/x/a.ts', 'src/x/b.ts']);
    expect(r.slices[0]!.hit).toEqual(['src/x/**']); // 不是 ['src/x/a.ts','src/x/b.ts']
    expect(r.slices[0]!.kind).toBe('partial'); // 2 项声明命中 1 项
  });

  test('反面: diff 为空 → 全片皆缺(闸不是恒真式)', () => {
    const r = coverSlices([slice(1, ['a/x.ts']), slice(2, ['b/y.ts'])], []);
    expect(r.red).toBe(true);
    expect(r.missing).toEqual([1, 2]);
  });
});
