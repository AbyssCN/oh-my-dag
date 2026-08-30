/**
 * src/model/seat-usage-fallback.test —— per-seat 台账的**只读挂载回退**闸。
 *
 * ## 为什么有这一片
 *
 * omd 以只读挂载分发时 (workbuddy-bench split-mount → `/opt/omd/pkg`), `mkdir <仓根>/.omd`
 * 抛 EROFS。兄弟账本 `dag-record` 早有回退 (`dag-record.ts:684`), 这一本没有 —— 只 warn
 * 一句就把整发丢掉。实测: `results/omd-bridge-code80-opusv/2026-08-29__21-54-51` 批
 * **75/77 trial** 的 `[omd/seat-usage] 台账写入失败` 都在, 整本账在容器里恒空。
 *
 * 后果不是"少个文件": 「协调税」的分子里 verifier / judge / classify / map lister
 * **都不是 DAG 节点**, 它们的 token 只落这一本; `tui-usage.jsonl` 按 `seat-usage.ts` 自己的注
 * 「那一层看不见角色」, 补不上。⇒ 分子少算, 协调税被**单向**低估。
 *
 * ## 逐条的反向自检 (每条都当场证伪过)
 *
 * | 用例 | 删什么 → 它红 |
 * |---|---|
 * | 注入的改动 | 实测读数 |
 * |---|---|
 * | `recordSeatUsage` 改回 `seatUsagePath()`(= 修前状态) | **3 pass / 2 fail** —— ★F2 ★F5 |
 * | 回退序里删掉 `OMD_DATA_HOME` 那一项 | **1 pass / 4 fail** |
 * | 键缓存换成进程级单例 (`if (_writableTo) return _writableTo`) | **1 pass / 4 fail** |
 * | (未注入, 当前实装) | **5 pass / 0 fail** |
 *
 * 后两个注入各自红 4 条而不是 1 条: 它们把回退**落点**打歪, 而除 ★F1 外每条都依赖落点。
 * 照实记, 不写成"一条改动对一条断言"那种好看但假的对应。
 *
 * ## 泄漏防护:靠**机械过滤**, 不靠"记得设 env"
 *
 * 每个用例都设 `OMD_DATA_HOME`, 否则回退根 = `process.cwd()/.omd` = 真仓账本
 * (`seat-usage.ts:202` 记的「21,028 / 23,392 条是合成的」那个坑)。
 *
 * ⚠ 但**散文拦不住** —— 实测: 上面 ★F3 的证伪动作(删掉回退序里 `OMD_DATA_HOME` 那一项)
 * 当场往真仓账本写进 10 条, 而那 10 条用的是 `claude-code:claude-opus-5` + `in:1000`,
 * **`syntheticSeatUsageReason` 的两条判据一条都拦不住**(真前缀 ∧ `in > 10`)⇒ 会被当成真调用读。
 *
 * 所以夹具坐标一律用 `fixture:none`: 万一再泄漏, 既有的合成过滤器**机械地**滤得掉。
 * 断言不受影响 —— 本片测的是"落到哪个文件、几条、哪几列还在", 与坐标真假无关。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSeatUsage, seatUsagePathWritable, SEAT_USAGE_FILE, type SeatUsageEntry } from './seat-usage';

const saved = {
  path: process.env.OMD_SEAT_USAGE_PATH,
  dataHome: process.env.OMD_DATA_HOME,
  off: process.env.OMD_SEAT_USAGE,
};
const tmps: string[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

/** 造一个**父目录是文件**的中央路径 → `mkdirSync` 抛 ENOTDIR, 即容器里 EROFS 的同型。 */
function unwritableCentral(): string {
  const d = tmpDir('omd-seat-ro-');
  const blocker = join(d, 'i-am-a-file');
  writeFileSync(blocker, 'not a directory');
  return join(blocker, '.omd', SEAT_USAGE_FILE);
}

