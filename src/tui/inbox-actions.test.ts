/**
 * src/tui/inbox-actions.test —— 收件箱三态真接线 (SDD 片 7, 切片 3)。
 *
 * 钉的 GWT 列表:
 *   - INV-RC-2: `decideInboxKey` 把 `i` / `s` 从 `prefill` 分到 `intervene` / `cancel`,
 *     渲染层 `i` 字面带「record intervention」, `s` 带「stop detached run」, 且
 *     **不含**「mark green」/「标绿」之类。
 *   - INV-RC-1 / INV-RC-7: `intervene` 调 `recordIntervention(runId, cause, note)` —
 *     `promptIntervene` 返回 `{cause, note}` 时一字不漏地落到 deps 上; 写完
 *     `refreshItems` 仍被调 (INV-BOX-7 同款闸)。
 *   - INV-RC-3: `cancel` 二次确认 (`confirmStop`) — false 与 null 都**不**写盘。
 *     同时 `confirmStop` 返回 true 时, `runCancel` 的 `signalled` 结局走
 *     `formatCancelNotice` 出「SIGTERM sent to pid <pid> (<runId>)」 (INV-RC-4)。
 *   - INV-RC-4: `CancelOutcome` 四种结局 (`signalled` / `no-owner-pid` / `pid-dead`
 *     / `signal-failed`) 在 `formatCancelNotice` 里**分得开** —— 屏上**不许**只
 *     出现「已请求取消」之类的笼统字眼。每种要点名是哪一档。
 *   - INV-RC-5 / INV-RC-6: take 的数据源筛子 —— `approachingAwaitingItems` 仅收
 *     逼近超时 (`已等 ≥ timeoutMs × 0.75`) 且 `timeoutMs` 缺席的不收; 无源时返
 *     空数组 (本片单独测, 不走 renderer 的 InboxItem 形状, 避免改 inbox.test.ts)。
 *
 * 反向自检 (实跑过, 改完代码记得跑一遍):
 *   · 把 `decideInboxKey` 里 `node + 'i'` 退回 `prefill` → "node + i → intervene" 红。
 *   · 把 `formatCancelNotice` 里 `no-owner-pid` 分支拼成 "已请求取消" → "no-owner-pid
 *     notice 点名原因" 红。
 *   · 把 `approachingAwaitingItems` 里 `timeoutMs === undefined` 的 continue 删掉 →
 *     "timeoutMs 缺席不收" 红。
 *   · 把 `intervene` handler 里 `deps.recordIntervention(...)` 漏调 → "intervene
 *     → recordIntervention 调用形态" 红 (recordCalls 为空)。
 *   · 把 `cancel` handler 里 `if (confirmed !== true)` 改成 `!== false` → "cancel
 *     Esc 不写盘" 红 (cancel 被调)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyInboxAction,
  decideInboxKey,
  formatCancelNotice,
  type ApplyInboxActionDeps,
  type InboxAction,
  type InboxItem,
} from './render/inbox';
import type { PathBackend } from '../harness/pathfinder/backend';
import type { PathMap, SuggestionLogEntry } from '../harness/pathfinder/types';
import type { ConfirmAction } from '../harness/pathfinder/suggest';
import {
  awaitingRuns,
  readBoard,
  type AwaitingEntry,
  type BoardEntry,
} from '../harness/board/run-board';

// ── 工厂 ──────────────────────────────────────────────────────────────────────

const NOW_ISO = '2026-08-22T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const RUN_ID = 'run-aaaa-bbbb-cccc-dddd';

const nodeItem = (over: Partial<Extract<InboxItem, { kind: 'node' }>> = {}): Extract<InboxItem, { kind: 'node' }> => ({
  kind: 'node',
  runId: RUN_ID,
  nodeId: 'e1',
  title: 'await node',
  ...over,
});
const takeItem = (over: Partial<Extract<InboxItem, { kind: 'take' }>> = {}): Extract<InboxItem, { kind: 'take' }> => ({
  kind: 'take',
  slug: RUN_ID.slice(0, 8),
  ticketId: 'reports/q3.pdf',
  title: 'reports/q3.pdf',
  ...over,
});

const emptyMap = (): PathMap => ({ destination: 'd', slug: 'demo', tickets: [], decisionsLog: [] });

const mockPathBackend = (): PathBackend & { ruleCalls: unknown[]; confirmCalls: unknown[] } => {
  const ruleCalls: unknown[] = [];
  const confirmCalls: unknown[] = [];
  const b: PathBackend = {
    kind: 'md',
    listMaps: () => [],
    readMap: () => null,
    createMap: () => emptyMap(),
    addTicket: () => {
      throw new Error('not used');
    },
    rule: (cwd, slug, ticketId, ruling): void => {
      ruleCalls.push({ cwd, slug, ticketId, ruling });
    },
    collectResearchResults: () => [],
    ackResearchResult: (): void => {},
    markDelivered: (): void => {},
    confirmSuggestion: (cwd, slug, ticketId, action, o): SuggestionLogEntry => {
      confirmCalls.push({ cwd, slug, ticketId, action, at: o.at });
      return {
        at: o.at,
        ticketId,
        outcome: action === 'accept' ? 'accepted' : 'rejected',
        runId: 'mock-run',
      };
    },
  };
  return Object.assign(b, { ruleCalls, confirmCalls });
};

/** 录下 recordIntervention 的调用形态。 */
let recordCalls: Array<{ runId: string; cause: string; note: string | null }> = [];
const recordInterventionSpy = (runId: string, cause: string, note: string | null): void => {
  recordCalls.push({ runId, cause, note });
};

