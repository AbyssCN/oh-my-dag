/**
 * **效果指标闸** (2026-07-31, 承 Loop Engineering §8.5「静默失败」)。
 *
 * 这条链我们已经补过两级, 每一级都是被一次真事故逼出来的:
 *   2026-07-29 —— 「文件**真在盘上**」(反捏造判词打在真做完的活上 → 补存在性)
 *   2026-08-03 S1 —— 「文件**里写了什么**」(judge 看不见内容 → 内容验收类目标倾向永不收敛)
 * 第三级是这里: **写进去的和原来一样, 等于没写**。前两级都拦不住它 —— 文件在、内容也在,
 * 只是这次调用什么都没改变, 而且**返回码是成功的**。
 *
 * 本文件盯的是这条指标唯一容易搞错的地方: `noop` 的判据。直觉会写成 `lineDelta === 0`,
 * 那是错的 —— 换掉同样多的行 delta = 0 而它明明改了东西。判据必须是「内容变没变」。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffWriteEffect, snapshotFile, type FileSnapshot } from './agent-leaf';

const snap = (exists: boolean, lines: number, hash: string | null): FileSnapshot => ({ exists, lines, hash });

describe('diffWriteEffect — noop 判的是「内容变没变」, 不是「delta 是不是 0」', () => {
  test('内容逐字相同 = noop (这就是 §8.5 要抓的那一类)', () => {
    const s = snap(true, 10, 'abc');
    expect(diffWriteEffect('a.md', s, s)).toEqual({ path: 'a.md', lineDelta: 0, noop: true });
  });

  test('⚠ 行数没变但内容变了 = **不是** noop —— 直觉写法会在这里判错', () => {
    const e = diffWriteEffect('a.md', snap(true, 10, 'abc'), snap(true, 10, 'xyz'));
    expect(e.lineDelta).toBe(0);
    expect(e.noop).toBe(false);
  });

  test('新建文件: 写前不存在 → delta = 全文行数, 不是 noop', () => {
    const e = diffWriteEffect('new.md', snap(false, 0, null), snap(true, 7, 'h'));
    expect(e).toEqual({ path: 'new.md', lineDelta: 7, noop: false });
  });

  test('⚠ 新建一个**空**文件也不是 noop (exists false→true 就是变化)', () => {
    const e = diffWriteEffect('empty.md', snap(false, 0, null), snap(true, 0, 'e3b0c442'));
    expect(e.lineDelta).toBe(0);
    expect(e.noop).toBe(false);
  });

  test('删减内容 = 负 delta', () => {
    expect(diffWriteEffect('a.md', snap(true, 20, 'a'), snap(true, 5, 'b')).lineDelta).toBe(-15);
  });
});

describe('snapshotFile — fail-open, 绝不因为量不出来就把一次真的写弄成异常', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-writeeffect-'));

  test('不存在的文件 → exists:false, 不抛', () => {
    expect(snapshotFile(root, 'nope.md')).toEqual({ exists: false, lines: 0, hash: null });
  });

  test('目录 → 当"不存在"处理, 不抛 (EISDIR 曾经真的搞掉过一次冒烟的产物摊开)', () => {
    mkdirSync(join(root, 'adir'), { recursive: true });
    expect(snapshotFile(root, 'adir').exists).toBe(false);
  });

  test('相对路径按 cwd 解析; 绝对路径原样用', () => {
    writeFileSync(join(root, 'a.md'), 'l1\nl2\nl3');
    expect(snapshotFile(root, 'a.md').lines).toBe(3);
    expect(snapshotFile('/nonexistent-root', join(root, 'a.md')).lines).toBe(3);
  });

  test('空文件 = 0 行且 exists:true (与"不存在"区分得开 —— 上面那条空文件用例靠的就是这个)', () => {
    writeFileSync(join(root, 'empty.md'), '');
    const s = snapshotFile(root, 'empty.md');
    expect(s.exists).toBe(true);
    expect(s.lines).toBe(0);
    expect(s.hash).not.toBeNull();
  });

  test('末尾无换行的最后一行也算一行', () => {
    writeFileSync(join(root, 'nonl.md'), 'only');
    expect(snapshotFile(root, 'nonl.md').lines).toBe(1);
    writeFileSync(join(root, 'trail.md'), 'a\n');
    expect(snapshotFile(root, 'trail.md').lines).toBe(2); // 'a' 与末尾空串
  });

  test('真跑一遍：写同样的内容 → noop:true;写不同内容 → noop:false', () => {
    const p = 'round.md';
    writeFileSync(join(root, p), 'hello\nworld');
    const before = snapshotFile(root, p);
    writeFileSync(join(root, p), 'hello\nworld'); // 逐字相同的"修改"
    expect(diffWriteEffect(p, before, snapshotFile(root, p)).noop).toBe(true);
    writeFileSync(join(root, p), 'hello\nthere'); // 同样两行, 内容不同
    const e = diffWriteEffect(p, before, snapshotFile(root, p));
    expect(e.noop).toBe(false);
    expect(e.lineDelta).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