afterEach(() => {
  for (const [k, v] of Object.entries({
    OMD_SEAT_USAGE_PATH: saved.path,
    OMD_DATA_HOME: saved.dataHome,
    OMD_SEAT_USAGE: saved.off,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (o: Partial<SeatUsageEntry> = {}): SeatUsageEntry => ({
  ts: 1,
  seat: 'gate',
  traceName: 'gate:convergence',
  // 夹具坐标: 泄漏时能被 syntheticSeatUsageReason 机械滤掉 (见文件头「泄漏防护」)。
  model: 'fixture:none',
  in: 1000,
  out: 100,
  cacheHit: 0,
  runId: 'r-fallback',
  ...o,
});

/** 读回一本账的行数(文件不在 = 0)。 */
const lines = (p: string): number =>
  existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0;

describe('seat-usage 只读回退 —— 中央不可写时账不许整本丢', () => {
  test('★F1 (零回归): 中央路径可写 → 就用中央路径, 不回退', () => {
    const central = join(tmpDir('omd-seat-ok-'), '.omd', SEAT_USAGE_FILE);
    const dataHome = tmpDir('omd-seat-dh-');
    process.env.OMD_SEAT_USAGE_PATH = central;
    process.env.OMD_DATA_HOME = dataHome;

    expect(seatUsagePathWritable()).toBe(central);
    recordSeatUsage(entry());
    expect(lines(central)).toBe(1);
    // 回退根一个字节都不该被碰。
    expect(lines(join(dataHome, SEAT_USAGE_FILE))).toBe(0);
  });

  test('★F2: 中央不可写 (父目录是文件 → ENOTDIR) → 回退到 OMD_DATA_HOME, 且**真的写进去了**', () => {
    const dataHome = tmpDir('omd-seat-dh-');
    process.env.OMD_SEAT_USAGE_PATH = unwritableCentral();
    process.env.OMD_DATA_HOME = dataHome;

    const fallback = join(dataHome, SEAT_USAGE_FILE);
    expect(seatUsagePathWritable()).toBe(fallback);
    recordSeatUsage(entry());
    recordSeatUsage(entry({ traceName: 'verifier' }));
    // 这就是修的那件事: 此前这两发在容器里都被 warn 掉了, 账本恒空。
    expect(lines(fallback)).toBe(2);
    const rows = readFileSync(fallback, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.map((r) => r.traceName)).toEqual(['gate:convergence', 'verifier']);
    // 归属那几位没在回退路上被吃掉 —— 协调税分子要的正是它们。
    expect(rows[0].seat).toBe('gate');
    expect(rows[0].in).toBe(1000);
  });

  test('★F3: 回退序 = OMD_DATA_HOME 优先于 cwd/.omd', () => {
    const dataHome = tmpDir('omd-seat-dh-');
    process.env.OMD_SEAT_USAGE_PATH = unwritableCentral();
    process.env.OMD_DATA_HOME = dataHome;
    expect(seatUsagePathWritable()).toBe(join(dataHome, SEAT_USAGE_FILE));
    // 与 dag-record.ts:690 同款: 显式数据根压过 cwd。删掉那一项 → 落到 cwd/.omd, 本条红。
    expect(seatUsagePathWritable()).not.toContain(process.cwd());
  });

  test('★F4: 解析按中央路径做键 —— 换一个中央路径要重解析 (不是进程级单例)', () => {
    const dataHome = tmpDir('omd-seat-dh-');
    process.env.OMD_DATA_HOME = dataHome;

    // 先解析一个**不可写**的 → 落回退。
    process.env.OMD_SEAT_USAGE_PATH = unwritableCentral();
    expect(seatUsagePathWritable()).toBe(join(dataHome, SEAT_USAGE_FILE));

    // 再换一个**可写**的 → 必须重解析成中央, 而不是复用上一个的回退结果。
    const central = join(tmpDir('omd-seat-ok-'), '.omd', SEAT_USAGE_FILE);
    process.env.OMD_SEAT_USAGE_PATH = central;
    expect(seatUsagePathWritable()).toBe(central);
  });

  test('★F5: 回退证据行**每个键只打一次** (本函数在每一发上被调, 照抄 ledgerPathWritable 会刷屏)', () => {
    const dataHome = tmpDir('omd-seat-dh-');
    process.env.OMD_SEAT_USAGE_PATH = unwritableCentral();
    process.env.OMD_DATA_HOME = dataHome;

    const orig = process.stderr.write.bind(process.stderr);
    let hits = 0;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string' && chunk.includes('[omd/seat-usage] 中央台账不可写')) hits += 1;
      return orig(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      for (let i = 0; i < 5; i += 1) recordSeatUsage(entry());
    } finally {
      process.stderr.write = orig;
    }
    // 5 发, 证据行 1 条。容器里那批日志刷的正是这一条的反面。
    expect(hits).toBe(1);
    expect(lines(join(dataHome, SEAT_USAGE_FILE))).toBe(5);
  });
});
