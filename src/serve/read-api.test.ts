/**
 * src/serve/read-api —— 座位/额度视图 (readSeats) 契约测试 (S4)。
 *
 * T-1..T-4 每条都写了「怎么让它红」并当场证伪过 —— 永远绿的闸不是闸。
 * ⚠ 文件级纪律: **真调用 channelOf 的 mock 测试排最后**。mock.module 在 Bun 里对
 * 整个测试文件生效(且会改写已加载模块的导出), 排在前面会把后面所有真实数据断言污染掉。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSeats, type SeatRow, type SeatsView } from './read-api';
import { channelOf } from '../model/cost-ledger';
import { ALL_SEAT_IDS, SEAT_PREFERRED_COORD } from '../model/seats';
import type { PlanLedger } from '../harness/plan-ledger';
import { createOmdSessionStore, resetSessionCacheForTest } from '../harness/chat/session-store';
import { createDaemonFetch } from './daemon';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-seats-'));
  delete process.env.OMD_DATA_HOME;
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('T-1: SeatRow.channel 与 cost-ledger.channelOf(coord) 一致', () => {
  test('真实数据: 每个有 coord 的座位 channel === channelOf(coord)(当前全是 openai-codex → api 分支)', () => {
    const view = readSeats(root);
    const withCoord = view.seats.filter((s) => s.coord !== undefined);
    // seats.ts 里显式配了 preferredCoord 的座位数(静态表 6 个, 全是 openai-codex:gpt-5.6-sol)
    expect(withCoord.length).toBeGreaterThan(0);
    for (const row of withCoord) {
      expect(row.channel).toBe(channelOf(row.coord!));
    }
    // 无 coord 的座位 channel 必须是 undefined —— channelOf 需要入参, 不许替它编一个 'api'
    for (const row of view.seats) {
      if (!row.coord) expect(row.channel).toBeUndefined();
    }
    // 订阅分支的真源判据: 静态表里没有订阅坐标样本, 但分道判据本身必须是真的
    // (claude-code:* 走 Agent SDK 订阅通道, 其余按美元计价 —— cost-ledger.ts 头注)
    expect(channelOf('claude-code:claude-opus-4-8')).toBe('subscription');
    expect(channelOf('openai-codex:gpt-5.6-sol')).toBe('api');
    // 怎么让它红: readSeats 里把 channel 写成恒 'api' / 或自写一份与 channelOf 不一致的判据 → 循环断言失败。
  });
});

describe('T-2: NULL ≠ 0 ≠ 不适用 —— 取不到必须 undefined + unavailable 带非空 reason', () => {
  test('leaf 座位(无 preferredCoord)全部可空字段 undefined, unavailable 逐项有非空 reason', () => {
    const view = readSeats(root);
    const leaf = view.seats.find((s) => s.role === 'leaf');
    expect(leaf, 'leaf 座位必须在列表里(seats.ts ALL_SEAT_IDS 含 leaf)').toBeDefined();
    expect(leaf!.coord).toBeUndefined();
    expect(leaf!.channel).toBeUndefined();
    expect(leaf!.spentUsd).toBeUndefined();
    expect(leaf!.tokensIn).toBeUndefined();
    expect(leaf!.tokensOut).toBeUndefined();
    expect(leaf!.overflowTo).toBeUndefined();

    // 反向自检(当场证伪过): 把 readSeats 里任一取不到路径改成 `?? 0` 或 `?? ''`
    // (例如 `coord: SEAT_PREFERRED_COORD[role] ?? ''`, 或 `spentUsd: 0`) → 上面断言立刻红。
    // undefined ≠ 0 ≠ 不适用 —— 一个取不到的数不许画成 0。
    for (const field of ['leaf.coord', 'spentUsd', 'tokensIn', 'tokensOut', 'overflowTo']) {
      const entry = view.unavailable.find((u) => u.field === field);
      expect(entry, `unavailable 缺 ${field} 条目(取不到不解释 = 骗人)`).toBeDefined();
      expect(entry!.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test('全部座位: 花费/用量/溢出恒 undefined(不只查 leaf 一只, 防漏网)', () => {
    const view = readSeats(root);
    for (const row of view.seats) {
      expect(row.spentUsd).toBeUndefined();
      expect(row.tokensIn).toBeUndefined();
      expect(row.tokensOut).toBeUndefined();
      expect(row.overflowTo).toBeUndefined();
    }
    // 有 coord 的座位数必须与 seats.ts 真源一致(SEAT_PREFERRED_COORD 只含显式配了的)
    expect(view.seats.filter((s) => s.coord !== undefined).length).toBe(
      ALL_SEAT_IDS.filter((id) => SEAT_PREFERRED_COORD[id] !== undefined).length,
    );
  });
});

describe('T-3: GET /api/seats —— createDaemonFetch 造 handler, 不占端口', () => {
  let fetchFn: (req: Request) => Promise<Response>;

  const fakeLedger: PlanLedger = {
    record: () => null,
    families: () => [],
    plans: () => [],
    planJson: () => null,
    rebuild: () => 0,
    close: () => {},
  };

  beforeEach(() => {
    // deps 桩照 daemon.test.ts 既有 fixture 的形状(读侧路由不碰 tools/chat/ledger 的实际内容)
    fetchFn = createDaemonFetch({
      cwd: root,
      tools: [],
      chatStore: createOmdSessionStore(root),
      ledger: fakeLedger,
      resolveChatModel: () => 'deepseek:deepseek-v4-flash',
      chatTools: [],
    });
  });

  test('200 且 body 形状匹配 SeatsView;非 GET 落 404', async () => {
    // 怎么让它红: daemon.ts 漏挂这条路由(或写成 POST-only)→ 请求落 notFound(404), status 断言失败。
    const res = await fetchFn(new Request('http://x/api/seats'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SeatsView;
    expect(Array.isArray(body.seats)).toBe(true);
    for (const s of body.seats) expect(typeof (s as SeatRow).role).toBe('string');
    for (const k of ['inFlight', 'waiting', 'cap', 'rpmTokens', 'rpmLimit'] as const) {
      expect(typeof body.budget[k]).toBe('number');
    }
    expect(Array.isArray(body.unavailable)).toBe(true);
    for (const u of body.unavailable) {
      expect(typeof u.field).toBe('string');
      expect(u.reason.trim().length).toBeGreaterThan(0);
    }
    // 与直接读 readSeats 的结果一致 —— HTTP 面只是透传, 不许在 daemon 里再算第二份
    expect(body.seats).toEqual(readSeats(root).seats);
    // 只读视图: 非 GET 一律 404(与 /board 同款纪律, 写方法不许被静默当成读)
    expect((await fetchFn(new Request('http://x/api/seats', { method: 'POST' }))).status).toBe(404);
  });
});

describe('T-4: readSeats 只读 —— .omd/ 下文件调用前后逐字节一致', () => {
  function snapshot(dir: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.set(p, readFileSync(p));
      }
    };
    walk(dir);
    return out;
  }

  test('调用多次前后, .omd/ 文件列表与逐字节内容不变', () => {
    const omd = join(root, '.omd');
    mkdirSync(omd, { recursive: true });
    writeFileSync(join(omd, 'probe.txt'), '座位视图不许写盘\n');
    const before = snapshot(omd);

    const view = readSeats(root);
    expect(view.seats.length).toBeGreaterThan(0);
    readSeats(root); // 调多次, 防「第一次写、第二次不写」的缓存式实现蒙混过关
    readSeats(root);

    const after = snapshot(omd);
    expect(after.size).toBe(before.size);
    for (const [p, buf] of before) {
      const buf2 = after.get(p);
      expect(buf2, `文件被删: ${p}`).toBeDefined();
      expect(buf2!.equals(buf), `文件内容变了: ${p}`).toBe(true);
    }
    // 怎么让它红: 在 readSeats 里加任何 fs 写(如仿 readReadout 的落盘缓存) → 多文件/内容变 → 红。
    // 当前实现零 fs 调用(编译期常量 + 内存态 budgetStats), 这条闸是防未来回潮, 不是冗余。
  });
});

describe('T-1 补: 真调用 channelOf, 不是另写一份判据(mock 证订阅分支原样透传)', () => {
  test('mock 把 channelOf 返回值改成 subscription, readSeats 输出必须跟着变', () => {
    // 怎么让它红: 若把 readSeats 的 channel 改成内联 `coord?.startsWith('claude-code:') ? 'subscription' : 'api'`
    // (绕开 import 的 channelOf), mock 改了返回值但输出不跟着变 → 下面断言失败。
    // 静态表里没有订阅坐标样本, mock 是证明「订阅返回值能原样透传到 SeatRow.channel」的唯一途径。
    mock.module('../model/cost-ledger', () => ({
      channelOf: () => 'subscription' as const,
    }));
    const view = readSeats(root);
    const withCoord = view.seats.filter((s) => s.coord !== undefined);
    expect(withCoord.length).toBeGreaterThan(0);
    for (const row of withCoord) expect(row.channel).toBe('subscription');
    mock.restore(); // 还原 cost-ledger, 防污染本文件后续(实际已无后续, 纪律而已)
  });
});
