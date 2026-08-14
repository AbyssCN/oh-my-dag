/**
 * src/model/seat-usage.test —— per-seat 台账的闸。
 *
 * **每条都写了怎么让它红**(本仓惯例:永远绿的闸不是闸)。三条主闸:
 * ① `NULL` ≠ 0:抛错那一发的 token 是「没读到」,不是 0 —— 把 `in: null` 换成 `in: 0` 这条当场红;
 * ② 归不了座不许编:`seatOfTrace` 认不出返 `null`,改成 `?? 'unknown'` 兜底这条当场红;
 * ③ 覆盖率:src 里每个 `traceName:` 字面量都得核过(归座 ∨ 明列归不了)。新加一个标签
 *    而不进表 → 这条红。这一条是**给未来的人**设的,不是给今天的代码。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import {
  aggregateSeatUsage,
  readSeatUsage,
  recordSeatUsage,
  seatOfTrace,
  seatUsagePath,
  traceIsClassified,
  UNATTRIBUTED,
  type SeatUsageEntry,
} from './seat-usage';

const savedPath = process.env.OMD_SEAT_USAGE_PATH;
const savedOff = process.env.OMD_SEAT_USAGE;
const tmps: string[] = [];

function tmpLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-seat-usage-'));
  tmps.push(dir);
  const p = join(dir, 'seat-usage.jsonl');
  process.env.OMD_SEAT_USAGE_PATH = p;
  return p;
}

afterEach(() => {
  if (savedPath === undefined) delete process.env.OMD_SEAT_USAGE_PATH;
  else process.env.OMD_SEAT_USAGE_PATH = savedPath;
  if (savedOff === undefined) delete process.env.OMD_SEAT_USAGE;
  else process.env.OMD_SEAT_USAGE = savedOff;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (o: Partial<SeatUsageEntry> = {}): SeatUsageEntry => ({
  ts: 1,
  seat: 'leaf',
  traceName: 'leaf:x',
  model: 'p:m',
  in: 100,
  out: 10,
  cacheHit: 0,
  runId: 'r1',
  ...o,
});

describe('seatOfTrace —— 派生的那一列', () => {
  test('核过的前缀归到它真正解析的那个座', () => {
    expect(seatOfTrace('conductor:plan')).toBe('conductor');
    expect(seatOfTrace('conductor:repair')).toBe('conductor');
    expect(seatOfTrace('judge:n3')).toBe('judge');
    expect(seatOfTrace('halt-judge')).toBe('gate');
    // 三个都读 config.leafModel —— 名字不同不代表座位不同 (engine.ts 2204/2327/3135)
    expect(seatOfTrace('leaf:n1')).toBe('leaf');
    expect(seatOfTrace('map-lister:n1')).toBe('leaf');
    expect(seatOfTrace('fanin-summary:n1')).toBe('leaf');
    expect(seatOfTrace('omd-leaf')).toBe('leaf');
  });

  test('★ 反向自检: 认不出的标签返 null, 不编座位', () => {
    // 证伪方式: 把 seatOfTrace 末行的 `return null` 改成 `return 'leaf'` (或任何兜底) → 这三条红。
    expect(seatOfTrace('brand-new-role')).toBeNull();
    expect(seatOfTrace(undefined)).toBeNull();
    expect(seatOfTrace('')).toBeNull();
  });

  test('research fanout 分 stage 之后, 每个 stage 归到它自己的座', () => {
    // 这是 #6 (research 内部降耗) 的分母来源: 契约段 90.8% 的量在 research 内部,
    // 而分不出 stage 就问不出「降谁」。stage 标签在 research/fanout.ts 的 CallFn.stage。
    expect(seatOfTrace('fanout:gen')).toBe('lens');
    expect(seatOfTrace('fanout:reduce')).toBe('reduce');
    expect(seatOfTrace('fanout:judge')).toBe('judge');
    for (const s of ['gap', 'synth', 'fusion', 'graft']) expect(seatOfTrace(`fanout:${s}`)).toBe('reason');
  });

  test('★ 反向自检: 明知多座共用的标签也返 null —— 不许挂到某一个座上', () => {
    // fanout-leaf 是 research 五个阶段的单一漏斗 (fanout.ts:315)。若哪天有人图省事把它
    // 映射成 'lens', 这条红 —— 那才是把 90.8% 的量记到一个错座上的开始。
    expect(seatOfTrace('fanout-leaf')).toBeNull();
    expect(seatOfTrace('seed-author')).toBeNull();
    // 但它们与「没核过」不同 —— 这一层由 traceIsClassified 分开
    expect(traceIsClassified('fanout-leaf')).toBe(true);
    expect(traceIsClassified('brand-new-role')).toBe(false);
  });
});

describe('落盘 / 读回 / 聚合', () => {
  test('一发一行, 读回等值', () => {
    const p = tmpLedger();
    recordSeatUsage(entry({ traceName: 'leaf:a' }));
    recordSeatUsage(entry({ traceName: 'conductor:plan', seat: 'conductor', in: 2000, out: 300 }));
    expect(readFileSync(p, 'utf8').trim().split('\n').length).toBe(2);
    const rows = readSeatUsage(p);
    expect(rows.map((r) => r.traceName)).toEqual(['leaf:a', 'conductor:plan']);
  });

  test('★ 反向自检: OMD_SEAT_USAGE=off 真的一个字节都不写', () => {
    // 证伪方式: 删掉 recordSeatUsage 里那行 early return → 文件出现, readSeatUsage 非空。
    const p = tmpLedger();
    process.env.OMD_SEAT_USAGE = 'off';
    recordSeatUsage(entry());
    expect(readSeatUsage(p)).toEqual([]);
  });

  test('坏行跳过, 好行照读 (账本是读数不是闸)', () => {
    const p = tmpLedger();
    recordSeatUsage(entry());
    writeFileSync(p, `${readFileSync(p, 'utf8')}{ 这不是 JSON\n`);
    recordSeatUsage(entry({ traceName: 'judge:z', seat: 'judge' }));
    expect(readSeatUsage(p).length).toBe(2);
  });

  test('按座位聚合: 三个 leaf 家族标签合成一个座, 归不了座的单摆一桶', () => {
    const rows = [
      entry({ traceName: 'leaf:a', in: 100, out: 10 }),
      entry({ traceName: 'map-lister:b', in: 50, out: 5 }),
      entry({ traceName: 'fanout-leaf', seat: null, in: 8000, out: 800 }),
    ];
    const s = aggregateSeatUsage(rows);
    expect(s.bySeat.leaf).toEqual({ calls: 2, in: 150, out: 15, cacheHit: 0, unmeasured: 0 });
    expect(s.bySeat[UNATTRIBUTED]!.in).toBe(8000);
    // 座位归不了的时候 traceName 那一层仍然分得开 —— 这正是保留原始列的理由
    expect(Object.keys(s.byTrace).sort()).toEqual(['fanout-leaf', 'leaf:a', 'map-lister:b']);
    expect(s.total.calls).toBe(3);
  });

  test('runId 过滤: 别把上一次 run 的量算进这一次', () => {
    const s = aggregateSeatUsage([entry({ runId: 'r1' }), entry({ runId: 'r2', in: 999 })], 'r1');
    expect(s.total.calls).toBe(1);
    expect(s.total.in).toBe(100);
  });

  test('★ 反向自检: 没读到 token 的那一发进 unmeasured, 不当 0 混进和里', () => {
    // 证伪方式: 把 SeatUsageEntry 的 in/out 落成 0 (而不是 null), 或删掉 addTo 里的
    // unmeasured 计数 → 这条红。合计仍是 100 是对的; 关键在 calls=2 而 unmeasured=1 ——
    // 「两发里有一发的量不知道」这件事不许在聚合面上消失。
    const s = aggregateSeatUsage([
      entry({ in: 100, out: 10 }),
      entry({ in: null, out: null, cacheHit: null, error: 'boom' }),
    ]);
    expect(s.bySeat.leaf).toEqual({ calls: 2, in: 100, out: 10, cacheHit: 0, unmeasured: 1 });
  });
});

describe('★ 覆盖率闸: src 里的每个 traceName 字面量都核过', () => {
  test('新加一个 traceName 而不进映射表 → 这条红', () => {
    const root = join(import.meta.dir, '..');
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/traceName:\s*'([^']+)'/g)) seen.add(m[1]!);
        // 节点级的那些是模板串 (`leaf:${id}`) —— 只取插值前的静态前缀。**新标签基本都长这样**,
        // 不扫它的话这道闸就只守着 4 个常量, 等于没守。
        for (const m of src.matchAll(/traceName:\s*`([^`$]*)\$\{/g)) if (m[1]) seen.add(m[1]);
      }
    };
    walk(root);
    // 至少要扫到今天在场的那几个, 否则是扫器坏了在放水 (扫不到东西的闸恒绿)。
    // 两种写法各点一个名, 免得哪天正则少扫一半而计数照样够。
    expect(seen.has('conductor:plan')).toBe(true); // 单引号常量
    expect(seen.has('fanin-summary:')).toBe(true); // 模板串前缀
    expect(seen.size).toBeGreaterThanOrEqual(8);
    expect([...seen].filter((t) => !traceIsClassified(t))).toEqual([]);
  });
});

describe('★ 网关接线 (端到端, 零成本那一半)', () => {
  test('send 抛出时也落一行: seat 反查 / runId 透传 / token 记 null 而不是 0', async () => {
    // 用一个没注册的 provider —— callModel 当场抛, 不发任何网络请求, 也就不花钱。
    // 它走的是 send 的 catch 分支, 而那条分支与成功分支共用同一段记账代码。
    // 证伪方式: 把 gateway.ts catch 里的 recordSeatUsage 删掉 → rows 为空, 这条红。
    const p = tmpLedger();
    const { send } = await import('./gateway');
    await expect(
      send({
        model: 'no-such-provider-zzz:nope',
        messages: [{ role: 'user', content: 'x' }],
        meta: { role: 'leaf:n1', sessionId: 'run-x' },
      }),
    ).rejects.toThrow();
    const rows = readSeatUsage(p);
    expect(rows.length).toBe(1);
    expect(rows[0]!.seat).toBe('leaf');
    expect(rows[0]!.traceName).toBe('leaf:n1');
    expect(rows[0]!.runId).toBe('run-x');
    expect(rows[0]!.in).toBeNull(); // 「没读到」不是「烧了 0」
    expect(rows[0]!.error).toBeTruthy(); // fail-open 不吞证据
    expect(aggregateSeatUsage(rows).bySeat.leaf!.unmeasured).toBe(1);
  });
});

describe('账本路径', () => {
  test('env 覆盖优先, 否则落 .omd/seat-usage.jsonl', () => {
    const p = tmpLedger();
    expect(seatUsagePath()).toBe(p);
    delete process.env.OMD_SEAT_USAGE_PATH;
    expect(seatUsagePath().endsWith(join('.omd', 'seat-usage.jsonl'))).toBe(true);
  });
});
