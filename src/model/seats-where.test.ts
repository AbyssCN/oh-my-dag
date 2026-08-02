/**
 * seats.where 可证伪登记表闸 (P1 T3, 2026-08-03)。
 *
 * `where` 的每条都是 `<src 下相对文件路径>:<符号名>` —— 本闸把它从"一句散文"变成两条可证伪断言:
 * ① 该文件真的存在; ② 该符号名**逐字**出现在该文件文本里。
 * (语法与越界防护在 seats.test.ts 的登记表条目里; 这里守语义半边。)
 *
 * ⚠ 已知边界: "符号字面在场" ≠ "那一行真的在解析这个座位" —— 后者要 AST 级检查, 本闸不假装做到。
 * 但它足以杀死两类真实漂移: 文件改名/移动没跟 (ENOENT), 符号改名没跟 (字面缺席)。
 *
 * 反向自检 (15 号纪律「一条永远绿的闸比没有闸更坏」): 用捏造的文件与符号各验一次闸真的会红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEATS } from './seats';

const SRC_ROOT = join(import.meta.dir, '..');

/** 一条 where 的检查结果; null = 通过, 否则是可读的失败原因。 */
function checkWhereEntry(entry: string): string | null {
  const i = entry.indexOf(':');
  if (i <= 0 || i === entry.length - 1) return `"${entry}" 不是 文件:符号 形式`;
  const file = entry.slice(0, i);
  const symbol = entry.slice(i + 1);
  const abs = join(SRC_ROOT, `${file}.ts`);
  if (!existsSync(abs)) return `src/${file}.ts 不存在`;
  if (!readFileSync(abs, 'utf8').includes(symbol)) return `符号 ${symbol} 不在 src/${file}.ts 里 (逐字)`;
  return null;
}

describe('seats.where 可证伪登记表', () => {
  test('每条 where: 文件存在 且 符号逐字在场', () => {
    for (const s of SEATS) {
      for (const w of s.where) {
        expect(checkWhereEntry(w), `${s.id}.where 的 "${w}"`).toBeNull();
      }
    }
  });

  test('反向自检: 捏造的符号会红 (闸不是恒真式)', () => {
    expect(checkWhereEntry('model/seats:zzNoSuchSymbolZZ')).toContain('不在');
  });

  test('反向自检: 捏造的文件会红', () => {
    expect(checkWhereEntry('model/zz-no-such-file:SEATS')).toContain('不存在');
  });
});
