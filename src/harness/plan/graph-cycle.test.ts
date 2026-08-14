/**
 * `findGraphCycle` —— 找环的单一真源 (issue #25, 2026-08-14)。
 *
 * 这里钉的是**两条容易做错的边界**, 而不是"能不能找到环"这种显然的事:
 *  ① **图外引用不算边** —— 指向不存在的 id 不构成依赖关系。做错了就会把一张正常图误判成环,
 *     而顶层这道闸是 fail-closed 的, 误判 = 把本来能跑的活拒掉。
 *  ② 判词得**点名环上是谁** —— 判词的读者是下一轮 conductor, "有环"三个字它改不动。
 *
 * **反向自检 (实跑, 两侧都记)**:
 *  - 删掉 `visit` 里的 `if (state.get(id) === 1) return ...` → 报环的三条当场红 (7 pass → 4 pass 3 fail)。
 *  - 删掉 `if (!(d in nodes)) continue` → **一条都没红** (7 pass 0 fail)。我原本以为它会红, 读了才明白
 *    为什么不会: 幽灵 id 取到 `undefined` → `?? []` → 没有出边 → 走一遍照样返 null。也就是说那一行
 *    管的是**明确性和一次无谓递归, 不是正确性**。按仓规记下来而不是改掉判据 —— 一个在干预下不动的
 *    读数, 量的是尺子; 把它写成"闸"才是自欺。
 */
import { describe, expect, test } from 'bun:test';
import { findGraphCycle } from './graph-cycle';

describe('findGraphCycle', () => {
  test('二元环 → 点名环上两个节点, 首尾同名', () => {
    const c = findGraphCycle({ a: { depends_on: ['b'] }, b: { depends_on: ['a'] } });
    expect(c).not.toBeNull();
    expect(c![0]).toBe(c![c!.length - 1]);
    expect(new Set(c)).toEqual(new Set(['a', 'b']));
  });

  test('自环 → 找得到', () => {
    expect(findGraphCycle({ a: { depends_on: ['a'] } })).toEqual(['a', 'a']);
  });

  test('三元环 → 找得到', () => {
    expect(findGraphCycle({ a: { depends_on: ['c'] }, b: { depends_on: ['a'] }, c: { depends_on: ['b'] } })).not.toBeNull();
  });

  test('DAG → null (证明上面不是恒报的空转断言)', () => {
    expect(findGraphCycle({ a: {}, b: { depends_on: ['a'] }, c: { depends_on: ['a', 'b'] } })).toBeNull();
  });

  test('★ 图外引用不算边 → 不误判成环', () => {
    expect(findGraphCycle({ a: { depends_on: ['不存在'] } })).toBeNull();
    expect(findGraphCycle({ research: {}, syn: { depends_on: ['reserach'] } })).toBeNull();
  });

  test('菱形 (同一节点被多路到达) → null, 且不指数爆 (三色的 2 态就是为这个)', () => {
    expect(findGraphCycle({
      top: {},
      l: { depends_on: ['top'] },
      r: { depends_on: ['top'] },
      bottom: { depends_on: ['l', 'r'] },
    })).toBeNull();
  });

  test('空图 / 无 depends_on → null', () => {
    expect(findGraphCycle({})).toBeNull();
    expect(findGraphCycle({ a: {}, b: {} })).toBeNull();
  });
});