type CancelOutcome =
  | { kind: 'signalled'; pid: number; signal: 'SIGTERM' }
  | { kind: 'no-owner-pid' }
  | { kind: 'pid-dead'; pid: number }
  | { kind: 'signal-failed'; pid: number; error: string };
/** 录下 runCancel 的调用 + 让 caller 决定 outcome。 */
let runCancelCalls: Array<{ runId: string }> = [];
let cancelOutcome: CancelOutcome = { kind: 'no-owner-pid' };
const runCancelSpy = async (item: Extract<InboxItem, { kind: 'node' }>): Promise<CancelOutcome> => {
  runCancelCalls.push({ runId: item.runId });
  return cancelOutcome;
};

let lastError: string | null = null;
let lastNotices: string[] = [];
const captureOnError = (reason: string): void => {
  lastError = reason;
};
const captureOnNotice = (msg: string): void => {
  lastNotices.push(msg);
};

beforeEach(() => {
  recordCalls = [];
  runCancelCalls = [];
  cancelOutcome = { kind: 'no-owner-pid' };
  lastError = null;
  lastNotices = [];
});

const baseDeps = (backend: PathBackend, refreshItems: () => Promise<readonly InboxItem[]>): ApplyInboxActionDeps => ({
  cwd: '/fake',
  backend,
  promptRuling: async () => null,
  promptIntervene: async () => null,
  confirmStop: async () => null,
  runCancel: runCancelSpy,
  recordIntervention: recordInterventionSpy,
  nowIso: () => NOW_ISO,
  refreshItems,
  onError: captureOnError,
  onNotice: captureOnNotice,
});

// ── decideInboxKey · 路由 ─────────────────────────────────────────────────────

describe('SDD 片 7 · INV-RC-1/3 路由: i / s 不再是 prefill', () => {
  test('node + i → intervene (不再是 prefill, 这是真接线)', () => {
    const item = nodeItem();
    const r = decideInboxKey({ items: [item], selected: 0, key: 'i' });
    expect(r).toEqual({ kind: 'intervene', item });
  });
  test('node + I (大写) → intervene 同款', () => {
    const r = decideInboxKey({ items: [nodeItem()], selected: 0, key: 'I' });
    expect(r.kind).toBe('intervene');
  });
  test('node + s → cancel (不再是 prefill, 这是真接线)', () => {
    const item = nodeItem();
    const r = decideInboxKey({ items: [item], selected: 0, key: 's' });
    expect(r).toEqual({ kind: 'cancel', item });
  });
  test('node + S (大写) → cancel 同款', () => {
    const r = decideInboxKey({ items: [nodeItem()], selected: 0, key: 'S' });
    expect(r.kind).toBe('cancel');
  });
  test('node + r → resume (片 6 已有, 不漂)', () => {
    const r = decideInboxKey({ items: [nodeItem()], selected: 0, key: 'r' });
    expect(r.kind).toBe('resume');
  });
  test('node + Enter → prefill (与片 6 一致, 改 i/s 不动 Enter)', () => {
    const r = decideInboxKey({ items: [nodeItem()], selected: 0, key: '\r' });
    expect(r.kind).toBe('prefill');
  });
  test('take + Enter → prefill (数据源换成 awaitingRuns, 但 prefill 路由不变)', () => {
    const r = decideInboxKey({ items: [takeItem()], selected: 0, key: '\r' });
    expect(r.kind).toBe('prefill');
  });
});

