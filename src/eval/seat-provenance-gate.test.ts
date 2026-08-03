/**
 * eval 脚本的**座位来源闸** (2026-08-03)。
 *
 * ## 它守的那一条(很窄,故意的)
 *
 * 凡 eval 脚本调用 `tryResolveSeatModel(<座位>)` 解析座位,它的源码里**必须**有
 * 读取结果 `.source` 的形迹。`tryResolveSeatModel` 返回 `{ model, source, via }`,
 * `source` 记录这次解析的来历(`explicit` / `override` / `file` / `env` / `auto` /
 * `default`)—— 报告里不读它,读者就看不出这发读数**实际落在哪个座位**上,
 * 与座位表的漂移也就无从对质。只取模型不报来源 = 白解析。
 *
 * ## 为什么值一条闸
 *
 * `eval-detector-usage.ts` / `eval-judge-artifacts.ts` 已经把来源拼进输出
 * (如 `(gate 座 · 来源 ${seatModel?.source})`),证明"报了来源"是可行且已成惯例的;
 * 而 `eval-thinking-ab.ts` 调了 `tryResolveSeatModel('leaf')` 却从不读 `.source` ——
 * 它的读数从哪个座位来,报告里无迹可寻。闸就是抓这族"解析了却不说来源"的漂移。
 *
 * ## 判据的诚实边界
 *
 * 查的是**源码形状**(有没有读 `.source` 的形迹),不是"跑起来报告里真的写了什么"。
 * 它不运行 eval、不解析模型、不执行脚本;一个 `.source` 形迹也可能写在没被
 * 报告路径用到的分支里,这条闸看不见。要"读到的值真进了产物"得靠运行时校验,
 * 那是另一条闸的事 —— 本闸只承诺:解析了座位的脚本,源码里找得到来源读取。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dir, '..', '..', 'scripts');

/** 调用 tryResolveSeatModel(…) 的形迹 —— 带括号才叫调用, import 行不算。 */
const SEAT_CALL = /tryResolveSeatModel\s*\(/;

/** 读 `.source` 的形迹。 */
const SOURCE_TRACE = /\.source\b/;

/** 注释行(说明性文字)不算形迹 —— 与 seat-sourced.test.ts 同款过滤。 */
const isCommentLine = (line: string): boolean => /^\s*(\*|\/\/)/.test(line);

const evalScripts = readdirSync(SCRIPTS).filter((f) => f.startsWith('eval-') && f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('eval 脚本: 解析了座位就得报来源', () => {
  test('至少扫到几个 eval 脚本 (免得目录改名后闸静默变空跑)', () => {
    expect(evalScripts.length).toBeGreaterThan(3);
  });

  test('至少有一个脚本真的在解析座位 (否则这条闸是恒真式)', () => {
    const withCalls = evalScripts.filter((f) => SEAT_CALL.test(readFileSync(join(SCRIPTS, f), 'utf8')));
    expect(withCalls.length).toBeGreaterThan(0);
  });

  for (const f of evalScripts) {
    test(`${f}: 调了 tryResolveSeatModel 就读 .source`, () => {
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      if (!SEAT_CALL.test(src)) return; // 没解析座位, 本闸不管。
      const traces = src
        .split('\n')
        .filter((l) => !isCommentLine(l))
        .filter((l) => SOURCE_TRACE.test(l));
      expect(
        traces.length,
        `${f} 调了 tryResolveSeatModel 却不读结果的 .source —— 读数从哪个座位来, ` +
          '报告里看不出来; 把来源拼进输出 (参照 eval-detector-usage.ts 的 SEAT_PROVENANCE)',
      ).toBeGreaterThan(0);
    });
  }

  test('反向自检: 形状真的区分得出 (闸不是恒真式)', () => {
    const withProvenance = `const seat = tryResolveSeatModel('gate'); log(\`来源 \${seat?.source}\`);`;
    const withoutProvenance = `const seat = tryResolveSeatModel('gate'); const MODEL = seat?.model;`;
    const importOnly = `import { tryResolveSeatModel } from '../src/model/role-models';`;
    // 调用 + 读来源 → 过; 调用不读来源 → 抓; 只有 import 不算调用 → 不误伤。
    expect(SOURCE_TRACE.test(withProvenance)).toBe(true);
    expect(SOURCE_TRACE.test(withoutProvenance)).toBe(false);
    expect(SEAT_CALL.test(importOnly)).toBe(false);
    // 注释里的 .source 说明不算形迹
    expect(isCommentLine('// 来源 ${seat?.source} 拼接见下')).toBe(true);
  });
});
