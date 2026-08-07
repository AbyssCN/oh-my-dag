/**
 * coupled-layout fixture 的**双向自检**(2026-08-07)——
 * `scripts/eval-coupling-ab.ts` 那个实验的判据本身,先证明它站得住。
 *
 * 两个方向缺一不可:
 *   **正向** 参考实现 → 11/11 必须全绿。不绿说明契约测试自相矛盾,
 *           那样每个臂都会输在同一批用例上,整个实验从头就是废的。
 *   **反向** ANSI 盲的实现(R1/R2 照做、R3 完全不认转义)→ 必须红在 R3 与 X 格上。
 *           一条永远绿的用例比没有用例更坏。
 *
 * ## 首次跑到的数(2026-08-07)
 *
 * 参考实现 11/11 绿 · ANSI 盲 单需求缺陷 2 / 交叉缺陷 4。
 *
 * ⚠ **反向这一跑当场抓到两条假闸**,先修了才有上面这个数:
 *   · `R3/ 只有颜色码的单元格视作空` 原本只断言整行可见宽度 —— ANSI 盲照样过;
 *   · `X/ 不变量` 原本只查宽度 —— 按字节截出来的**半截转义**(ESC 后面不是完整的 `[..m`)
 *     同样占一个字符位, 于是宽度照样对得上。
 *   两条都改成断言**具体输出**并加了「不许留半截转义」那一条之后才真的会红。
 *
 * 何时重跑:改 `REQUIREMENTS` 原文、改契约测试、或换 bun 版本(失败行格式变了会让
 * `scoreCoupled` 的分格静默失灵)之后。
 *
 * 跑:`bun run scripts/probes/coupled-layout-selfcheck.ts`
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoupledFixture, scoreCoupled } from '../../src/eval/tasks/coupled-layout';

const GOOD = `const SGR = /\\x1b\\[[0-9;]*m/;
const SGR_G = /\\x1b\\[[0-9;]*m/g;
const visLen = (s: string): number => s.replace(SGR_G, '').length;

function takeVisible(s: string, n: number): string {
  let out = '';
  let count = 0;
  let i = 0;
  while (i < s.length) {
    const m = /^\\x1b\\[[0-9;]*m/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    if (count >= n) break;
    out += s[i]; count++; i++;
  }
  return out;
}

function renderCell(cell: string, w: number): string {
  const vl = visLen(cell);
  let body = vl > w ? (w >= 2 ? takeVisible(cell, w - 1) + '\\u2026' : '\\u2026') : cell;
  if (SGR.test(body) && !body.endsWith('\\x1b[0m')) body += '\\x1b[0m';
  return body + ' '.repeat(Math.max(0, w - visLen(body)));
}

export function renderRow(cells: string[], totalWidth: number): string {
  const n = cells.length;
  const avail = totalWidth - (n - 1);
  const base = Math.floor(avail / n);
  const r = avail % n;
  return cells.map((c, i) => renderCell(c, base + (i < r ? 1 : 0))).join(' ');
}
`;

/** 反向样本: R1/R2 照做, **R3 完全不认 ANSI**(拿 .length 当宽度)。 */
const ANSI_BLIND = `function renderCell(cell: string, w: number): string {
  const body = cell.length > w ? (w >= 2 ? cell.slice(0, w - 1) + '\\u2026' : '\\u2026') : cell;
  return body + ' '.repeat(Math.max(0, w - body.length));
}

export function renderRow(cells: string[], totalWidth: number): string {
  const n = cells.length;
  const avail = totalWidth - (n - 1);
  const base = Math.floor(avail / n);
  const r = avail % n;
  return cells.map((c, i) => renderCell(c, base + (i < r ? 1 : 0))).join(' ');
}
`;

const fx = await createCoupledFixture();
try {
  for (const [name, src] of [['参考实现(应全绿)', GOOD], ['ANSI 盲(应红在 R3 + X)', ANSI_BLIND]] as const) {
    await writeFile(join(fx.root, fx.implPath), src, 'utf8');
    const s = await scoreCoupled(fx.root, fx.testPath);
    console.log(`\n── ${name} ──`);
    console.log(`runnable=${s.runnable} tsc=${s.tscClean ? '绿' : '红'} 单需求缺陷=${s.singleFail} 交叉缺陷=${s.crossFail} 总用例=${s.total}`);
    if (s.failedNames.length) console.log('  失败: ' + s.failedNames.join(' | '));
    if (!s.runnable) console.log('  raw尾巴: ' + s.raw);
  }
} finally {
  await fx.cleanup();
}