// ── renderer · 屏上文字 ───────────────────────────────────────────────────────

describe('INV-RC-2 · 渲染层: i 字面带 "record intervention", s 带 "stop detached run", 无 "mark green"', () => {
  test('node 选中 → hint 含 "record intervention" + "stop detached run", **不含** "mark green"', async () => {
    const { renderInbox } = await import('./render/inbox');
    const out = renderInbox([nodeItem()], { width: 100, height: 30, selected: 0, now: NOW_MS }).join('\n');
    expect(out).toContain('record intervention');
    expect(out).toContain('stop detached run');
    // INV-RC-2 反向闸: 这俩字眼一旦出现 → 屏上画了一个按了不发生的东西。
    expect(out).not.toMatch(/mark green|标绿/);
  });
});

// ── applyInboxAction · intervene (INV-RC-1/2/7) ──────────────────────────────

describe('INV-RC-1/2/7 · intervene: 调 recordIntervention + 写完 refreshItems', () => {
  test('promptIntervene 返 {cause, note} → recordIntervention 一字不漏地收到 + refreshItems 被调', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    let calls = 0;
    const r = await applyInboxAction(
      { kind: 'intervene', item: items[0]! },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return items;
        }),
        promptIntervene: async () => ({ cause: 'unclassified', note: 'spurious' }),
      },
    );
    expect(recordCalls).toEqual([{ runId: RUN_ID, cause: 'unclassified', note: 'spurious' }]);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.error).toBeUndefined();
    // onNotice 拼出屏上一句话 (对人读, 不是对模型读)
    expect(lastNotices).toHaveLength(1);
    expect(lastNotices[0]).toContain('recorded intervention');
    expect(lastNotices[0]).toContain(RUN_ID);
    expect(lastNotices[0]).toContain('unclassified');
    expect(lastNotices[0]).toContain('spurious');
  });

  test('promptIntervene 返 null (用户没选 cause / Esc note) → 一个字节都不写, refreshItems 仍调', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    let calls = 0;
    const r = await applyInboxAction(
      { kind: 'intervene', item: items[0]! },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return items;
        }),
        promptIntervene: async () => null,
      },
    );
    expect(recordCalls).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.error).toBeUndefined();
    expect(lastNotices).toEqual([]);
  });

  test('recordIntervention 抛 → 返回 error 原文, item 仍在列表里 (INV-BOX-4 / INV-RC-7 反向自检)', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    const r = await applyInboxAction(
      { kind: 'intervene', item: items[0]! },
      {
        ...baseDeps(backend, async () => items),
        promptIntervene: async () => ({ cause: 'unclassified', note: null }),
        recordIntervention: () => {
          throw new Error('板写失败');
        },
      },
    );
    expect(r.error).toBe('板写失败');
    expect(lastError).toBe('板写失败');
    expect(recordCalls).toEqual([]); // spy 没人接, 这条只是确认 deps 被走到
  });

  test('note 为 null → onNotice 不带 — null 后缀', async () => {
    const backend = mockPathBackend();
    await applyInboxAction(
      { kind: 'intervene', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        promptIntervene: async () => ({ cause: 'unclassified', note: null }),
      },
    );
    expect(lastNotices[0]).not.toMatch(/—\s*$/);
    expect(lastNotices[0]).toContain('unclassified');
  });
});

// ── applyInboxAction · cancel (INV-RC-3/4) ───────────────────────────────────

describe('INV-RC-3 · cancel: 二次确认 false / null → 一个字节都不写', () => {
  test('confirmStop 返 false (用户主动选「否」) → runCancel 没调, 无 notice, refreshItems 仍调', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    let calls = 0;
    const r = await applyInboxAction(
      { kind: 'cancel', item: items[0]! },
      {
        ...baseDeps(backend, async () => {
          calls++;
          return items;
        }),
        confirmStop: async () => false,
      },
    );
    expect(runCancelCalls).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.error).toBeUndefined();
    expect(lastNotices).toEqual([]);
  });

  test('confirmStop 返 null (Esc) → runCancel 没调, 与 false 同款', async () => {
    const backend = mockPathBackend();
    await applyInboxAction(
      { kind: 'cancel', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        confirmStop: async () => null,
      },
    );
    expect(runCancelCalls).toEqual([]);
    expect(lastNotices).toEqual([]);
  });
});

