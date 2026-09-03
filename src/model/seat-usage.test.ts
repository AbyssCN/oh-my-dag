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
  breakdownRun,
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

describe('写入磁盘 / 读回 / 聚合', () => {
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
        // 不扫它的话这道闸就只守着几个常量, 等于没守。
        for (const m of src.matchAll(/traceName:\s*`([^`$]*)\$\{/g)) if (m[1]) seen.add(m[1]);
        // 2026-08-16 (#144 洞 1) 扩面: 直调 `send({ meta: { role: … } })` 的那批调用点**不经
        // GenerateFn**, 标签写作 `role:` —— 老扫器一个都看不见, 而 verifier / gate / review /
        // review-spec 恰好全在这一批里 (账上 402 发无归属)。
        //
        // ⚠ 必须锚在 `meta:` 上, 不能只认 `role:` —— `role` 在本仓是个**重载的键名**:
        // 消息体 (`role:'user'`)、TUI 行类型 (`role:'divider'|'notice'`)、座位表 (`role:'leaf'`)
        // 都用它。只认 `role:` 试过一次, 当场扫进 6 个别家的串, 闸恒红 —— 恒红的闸与恒绿的闸
        // 一样没用。同理值这侧只认紧跟其后的字面量: 标签写成拼接式就出了闸的视野 (见 engine.ts)。
        for (const m of src.matchAll(/\bmeta:\s*\{[^}]*?\brole:\s*'([^']+)'/g)) seen.add(m[1]!);
        for (const m of src.matchAll(/\bmeta:\s*\{[^}]*?\brole:\s*`([^`$]*)\$\{/g)) if (m[1]) seen.add(m[1]);
      }
    };
    walk(root);
    // 至少要扫到今天在场的那几个, 否则是扫器坏了在放水 (扫不到东西的闸恒绿)。
    // 三种写法各点一个名, 免得哪天正则少扫一路而计数照样够。
    expect(seen.has('agent-leaf')).toBe(true); // traceName 单引号常量 (v1 的 conductor:plan 已随规划器退役)
    expect(seen.has('fanin-summary:')).toBe(true); // traceName 模板串前缀
    expect(seen.has('verifier')).toBe(true); // meta.role 常量 (#144 补的那批)
    expect(seen.size).toBeGreaterThanOrEqual(16);
    expect([...seen].filter((t) => !traceIsClassified(t))).toEqual([]);
  });
});

describe('★ #144 洞 1: 八个"从未出现过一次"的座位', () => {
  // 全账本 78KB / 6 个 runId 里, 这八座**一发都没有**, 而 owner 想量的恰好是它们。
  // 补法分两类, 这条闸把两类都钉住 —— 少任何一条, 那个座位又变回账上的空白。
  test('经网关的五座: 标签落地即归座 (gate:convergence 随 gate 座 2026-09-04 删除)', () => {
    // 证伪方式: 把对应调用点的 `meta: { role: … }` 删掉 → 那一发回到 traceName=null,
    // 上面那道覆盖率闸不会红 (它只查已有标签), 但这一条会。
    expect(seatOfTrace('verifier')).toBe('verifier'); // verifier.ts:302
    expect(seatOfTrace('review:spec')).toBe('review-spec'); // review/run.ts (spec 维度)
    expect(seatOfTrace('review:security')).toBe('review'); // review/run.ts (其余维度)
    expect(seatOfTrace('review:verify-verdict')).toBe('review'); // review/verify.ts
    expect(seatOfTrace('escalation:plan')).toBe('escalation'); // engine.ts 升级重规划轮
    expect(seatOfTrace('escalation:repair')).toBe('escalation'); // engine.ts 补丁轮
  });

  test('★ review-spec 必须排在 review 前面 —— 顺序错了就静默错归', () => {
    // 两条规则都能匹配 `review:spec`; `/^review:/` 若排在前面, review-spec 座的量会**静默**
    // 并进 review 桶。证伪方式: 把 TRACE_SEAT_RULES 里两条的顺序对调 → 这条红。
    // 这类错归比缺数难发现得多 —— 账上有个看起来正常的数字, 没人会去怀疑它。
    expect(seatOfTrace('review:spec')).not.toBe('review');
  });

  test('不经网关的 agent 座: 节点级行归 agent, 且只有 agent 一种', () => {
    // agent leaf 走 pi-agent-core 自己的循环 → 网关看不见它。engine 的 settle() 补节点级一行。
    // 证伪方式: 删掉 settle 里那段 recordSeatUsage → 端到端账里 agent 座重新归零。
    expect(seatOfTrace('agent-leaf')).toBe('agent');
    // ⚠ 别顺手给 inproc 也加一条: 它经网关, 已有发级行, 再记节点级会把同一份 in/out 计两遍。
    expect(seatOfTrace('inproc-leaf')).toBeNull();
  });

  test('fusion / graft 仍归 reason —— 这是"核过, 归不了"不是"补漏了"', () => {
    // #144 把这两座列进"从未出现过"。实测它们**在账上**, 只是 bySeat 归进 reason 桶
    // (两者默认都吃 cfg.reasonModel, 可被 fusionModel/graftModel 覆盖)。
    // 想按座位分开必须先在 fanout 侧把座位定死, 那是另一片的活 —— 今天分得开的层是 byTrace。
    expect(seatOfTrace('fanout:fusion')).toBe('reason');
    expect(seatOfTrace('fanout:graft')).toBe('reason');
  });
});

