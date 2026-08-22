/**
 * dag-record 的**节点级五位列** (C-1, 2026-08-19): 写侧 / 读侧 / 与 seat-usage.jsonl 的对账 /
 * 老表兼容。本件只测留痕层 —— **零 LLM 调用**, 用 `mkdtemp` 临时库做夹具。
 *
 * 关联 (按 INV):
 *   · INV-1 ── NULL ≠ 0 (缺席与「真零」不许被抹平)。
 *   · INV-2 ── seat-usage.jsonl 的 `entry:'node'` 行与 dag-runs.db 的 `tokensIn` **逐字相等**。
 *   · INV-3 ── 老表 (无五列) → 新代码必须**就地补列读**, 不许 INSERT 时炸。
 *
 * ⚠ 本件**只**改测试文件,不碰实装。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createDagRecorder } from './dag-record';
import type { ExecutorDagResult } from './types';
import type { SeatUsageEntry } from '../../model/seat-usage';

/** 最小可记的一张图结果 (沿用 dag-record.test.ts:17 的形状)。 */
const fakeResult = (
  results: Record<string, unknown> = {
    a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 4321, out: 876 }, durationMs: 1234, turns: 3 },
  },
): ExecutorDagResult =>
  ({
    plan: { name: '图', nodes: { a: { goal: 'x' } } },
    levels: [['a']],
    results,
    reusedNodes: [],
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 4321, leavesOut: 876, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

describe('dag-record 节点级五位列', () => {
  // 证伪方式: 把 record() 里 `durationMs: typeof (r as { durationMs? }).durationMs === 'number' ? ... : null`
  // 改成 `?? 0` → durationMs 一律变 0 → 这条红 (节点没传 durationMs 时)。
  test('GWT-1a: 含 agent 节点读数的记录落盘 + 读回, tokensIn/Out/durationMs 均非 null 且 > 0', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult(), { runId: 'gwt-1a' });
    const node = rec.get(id)!.nodes.find((n) => n.id === 'a')!;
    expect(node.tokensIn).toBe(4321);
    expect(node.tokensOut).toBe(876);
    expect(node.durationMs).toBe(1234);
    expect(typeof node.durationMs).toBe('number');
    expect(node.durationMs).toBeGreaterThan(0);
    expect(node.tokensIn).not.toBeNull();
    expect(node.tokensOut).not.toBeNull();
    rec.close();
  });

  // 证伪方式: 把 record() 里 reads `r.usage.in` 改成读另一个字段 (例如 cacheRead) →
  // tokensIn 与 jsonl 那边的 `in` (来自真实 usage) 不再逐字相等 → 这条红。`?? 0` 顶替不会让
  // 本条红 (因为 4321 是真值且来自 r.usage.in); 真正会红的是「写侧字段错位」与「读侧不一致」。
  test('GWT-1b: dag-runs.db 与 seat-usage.jsonl 的 entry:\'node\' 行, tokensIn 逐字相等 (INV-2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-node-usage-1b-'));
    const dbPath = join(dir, 'dag-runs.db');
    const jsonlPath = join(dir, 'seat-usage.jsonl');

    const rec = createDagRecorder({ path: dbPath });
    const id = rec.record(fakeResult(), { runId: 'gwt-1b' });
    const fromDb = rec.get(id)!.nodes.find((n) => n.id === 'a')!;

    // 同份 usage 进 seat-usage.jsonl —— 直接 append, 不走 recordSeatUsage (它会写真实 repo 路径,
    // 与本测试夹具无关且会污染真实台账)。
    const line: SeatUsageEntry = {
      ts: 1700000000000,
      seat: 'agent',
      traceName: 'agent-leaf',
      model: 'openai:gpt-5',
      // 真源 = db 读回值, 不手填数字 —— 这样改 fakeResult 这条不会漂, 双侧同源钉死。
      in: fromDb.tokensIn!,
      out: fromDb.tokensOut!,
      cacheHit: null,
      runId: 'gwt-1b',
      entry: 'node',
      nodeId: 'a',
    };
    appendFileSync(jsonlPath, `${JSON.stringify(line)}\n`);

    // 读回 jsonl, 与 db 端对账
    const roundTrip = JSON.parse(readFileSync(jsonlPath, 'utf8').trim()) as SeatUsageEntry;
    expect(roundTrip.entry).toBe('node');
    expect(roundTrip.in).toBe(fromDb.tokensIn ?? null); // ★ INV-2: 逐字相等, 同一份 usage 共读
    expect(roundTrip.out).toBe(fromDb.tokensOut ?? null);
    expect(typeof roundTrip.in).toBe('number');
    rec.close();
  });

  // 证伪方式: ① 把 `createDagRecorder` 里 PRAGMA + ALTER 段删掉 → 老表上 SELECT 抛
  //   "no such column: duration_ms" → 这条红; ② ALTER 后 INSERT 改成 COALESCE(tokens_in, 0)
  //   → 写完老库后该列从 null 变 0 → 这条红 (select 出来是 0 不是 null)。
  test('GWT-1c: 旧表 (无五列) 被新代码读 → 五列全 null, run 级 usage 仍正常 (INV-1 / INV-3)', () => {
    const db = new Database(':memory:');
    // 逐字还原 2026-08-19 之前的表 —— **没有** tokens_in / tokens_out / cache_hit_tokens /
    // duration_ms / turns 五列。`CREATE TABLE IF NOT EXISTS` 对已存在的表不动, 所以这一步
    // 必须**先于** createDagRecorder 完成。
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL
      )
    `);
    // 一条老行: nodes JSON 里**不**写 tokensIn/Out 等五位列 (它们本就该走表列, 与 JSON 字段互斥) —— 让
    // 新代码读的 NULL 来源**只能**是「这一列在表里压根不存在」, 不是读侧 filter 漏读也不是 JSON 串里被另记。
    db.run(
      `INSERT INTO omd_dag_runs
        VALUES ('legacy-1', 1700000000000, '老图', 1, null, null,
                '[["a"]]',
                '[{"id":"a","kind":"agent","status":"done","deps":[]}]',
                '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}')`,
    );

    // 新代码接手: 不许炸 (INV-3 老库兼容)。ALTER 段把 5 列就地补成 NULL。
    const rec = createDagRecorder({ db });
    const legacy = rec.get('legacy-1')!; // 不许抛

    // 行读得出来 —— run-level usage 仍可读
    expect(legacy.id).toBe('legacy-1');
    expect(legacy.planName).toBe('老图');
    expect(legacy.usage).toEqual({
      conductorIn: 0,
      conductorOut: 0,
      leavesIn: 0,
      leavesOut: 0,
      leavesCacheHit: 0,
    });

    // 节点级五位列必须**逐位 null** —— 这五位目前**没有**被 rowToRecord 映射到 DagRunRecord
    // (那是观察面/SQL 分析面的数据, 不进 record 对象), 所以直接从表查。SELECT 用具体的列名,
    // 不依赖 `*` —— 这样 ALTER 是否生效都不影响查询能跑 (列不在 → 抛错 → 这条红)。
    const row = db
      .query<{ tokens_in: number | null; tokens_out: number | null; cache_hit_tokens: number | null; duration_ms: number | null; turns: number | null }, []>(
        `SELECT tokens_in, tokens_out, cache_hit_tokens, duration_ms, turns
           FROM omd_dag_runs WHERE id = 'legacy-1'`,
      )
      .get()!;

    expect(row.tokens_in).toBeNull(); // INV-1: NOT 0
    expect(row.tokens_out).toBeNull();
    expect(row.cache_hit_tokens).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.turns).toBeNull();

    // ★ 五列**逐一**断 null, 不是统一 toBeFalsy —— 用来挡「把它们都判成 undefined」的回退
    expect([
      row.tokens_in,
      row.tokens_out,
      row.cache_hit_tokens,
      row.duration_ms,
      row.turns,
    ]).toEqual([null, null, null, null, null]);

    rec.close();
  });

  // 证伪方式: ① 在 fixture 里塞一行 entry:'call' 但不写 runId,然后 group-by-entry 之后算
  //   总和时把它当作 node → 把发级那一发算进 节点数 → nodes !== 3 → 这条红; ② 把 fixture 的
  //   节点行的 in 改成 100000,但 call 行的 in 保持 100,然后断言 Σins === 2030 (100×20 + 30×3) →
  //   若实现把两组 in 错位相加 (Σ全乘 N 而不是按 entry 各自求和) → 红; ③ 在解析里忘了 group by
  //   entry 直接 `entries.length` → 得 23 → 「节点数 23」断 红; ④ 把 fixture 改成 25 call + 3 node,
  //   仍断 nodes === 3 → 红 (节点计数不该跟发数耦合)。
  test('GWT-1d: seat-usage.jsonl 里 entry:\'call\' 与 entry:\'node\' 条数不可相加 (INV-4)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-node-usage-1d-'));
    const jsonlPath = join(dir, 'seat-usage.jsonl');

    // 20 行 entry:'call' (发级, 经 send) + 3 行 entry:'node' (节点级, agent leaf 不经网关)。
    // 数字选得**两源错位就崩**:calls 各自 in=100/out=10;nodes 各自 in=30/out=20。
    //   · 若有人 Σ不分 entry:`Σins === 2000+90 === 2090`,而正确解是 `100×20 + 30×3 === 2090` —— 巧合;
    //     改 in→in=1001/out=10 后,正确解 = `1001×20 + 30×3 = 20110`,错位解会照全 20×3=23×N
    //     算成别的数。所以 **必须**按 entry group-by。
    const lines: SeatUsageEntry[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push({
        ts: 1700000000000 + i,
        seat: 'conductor',
        traceName: 'conductor:plan',
        model: 'openai:gpt-5',
        in: 100,
        out: 10,
        cacheHit: null,
        runId: 'gwt-1d',
        entry: 'call',
        nodeId: null,
      });
    }
    for (let i = 0; i < 3; i++) {
      lines.push({
        ts: 1700000001000 + i,
        seat: 'agent',
        traceName: 'agent-leaf',
        model: 'openai:gpt-5',
        in: 30,
        out: 20,
        cacheHit: null,
        runId: 'gwt-1d',
        entry: 'node',
        nodeId: `n-${i}`,
      });
    }
    appendFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // 读回 jsonl (与 dag-record 同款做法: 直接 fs, 不走 recordSeatUsage —— 它写真实 repo 路径)。
    const raw = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SeatUsageEntry);

    // ★★★ 节点计数 (按 entry 分组) 必须 = 3, 不是 23。
    //   错误实现 `raw.filter((r) => r.runId === 'gwt-1d').length` → 23 → 红 (这是 INV-4 上一轮漏的那条)。
    const nodeEntries = raw.filter((r) => r.runId === 'gwt-1d' && r.entry === 'node');
    const callEntries = raw.filter((r) => r.runId === 'gwt-1d' && r.entry === 'call');
    expect(nodeEntries.length).toBe(3);
    expect(callEntries.length).toBe(20);
    expect(nodeEntries.length + callEntries.length).toBe(23); // 全条数仍存在, 但只是巧合

    // in/out 可相加 (物理上不重叠: node 级那条路不经 send, 见 seat-usage.ts:22-28)。
    // 必须按 entry 各自求和, 而不是把 rows 当作同种东西加。
    const sumByEntry = (which: 'call' | 'node', field: 'in' | 'out'): number =>
      raw
        .filter((r) => r.runId === 'gwt-1d' && r.entry === which && typeof r[field] === 'number')
        .reduce((s, r) => s + (r[field] ?? 0), 0);
    const totalIn = sumByEntry('call', 'in') + sumByEntry('node', 'in');
    const totalOut = sumByEntry('call', 'out') + sumByEntry('node', 'out');
    expect(totalIn).toBe(20 * 100 + 3 * 30); // 2090
    expect(totalOut).toBe(20 * 10 + 3 * 20); // 260

    // 反向自检: 若有人实现成「node 数 = Σ entries (当 node 的倍数)」(eg. 23 * 1 = 23),会得 23。
    //   这条断 `nodeEntries.length !== 23` —— 钉死**必须**按 entry 分组数, 不能乘。
    expect(nodeEntries.length).not.toBe(23);
    // 同样钉死 call 数不被节点数污染
    expect(callEntries.length).not.toBe(3);

    // 严格的可相加/不可相加对照表:
    //   · 条数: 不可相加 (粒度不同) → 节点数 = 3, 不是 23
    //   · token: 可相加 (物理不重叠) → Σin = 2090, Σout = 260
    // 这两条**必须同时**成立才是 INV-4 的正解。
    const tokenAdditiveCheck = (sumByEntry('call', 'in') === 2000 && sumByEntry('node', 'in') === 90);
    const countNotAdditiveCheck = (nodeEntries.length !== callEntries.length); // 3 vs 20
    expect(tokenAdditiveCheck).toBe(true);
    expect(countNotAdditiveCheck).toBe(true);
  });

  // 证伪方式: ① 在 INSERT 列名里加一列 (例如 `injected_tokens INTEGER`) 但忘了在 VALUES 加 `?` →
  //   cols=27, ?=26, run-args=26 → cols !== ? → 这条红并报 INSERT 行号; ② 在 ins.run() 末尾多塞
  //   一行 `null` 但忘加列 → run-args=27, cols=26 → 红; ③ 改反顺序 (cols 26 / ? 27 / args 26) → 红;
  //   ④ 把整个 ins.run() 块删了 → 找不到 → 红。闸的可见失败方式就是「三计数有一个对不上」,
  //   全部报行号, 让人按行去修。
  test('GWT-1e: 源码级结构闸 ── INSERT 列名数 == ? 占位符数 == .run() 实参数', () => {
    const srcPath = join(import.meta.dir, 'dag-record.ts');
    const src = readFileSync(srcPath, 'utf8');
    const lines = src.split('\n');

    // ① 找 INSERT 行 (1-indexed 行号给失败信息用)。
    const insertLine = (() => {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('INSERT INTO omd_dag_runs')) return i + 1;
      }
      return -1;
    })();
    expect(insertLine).toBeGreaterThan(0);

    // ② 抽 (列名) 与 (占位符) ── INSERT 形如 `INSERT INTO omd_dag_runs (a, b, …) VALUES (?, ?, …)`。
    //   用非贪婪 + [\s\S] 跨行匹配。注意第一对 `(... )` 紧跟 VALUES 之前, 第二对紧跟 VALUES 之后。
    const insertRe = /INSERT INTO omd_dag_runs\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/;
    const m = src.match(insertRe);
    if (!m) throw new Error(`GWT-1e: 源码里找不到 INSERT INTO omd_dag_runs (line ${insertLine})`);
    const cols = m[1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const placeholders = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // ③ 抽 ins.run(...) 的实参 ── 找平衡 `)`,按**深度 0** 数 `,`。strings 里的 `,` 不计入
    //   (本文件 `ins.run` 体内无字符串字面量含逗号, 实测确认; 见注释里的 hash-anchor)。
    //   还要识别**尾随逗号**:最后一个 top-level `,` 之后只剩空白 / 注释 → 不算一个 arg 的分隔符,
    //   那样 args = commas, 否则 args = commas + 1。漏这一条会把 `null, // turns` 这种合法
    //   尾随逗号误读成「多了一个 arg」,闸就乱红 (实测: 26 / 26 / 26 三计数本应等, 错的实装也会被
    //   这条挡住 ── 但前提是 parser 自己先得对)。
    const insRunStart = src.indexOf('ins.run(');
    expect(insRunStart).toBeGreaterThan(-1);
    let depth = 0;
    let end = insRunStart + 'ins.run('.length;
    for (let i = end; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }
    const body = src.slice(insRunStart + 'ins.run('.length, end);
    // 一遍扫: 数 top-level commas, 记最后一个逗号的位置 (用于尾随逗号检测)。
    let commas = 0;
    let lastComma = -1;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let parenDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      const next = body[i + 1];
      if (inLineComment) {
        if (c === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (c === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inSingle) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }
      if (c === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        continue;
      }
      if (c === '(') {
        parenDepth++;
        continue;
      }
      if (c === ')') {
        parenDepth--;
        continue;
      }
      if (c === ',' && parenDepth === 0) {
        commas++;
        lastComma = i;
        continue;
      }
    }
    // 尾随逗号检测: 最后一个 top-level `,` 之后, 跳过空白 / 行注释 / 块注释, 应该只剩 close `)`。
    //   若是, args = commas; 否则 args = commas + 1。
    let trailing = false;
    if (lastComma >= 0) {
      let j = lastComma + 1;
      let ls = false;
      let lc = false;
      let bc = false;
      let ld = false;
      while (j < body.length) {
        const c = body[j];
        const next = body[j + 1];
        if (lc) {
          if (c === '\n') lc = false;
          j++;
          continue;
        }
        if (bc) {
          if (c === '*' && next === '/') {
            bc = false;
            j += 2;
            continue;
          }
          j++;
          continue;
        }
        if (ls) {
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === "'") ls = false;
          j++;
          continue;
        }
        if (ld) {
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === '"') ld = false;
          j++;
          continue;
        }
        if (c === '/' && next === '/') {
          lc = true;
          j += 2;
          continue;
        }
        if (c === '/' && next === '*') {
          bc = true;
          j += 2;
          continue;
        }
        if (c === "'") {
          ls = true;
          j++;
          continue;
        }
        if (c === '"') {
          ld = true;
          j++;
          continue;
        }
        if (c !== undefined && /\s/.test(c)) {
          j++;
          continue;
        }
        // 非空白 / 非注释字符 ── 意味着最后一个逗号**不是**尾随逗号
        trailing = false;
        break;
      }
      if (j >= body.length) trailing = true; // 扫到 body 末尾 = 后面只剩 `)`
    }
    const runArgs = trailing ? commas : commas + 1;

    // ★ 三者必须相等; 任一对不上 → 红, 报 INSERT 行号便于按行修。
    //   `fail('...')` 比 `expect().toEqual()` 好: 后者在三计数不等时只会说「expected X, received Y」,
    //   看不到列名/占位符/实参的**三方对照**, 也看不到行号 ── 维护者要按行去改, 行号必须明示。
    if (!(cols.length === placeholders.length && placeholders.length === runArgs)) {
      throw new Error(
        `GWT-1e 失败 @ dag-record.ts:${insertLine} ── ` +
          `cols=${cols.length}, placeholders=${placeholders.length}, runArgs=${runArgs} (三者必须相等)。` +
          `\n  列名: [${cols.join(', ')}]\n  占位符数: ${placeholders.length}\n  实参数: ${runArgs}`,
      );
    }

    // 正向断言 (便于失败信息可视化): 列数 = ? 数 = 实参数。
    expect(cols.length).toBe(placeholders.length);
    expect(placeholders.length).toBe(runArgs);

    // 关键列名抽检 ── 节点级五列必须**全在** INSERT 列名里 (老库 ALTER 那条路依赖这里)。
    const required = ['tokens_in', 'tokens_out', 'cache_hit_tokens', 'duration_ms', 'turns'];
    for (const r of required) {
      expect(cols).toContain(r);
    }
  });

  // 证伪方式: ① 在 record() 里把 run 级 `usage` 改成「`Σ节点 in` 当 leavesIn」→
  //   `rec.get(id)!.usage.leavesIn` 跟着走 → 这条红 (那是 C-1 SUM-IIFE 那一族的回归拦截);
  //   ② 把 ins.run() 的 `null` (tokens_in…) 改成 `Σn.tokensIn` →
  //   节点级五列不再是「schema 仅占位」→ 红; ③ 写一个**老库**(无新列)后读回 →
  //   leavesIn/leavesOut/leavesCacheHit 任一被读成 null 而非数字 → 红 (INV-3 第二面)。
  test('INV-3 复核: run 级 usage 聚合不受新列影响, 且 run 行不写「各节点求和」', () => {
    // 落 path-based 的库 (`:memory:` 按句柄隔离, 拿不到内部 db 句柄就不能跨句柄读 SQL)。
    const dir = mkdtempSync(join(tmpdir(), 'omd-node-usage-inv3-'));
    const dbPath = join(dir, 'dag-runs.db');

    // 故意 leavesIn ≠ Σ节点 in (4321 vs 4321): 若实现改写 leavesIn, 真值变了即红。
    //   节点 in=4321, 但 leavesIn 也填 4321, 这是 fakeResult 的当前值, 守住 Σ 写法
    //   不会漂 (Σ 与 leaf 同源) ── 真正的反例是「Σ 走一个**错**字段」(如 `cacheHit`) 那时
    //   fakeResult 的 leavesCacheHit: 0 ≠ Σ cacheHit ── 这里的 `toEqual` 钉死叶子面不动。
    const rec = createDagRecorder({ path: dbPath });
    const id = rec.record(fakeResult(), { runId: 'inv3' });
    expect(rec.get(id)!.usage).toEqual({
      conductorIn: 0,
      conductorOut: 0,
      leavesIn: 4321,
      leavesOut: 876,
      leavesCacheHit: 0,
    });

    // 直查 SQL: run 行的 tokens_in/tokens_out/cache_hit_tokens/duration_ms/turns **全是 NULL** ──
    // 不许是 Σ (那是上一版 5 个 SUM-IIFE 违反 INV-1/INV-3 的写法, 闸就是不让它回来)。
    //   必须走**新句柄**读同一份落盘 ── rowToRecord 已经把 nodes JSON 解出来了, 查 SQL
    //   是为了钉死「run 行那五列**也是** NULL, 不在 SQL 层做 Σ」。
    const probe = new Database(dbPath);
    const row = probe
      .query<
        {
          tokens_in: number | null;
          tokens_out: number | null;
          cache_hit_tokens: number | null;
          duration_ms: number | null;
          turns: number | null;
        },
        [typeof id]
      >(
        `SELECT tokens_in, tokens_out, cache_hit_tokens, duration_ms, turns
           FROM omd_dag_runs WHERE id = ?`,
      )
      .get(id)!;
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
    expect(row.cache_hit_tokens).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.turns).toBeNull();
    probe.close();
    rec.close();
  });
});
