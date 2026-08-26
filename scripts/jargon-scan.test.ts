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
import { EXCLUDE_FILES, JARGON, SKIP_PREFIXES, scanJargon, scanTree } from './jargon-scan';

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

  test('把禁词当**数据**用的文件必须在排除名单里(算进来 = 这条闸永远红)', () => {
    expect(EXCLUDE_FILES).toContain('scripts/jargon-scan.ts');
    expect(EXCLUDE_FILES).toContain('src/harness/harness-prompts.ts');
    // ⚠ 这一条是拿真事故换来的(2026-08-24): 清扫按散文规矩把谎报完成闸正则里的
    //   「搞定」换成了「完成」, 闸从此认不出「全部搞定」。判据是「散文还是数据」,
    //   不是「文件重不重要」。
    expect(EXCLUDE_FILES).toContain('src/harness/plan/false-completion.ts');
  });

  test('★ 决定了不扫的范围, 每条必须写明为什么(照 COVERAGE_DEBT 的规矩)', () => {
    const thin = SKIP_PREFIXES.filter((s) => !s.why || s.why.trim().length < 25);
    expect(thin.map((s) => s.prefix)).toEqual([]);
    // 绊线: 不扫的范围**只许缩不许涨**。加一条 skip 是消音最省事的办法, 所以它要有代价。
    expect(SKIP_PREFIXES.length).toBeLessThanOrEqual(2);
  });

  // ⚠ 2026-08-26: 「清扫完成态」绊线(全树 scanTree 恒空)**已移除**, 禁用词不再是闸。
  //
  // owner 裁: 维护成本压过收益。实账 —— leaf 三发实装 run 全死在它手上(它写的词
  // 从来不在 leaf 的 prompt 里, 见 harness-prompts.ts:127-137 的 LEAF_HARNESS_CORE);
  // owner 与 leaf 各自又撞了「解释一个禁止项就必须引用它、而闸只看字面」这个形态数次;
  // 隔壁窗口提交进 main 的两处禁用词, 还让本轨两发勘察 run 的每个 leaf 收尾全红。
  //
  // 保留的是**工具**不是闸: `bun scripts/jargon-scan.ts` 仍可手动跑, 下面的判别力用例
  // 继续钉它的分辨力。写作纪律留在 CLAUDE.md 的散文层 —— 那是给人和 conductor 的要求,
  // 不再机械强制到每一次写文件。

});
