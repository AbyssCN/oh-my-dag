/**
 * 切片②:调用账本。
 *
 * 反向自检:
 * - 「5h 窗口是滚动的」用注入时钟证 —— 把 window() 里的 `r.ts >= since` 改成恒真,
 *   「窗口外那笔不算」当场红。
 * - 「跨重启存活」开第二个实例读同一目录 —— 把 persist 注释掉,那条当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIVE_HOURS_MS, USAGE_LEDGER_FILE, createTuiUsageLedger } from './ledger';

const tdir = () => mkdtempSync(join(tmpdir(), 'omd-usage-'));

describe('记账与窗口', () => {
  test('record 上账 + 计价(价表坐标)+ unpriced 标注(坐标不在表里)', () => {
    const led = createTuiUsageLedger({ dir: tdir(), now: () => 1000 });
    const priced = led.record({ in: 1_000_000, out: 0 }, 'deepseek:deepseek-v4-flash', 'engine');
    expect(priced.costUsd).toBeCloseTo(0.27, 5);
    expect(priced.unpriced).toBe(false);
    const un = led.record({ in: 100, out: 10 }, 'nobody:mystery', 'chat');
    expect(un.costUsd).toBe(0);
    expect(un.unpriced).toBe(true); // 0 元与没计价不是一回事
  });

  test('★ 5h 窗口是滚动的: 窗口外那笔不算', () => {
    let clock = 0;
    const led = createTuiUsageLedger({ dir: tdir(), now: () => clock });
    led.record({ in: 100, out: 10 }, 'a:m', 'chat');
    clock = FIVE_HOURS_MS + 1; // 第一笔滚出窗口
    led.record({ in: 200, out: 20 }, 'a:m', 'chat');
    const w = led.window();
    expect(w.calls).toBe(1);
    expect(w.in).toBe(200);
  });

  test('byProvider 按坐标前缀分组, 花费多的在前', () => {
    const led = createTuiUsageLedger({ dir: tdir(), now: () => 0 });
    led.record({ in: 1_000_000, out: 0 }, 'deepseek:deepseek-v4-flash', 'engine');
    led.record({ in: 50, out: 5 }, 'kimi-coding:k3', 'chat');
    led.record({ in: 60, out: 6 }, 'kimi-coding:k3', 'chat');
    const w = led.window();
    expect(w.byProvider.map((p) => p.provider)).toEqual(['deepseek', 'kimi-coding']);
    expect(w.byProvider[1]!.calls).toBe(2);
  });

  test('sessionTotal 只算本进程写的; window 算全部(含读回的历史)', () => {
    const dir = tdir();
    const a = createTuiUsageLedger({ dir, now: () => 0 });
    a.record({ in: 100, out: 10 }, 'a:m', 'chat');
    const b = createTuiUsageLedger({ dir, now: () => 1 });
    b.record({ in: 200, out: 20 }, 'a:m', 'chat');
    expect(b.sessionTotal().calls).toBe(1); // 只有自己那笔
    expect(b.window().calls).toBe(2); // 历史 + 自己 (5h 窗口跨重启存活的意义)
  });
});

describe('持久化', () => {
  test('★ 跨实例读回(jsonl 落在 .omd/tui-usage.jsonl)', () => {
    const dir = tdir();
    const a = createTuiUsageLedger({ dir, now: () => 42 });
    a.record({ in: 7, out: 3, cacheHit: 2 }, 'p:m', 'engine');
    const raw = readFileSync(join(dir, USAGE_LEDGER_FILE), 'utf8');
    expect(raw).toContain('"model":"p:m"');
    const again = createTuiUsageLedger({ dir, now: () => 43 });
    expect(again.window().in).toBe(7);
  });

  test('坏行静默跳过, 好行照读(账本是读数不是闸)', () => {
    const dir = tdir();
    writeFileSync(
      join(dir, USAGE_LEDGER_FILE),
      `{oops\n${JSON.stringify({ ts: 1, model: 'a:m', source: 'chat', in: 5, out: 1, cacheHit: 0, costUsd: 0, unpriced: true })}\n`,
    );
    const led = createTuiUsageLedger({ dir, now: () => 2 });
    expect(led.window().calls).toBe(1);
  });

  test('超长文件压缩到最近 1 万行(无界增长是已知脏场景)', () => {
    const dir = tdir();
    const path = join(dir, USAGE_LEDGER_FILE);
    const line = JSON.stringify({ ts: 1, model: 'a:m', source: 'chat', in: 1, out: 0, cacheHit: 0, costUsd: 0, unpriced: true });
    writeFileSync(path, `${Array.from({ length: 50_001 }, () => line).join('\n')}\n`);
    createTuiUsageLedger({ dir, now: () => 2 });
    const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
    expect(kept).toBe(10_000);
  });
});