describe('★ #144 洞 3 验收判据: 规划层 vs 执行层 vs 拒回轮', () => {
  test('一次 run 能直接答出三个数', () => {
    // issue 的验收原文: 「任取一个 run, 能直接答出规划层 vs 执行层各烧了多少 in/out、
    // 其中多少发是拒回轮」。这条就是那句话的可执行版。
    const rows: SeatUsageEntry[] = [
      entry({ seat: 'conductor', traceName: 'conductor:plan', in: 1000, out: 100, rejectRound: 0, phase: 'goal-contract' }),
      entry({ seat: 'conductor', traceName: 'conductor:plan', in: 1200, out: 120, rejectRound: 1, phase: 'goal-contract' }),
      entry({ seat: 'escalation', traceName: 'escalation:repair', in: 900, out: 90, rejectRound: 2, phase: 'goal-contract' }),
      entry({ seat: 'verifier', traceName: 'verifier', in: 500, out: 50, phase: 'goal-execute' }),
      entry({ seat: 'agent', traceName: 'agent-leaf', entry: 'node', in: 110_000, out: 900, phase: 'goal-execute' }),
      entry({ seat: null, traceName: 'fanout-leaf', in: 7, out: 7 }),
    ];
    const b = breakdownRun(rows);
    expect(b.planning.in).toBe(3600); // conductor ×2 + escalation + verifier
    expect(b.execution.in).toBe(110_000); // agent
    expect(b.other.in).toBe(7); // 归不了座的那一发 —— 不是 0, 是"还没归层"
    // 拒回轮是 planning 的**子集**: 1200 + 900 = 2100 发在"照建议重写"上, 零新产出。
    expect(b.planningRejects.in).toBe(2100);
    expect(b.byPhase['goal-contract']!.in).toBe(3100);
    expect(b.byPhase['goal-execute']!.in).toBe(110_500);
    expect(b.byPhase[UNATTRIBUTED]!.in).toBe(7);
  });

  test('★ 反向自检: rejectRound 缺席 ≠ 0 —— verifier 那发不算拒回', () => {
    // 证伪方式: 把 breakdownRun 里的 `(e.rejectRound ?? 0) > 0` 写成 `>= 0` → 这条红。
    // 「首问」「不适用」「拒回轮」三件事必须分得开, 否则空转量会被读成全部规划量。
    const b = breakdownRun([entry({ seat: 'verifier', traceName: 'verifier', in: 500 })]);
    expect(b.planning.in).toBe(500);
    expect(b.planningRejects.in).toBe(0);
    expect(b.planningRejects.calls).toBe(0);
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