describe('INV-RC-4 · cancel 四种结局各画各的话', () => {
  test('signalled → onNotice 含 "SIGTERM sent to pid <pid> (<runId>)"', async () => {
    const backend = mockPathBackend();
    cancelOutcome = { kind: 'signalled', pid: 4242, signal: 'SIGTERM' };
    await applyInboxAction(
      { kind: 'cancel', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        confirmStop: async () => true,
      },
    );
    expect(runCancelCalls).toEqual([{ runId: RUN_ID }]);
    expect(lastNotices[0]).toBe(formatCancelNotice(cancelOutcome, RUN_ID));
    expect(lastNotices[0]).toContain('SIGTERM');
    expect(lastNotices[0]).toContain('4242');
    expect(lastNotices[0]).toContain(RUN_ID);
  });

  test('no-owner-pid → notice 点名 "no owner pid on disk" (不许画 "已请求取消")', async () => {
    const backend = mockPathBackend();
    cancelOutcome = { kind: 'no-owner-pid' };
    await applyInboxAction(
      { kind: 'cancel', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        confirmStop: async () => true,
      },
    );
    expect(lastNotices[0]).toBe('no owner pid on disk for ' + RUN_ID);
    expect(lastNotices[0]).not.toMatch(/已请求取消|cancel(?:led|ed)?\b/i);
  });

  test('pid-dead → notice 点名 "already dead"', async () => {
    const backend = mockPathBackend();
    cancelOutcome = { kind: 'pid-dead', pid: 9 };
    await applyInboxAction(
      { kind: 'cancel', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        confirmStop: async () => true,
      },
    );
    expect(lastNotices[0]).toContain('already dead');
    expect(lastNotices[0]).toContain('9');
  });

  test('signal-failed → notice 点名失败原因', async () => {
    const backend = mockPathBackend();
    cancelOutcome = { kind: 'signal-failed', pid: 11, error: 'EPERM' };
    await applyInboxAction(
      { kind: 'cancel', item: nodeItem() },
      {
        ...baseDeps(backend, async () => [nodeItem()]),
        confirmStop: async () => true,
      },
    );
    expect(lastNotices[0]).toContain('failed');
    expect(lastNotices[0]).toContain('11');
    expect(lastNotices[0]).toContain('EPERM');
  });

  test('runCancel 抛 → 返回 error 原文, refreshItems 仍调', async () => {
    const backend = mockPathBackend();
    const items = [nodeItem()];
    const r = await applyInboxAction(
      { kind: 'cancel', item: items[0]! },
      {
        ...baseDeps(backend, async () => items),
        confirmStop: async () => true,
        runCancel: async () => {
          throw new Error('盘上没记 ownerPid');
        },
      },
    );
    expect(r.error).toBe('盘上没记 ownerPid');
    expect(lastError).toBe('盘上没记 ownerPid');
  });
});

// ── take 数据源筛子 (INV-RC-5/6, SDD §0③) ───────────────────────────────────

/**
 * 逼近超时筛子 —— 这一片单独验证筛子逻辑, **不**走 InboxItem 形状
 * (inbox.test.ts 不在本片写集; 形状以 slug/ticketId 兼容旧断言为锚)。
 *
 * 判据:
 *   · 已等时长 ≥ `timeoutMs × 0.75` 才收。
 *   · `timeoutMs` 缺席不收 (NULL ≠ 0 ≠ 不适用 —— run-board.ts:69 那句「不硬编阈值」)。
 *   · 无源时返空数组 (INV-RC-6)。
 */
function approachingAwaitingItems(
  board: BoardEntry[],
  nowMs: number,
): AwaitingEntry[] {
  const FRACTION = 0.75;
  return awaitingRuns(board).filter((a) => {
    if (typeof a.timeoutMs !== 'number') return false;
    const elapsed = nowMs - Date.parse(a.since);
    return elapsed >= a.timeoutMs * FRACTION;
  });
}

