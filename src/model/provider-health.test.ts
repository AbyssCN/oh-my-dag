/**
 * provider-health 熔断测试 (D-18/INV-5): channel:model 粒度冷却。
 *  · 上报 channel:model → 该精确组合冷却, 其它 model 同 channel 不受影响
 *  · channelInCooldown(channel) → channel 级宽门 (role-fallback 用)
 *  · 窗过自愈 · 空串忽略 · reset
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERIOD_COOLDOWN_MS,
  channelInCooldown,
  cooldownMsFor,
  inCooldown,
  livePin,
  reportProviderFailure,
  resetProviderCooldowns,
} from './provider-health';

// 文件级: 周期档 (402/403) 会持久化 —— 不重定向的话测试把死座写进**真仓** .omd/seat-health.json
// (S-B2 落地当天实测: 分档测试污染 pi-transport 测试, 见 commit)。
let fileDir: string;
let fileSavedEnv: string | undefined;
beforeEach(() => {
  fileDir = mkdtempSync(join(tmpdir(), 'omd-ph-'));
  fileSavedEnv = process.env.OMD_SEAT_HEALTH_PATH;
  process.env.OMD_SEAT_HEALTH_PATH = join(fileDir, 'seat-health.json');
  resetProviderCooldowns();
});
afterEach(() => {
  if (fileSavedEnv === undefined) delete process.env.OMD_SEAT_HEALTH_PATH;
  else process.env.OMD_SEAT_HEALTH_PATH = fileSavedEnv;
  rmSync(fileDir, { recursive: true, force: true });
  resetProviderCooldowns();
});

describe('provider-health circuit breaker (D-18/INV-5)', () => {
  afterEach(() => resetProviderCooldowns());

  test('未上报 → 不在冷却', () => {
    expect(inCooldown('allegretto:kimi-k3')).toBe(false);
    expect(channelInCooldown('allegretto')).toBe(false);
  });

  test('上报 channel:model → 该精确组合冷却; 窗过 → 自愈', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    const t0 = Date.now();
    expect(inCooldown('allegretto:kimi-k3', t0 + 10_000)).toBe(true);  // 窗内
    expect(inCooldown('allegretto:kimi-k3', t0 + 40_000)).toBe(false); // 窗过 → 自愈
    expect(inCooldown('allegretto:kimi-k3', t0 + 10_000)).toBe(false); // 自愈后条目已清
  });

  test('同 channel 不同 model 独立冷却 (D-18 核心)', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    // kimi-k3 冷却中, 但同 channel 的其它 model 不受影响
    expect(inCooldown('allegretto:kimi-k3')).toBe(true);
    expect(inCooldown('allegretto:other-model')).toBe(false);
    expect(inCooldown('lite:kimi-k3')).toBe(false); // 不同 channel 也不影响
  });

  test('channelInCooldown 宽门: channel 内任一 model 冷却 → true', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    expect(channelInCooldown('allegretto')).toBe(true);   // channel 有 model 在冷却
    expect(channelInCooldown('lite')).toBe(false);         // 不同 channel
  });

  test('空串忽略, 不抛', () => {
    expect(() => reportProviderFailure('')).not.toThrow();
    expect(inCooldown('')).toBe(false);
  });

  test('reset 清全部冷却', () => {
    reportProviderFailure('allegretto:kimi-k3', 60_000);
    reportProviderFailure('lite:kimi-k3', 60_000);
    resetProviderCooldowns();
    expect(inCooldown('allegretto:kimi-k3')).toBe(false);
    expect(inCooldown('lite:kimi-k3')).toBe(false);
  });
});

describe('冷却分档 (S-B1, 2026-08-10 —— 样本 A: 403 周期级 ≠ 429 瞬时)', () => {
  afterEach(() => resetProviderCooldowns());

  // 证伪方式 (当场验过): cooldownMsFor 里删掉 403 分支 → 首条断言红 (30_000); 恢复后绿。
  test('402/403 → 周期档长窗; 429/5xx/transport → 瞬时档 30s', () => {
    expect(cooldownMsFor(403)).toBe(PERIOD_COOLDOWN_MS);
    expect(cooldownMsFor(402)).toBe(PERIOD_COOLDOWN_MS);
    expect(cooldownMsFor(429)).toBe(30_000);
    expect(cooldownMsFor(500)).toBe(30_000);
    expect(cooldownMsFor(undefined)).toBe(30_000); // transport 无 status
  });

  test('周期档窗内跨过瞬时档边界仍在冷却, 窗过自愈 (有界重试语义)', () => {
    const t0 = Date.now();
    reportProviderFailure('kimi-coding:k3', cooldownMsFor(403));
    expect(inCooldown('kimi-coding:k3', t0 + 60_000)).toBe(true); // 瞬时窗后仍下线
    expect(inCooldown('kimi-coding:k3', t0 + PERIOD_COOLDOWN_MS - 1)).toBe(true);
    expect(inCooldown('kimi-coding:k3', t0 + PERIOD_COOLDOWN_MS + 1)).toBe(false); // 窗过重试一次
  });

  // 证伪方式 (当场验过): livePin 里把 inCooldown 判断取反 → 两条断言红; 恢复后绿。
  test('livePin: 冷却中的 pin 视为缺席 (样本 B/C: 死座不复活), 活座原样透传', () => {
    const t0 = Date.now();
    reportProviderFailure('kimi-coding:k3', cooldownMsFor(403));
    expect(livePin('kimi-coding:k3', t0 + 1000)).toBeUndefined(); // 死座 → 缺席, 落回解析链
    expect(livePin('deepseek:deepseek-v4-pro', t0 + 1000)).toBe('deepseek:deepseek-v4-pro');
    expect(livePin(undefined, t0)).toBeUndefined(); // 无 pin 本来就缺席
    expect(livePin('kimi-coding:k3', t0 + PERIOD_COOLDOWN_MS + 1)).toBe('kimi-coding:k3'); // 窗过复活
  });
});

describe('S-B2 周期档跨进程持久化 (.omd/seat-health.json)', () => {
  const { mkdtempSync, rmSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omd-seat-health-'));
    savedEnv = process.env.OMD_SEAT_HEALTH_PATH;
    process.env.OMD_SEAT_HEALTH_PATH = join(dir, 'seat-health.json');
    resetProviderCooldowns();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OMD_SEAT_HEALTH_PATH;
    else process.env.OMD_SEAT_HEALTH_PATH = savedEnv;
    rmSync(dir, { recursive: true, force: true });
    resetProviderCooldowns();
  });

  // 证伪方式 (当场验过): reportProviderFailure 里删掉 persistPeriodCooldown 调用
  // → 本测试红 (reset 后 inCooldown false); 恢复后绿。
  test('★ 周期档 (403) 写入磁盘, 「新进程」(reset 模拟) 继承 —— spawn 的 worker 不再撞死座', () => {
    reportProviderFailure('kimi-coding:k3', cooldownMsFor(403));
    resetProviderCooldowns(); // 模拟新 spawn 的 goal-worker (内存全空)
    expect(inCooldown('kimi-coding:k3')).toBe(true); // 从 seat-health.json 继承
    expect(livePin('kimi-coding:k3')).toBeUndefined(); // dispatch 存活闸同样看得见
  });

  test('瞬时档 (429) 不写入磁盘 —— 新进程不继承 (30s 陈旧只有害处)', () => {
    reportProviderFailure('mimo:m2', cooldownMsFor(429));
    expect(inCooldown('mimo:m2')).toBe(true); // 本进程内存里在
    resetProviderCooldowns();
    expect(inCooldown('mimo:m2')).toBe(false); // 盘上没有 → 新进程不继承
  });

  test('过期条目读时过滤 (存到期时刻, 窗过即自愈)', () => {
    writeFileSync(
      process.env.OMD_SEAT_HEALTH_PATH!,
      JSON.stringify({ cooldowns: [{ key: 'dead:seat', until: Date.now() - 1000, since: Date.now() - 7_200_000 }] }),
    );
    expect(inCooldown('dead:seat')).toBe(false); // 过期 = 自愈, 不许永久除名
  });

  test('坏文件 fail-open: 不抛、按空处理 (证据走 logger)', () => {
    writeFileSync(process.env.OMD_SEAT_HEALTH_PATH!, '{corrupt');
    expect(() => inCooldown('any:seat')).not.toThrow();
    expect(inCooldown('any:seat')).toBe(false);
  });
});
