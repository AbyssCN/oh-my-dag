/**
 * 规格数量声明告知层的判别力闸。
 *
 * ⚠ **两份主样本是真的**: 2026-08-23 派 #238 那两趟 goal 的原文片段 —— 第一趟(错的,
 * 「7 条」是我数错的, 没有任何可跑出处)与第二趟(改过的, 验收里有 `grep -c … 输出 6`)。
 * 手编样本只能证明「正则和我脑子里的格式一致」, 而这条启发式要认的恰恰是**我真会写出来的文字**。
 *
 * 反向自检(2026-08-23 各跑过一遍, 还原复绿):
 * - 把 `commandNumbers` 那段收集去掉(所有声明都判 unbacked) ⇒ ★② 红(第二趟本该干净);
 * - 把 `CLAIM` 的量词表加上「行」⇒ ★③ 红(行号会被误报成数量声明)。
 */
import { describe, expect, test } from 'bun:test';
import { findNumericClaims, renderNumericClaimNotice } from './numeric-claims';

/** 真样本 A —— 2026-08-23 第一趟 #238 派工原文(「7 条」是错的, 且没有可跑出处)。 */
const GOAL_BAD = `
- \`test/core/fault-injection.test.ts:62\` 的 \`runChild\` 用 \`awaitExitBounded\` 拿退出码。
- **\`r.code === 0\` 被 7 条用例真的断言**(约 :243 / :255 / :267 一带)。

## 硬约束
- **7 条 \`expect(r.code).toBe(0)\` 一条都不许删、不许放宽。**

## 验收
- \`bunx tsc --noEmit\` 退出码 0
- \`bun test test/core/fault-injection.test.ts\` 连跑 3 趟 11 pass / 0 fail
`;

/** 真样本 B —— 改过的第二趟: 数字进了验收命令, 于是它可跑。 */
const GOAL_FIXED = `
- **恰好 6 条** \`expect(r.code).toBe(0)\` 真的断言它, 在 :257 :269 :281 :291 :303 :314。

## 验收
- \`grep -c 'expect(r.code).toBe(0)' test/core/fault-injection.test.ts\` 输出 6
`;

describe('规格数量声明 —— 有没有可跑的出处', () => {
  test('★① 第一趟那份: 「7 条」被认出来且判 unbacked, 回执把话说到点上', () => {
    const claims = findNumericClaims(GOAL_BAD);
    const seven = claims.find((c) => c.value === 7);
    expect(seven).toBeDefined();
    expect(seven!.backed).toBe(false);
    const notice = renderNumericClaimNotice(GOAL_BAD);
    expect(notice).toContain('没有可跑的出处');
    expect(notice).toContain('test $(grep -c'); // 念出补救形状, 不只说"你错了"
  });

  test('★② 第二趟那份: 数字进了验收命令 ⇒ 判 backed, 回执**不出声**', () => {
    const six = findNumericClaims(GOAL_FIXED).find((c) => c.value === 6);
    expect(six?.backed).toBe(true);
    expect(renderNumericClaimNotice(GOAL_FIXED)).toBe('');
  });

  test('★③ 行号 / 日期 / 预算 / 「第 N 行」一个都不许进(误报会让这条被无视)', () => {
    const claims = findNumericClaims(
      '改 `src/x.ts:257` 与 :314 两处; 2026-08-23 定的; budgetMinutes 60; 不许改第 58 行。',
    );
    // 257/314/2026/08/23/60/58 都不是"在数东西", 一个都不该报。
    // ⚠ **已知缺口, 照实钉**: 「两处」是真声明却也没被抓 —— 本模块只认阿拉伯数字,
    //   中文数词(两/三/五条)不认。取窄不取宽的理由: 误报一次, 这行字下次就被跳过了;
    //   而今天真实付账的那次写的是「7 条」, 正在覆盖面内。要扩到中文数词, 先拿真 goal
    //   语料量一次误报率再说, 别拍脑袋加。
    expect(claims).toHaveLength(0);
  });

  test('同一个「数+量词」重复出现只报一次(第一趟里「7 条」出现两次)', () => {
    expect(findNumericClaims(GOAL_BAD).filter((c) => c.value === 7)).toHaveLength(1);
  });

  test('没有数量声明 ⇒ 空串(没话说就别占回执的地方)', () => {
    expect(renderNumericClaimNotice('把 X 改成 Y, 跑 `bun test` 绿。')).toBe('');
  });
});