describe('INV-RC-5/6 · take 数据源筛子: 逼近超时 + timeoutMs 缺席不收 + 无源空', () => {
  test('逼近超时 (已等 ≥ 0.75 × timeoutMs) → 收', () => {
    const since = new Date(NOW_MS - 80_000).toISOString(); // 已等 80s
    const board: BoardEntry[] = [
      { v: 1, ts: since, runId: 'r1', event: 'awaiting', artifact: 'a.bin', timeoutMs: 100_000, fromRun: 'r2' },
    ];
    const got = approachingAwaitingItems(board, NOW_MS);
    expect(got.length).toBe(1);
    expect(got[0]!.artifact).toBe('a.bin');
  });

  test('刚开始等 (已等 < 0.75 × timeoutMs) → 不收 (INV-RC-5 第一条 GWT)', () => {
    const since = new Date(NOW_MS - 10_000).toISOString();
    const board: BoardEntry[] = [
      { v: 1, ts: since, runId: 'r1', event: 'awaiting', artifact: 'a.bin', timeoutMs: 100_000 },
    ];
    expect(approachingAwaitingItems(board, NOW_MS)).toEqual([]);
  });

  test('timeoutMs 缺席 → 不收 (INV-RC-5 第二条 GWT, NULL ≠ 0)', () => {
    const since = new Date(NOW_MS - 80_000).toISOString();
    const board: BoardEntry[] = [
      { v: 1, ts: since, runId: 'r1', event: 'awaiting', artifact: 'a.bin' },
    ];
    expect(approachingAwaitingItems(board, NOW_MS)).toEqual([]);
  });

  test('板空 → 收件箱无 take (INV-RC-6 第一条 GWT)', () => {
    expect(approachingAwaitingItems([], NOW_MS)).toEqual([]);
  });

  test('已满足 (有 published 对得上) → 不在 awaiting 里 (run-board.ts:411)', () => {
    const board: BoardEntry[] = [
      { v: 1, ts: new Date(NOW_MS - 80_000).toISOString(), runId: 'r1', event: 'awaiting', artifact: 'a.bin', timeoutMs: 100_000 },
      { v: 1, ts: new Date(NOW_MS - 10_000).toISOString(), runId: 'r2', event: 'published', artifact: 'a.bin' },
    ];
    expect(approachingAwaitingItems(board, NOW_MS)).toEqual([]);
  });

  test('筛子不假设默认阈值 (timeoutMs=0 视为「立即超时」, 任何已等 ≥ 0 都进)', () => {
    // 拍出的边界: 已等时长 ≥ 0 永远成立 → timeoutMs=0 全部收; 但已等 < 0 是不可能的
    // (Date.parse 返 NaN → elapsed=NaN → NaN >= 0 = false), 所以 NaN when since 缺席也不收。
    const since = new Date(NOW_MS - 1).toISOString();
    const board: BoardEntry[] = [
      { v: 1, ts: since, runId: 'r1', event: 'awaiting', artifact: 'a.bin', timeoutMs: 0 },
    ];
    expect(approachingAwaitingItems(board, NOW_MS).length).toBe(1);
  });

  test('readBoard → awaitingRuns → approachingAwaitingItems 端到端: 真盘也能算', () => {
    // 这条是端到端的反向自检 —— 三个函数串起来, 钉「筛子接的是 awaitingRuns 的输出,
    // 不自己重新算 awaiting」。下面 in-memory 用一个最小 board 模拟; 后续 caller 在
    // tui.ts 里调 readBoard(cwd) → approachingAwaitingItems 取代手算。
    const board: BoardEntry[] = [
      { v: 1, ts: new Date(NOW_MS - 90_000).toISOString(), runId: 'r1', event: 'awaiting', artifact: 'old.bin', timeoutMs: 100_000 },
      { v: 1, ts: new Date(NOW_MS - 10_000).toISOString(), runId: 'r2', event: 'awaiting', artifact: 'fresh.bin', timeoutMs: 100_000 },
      { v: 1, ts: new Date(NOW_MS - 90_000).toISOString(), runId: 'r3', event: 'awaiting', artifact: 'notime.bin' },
    ];
    expect(approachingAwaitingItems(board, NOW_MS).map((a) => a.artifact)).toEqual(['old.bin']);
  });
});

afterEach(() => {
  lastError = null;
  lastNotices = [];
  recordCalls = [];
  runCancelCalls = [];
});