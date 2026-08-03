/**
 * eval 脚本的**默认座位来源闸** (2026-08-03)。
 *
 * ## 它守的那一条(很窄,故意的)
 *
 * eval 脚本的**默认模型**必须从座位表解析(`tryResolveSeatModel(<座位>)`),
 * 不许回落到一个写死的 `provider:modelId` 字面量。
 *
 * ⚠ **不禁止脚本里出现坐标** —— 有些 eval 的坐标本身就是**被测变量**
 * (跨家族发散实验点名坐标正是它的意义)。禁的是"**没人指定时默默跑哪个**"这一格:
 * 它决定了读数落在哪个座位上,而报告里看不出来。
 *
 * ## 为什么值一条闸(同一形态一天内咬了两次)
 *
 * - `eval-judge-artifacts.ts` 硬编码 `deepseek:deepseek-v4-pro`,而它量的那一发在生产上骑
 *   **`gate` 座**(`deepseek-v4-flash`)→ 2026-08-03 那批读数(含「证据词表让点名召回
 *   0/8 → 8/8」)**量在一个生产上不存在的座位上**。
 * - `eval-detector-usage.ts` 的变量名写着 `CONDUCTOR_SEAT`,值却也是 `deepseek-v4-pro`,
 *   而生产 conductor 当时是 `openai-codex:gpt-5.6-sol` → **detector 那条 60% 天花板的基线
 *   从来不是在生产 conductor 上量的**,而 G6 换座位实验正要拿它当对照。
 *
 * 两处都是**会漂的第二真源**,与 `NODE_CLASS` 手抄座位表同族:平时自洽,漂了没人知道。
 *
 * ## 判据的诚实边界
 *
 * 查的是**源码形状**(默认值回落),不是"跑起来解析成了什么" —— 后者要真跑模型。
 * 它**看不见**从 env / 另一份配置拿坐标的路子;那类要靠 `empty-knobs` 与座位闸那两条。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dir, '..', '..', 'scripts');

/**
 * 默认模型回落到字面坐标: `opt('model') ?? 'provider:modelId'` 一族。
 * 只认**引号里带冒号**的那种(那才是坐标),`?? '3'` 这类数字默认不算。
 */
const HARDCODED_DEFAULT = /\?\?\s*['"`][a-z][a-z0-9-]*:[a-z0-9][a-z0-9.-]*['"`]/g;

const evalScripts = readdirSync(SCRIPTS).filter((f) => f.startsWith('eval-') && f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('eval 脚本的默认模型来自座位表', () => {
  test('至少扫到几个 eval 脚本 (免得目录改名后闸静默变空跑)', () => {
    expect(evalScripts.length).toBeGreaterThan(3);
  });

  for (const f of evalScripts) {
    test(`${f}: 默认模型不是写死的坐标`, () => {
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      const hits = [...src.matchAll(HARDCODED_DEFAULT)]
        .filter((m) => {
          // 注释里举例说明(如"值却曾是 xxx")不算配置。
          const lineStart = src.lastIndexOf('\n', m.index!) + 1;
          return !/^\s*(\*|\/\/)/.test(src.slice(lineStart, src.indexOf('\n', m.index!)));
        })
        .map((m) => m[0]!);
      expect(
        hits,
        `${f} 的默认模型写死了 ${hits.join(', ')} —— 改成 tryResolveSeatModel('<座位>'), ` +
          '否则读数会量在一个与生产不同的座位上(2026-08-03 一天内撞了两次)',
      ).toEqual([]);
    });
  }

  test('反向自检: 这个形状真的匹配得上 (闸不是恒真式)', () => {
    const probe = `const M = opt('model') ?? 'deepseek:deepseek-v4-pro';`;
    expect([...probe.matchAll(HARDCODED_DEFAULT)].length).toBe(1);
    // 数字默认不该误伤
    expect([...`const N = Number(opt('n') ?? '3');`.matchAll(HARDCODED_DEFAULT)].length).toBe(0);
  });
});
