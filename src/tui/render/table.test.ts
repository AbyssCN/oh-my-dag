/**
 * L1 判据:表格与进度条(TUI SDD §7.5.3,切片 S11)。
 *
 * ★ 这里钉的是 goal §4 点名的那条:**CJK 表格用 `.length` 算列宽必须红**。
 * `'节点'.length === 2` 而它占 **4 列** —— 用 `.length` 分配出来的列宽会让每行超出格子,
 * 整张表错位。这是同一个坑的第三次出现(字形 · 表格 · 单行渲染),所以三处共用一把尺子。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { BAR_DONE, BAR_TODO, renderBar } from './bar';
import { SAFE_GLYPH_WIDTHS } from './glyph-table';
import { findRiskyGlyphs } from './glyphs';
import { COL_SEP, renderTable } from './table';

describe('renderTable', () => {
  // 反向自检 (2026-08-07 实跑): 把 table.ts 里两处 visibleWidth 换成 .length
  // → 下面「CJK 表格不超宽」当场红 (中文列被按字符数分格, 实际画出来宽一倍)。
  test('★ CJK 内容的表格逐行不超宽 —— 用 .length 算列宽的版本会宽出一倍', () => {
    const rows = [
      ['节点', '角色', '状态', '模型'],
      ['规划中文节点名', 'leaf', '在跑', 'deepseek-v4-flash'],
      ['另一个很长的中文节点名字', 'verifier', '失败', 'kimi-k3'],
    ];
    for (const w of [20, 40, 60, 100]) {
      for (const line of renderTable(rows, w)) {
        expect(visibleWidth(line), `w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('放得下时列是对齐的(同一列的起始可见列号一致)', () => {
    const lines = renderTable([['a', 'xx'], ['bbb', 'y']], 40);
    const col2 = lines.map((l) => visibleWidth(l.slice(0, l.indexOf('y') >= 0 ? l.indexOf('y') : l.indexOf('xx'))));
    expect(col2[0]).toBe(col2[1] as number);
  });

  test('★ 削列从最宽的那一列开始 —— 平均削会把窄列削没而宽列还是超', () => {
    const rows = [['x'.repeat(50), 'ok']];
    const [line] = renderTable(rows, 20);
    expect(visibleWidth(line as string)).toBeLessThanOrEqual(20);
    expect(line).toContain('ok'); // 窄列活下来了
  });

  test('行内单元格数不齐 → 按最长的补空, 不抛', () => {
    expect(() => renderTable([['a', 'b', 'c'], ['d']], 30)).not.toThrow();
    expect(renderTable([['a', 'b'], ['d']], 30)).toHaveLength(2);
  });

  test('最后一列不补尾随空格(复制出来会带一串空白)', () => {
    const [line] = renderTable([['a', 'b']], 40);
    expect(line).toBe(`a${COL_SEP}b`);
  });

  test('空表 / 零宽 → 空数组, 不抛', () => {
    expect(renderTable([], 40)).toEqual([]);
    expect(renderTable([['a']], 0)).toEqual([]);
  });
});

describe('renderBar', () => {
  // 反向自检: 把 inner 的减法去掉 (不给方括号与计数留位) → 「整行不超宽」当场红。
  test('★ 整行不超过 width(方括号与计数都算在内)', () => {
    for (const w of [5, 10, 20, 80]) {
      expect(visibleWidth(renderBar(3, 10, w)), `w=${w}`).toBeLessThanOrEqual(w);
    }
  });

  test('比例对得上(inner = width - 计数宽 - 3, 四舍五入)', () => {
    // width 20, 标签 '5/10' 占 4 → inner = 13 → filled = round(0.5*13) = 7。
    expect(renderBar(5, 10, 20)).toBe(`[${BAR_DONE.repeat(7)}${BAR_TODO.repeat(6)}] 5/10`);
    expect(renderBar(0, 10, 20)).toBe(`[${BAR_TODO.repeat(13)}] 0/10`);
    expect(renderBar(10, 10, 20)).toBe(`[${BAR_DONE.repeat(12)}] 10/10`);
  });

  test('★ total=0 时是 0/0 —— 与"一个都没跑完"(0/N)不是一回事', () => {
    expect(renderBar(0, 0, 20)).toContain('0/0');
    expect(renderBar(0, 7, 20)).toContain('0/7');
  });

  test('★ done > total 夹到 total —— UI 不许画出 11/10 这种自相矛盾', () => {
    expect(renderBar(11, 10, 20)).toContain('10/10');
  });

  test('窄到放不下条子时保住计数', () => {
    expect(renderBar(3, 10, 4)).toBe('3/10');
  });

  test('★ 画出来的每个字形都判得准 —— 换字形的前提是读数, 不是好看', () => {
    // ⚠ 初版写的是 `SAFE_GLYPH_WIDTHS.has(ch)` —— **太严**: 那张表只装**探针显式量过的**字形,
    // 而 `[` `/` 数字这些普通 ASCII 从来不在候选集里 (它们由 classifyGlyph 的兜底规则放行)。
    // 要钉的语义是"画得准", 那就用真闸 `findRiskyGlyphs`, 别自己另写一个更严的判据。
    // 表要是回到没量过真终端的状态 (block 元素退回 needs-tty), 这条当场红。
    expect(findRiskyGlyphs(renderBar(3, 10, 30))).toEqual([]);
    expect(SAFE_GLYPH_WIDTHS.has(BAR_DONE) && SAFE_GLYPH_WIDTHS.has(BAR_TODO), '填充字符必须是显式量过的').toBe(true);
  });

  test('比例与边界在换字形之后仍然对', () => {
    expect(renderBar(5, 10, 20)).toBe(`[${BAR_DONE.repeat(7)}${BAR_TODO.repeat(6)}] 5/10`);
  });
});
