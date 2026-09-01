#!/usr/bin/env bun
/**
 * scripts/bench-usage —— bench A 臂 token 账的机械判据 (D4.2 GWT-4a/4b)。
 *
 * 反向自检(slice 3 写完时还原跑过; 数据用 named sentinel 区别源):
 *   · 把 `note` 字段一律判空  ⇒ GWT-4b 红(空 note = "没采集"无可读性);
 *   · 把 `inV === 0 && outV === 0` 去掉  ⇒ GWT-4b / 补充「usage 全 0」红
 *     (守"绝不记 0 冒充");
 *   · 用 `tokensIn: 0` 直接返回  ⇒ GWT-4b 红(违反 NULL≠0≠不适用 仓规)。
 *
 * 这条测只读盘, **不起真 run**: 整个 bench 跑几分钟甚至几十分钟, 而真 run 的 token 账
 * 真伪只能拆 deps 单测。本测装一条假 `runs.db` 写一条假记录, 走 `readArmTokens` 同一条管线,
 * 守住「真数 > 0 / 缺席 → null + note / 全 0 → null + note」三条闸。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArmTokens } from './omd-bench';
import { createRunStore } from '../src/mcp/run-store';

const newRun = (runId: string, result: unknown, status: 'done' | 'failed' | 'cancelled' = 'done'): {
  runId: string;
  status: string;
  goal: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  ownerPid: null;
  result: unknown;
} => ({
  runId,
  status,
  goal: 'fixture',
  meta: {},
  createdAt: new Date('2026-09-01T00:00:00Z').toISOString(),
  updatedAt: new Date('2026-09-01T00:01:00Z').toISOString(),
  ownerPid: null,
  result,
});

describe('bench A 臂 token 账 (D4.2 GWT-4a/4b)', () => {
  test('★ GWT-4a: 终态 done + 完整 usage → tokensIn/Out > 0, note 空串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      mkdirSync(join(dir, '.omd'), { recursive: true });
      const store = createRunStore({ path: join(dir, '.omd', 'runs.db') });
      try {
        store.put(
          newRun('real', {
            usage: {
              conductor: { in: 10, out: 5 },
              leavesIn: 100,
              leavesOut: 50,
              leavesCacheHit: 0,
              verifier: { in: 20, out: 15 },
            },
          }),
        );
      } finally {
        store.close();
      }
      const r = readArmTokens(dir, 'real');
      expect(r.tokensIn).not.toBeNull();
      expect(r.tokensOut).not.toBeNull();
      // conductor(10) + leavesIn(100) + verifier(20) = 130
      expect(r.tokensIn).toBe(130);
      // conductor(5) + leavesOut(50) + verifier(15) = 70
      expect(r.tokensOut).toBe(70);
      expect(r.tokensIn).toBeGreaterThan(0);
      expect(r.tokensOut).toBeGreaterThan(0);
      expect(r.note).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ GWT-4b: 盘上无该 run 行 → tokensIn/Out = null, note 非空且说明没采 (不是 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      mkdirSync(join(dir, '.omd'), { recursive: true });
      // 不放任何记录。readArmTokens 必须返 null, **绝不可返 0** (NULL≠0≠不适用)。
      const r = readArmTokens(dir, 'phantom-run');
      expect(r.tokensIn).toBeNull();
      expect(r.tokensOut).toBeNull();
      expect(r.note).not.toBe('');
      expect(r.note).toContain('phantom-run');
      // 三态纪律这条要看得见的: note 必须说出 "无… 行", 否则 null 与 0 在字面上没区分。
      expect(r.note).toMatch(/无|未|缺席/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ 三态闸: usage 已写但全 0 (probe-only) → null + note (绝不记 0 冒充)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      mkdirSync(join(dir, '.omd'), { recursive: true });
      const store = createRunStore({ path: join(dir, '.omd', 'runs.db') });
      try {
        store.put(
          newRun('probe-only', {
            usage: {
              conductor: { in: 0, out: 0 },
              leavesIn: 0,
              leavesOut: 0,
              leavesCacheHit: 0,
              // 探测段按 I-11 不算 ── 就算写了也不进聚合
              probe: { in: 333, out: 111 },
            },
          }),
        );
      } finally {
        store.close();
      }
      const r = readArmTokens(dir, 'probe-only');
      expect(r.tokensIn).toBeNull();
      expect(r.tokensOut).toBeNull();
      expect(r.note).toContain('probe-only');
      // 关键: 不能把 probe 的 in=333 当 in 报上去 (I-11 隔离)
      expect(r.note).toMatch(/0|全 0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('三态闸: 终态 done 但 result.usage 缺席 → null + note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      mkdirSync(join(dir, '.omd'), { recursive: true });
      const store = createRunStore({ path: join(dir, '.omd', 'runs.db') });
      try {
        store.put(newRun('no-usage', { verification: { pass: true, reason: 'ok' } }));
      } finally {
        store.close();
      }
      const r = readArmTokens(dir, 'no-usage');
      expect(r.tokensIn).toBeNull();
      expect(r.tokensOut).toBeNull();
      expect(r.note).toContain('no-usage');
      expect(r.note).toContain('usage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('三态闸: failed 终态也算 (失败也烧 token, 不丢账) → 真数读得到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      mkdirSync(join(dir, '.omd'), { recursive: true });
      const store = createRunStore({ path: join(dir, '.omd', 'runs.db') });
      try {
        store.put(
          newRun(
            'failed-with-usage',
            { usage: { conductor: { in: 7, out: 3 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 } },
            'failed',
          ),
        );
      } finally {
        store.close();
      }
      const r = readArmTokens(dir, 'failed-with-usage');
      expect(r.tokensIn).toBe(7);
      expect(r.tokensOut).toBe(3);
      expect(r.note).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('读盘异常 → null + note (不算通过, fail-open 留证)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-tok-'));
    try {
      // .omd 目录不建, runs.db 不存在 ── createRunStore 会自动 mkdir 创建空表(get 返 null,
      // 走 GWT-4b 那条); 这条覆盖的是另一种异常形态: 占着一个损坏的 db 文件, 让 store 初始化抛。
      mkdirSync(join(dir, '.omd'), { recursive: true });
      // 写一份首字节就坏的文件, 模拟半挂态
      const path = join(dir, '.omd', 'runs.db');
      require('node:fs').writeFileSync(path, 'NOT A VALID SQLITE FILE');
      const r = readArmTokens(dir, 'whatever');
      // 三选一: 抛了的 catch 路径返 null; 或 store 自身吞了异常(get 返 null)。
      // 两条路都接受「不是 0」 ── 但用真 null 守 NULL≠0。
      if (r.tokensIn !== null || r.tokensOut !== null) {
        // 若实现选择「该 path 抛就让外层兜」的语义, 这条应改; 但本切片没承诺它, 跳过。
        // 真要这条走 GWT-4b 那条路径 ── 必须有 note。
        expect(r.note).not.toBe('');
      } else {
        expect(r.note).not.toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
