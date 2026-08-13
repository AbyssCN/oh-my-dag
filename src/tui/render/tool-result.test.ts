/**
 * L1:工具行右半句 = 结果(2026-08-13,owner 点名「工具结果也进屏」)。
 *
 * 这一族真正会咬人的是**把两种状态抹成一种**,所以判据集中在那几处:
 * `no match` 与 `capped` 必须能同时出现(否则"没搜到"与"没走到那儿"分不开)、
 * `exit undefined` 不许画成 `exit 0`(否则"被杀掉"读成"跑成功了")。
 *
 * 反向自检(实跑):把 `summarizeToolResult` 里 grep 那支的 `flags` 拼接删掉 →
 * 「no match 与 capped 同时出现」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { summarizeToolResult } from './tool-result';

describe('grep —— 命中数是主体, 截断与剪枝跟着它一起出现', () => {
  test('命中', () => {
    expect(summarizeToolResult('grep', { matches: 8, files: 3, walkCapped: false, skippedMounts: 0 })).toBe('8 in 3 files');
  });

  test('单数不写 files', () => {
    expect(summarizeToolResult('grep', { matches: 2, files: 1, walkCapped: false, skippedMounts: 0 })).toBe('2 in 1 file');
  });

  test('★ 0 命中说成 no match, 不是留空 —— 「没搜到」是一个读数', () => {
    expect(summarizeToolResult('grep', { matches: 0, files: 0, walkCapped: false, skippedMounts: 0 })).toBe('no match');
  });

  test('★★ no match 与 capped 必须同屏 —— 否则"没走到那儿"读成"那儿没有"', () => {
    expect(summarizeToolResult('grep', { matches: 0, files: 0, walkCapped: true, skippedMounts: 0 })).toBe('no match · capped');
  });

  test('★★ 剪掉的远端挂载也要出现 —— 静默剪 = 用 no match 骗人', () => {
    expect(summarizeToolResult('grep', { matches: 0, files: 0, walkCapped: false, skippedMounts: 2 })).toBe(
      'no match · 2 mounts skipped',
    );
    expect(summarizeToolResult('grep', { matches: 1, files: 1, walkCapped: false, skippedMounts: 1 })).toBe(
      '1 in 1 file · 1 mount skipped',
    );
  });

  test('两条旗标一起来', () => {
    expect(summarizeToolResult('grep', { matches: 0, files: 0, walkCapped: true, skippedMounts: 3 })).toBe(
      'no match · capped · 3 mounts skipped',
    );
  });

  test('四位数带千分位 —— 不加分隔符读不出量级', () => {
    expect(summarizeToolResult('grep', { matches: 12_345, files: 678, walkCapped: false, skippedMounts: 0 })).toBe(
      '12,345 in 678 files',
    );
  });
});

describe('其余工具', () => {
  test('read 行数 + 截断', () => {
    expect(summarizeToolResult('read', { lines: 120, truncated: false })).toBe('120 lines');
    expect(summarizeToolResult('read', { lines: 9000, truncated: true })).toBe('9,000 lines · truncated');
  });

  test('ls 条目数(单复数)', () => {
    expect(summarizeToolResult('ls', { count: 18 })).toBe('18 entries');
    expect(summarizeToolResult('ls', { count: 1 })).toBe('1 entry');
  });

  test('write 字节数 · edit 替换', () => {
    expect(summarizeToolResult('write', { bytes: 512 })).toBe('512 B');
    expect(summarizeToolResult('edit', { replaced: true })).toBe('1 replaced');
  });

  test('★ bash 的 exitCode 缺席 ≠ exit 0 —— 被杀掉不许读成跑成功了', () => {
    expect(summarizeToolResult('bash', { exitCode: 0, truncated: false })).toBe('exit 0');
    expect(summarizeToolResult('bash', { exitCode: 3, truncated: false })).toBe('exit 3');
    expect(summarizeToolResult('bash', { exitCode: undefined, truncated: false })).toBe('no exit code');
  });

  test('bash 输出被截也说出来', () => {
    expect(summarizeToolResult('bash', { exitCode: 0, truncated: true })).toBe('exit 0 · output truncated');
  });
});

describe('挑不出就不画 —— 不编占位', () => {
  test('未登记的工具', () => {
    expect(summarizeToolResult('omd_run', { runId: 'r1' })).toBeNull();
  });

  test('details 缺席 / 形状不对', () => {
    for (const d of [undefined, null, 'text', 42, []]) expect(summarizeToolResult('grep', d)).toBeNull();
  });

  test('登记了但缺关键字段 → null, 不是 0', () => {
    expect(summarizeToolResult('grep', { files: 3 })).toBeNull();
    expect(summarizeToolResult('read', { truncated: true })).toBeNull();
    expect(summarizeToolResult('edit', { replaced: false })).toBeNull();
  });
});
