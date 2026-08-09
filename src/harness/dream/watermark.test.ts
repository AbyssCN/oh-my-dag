/**
 * src/harness/dream/watermark.test —— dream SDD §S1 水位闸。
 *
 * 判据:
 * a. 水位三态分得开:缺 key / clean / skip 互斥可区分。
 *    **反向自检**:删 skip 分支 →「当前会话被排除」与「clean」读数相同 → 红(SDD 判据 2)。
 * b. (幂等闸在 gather.test.ts,不在此)
 *
 * 每条闸的反向自检(证伪)记录在对应测试注释里。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWatermark, type Watermark } from './watermark';

let db: Database;
let wm: Watermark;

beforeEach(() => {
  db = new Database(':memory:');
  wm = createWatermark({ db });
});

describe('水位三态分得开(缺 key / clean / skip 互斥可区分)', () => {
  test('缺 key → get 返 null(从未固化)', () => {
    expect(wm.get('session:never-existed')).toBeNull();
  });

  test('setClean → get 返 { lastCursor, dirty:0, skipped:false }', () => {
    wm.setClean('session:a', '5');
    const s = wm.get('session:a');
    expect(s).not.toBeNull();
    if (!s) throw new Error('unreachable');
    expect(s.skipped).toBe(false);
    if (!s.skipped) {
      expect(s.lastCursor).toBe('5');
      expect(s.dirty).toBe(0);
    }
  });
  test('setDirty → get 返 { lastCursor, dirty:N>0, skipped:false }', () => {
    wm.setDirty('session:a', '10', 3);
    const s = wm.get('session:a');
    expect(s).not.toBeNull();
    if (!s) throw new Error('unreachable');
    expect(s.skipped).toBe(false);
    if (!s.skipped) {
      expect(s.lastCursor).toBe('10');
      expect(s.dirty).toBe(3);
    }
  });
  test('skip → get 返 { skipped:true, skipReason }', () => {
    wm.skip('session:active', '当前会话正写');
    const s = wm.get('session:active');
    expect(s).not.toBeNull();
    if (!s) throw new Error('unreachable');
    expect(s.skipped).toBe(true);
    if (s.skipped) {
      expect(s.skipReason).toBe('当前会话正写');
    }
  });

  test('★ 三态互斥:同一 key 不能同时是 clean 又是 skip', () => {
    // clean → skip 覆盖
    wm.setClean('x', '1');
    wm.skip('x', '后来被排除');
    const s = wm.get('x');
    expect(s!.skipped).toBe(true);

    // skip → clean 覆盖
    wm.setClean('x', '2');
    const s2 = wm.get('x');
    expect(s2!.skipped).toBe(false);
  });

  test('★ 反向自检 a-1:删 skip 分支 → skip 态与 clean 态读数相同 → 红', () => {
    // 正常:skip 的 key 返回 { skipped:true, skipReason }
    wm.skip('s1', 'active');
    const normal = wm.get('s1');
    expect(normal!.skipped).toBe(true);

    // 证伪:如果代码不写 skip 分支,只靠 dirty=0 来区分,
    // 则 skip 态会返回 { lastCursor:'', dirty:0, skipped:false }
    // 与 clean 态(lastCursor 不同但 dirty=0)无法区分。
    // 这里直接验证:clean 态的 dirty 也是 0,仅靠 skipped 列分辨。
    wm.setClean('s2', '0');
    const clean = wm.get('s2');
    expect(clean).not.toBeNull();
    if (!clean) throw new Error('unreachable');
    expect(clean.skipped).toBe(false);
    if (!clean.skipped) expect(clean.dirty).toBe(0);

    // 没有 skipped 列的话,两个态都会是 { dirty:0 },无法分辨。
    // 本闸保证:skipped 列让它们互斥。
    expect(normal!.skipped).not.toBe(clean!.skipped);
  });

  test('★ 反向自检 a-2:用 magic 0 同时表示"clean"和"从未固化" → 红', () => {
    // 正常:从未固化的 key 返回 null
    expect(wm.get('never')).toBeNull();

    // 如果设计用 magic 0(lastCursor='0') 表示"从未固化",
    // 则与"固化了但 seq=0" 冲突 → 无法分辨。
    // 本设计:行不存在 = null,与任何 dirty=0 的 clean 行互斥。
    wm.setClean('has-zero', '0');
    const hasZero = wm.get('has-zero');
    expect(hasZero).not.toBeNull();
    if (!hasZero) throw new Error('unreachable');
    expect(hasZero.skipped).toBe(false);
    if (!hasZero.skipped) {
      expect(hasZero.lastCursor).toBe('0');
      expect(hasZero.dirty).toBe(0);
    }
    // null(从未固化) ≠ { lastCursor:'0', dirty:0 }(固化了但游标为 0)
    // — 靠行存在性区分,不靠魔法值。
  });
});

describe('delete + close', () => {
  test('delete 后 get 返 null', () => {
    wm.setClean('x', '1');
    expect(wm.get('x')).not.toBeNull();
    wm.delete('x');
    expect(wm.get('x')).toBeNull();
  });

  test('close 不抛', () => {
    wm.close();
    // 重复 close 也不抛(bun:sqlite 容许多次)
  });
});
