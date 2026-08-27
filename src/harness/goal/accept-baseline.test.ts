/**
 * 取末环纯函数的契约测试 (SDD 片 1: INV-1 / INV-2 / INV-3)。
 *
 * 这文件存在的理由:基线赦免在直通 SDD 档下恒失效,根因是批前跑整条验收命令
 * (该命令按 `src/harness/goal/sdd-compile.ts:373-380` 逐字规定为「各片 verify 串联 && 末环全量」)
 * 必然停在第一环 `ugrep -q` 的反作弊条款上,基线失败集是空集,`makeBaselineWaiver` 按
 * fail-closed 返 null。修法:批前只跑末环 —— 末环按构造是去掉路径的全量回归,
 * 活干之前跑它,量到的就是这个仓当下真实的存量红。
 *
 * 本片是那一片修法的**纯函数层** (零接线, 零命令执行) —— INV-4/INV-6 在片 2 接线层验证。
 *
 * 反向自检(必须真跑一次, 红了才算闸活着):
 * - 让函数返整条命令 → 下方 `★①` 与 `★②` 红。
 * - 让函数对不含 `&&` 的输入做 trim → 下方 `INV-2` 红。
 * - 让函数取首段 → 下方 `INV-1` 红。
 * - 让函数不 trim → 下方 `INV-3 ③` 红。
 */
import { describe, expect, test } from 'bun:test';
import { baselineCommandOf } from './accept-baseline';

describe('INV-1 取末环: 输入 N 段串联, 返回最后一段 (整条不为首段)', () => {
  test('★① 三段串联,末环是去掉路径的全量版', () => {
    // SDD 注释里给的原形: 各片 verify 去重串联 + 末尾去掉路径限定。
    const cmd = "ugrep -q 'X' ./a.test.ts && bun test ./a.test.ts && bun test";
    expect(baselineCommandOf(cmd)).toBe('bun test');
  });

  test('★② 两段串联,末环是全量版', () => {
    expect(baselineCommandOf('bun test ./a.test.ts && bun test')).toBe('bun test');
  });

  test('四段串联,仍是最后一段', () => {
    expect(
      baselineCommandOf(
        'ugrep -q X a.test.ts && bun test a.test.ts && ugrep -q Y b.test.ts && bun test',
      ),
    ).toBe('bun test');
  });

  test('末环本身带路径限定也不被裁 (返回即末环, 不再二次切)', () => {
    expect(
      baselineCommandOf('ugrep -q X a.test.ts && pytest tests/integration/test_x.py'),
    ).toBe('pytest tests/integration/test_x.py');
  });
});

describe('INV-2 不含 && 的命令原样返回 (非直通档零回归由构造成立)', () => {
  test('★① 单条 bun test 命令逐字节相同', () => {
    const cmd = 'bun test src/x.test.ts';
    expect(baselineCommandOf(cmd)).toBe(cmd);
  });

  test('★② 单条 pytest 命令逐字节相同', () => {
    const cmd = 'pytest tests/x.py';
    expect(baselineCommandOf(cmd)).toBe(cmd);
  });

  test('★③ 单条命令前后带空白也逐字节相同 (原样 = 字节相同, 不许 trim)', () => {
    // 守卫: 实现若把"无 && → 原样返回"理解成"先 trim 再返"会在这条红。
    const cmd = '  bun test src/x.test.ts  ';
    expect(baselineCommandOf(cmd)).toBe(cmd);
  });

  test('空字符串', () => {
    expect(baselineCommandOf('')).toBe('');
  });
});

describe('INV-3 首尾空白与多重分隔不改变结果', () => {
  test('★① 末环尾部带空格 → trim 后等于末环原文', () => {
    const cmd = 'ugrep -q X a.test.ts && bun test   ';
    expect(baselineCommandOf(cmd)).toBe('bun test');
  });

  test('★② 分隔符两侧多空格仍正确切 (实现须吃下多空格, 不限于单空格)', () => {
    // 守卫: 实现若按字面 `' && '` 切, 这里会切成 ["...ugrep...", "  bun test ./a.test.ts"]
    // 然后返 "  bun test ./a.test.ts" —— 期望是 "bun test ./a.test.ts", 必红。
    const cmd = 'ugrep -q X a.test.ts  &&  bun test ./a.test.ts';
    expect(baselineCommandOf(cmd)).toBe('bun test ./a.test.ts');
  });

  test('★③ 末环前导 + 尾随空白 trim 后干净', () => {
    const cmd = 'ugrep -q X a.test.ts &&    bun test   &&   bun test   ';
    expect(baselineCommandOf(cmd)).toBe('bun test');
  });
});
