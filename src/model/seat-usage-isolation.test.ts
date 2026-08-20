/**
 * 座位账本的**测试隔离闸** + 合成记录判据(2026-08-21, owner 点名)。
 *
 * ## 为什么是一条闸而不是一句纪律
 *
 * 污染是**静默**的:测试跑在真仓根目录 → `emitSeatUsage` 往生产 `.omd/seat-usage.jsonl` 追加 →
 * 文件照常能读、统计照常出数,**只是九成是夹具写的**。没有任何报错会告诉你这件事。
 * 实测代价:「verifier 占全部调用 0.23%」的分母是被污染的 21,674(真分母 2,183,真占比 2.4%)。
 * 结论方向没错,但那个数是错的 —— 而它**错得看不出来**,正是本仓图鉴里最贵的那一类。
 *
 * 讲道理拦不住(仓规 §Q4):所以做成会红的闸。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { omdRepoRoot } from '../harness/repo-root';
import { SEAT_USAGE_FILE, seatUsagePath, syntheticSeatUsageReason } from './seat-usage';

describe('★ 隔离闸 — 测试期的账本不许指向生产文件', () => {
  test('seatUsagePath() 在测试进程里**不是** <repo>/.omd/seat-usage.jsonl', () => {
    // 反向自检(实跑过): 把 test/setup/tmpdir-isolation.ts 里那行
    // `process.env.OMD_SEAT_USAGE_PATH = …` 删掉 → 本条当场红。
    const production = join(omdRepoRoot(), '.omd', SEAT_USAGE_FILE);
    expect(seatUsagePath()).not.toBe(production);
  });

  test('它指向本轮一次性目录(TMPDIR 下), 跑完随目录一起消失', () => {
    expect(process.env.OMD_SEAT_USAGE_PATH).toBeDefined();
    expect(seatUsagePath().startsWith(process.env.TMPDIR!)).toBe(true);
  });
});

describe('合成记录判据 syntheticSeatUsageReason', () => {
  test('夹具坐标 → fake-model(真实样本: 账本里出现过的那几种)', () => {
    for (const model of ['fixture:none', 'l:l', 'fake:leaf', 'c:m', 'test:leaf', 'a:m']) {
      expect(syntheticSeatUsageReason({ model, in: 999_999 }), model).toBe('fake-model');
    }
  });

  test('★ 真坐标 + 玩具用量 → toy-usage(只看前缀会漏掉这一批)', () => {
    // 账本里真有 448 条 `claude-code:claude-sonnet-5` 配 in=1 out=1 —— 夹具借了真坐标。
    // 反向自检: 把 in<=10 那条判据摘掉 → 本条红, 而线上会多留几千条噪声。
    expect(syntheticSeatUsageReason({ model: 'claude-code:claude-sonnet-5', in: 1 })).toBe('toy-usage');
    expect(syntheticSeatUsageReason({ model: 'deepseek:deepseek-v4-flash', in: 10 })).toBe('toy-usage');
  });

  test('真坐标 + 真用量 → null(判别力锚: 闸不许把真调用也判掉)', () => {
    // 一个把所有记录都判成合成的"闸"量的是尺子。这条钉住它确实会放行真的。
    expect(syntheticSeatUsageReason({ model: 'openai-codex:gpt-5.6-sol', in: 9348 })).toBeNull();
    expect(syntheticSeatUsageReason({ model: 'minimax-cn:MiniMax-M3', in: 11 })).toBeNull();
  });

  test('★ in === null → **不算合成**(NULL ≠ 0 ≠ 不适用)', () => {
    // 「这一发没读到 usage」(抛错 / provider 不报) 是真调用的一种失败形态。
    // 判成合成就把真失败抹掉了 —— 而那正是最该留下的记录。
    expect(syntheticSeatUsageReason({ model: 'openai-codex:gpt-5.6-sol', in: null })).toBeNull();
  });

  test('in = 0 的真坐标 → toy-usage(0 与 null 是两件事, 这里只判 0)', () => {
    expect(syntheticSeatUsageReason({ model: 'deepseek:deepseek-v4-pro', in: 0 })).toBe('toy-usage');
  });
});
