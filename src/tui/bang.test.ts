/**
 * L1 判据:`!` bash 直通的纯函数半。
 *
 * 反向自检(实跑):把 `!!` 排除删掉 → 「!! 不认」当场红;
 * 把 slice(-cap) 改成 slice(0, cap) → 「保尾不保头」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { BANG_OUTPUT_CAP, formatBangEntry, parseBang } from './bang';

describe('parseBang', () => {
  test('!cmd 与 ! cmd 都认, 裸 ! 交空串', () => {
    expect(parseBang('!git status')).toEqual({ cmd: 'git status' });
    expect(parseBang('  ! git status ')).toEqual({ cmd: 'git status' });
    expect(parseBang('!')).toEqual({ cmd: '' });
  });
  test('!! 不认 (历史扩展语义不抢), 普通文本回落', () => {
    expect(parseBang('!!')).toBeNull();
    expect(parseBang('平文本 ! 中间的不算')).toBeNull();
  });
});

describe('formatBangEntry —— 屏与账同一份文本', () => {
  test('exit code 恒印, 空输出说真话', () => {
    expect(formatBangEntry('true', 0, '')).toBe('[local shell] $ true\n(exit 0)\n(no output)');
    expect(formatBangEntry('x', null, 'boom')).toContain('(exit signal)');
  });
  test('★ 超限保尾不保头 —— 结论几乎总在尾巴上, 且截断说出截了多少', () => {
    const out = `${'头'.repeat(100)}TAIL-MARKER`;
    const s = formatBangEntry('cmd', 1, out, 50);
    expect(s).toContain('TAIL-MARKER');
    expect(s).not.toContain('头'.repeat(100));
    expect(s).toMatch(/\d+ chars truncated/);
  });
  test('默认上限是导出的常量 (账本口径一处定)', () => {
    const s = formatBangEntry('cmd', 0, 'x'.repeat(BANG_OUTPUT_CAP + 1));
    expect(s).toContain('1 chars truncated');
  });
});
