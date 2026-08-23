/**
 * 禁词扫描器的判别力闸。
 *
 * 它要认对**两件事**,认错任何一件这次清扫就白做:
 *  ① 命中要认得出(否则清扫的验收恒绿,等于没扫);
 *  ② `comment` 与 `string` 要分得开 —— 字符串字面量里的禁词是**判词/日志原文**,
 *    有测试在断言它们,和注释是两档风险,混在一批里改会连带弄红一堆测试。
 *
 * 反向自检(2026-08-24 各跑过一遍,还原复绿):
 * - 把 `stringLiteralLines` 改成恒返回空集 ⇒ ★② 红(字符串档全被误判成注释档);
 * - 把 `JARGON` 里的 `落盘` 删掉 ⇒ ★① 红。
 */
import { describe, expect, test } from 'bun:test';
import { EXCLUDE_FILES, JARGON, scanJargon } from './jargon-scan';

/** 三种位置各一处:注释 · 字符串字面量 · 标识符(标识符**不该**被当成命中来改)。 */
const SAMPLE = [
  '// 这一步把数据落盘, 失败不阻断',
  "const msg = '[omd] 收口失败 —— 已落盘';",
  'export function 落盘Helper(): void {}',
  '/** 抓手在这里 */',
].join('\n');

describe('禁词扫描器', () => {
  test('★① 认得出命中, 并给出换成什么', () => {
    const hits = scanJargon(SAMPLE, 'x.ts');
    expect(hits.some((h) => h.word === '落盘')).toBe(true);
    expect(hits.some((h) => h.word === '抓手')).toBe(true);
    expect(JARGON['抓手']).toBe('着力点');
  });

  test('★② 字符串字面量与注释分得开(两档风险不同, 不许混批改)', () => {
    const hits = scanJargon(SAMPLE, 'x.ts');
    const line2 = hits.filter((h) => h.line === 2);
    expect(line2.length).toBeGreaterThan(0);
    expect(line2.every((h) => h.kind === 'string')).toBe(true);
    expect(hits.find((h) => h.line === 1)?.kind).toBe('comment');
  });

  test('Markdown 没有字符串字面量这一档, 全算 comment', () => {
    const hits = scanJargon('把结果落盘, 然后收口。', 'x.md');
    expect(hits.every((h) => h.kind === 'comment')).toBe(true);
  });

  test('禁词表自身所在的文件必须在排除名单里(算进来 = 这条闸永远红)', () => {
    expect(EXCLUDE_FILES).toContain('scripts/jargon-scan.ts');
    expect(EXCLUDE_FILES).toContain('src/harness/harness-prompts.ts');
  });
});
