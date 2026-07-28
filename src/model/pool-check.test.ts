/**
 * 池子自检 (2026-07-29) —— 补 `config.pools` 这条**绕开座位链**的轴。
 *
 * 实测踩过的形态 (owner 的排查记录): 12 个 `OMD_*` 环境变量 + 5 个 `--*-model` 旗标全设了,
 * 一个都没生效 —— 因为叶子走的是 `config.pools` 的轮换, 根本不问座位。而池子里全是欠费的
 * provider, 座位自检还全绿, 直到跑到一半 429/403 才炸。
 *
 * 这里钉的是: 显式配置的池子里有死坐标 → **起跑就说**, 且说清"座位覆盖对它无效"。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPools } from './role-fallback';

/** 造一份只含 pools 段的临时 config, 并把 OMD_CONFIG_PATH 指过去。 */
const withConfig = <T,>(cfg: unknown, fn: () => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-pools-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(cfg), 'utf-8');
  const prev = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = path;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.OMD_CONFIG_PATH;
    else process.env.OMD_CONFIG_PATH = prev;
  }
};

describe('checkPools — config.pools 的死坐标要在起跑就可见', () => {
  test('没配 pools → 空结论 (未配的档位由座位推导, 已被 checkSeats 覆盖, 不重复报)', () => {
    const out = withConfig({ models: {} }, () => checkPools({}));
    expect(out).toEqual([]);
  });

  test('显式池里全是无凭证坐标 → 整池标出, size 与 unusable 等长', () => {
    const out = withConfig({ pools: { cheap: ['deadco:m1', 'alsodead:m2'] } }, () => checkPools({}));
    const cheap = out.find((p) => p.tier === 'cheap')!;
    expect(cheap.size).toBe(2);
    expect(cheap.unusable.sort()).toEqual(['alsodead:m2', 'deadco:m1']);
  });

  test('池里混着一个可用坐标 → 只报死的那些 (部分可用不等于安全)', () => {
    const out = withConfig({ pools: { mid: ['deadco:m1', 'live:m2'] } }, () =>
      // env key 让 live provider 有凭证 (usable 走完整凭证链: registry / auth.json / env key)
      checkPools({ LIVE_API_KEY: 'k' }),
    );
    const mid = out.find((p) => p.tier === 'mid')!;
    expect(mid.size).toBe(2);
    expect(mid.unusable).toContain('deadco:m1');
  });

  test('多个档位各自独立结论 (一个档全死不影响另一个的判定)', () => {
    const out = withConfig({ pools: { cheap: ['deadco:m1'], strong: ['deadco:m2', 'deadco:m3'] } }, () =>
      checkPools({}),
    );
    expect(out.map((p) => p.tier).sort()).toEqual(['cheap', 'strong']);
    expect(out.find((p) => p.tier === 'strong')!.size).toBe(2);
  });

  test('空数组档位不产生结论 (配了个空池 ≠ 有问题)', () => {
    const out = withConfig({ pools: { cheap: [] } }, () => checkPools({}));
    expect(out).toEqual([]);
  });
});
