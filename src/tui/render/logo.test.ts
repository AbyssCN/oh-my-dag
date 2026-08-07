/**
 * 字标的 L1 判据。**两条都是会红的闸**,不是描述性测试。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { findRiskyGlyphs } from './glyphs';
import { LOGO_MIN_WIDTH, LOGO_NARROW, LOGO_ROWS, LOGO_WIDE, renderLogo, renderWord } from './logo';

describe('Oh My DAG 字标 (S-3)', () => {
  // 反向自检 (实跑): 把 LOGO_WIDE 任一行末尾的空格删掉 → 这条当场红。
  test('★ 五行等长 —— 短行会让差分渲染留下上一帧的残留', () => {
    const widths = LOGO_WIDE.map((l) => visibleWidth(l));
    expect(new Set(widths).size).toBe(1);
  });

  // 反向自检: 把 '█' 换成 Nerd Font 的 '' → 这条当场红 (私用区判 unsafe)。
  test('★ 只用量过的字形 —— 换字体就超宽的 logo 会把布局顶花', () => {
    expect(findRiskyGlyphs(LOGO_WIDE.join('\n'))).toEqual([]);
    expect(findRiskyGlyphs(LOGO_NARROW)).toEqual([]);
  });

  // 反向自检: 把 LETTERS.M 的某一行删掉一个 █ → 这条当场红。
  // 手写整幅字标的第一版就是**看不出错**的, 只有截图能看出来 —— 这条闸把那件事变成机器能判的。
  test('★ 每个字母自己五行等宽 —— 拼接能对齐的唯一前提', () => {
    for (const ch of 'OHMYDAG ') {
      const rows = renderWord(ch);
      expect(rows).toHaveLength(LOGO_ROWS);
      expect(new Set(rows.map((r) => visibleWidth(r))).size).toBe(1);
    }
  });

  test('未收录的字符直接抛, 不静默画成空白', () => {
    expect(() => renderWord('Z')).toThrow();
  });

  test('窄终端换小字标, 不折行', () => {
    expect(renderLogo(LOGO_MIN_WIDTH)).toEqual([...LOGO_WIDE]);
    expect(renderLogo(LOGO_MIN_WIDTH - 1)).toEqual([LOGO_NARROW]);
  });

  test('★ 任何宽度下每行都不超宽 —— 超宽即错位', () => {
    for (const w of [20, 40, 66, 67, 100, 200]) {
      for (const line of renderLogo(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(w, LOGO_NARROW.length));
    }
  });
});
