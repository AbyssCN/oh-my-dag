/**
 * **源码级闸 INV-7: 每个开 WAL 的函数体都必须配 busy_timeout** (2026-08-19)
 *
 * 闸的形状 (照 `src/mcp/no-cli-dep.test.ts` 那条全仓闸):
 * 扫 `src/` 下所有 `.ts` 文件, 每出现一处 `PRAGMA journal_mode = WAL`,
 * 其所在函数体内必须存在 `PRAGMA busy_timeout`; 少一处即红, 判词点名文件 + 行号。
 *
 * ## GWT-3a (反向闸的证伪方式)
 *
 * 从任意一处删掉 `db.run('PRAGMA busy_timeout = …')` 那行, 本测试的
 * `★ src/ 下任何含 WAL 的函数体都含 busy_timeout` 必须红并点名该文件 +
 * WAL 所在行号。**不会**因为 busy_timeout 在另一个函数 / 类方法里就被放过 —
 * 见下方 `合成: WAL 但 busy_timeout 在另一函数体内必须仍判红`。
 *
 * ## GWT-3b (并发写不抛 BUSY 且全落库)
 *
 * 两个 bun 子进程同时往同一临时 db 各写 200 行; 期望 0 个 SQLITE_BUSY, 且
 * 全部 400 行落地。busy_timeout 是这一条的承重墙: 默认值 0 时只要竞争就
 * 必抛 SQLITE_BUSY。
 *
 * ## 为什么需要它
 *
 * 全仓 10 个开 WAL 的点 (dag-record / run-store / plan-ledger / touch-ledger /
 * memory / model-router / quota-store / watermark / owner-inbox / mcp-call-ledger)
 * 在改 INV-7 之前有 9 处**只开 WAL 不设 busy_timeout**; 默认 0 等于并发写必
 * 抛 SQLITE_BUSY, 这一闸之后任何节点再新开库都得带 busy_timeout 才过编。
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const REPO = resolve(import.meta.dir, '..', '..');
const WAL_RE = /PRAGMA\s+journal_mode\s*=\s*WAL/;
const BUSY_RE = /PRAGMA\s+busy_timeout/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts'))
      acc.push(p);
  }
  return acc;
}

/**
 * 给源码 + 一个 0-based 行号, 返回该行所在最小函数体的 [startLine, endLine] (含, 0-based)。
 *
 * 算法是裸括号平衡 (本仓 pragma 周边都是平直调用, 无嵌套模板字符串里的 `{` / `}` 风险):
 *   - 从 WAL 所在行向**前**走, 维护一个 depth 计数器。初始 depth=1 (我们已经在某个 `{` 里面)。
 *     每看到一个 `}` 增 1 (往深处走), 每看到一个 `{` 减 1 (往外走); 当 depth 落到 0 时,
 *     我们刚刚跨过的那个 `{` 就是当前所在函数体的开括号。**关键**: 我们停在那行 `{` 所在行上,
 *     不再向上走 — 即便那个函数本身嵌在另一个 `{` 里也不进, 因为外层可能是类体 / 命名空间体
 *     而非法体, 那个范围不该算进 busy_timeout 的归属域。
 *   - 从那个 `{` 向**后**走。startLine 上**先**出现的 `{` 是函数签名里的字面量 (默认参 /
 *     返回类型 / 解构), 它们的 `}` 在源码顺序上一定早于函数体自己的 `{` — 所以我们必须
 *     找到 startLine 上**最后**那个 `{` 之后才开始计数, 否则会被默认参的 `}` 误截。
 *
 * 不处理注释 / 字符串里的 `{` / `}`。本仓所有 WAL pragma 都不带花括号字面量, 故不修这层。
 */
function enclosingFunctionRange(
  lines: string[],
  walIdx: number,
): [number, number] | null {
  let depth = 1; // 起点 = WAL 行所在作用域, 已经在某个 `{` 里
  let startLine = -1;
  outer: for (let i = walIdx - 1; i >= 0; i--) {
    const line = lines[i]!;
    for (let j = line.length - 1; j >= 0; j--) {
      const c = line[j];
      if (c === '}') depth++;
      else if (c === '{') {
        depth--;
        if (depth === 0) {
          startLine = i;
          break outer;
        }
      }
    }
  }
  if (startLine === -1) return null;

  // startLine 上最后一个 `{` 才是函数体自身的开括号; 它之前的 `{` / `}` 是签名里的字面量,
  // 它们的 `}` 在源码顺序上一定早于函数体的 `{`, 不能让前向计数先撞上默认参的 `}`。
  const startLineText = lines[startLine]!;
  let openPos = -1;
  for (let j = 0; j < startLineText.length; j++) {
    if (startLineText[j] === '{') openPos = j;
  }
  if (openPos === -1) return null; // startLine 上找不到 `{`, 是上游 bug

  let fwdDepth = 1; // 函数体 `{` 自己已经吃进去
  let endLine = -1;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]!;
    const fromJ = i === startLine ? openPos + 1 : 0;
    for (let j = fromJ; j < line.length; j++) {
      const c = line[j];
      if (c === '{') fwdDepth++;
      else if (c === '}') {
        fwdDepth--;
        if (fwdDepth === 0) {
          endLine = i;
          break;
        }
      }
    }
    if (endLine !== -1) break;
  }
  if (endLine === -1) endLine = lines.length - 1;
  return [startLine, endLine];
}

/** 单文件的 WAL 点扫描结果 (0-based 行号, 转 1-based 由调用方负责)。 */
export interface WalSite {
  walLine: number; // 1-based
  functionStart: number; // 1-based
  functionEnd: number; // 1-based
  hasBusyTimeout: boolean;
}

export function scanFileForWalBusyTimeout(file: string): WalSite[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const results: WalSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!WAL_RE.test(lines[i]!)) continue;
    const range = enclosingFunctionRange(lines, i);
    if (!range) continue;
    const [s, e] = range;
    const body = lines.slice(s, e + 1).join('\n');
    results.push({
      walLine: i + 1,
      functionStart: s + 1,
      functionEnd: e + 1,
      hasBusyTimeout: BUSY_RE.test(body),
    });
  }
  return results;
}

/** 扫一批文件, 返回 [file (相对 repoRoot) → 缺 busy_timeout 的 WAL 点]。 */
export function findMissingBusyTimeout(
  files: string[],
  repoRoot: string = REPO,
): Map<string, { walLine: number; functionStart: number; functionEnd: number }[]> {
  const misses = new Map<
    string,
    { walLine: number; functionStart: number; functionEnd: number }[]
  >();
  for (const f of files) {
    const bad = scanFileForWalBusyTimeout(f).filter((h) => !h.hasBusyTimeout);
    if (bad.length) {
      misses.set(
        relative(repoRoot, f),
        bad.map((h) => ({
          walLine: h.walLine,
          functionStart: h.functionStart,
          functionEnd: h.functionEnd,
        })),
      );
    }
  }
  return misses;
}

describe('INV-7: 全仓 WAL 开库点必须有 busy_timeout', () => {
  it('★ src/ 下任何含 WAL 的函数体都含 busy_timeout', () => {
    const files = tsFiles(join(REPO, 'src'));
    // 扫描面本身要是活的 —— 打错路径导致「扫了 0 个文件」也会绿。
    expect(files.length).toBeGreaterThan(100);

    // 同样要确认找到了真 WAL 点 —— 找不到说明扫描器死了 (扫不到也判 0 miss)。
    const allHits = files.flatMap((f) => scanFileForWalBusyTimeout(f));
    expect(allHits.length).toBeGreaterThanOrEqual(10);

    const misses = findMissingBusyTimeout(files);
    const flat = [...misses.entries()].flatMap(([f, hits]) =>
      hits.map((h) => `  ${f}:${h.walLine}  (函数体 L${h.functionStart}–L${h.functionEnd})`),
    );
    const detail = flat.join('\n');
    expect(
      misses.size === 0
        ? ''
        : `${misses.size} 个文件里的 ${flat.length} 处 WAL 缺 busy_timeout:\n${detail}\n` +
          '修法: 在该 WAL 所在的**同一个**函数体内 db.run(\'PRAGMA busy_timeout = …\')。',
    ).toBe('');
  });

  it('GWT-3a 反向自检: WAL 但无 busy_timeout 必须被抓到 + 点名行号', () => {
    // 从任意一处删掉 busy_timeout 那行, 本闸必须红并点名该文件 + WAL 所在行号。
    // 拿这个合成 fixture 走一遍 findMissingBusyTimeout, 期望命中。
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv7-'));
    const f = join(dir, 'no-busy.ts');
    writeFileSync(
      f,
      [
        'export function openLedger(opts: { path: string }): void {',
        '  const db = new Database(opts.path);',
        "  db.run('PRAGMA journal_mode = WAL');",
        "  db.run('CREATE TABLE t (id INTEGER)');",
        '}',
      ].join('\n'),
    );
    const misses = findMissingBusyTimeout([f], dir);
    expect(misses.size).toBe(1);
    const hits = misses.get('no-busy.ts');
    expect(hits).toBeDefined();
    expect(hits!.length).toBe(1);
    expect(hits![0]!.walLine).toBe(3);
  });

  it('合成: WAL + busy_timeout 在同一函数体内必须放过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv7-'));
    const f = join(dir, 'good.ts');
    writeFileSync(
      f,
      [
        'export function openLedger(opts: { path: string }): void {',
        '  const db = new Database(opts.path);',
        "  db.run('PRAGMA journal_mode = WAL');",
        "  db.run('PRAGMA busy_timeout = 20000');",
        '}',
      ].join('\n'),
    );
    expect(findMissingBusyTimeout([f], dir).size).toBe(0);
  });

  it('合成: WAL 但 busy_timeout 在另一函数体内必须仍判红 (跨函数逃逸检测)', () => {
    // GWT-3a 反向闸的另一半: 即使文件里**有** busy_timeout, 但若它跟 WAL 不在同一函数体,
    // 仍然判红 (因为另一函数体的 db 可能根本不是这个 WAL 的 db)。
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv7-'));
    const f = join(dir, 'leak.ts');
    writeFileSync(
      f,
      [
        'export function openLedger(opts: { path: string }): void {',
        '  const db = new Database(opts.path);',
        "  db.run('PRAGMA journal_mode = WAL');",
        '}',
        '',
        'export function otherThing(): void {',
        "  db.run('PRAGMA busy_timeout = 20000');",
        '}',
      ].join('\n'),
    );
    expect(findMissingBusyTimeout([f], dir).size).toBe(1);
  });

  it('合成: 类构造器里的 WAL, 跟另一个方法的 busy_timeout 不算配对', () => {
    // 边界: 类成员的函数体是方法体, 不是类体。busy_timeout 必须跟 WAL 在**同一个方法体**内。
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv7-'));
    const f = join(dir, 'class-leak.ts');
    writeFileSync(
      f,
      [
        'export class Store {',
        '  constructor(db: Database) {',
        "    db.run('PRAGMA journal_mode = WAL');",
        '  }',
        '  other(): void {',
        "    db.run('PRAGMA busy_timeout = 20000');",
        '  }',
        '}',
      ].join('\n'),
    );
    expect(findMissingBusyTimeout([f], dir).size).toBe(1);
  });
});

describe('GWT-3b: 两个进程同写一库, 零 SQLITE_BUSY, 全 400 条落库', () => {
  it('两子进程各写 200 行, 全落库无 BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-gwt3b-'));
    const dbPath = join(dir, 'gwt3b.db');

    // 初始化表 (单进程, 无竞争)
    {
      const init = new Database(dbPath);
      init.run('PRAGMA journal_mode = WAL');
      init.run('PRAGMA busy_timeout = 20000');
      init.run('CREATE TABLE t (id INTEGER PRIMARY KEY, who TEXT NOT NULL, payload TEXT NOT NULL)');
      init.close();
    }

    // 子进程脚本: 接 4 个 argv (path, who, startId, N)。
    // 关键是不在这里自己拼字符串塞 busy_timeout 数值, 让调用方决定 —— 这样同一脚本
    // 既能跑承重墙测试, 也能反向把 busy_timeout 调成 0 复现 BUSY, 验证机制本身在工作。
    //
    // 用 `db.transaction(() => { ... })` 包住全部 200 行 INSERT, 让写锁在整段循环内被
    // 持有 (而不是按行短持), 再叠 ~50KB 的 payload 让每行 insert 在毫秒级; 两个进程的
    // 写窗口足够重叠, busy_timeout=0 ⇒ SQLITE_BUSY, busy_timeout=20000 ⇒ 全过。
    const writer = [
      'import { Database } from \'bun:sqlite\';',
      'const path = process.argv[2];',
      'const who = process.argv[3];',
      'const startId = parseInt(process.argv[4], 10);',
      'const N = parseInt(process.argv[5], 10);',
      'const db = new Database(path);',
      'db.run(\'PRAGMA journal_mode = WAL\');',
      'db.run(\'PRAGMA busy_timeout = 20000\');',
      'try {',
      '  const insert = db.prepare(\'INSERT INTO t (id, who, payload) VALUES (?, ?, ?)\');',
      '  const payload = \'x\'.repeat(50_000);',
      '  db.transaction(() => {',
      '    for (let i = 0; i < N; i++) {',
      '      insert.run(startId + i, who, payload);',
      '    }',
      '  })();',
      '  process.exit(0);',
      '} catch (e: any) {',
      '  console.error(\'BUSY_TEST_FAIL\', who, e.code ?? e.message);',
      '  process.exit(2);',
      '}',
      '',
    ].join('\n');
    const scriptPath = join(dir, 'writer.ts');
    writeFileSync(scriptPath, writer);

    const procs = await Promise.all([
      Bun.spawn(['bun', 'run', scriptPath, dbPath, 'a', '0', '200'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited,
      Bun.spawn(['bun', 'run', scriptPath, dbPath, 'b', '200', '200'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited,
    ]);

    expect(procs[0]).toBe(0);
    expect(procs[1]).toBe(0);

    const check = new Database(dbPath);
    const row = check.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM t').get();
    check.close();
    expect(row).toBeDefined();
    expect(row!.n).toBe(400);
  }, 60_000);

  it('GWT-3b 反向自检: busy_timeout=0 + 真竞争 ⇒ 必须抛 SQLITE_BUSY', async () => {
    // 闸本身要是活的。把 busy_timeout 设回 0, 重跑并发写, 期望至少一个子进程
    // 退出码 2 且 stderr 带 BUSY_TEST_FAIL。这一条锁住「busy_timeout 是承重墙」这件事,
    // 否则上面的 400 行测试可以被空跑 (无竞争) 蒙混过关。
    const dir = mkdtempSync(join(tmpdir(), 'omd-gwt3b-'));
    const dbPath = join(dir, 'gwt3b-zero.db');

    {
      const init = new Database(dbPath);
      init.run('PRAGMA journal_mode = WAL');
      init.run('CREATE TABLE t (id INTEGER PRIMARY KEY, who TEXT NOT NULL, payload TEXT NOT NULL)');
      init.close();
    }

    const writerZero = [
      'import { Database } from \'bun:sqlite\';',
      'const path = process.argv[2];',
      'const who = process.argv[3];',
      'const startId = parseInt(process.argv[4], 10);',
      'const N = parseInt(process.argv[5], 10);',
      'const db = new Database(path);',
      'db.run(\'PRAGMA journal_mode = WAL\');',
      'db.run(\'PRAGMA busy_timeout = 0\');', // ← 反向自检: 关掉承重墙
      'try {',
      '  const insert = db.prepare(\'INSERT INTO t (id, who, payload) VALUES (?, ?, ?)\');',
      '  const payload = \'x\'.repeat(50_000);',
      '  db.transaction(() => {',
      '    for (let i = 0; i < N; i++) {',
      '      insert.run(startId + i, who, payload);',
      '    }',
      '  })();',
      '  process.exit(0);',
      '} catch (e: any) {',
      '  console.error(\'BUSY_TEST_FAIL\', who, e.code ?? e.message);',
      '  process.exit(2);',
      '}',
      '',
    ].join('\n');
    const scriptPath = join(dir, 'writer-zero.ts');
    writeFileSync(scriptPath, writerZero);

    const procs = await Promise.all([
      Bun.spawn(['bun', 'run', scriptPath, dbPath, 'a', '0', '200'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited,
      Bun.spawn(['bun', 'run', scriptPath, dbPath, 'b', '200', '200'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited,
    ]);

    // 承重墙测试里 transaction + 50KB payload 制造了毫秒级的写窗口重叠,
    // busy_timeout=0 时必有一边拿到 SQLITE_BUSY → 退出码 2。
    const someBusy = procs[0] === 2 || procs[1] === 2;
    expect(someBusy).toBe(true);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// GWT-3c (INV-9): schema 与查询语义的逐字前后比对
// ────────────────────────────────────────────────────────────────────────────
//
// 闸的形状: 跑 `git diff -- <C 片碰过的那些文件>`, 把每条 +/- 行分类:
//   · 允许: PRAGMA / BEGIN IMMEDIATE / 类似隔离级别 / transaction API 调用
//     (`tx.immediate()` 是 bun:sqlite 的 BEGIN IMMEDIATE 写法)。
//   · 禁止: CREATE TABLE / ALTER TABLE / SELECT / INSERT INTO / UPDATE /
//     DELETE FROM —— 出现任何一条即红并**原样打印该行**。
//
// C 片 (C-3) 本轮碰的文件 = `src/harness/memory/edge-store.ts` (fan-in 核验:
// diff 只含 `tx()` → `tx.immediate()` 两处升级 + 注释措辞更新, 无任何 schema /
// 查询语义改动)。dag-record.ts 是 A 片独占, 不在 C 片扫描面内。

const C_SLICE_FILES = ['src/harness/memory/edge-store.ts'];

const FORBIDDEN_DIFF_PATTERNS: RegExp[] = [
  /\bCREATE\s+TABLE\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bSELECT\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

function classifyDiffLine(rawLine: string): 'forbidden' | 'neutral' {
  if (!rawLine.startsWith('+') && !rawLine.startsWith('-')) return 'neutral';
  if (rawLine.startsWith('+++') || rawLine.startsWith('---')) return 'neutral';
  const body = rawLine.slice(1).trim();
  if (body === '') return 'neutral';
  // 注释行 / 纯 PRAGMA / 事务隔离升级不算 schema/query 改动
  if (body.startsWith('//') || body.startsWith('/*') || body.startsWith('*')) return 'neutral';
  if (/^\s*PRAGMA\b/i.test(body)) return 'neutral';
  if (/\btx\.immediate\b/.test(body)) return 'neutral';
  if (/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE|DEFERRED)\b/i.test(body)) return 'neutral';
  for (const re of FORBIDDEN_DIFF_PATTERNS) {
    if (re.test(body)) return 'forbidden';
  }
  return 'neutral';
}

describe('GWT-3c (INV-9): C 片 diff 只许 PRAGMA / 事务隔离, 禁止 schema/query 语义变动', () => {
  it('★ git diff -- C 片文件: 增删行只许 PRAGMA / 事务隔离 (CREATE/ALTER/SELECT/INSERT/UPDATE/DELETE 即红)', async () => {
    const proc = Bun.spawn(['git', 'diff', '--', ...C_SLICE_FILES], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: REPO,
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const violations: string[] = [];
    for (const line of out.split('\n')) {
      if (classifyDiffLine(line) === 'forbidden') violations.push(line);
    }

    expect(
      violations.length === 0
        ? ''
        : `C 片 git diff 出现 schema/query 语义改动 (INV-9 违规):\n${violations.join('\n')}\n` +
          'C 片 (C-3) 只许动 PRAGMA / 事务隔离, 任何 CREATE/ALTER/SELECT/INSERT/UPDATE/DELETE 即红。',
    ).toBe('');
  });

  it('GWT-3c 反向自检: 合成含 CREATE/ALTER/SELECT/INSERT/UPDATE/DELETE 的 diff, 必须逐条抓到', () => {
    const sample = [
      '+db.run(`CREATE TABLE t (id INTEGER)`);',
      '+db.run(`ALTER TABLE t ADD COLUMN x INTEGER`);',
      '+db.run(`SELECT * FROM t`);',
      '+db.run(`INSERT INTO t VALUES (1)`);',
      '+db.run(`UPDATE t SET x = 1`);',
      '+db.run(`DELETE FROM t`);',
    ];
    const hits = sample.filter((l) => classifyDiffLine(l) === 'forbidden');
    expect(hits.length).toBe(6);
  });

  it('GWT-3c 反向自检: PRAGMA / tx.immediate / 注释 不算 forbidden', () => {
    const allowed = [
      "+db.run('PRAGMA busy_timeout = 20000');",
      "+db.run('PRAGMA journal_mode = WAL');",
      '+tx.immediate();',
      "+db.run('BEGIN IMMEDIATE');",
      '+// 注释里出现 SELECT 也不算',
      '+/* PRAGMA + SELECT 都是文字 */',
    ];
    for (const line of allowed) {
      expect(classifyDiffLine(line)).toBe('neutral');
    }
  });

  it('GWT-3c 反向自检: diff 元信息行 (+++ / --- / @@) 必须不参与判定', () => {
    const meta = [
      '+++ b/src/harness/memory/edge-store.ts',
      '--- a/src/harness/memory/edge-store.ts',
      '@@ -104,7 +104,10 @@ export class SqliteEdgeStore implements EdgeStore {',
    ];
    for (const line of meta) {
      expect(classifyDiffLine(line)).toBe('neutral');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// INV-8: 全仓 check-then-write 清单闸
// ────────────────────────────────────────────────────────────────────────────
//
// 闸的形状 (照 `src/mcp/no-cli-dep.test.ts` 那条全仓闸): 扫 src/ 下所有 .ts,
// 找**同一函数体内**先 SELECT 后 INSERT/UPDATE (且写的内容依赖读的结果) 的位置,
// 含 dag-record.ts / plan-ledger.ts 的补列与 upsert 路径; 产出清单, 断言:
//   · 每一处要么用了 `BEGIN IMMEDIATE` / `tx.immediate()` (这是 INV-8 的正解);
//   · 要么在本测试文件内白名单常量里 (白名单每条必须写明理由: 纯读 / 单条写 /
//     单写者 / SELECT 在 tx 体外 / 写 在 tx 体外)。
// 清单出现白名单外的裸 check-then-write 即红并点名文件 + 行号。
//
// 启发式: 找**函数声明行** (function/method/arrow), 用括号平衡定位函数体起止,
// 然后在该函数体内:
//   - 有 SELECT 关键字 (不区分大小写)
//   - 有 INSERT INTO 或 UPDATE 关键字 (不区分大小写)
// 两者并存且无 tx.immediate/BEGIN IMMEDIATE 且不在白名单 → 违规。
//
// ⚠ 本仓库多数 db 文件是「工厂函数 + 准备 db.query + 返回 {方法}」的结构,
//   prepare 关键字 (SELECT/INSERT/UPDATE 字符串) 都落在工厂函数体内, 而
//   真正的 check-then-write 在内层方法里 (例如 plan-ledger.ts:record())。
//   本闸按关键字共存来判定 (与 memory/store.ts 同款启发式), 故会产生**工厂
//   函数级**的命中 —— 这种命中由 INV8_WHITELIST 用 "prepare-only" / "原子 upsert"
//   等理由收纳。

/** 白名单: 每条 reason 必填。functionLine = 函数声明行 (含 `{` 的那行, 1-based)。 */
const INV8_WHITELIST: ReadonlyArray<{ file: string; functionLine: number; reason: string }> = [
  // ── C-3 fan-in 已认定 ──────────────────────────────────────────────────
  {
    file: 'src/harness/memory/store.ts',
    functionLine: 223,
    reason: '纯 INSERT 无 SELECT (insertFact) —— 单条写',
  },
  {
    file: 'src/harness/memory/store.ts',
    functionLine: 242,
    reason: 'SELECT 在 L243-247 位于 tx 体外, tx 内只 UPDATE (tombstoneByIdentity)',
  },
  {
    file: 'src/harness/memory/store.ts',
    functionLine: 259,
    reason: 'get(id) 在 L261 位于 tx 体外, tx 内只 UPDATE (tombstone)',
  },
];

interface CheckThenWriteHit {
  file: string; // relative to REPO
  functionStart: number; // 1-based
  functionEnd: number; // 1-based
  selectLine: number | null;
  writeLine: number | null;
  hasImmediate: boolean;
}

/** 函数声明行匹配: `function name(`, `name(...): T {`, `name(...) {`,
 *  `async name(...)`, `=> {`, 也包含私有前缀 (private/protected/public)
 *  和导出前缀 (export/default)。
 *  简化: 同行的 `{` 之前的整行能匹配 `^\s*[\\w$<>,\\s\\[\\]\\?]+[\\(\\=]` 这种
 *  「签名 + 紧跟 ( 或 =>」就当作函数/方法签名。 */
function isFunctionDeclarationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  // 跳过箭头函数 (`=> {` 或 `() => {`) —— 它们是回调, 真正承重的 tx.immediate
  // 在外层函数体里。把回调误算成「独立函数」会把外层 `tx.immediate()` 的保护
  // 抹掉 (反向自检 #2 会立刻翻红)。
  if (/=>\s*\{/.test(trimmed)) return false;
  // 模式 1: `function name(` 或 `async function name(`
  if (/^(export\s+)?(default\s+)?(async\s+)?function\s*\w+\s*[(<]/.test(trimmed)) return true;
  // 模式 2: `name(...)` 或 `name(...): T` 后面跟 `{` (method shorthand)
  if (/[)][^{;]*\{\s*$/.test(trimmed) && /\([^)]*\)/.test(trimmed)) return true;
  return false;
}

/** 从 lineIdx 行的 `{` 起, 向后平衡找到匹配的 `}`。lineIdx 的 `{` 必须在该行上。 */
function findMatchingBrace(lines: string[], lineIdx: number): number {
  // 找 lineIdx 行上最后一个 `{` (函数签名后的 body 起点)
  const line = lines[lineIdx]!;
  let openPos = -1;
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '{') openPos = j;
  }
  if (openPos === -1) return lineIdx; // 没找到 `{`, 退化为自身行

  let depth = 1;
  for (let i = lineIdx; i < lines.length; i++) {
    const fromJ = i === lineIdx ? openPos + 1 : 0;
    const text = lines[i]!;
    for (let j = fromJ; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** 找 src/ 下所有函数体 (按函数声明行 + 括号平衡), 返回 [{ start, end }, ...] (0-based)。 */
function listFunctionBodies(lines: string[]): Array<{ start: number; end: number }> {
  const bodies: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isFunctionDeclarationLine(lines[i]!)) continue;
    // 跳过 `=> expr` 这种无 `{` 的 (与 isFunctionDeclarationLine 模式 3 互斥)
    const trimmed = lines[i]!.trim();
    if (!trimmed.endsWith('{') && !trimmed.endsWith(',') && !/=>\s*\{\s*$/.test(trimmed)) {
      // 可能是跨行声明: `function name(\n  args\n): T {` —— 这种情况罕见, 跳过
      // (本仓库所有 prepare-only 工厂函数 + 内层方法都在签名同行开 `{`)
      continue;
    }
    const end = findMatchingBrace(lines, i);
    bodies.push({ start: i, end });
  }
  return bodies;
}

/**
 * 把「预备语句」从函数体里抹掉 (用等长空白替换, 行号不变)。
 *
 * ⚠ 这一步是闸的**精度**所系, 不是可选的美化。首版没有它, 实测 9 处命中里 **8 处是
 * prepare-only 工厂** (`createRunStore` / `createModelRouter` / `createPlanLedger` …):
 * 那些函数体里的 SELECT 与 INSERT 只是 `const q = db.query(...)` 备好的语句, 根本不在
 * 同一个事务里执行, 包 `tx.immediate` 没有意义。精度 1/9 ≈ 11% —— 与 `beforeToolCall`
 * 写域闸那次撤回 (12% 在正当工作上开火) 是同一个形状, 所以判据必须收紧, 而不是加 8 条白名单
 * (白名单按**函数声明行号**钉, 上面插一行就悄悄错位)。
 *
 * 判据: `db.query(...)` / `db.prepare(...)` 之后**没有**链式执行调用
 * (`.get(` / `.all(` / `.run(` / `.values(` / `.iterate(`) = 预备, 抹掉;
 * 有 = 即用即弃的真查询, 保留。
 * 所以 `const q = db.query(sql);` 被抹, 而 `const rows = db.query(sql).all(1);` 保留
 * —— 后者正是三条反向自检里 `racyLedger` 的形状, 收紧后它**仍然必须被抓到**。
 */
export function stripPreparedStatements(body: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const re = /\bdb\s*\.\s*(?:query|prepare)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index < i) continue;
    // 从 `(` 开始做括号平衡, 找到这次调用的收尾位置
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < body.length; j++) {
      const c = body[j]!;
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= body.length) break; // 括号不平衡 —— 不猜, 原样留下
    // 跳过空白与换行, 看下一个非空字符是不是 `.` (链式执行)
    let k = j + 1;
    while (k < body.length && /\s/.test(body[k]!)) k++;
    const chained = body[k] === '.';
    out += body.slice(i, m.index);
    out += chained ? body.slice(m.index, j + 1) : blank(body.slice(m.index, j + 1));
    i = j + 1;
    re.lastIndex = i;
  }
  return out + body.slice(i);
}

/**
 * SQL 形状判据 —— 只认「长得像 SQL」的, 不认散文里的英文词。
 *
 * ⚠ 实测反例 (收紧前 `src/tui/tui.ts` 恒红): 「写」命中的是
 * `p?.phase === 'update'`, 「读」命中的是 `'… Enter model · Esc cancel'` 里的 `select`
 * —— 两个都是普通字符串, 一句 SQL 都没有。裸 `\bSELECT\b` 会把任何写了这两个英文词的
 * 函数算成 check-then-write。
 */
const looksLikeSelect = (t: string) => /\bSELECT\b[\s\S]{0,400}?\bFROM\b/i.test(t);
const looksLikeWrite = (t: string) =>
  /\bINSERT\s+INTO\b/i.test(t) || /\bUPDATE\b[\s\S]{0,200}?\bSET\b/i.test(t);

/** 包含 line (0-based) 的**最内层**函数体; 没有则 null。 */
function innermostBodyAt(
  bodies: ReadonlyArray<{ start: number; end: number }>,
  line: number,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const b of bodies) {
    if (line < b.start || line > b.end) continue;
    if (!best || b.end - b.start < best.end - best.start) best = b;
  }
  return best;
}

/** 在 src/ 下找所有 check-then-write 候选 (同一**最内层**函数体内同时含**执行中的** SELECT 与 INSERT/UPDATE)。 */
export function findCheckThenWrites(files: string[]): CheckThenWriteHit[] {
  const hits: CheckThenWriteHit[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const allLines = src.split('\n');
    const bodies = listFunctionBodies(allLines);
    for (const { start, end } of bodies) {
      // 函数体 = allLines[start..end] (含两端), 先抹掉预备语句再判
      const body = stripPreparedStatements(allLines.slice(start, end + 1).join('\n'));
      const lines = [...allLines];
      body.split('\n').forEach((l, idx) => {
        lines[start + idx] = l;
      });
      if (!looksLikeSelect(body) || !looksLikeWrite(body)) continue;
      // 第一个 SELECT 行 / 第一个 INSERT/UPDATE 行 (SQL 可跨行, 故取该行起 4 行的窗口)
      const win = (k: number) => lines.slice(k, k + 4).join('\n');
      let selectLine: number | null = null;
      let writeLine: number | null = null;
      for (let k = start; k <= end; k++) {
        if (selectLine === null && looksLikeSelect(win(k))) selectLine = k + 1;
        if (writeLine === null && looksLikeWrite(win(k))) writeLine = k + 1;
        if (selectLine !== null && writeLine !== null) break;
      }
      // 读与写落在**不同的兄弟闭包**里 → 从不在同一次调用中执行, 不是 check-then-write。
      // 实测反例: `openMcpCallLedger` 的 INSERT 在 record()、SELECT 在 rows(), 外层工厂体把两者圈在一起。
      if (selectLine !== null && writeLine !== null) {
        const bs = innermostBodyAt(bodies, selectLine - 1);
        const bw = innermostBodyAt(bodies, writeLine - 1);
        if (bs && bw && (bs.start !== bw.start || bs.end !== bw.end)) continue;
      }
      const hasImmediate =
        /\btx\.immediate\s*\(/.test(body) || /\bBEGIN\s+IMMEDIATE\b/i.test(body);
      hits.push({
        file: relative(REPO, f),
        functionStart: start + 1,
        functionEnd: end + 1,
        selectLine,
        writeLine,
        hasImmediate,
      });
    }
  }
  return hits;
}

describe('INV-8: 全仓 check-then-write 清单闸', () => {
  it('★ src/ 下所有 check-then-write 候选: 要么 tx.immediate, 要么在白名单', () => {
    const files = tsFiles(join(REPO, 'src'));
    expect(files.length).toBeGreaterThan(100);

    const hits = findCheckThenWrites(files);
    const violations: string[] = [];
    for (const h of hits) {
      if (h.hasImmediate) continue; // INV-8 正解
      const whitelisted = INV8_WHITELIST.some(
        (w) => w.file === h.file && w.functionLine === h.functionStart,
      );
      if (whitelisted) continue;
      violations.push(
        `  ${h.file}  函数体 L${h.functionStart}–L${h.functionEnd}  ` +
          `(SELECT@${h.selectLine ?? '?'} → 写@${h.writeLine ?? '?'})  无 tx.immediate 且不在白名单`,
      );
    }
    expect(
      violations.length === 0
        ? ''
        : `${violations.length} 处裸 check-then-write 缺 BEGIN IMMEDIATE 且不在白名单:\n` +
          violations.join('\n') +
          '\n修法: (a) 改用 `tx.immediate()` / `BEGIN IMMEDIATE` 包住 SELECT+写; ' +
          '(b) 或在本测试 INV8_WHITELIST 加白名单 (reason 必填)。',
    ).toBe('');
  });

  it('INV-8 反向自检: 合成 SELECT+UPDATE 的函数必须被抓到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv8-'));
    const f = join(dir, 'unsafe.ts');
    writeFileSync(
      f,
      [
        'export function racyLedger(db: any) {',
        '  const rows = db.query(`SELECT id FROM t WHERE x = ?`).all(1);',
        '  for (const r of rows) {',
        '    db.run(`UPDATE t SET y = 1 WHERE id = ?`, r.id);',
        '  }',
        '}',
      ].join('\n'),
    );
    const hits = findCheckThenWrites([f]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.hasImmediate).toBe(false);
  });

  it('INV-8 反向自检: tx.immediate() 包住 SELECT + UPDATE 必须放过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv8-'));
    const f = join(dir, 'safe.ts');
    writeFileSync(
      f,
      [
        'export function safe(db: any) {',
        '  const tx = db.transaction(() => {',
        '    const rows = db.query(`SELECT id FROM t WHERE x = ?`).all(1);',
        '    for (const r of rows) {',
        '      db.run(`UPDATE t SET y = 1 WHERE id = ?`, r.id);',
        '    }',
        '  });',
        '  tx.immediate();',
        '}',
      ].join('\n'),
    );
    const hits = findCheckThenWrites([f]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.hasImmediate).toBe(true);
  });

  it('INV-8 反向自检: 纯 INSERT 无 SELECT 的函数不应被算成 check-then-write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv8-'));
    const f = join(dir, 'pure-insert.ts');
    writeFileSync(
      f,
      [
        'export function pureInsert(db: any) {',
        '  db.run(`INSERT INTO t (id) VALUES (1)`);',
        '}',
      ].join('\n'),
    );
    expect(findCheckThenWrites([f]).length).toBe(0);
  });

  it('INV-8 反向自检: 全仓命中集非空且至少一处已 immediate (闸不许退化成恒空式)', () => {
    // 收紧判据 (prepare-only 抹除 / SQL 形状 / 同一最内层闭包) 把首版 9 处假阳降到了真阳。
    // 代价是: 收得过头会让全仓一处都不命中, 那时 ★ 那条恒绿, 闸就死了而没人知道。
    // 这条钉死两件: ① 还检得出东西 ② 我们对 pruneExpired 加的 tx.immediate() 被认了出来。
    const hits = findCheckThenWrites(tsFiles(join(REPO, 'src')));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((h) => h.hasImmediate).length).toBeGreaterThan(0);
  });

  it('INV-8 反向自检: prepare-only 工厂 (备语句不执行) 不该被算成 check-then-write', () => {
    // 这条钉的是收紧本身。抹掉它 (让 stripPreparedStatements 直接 return body),
    // 本条即红 —— 那正是首版的行为: 9 处命中 8 处是这种工厂。
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv8-'));
    const f = join(dir, 'factory.ts');
    writeFileSync(
      f,
      [
        'export function createStore(db: any) {',
        '  const qGet = db.query(`SELECT id FROM t WHERE x = ?`);',
        '  const qUpsert = db.query(',
        '    `INSERT INTO t (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET y = 1`,',
        '  );',
        '  return { qGet, qUpsert };',
        '}',
      ].join('\n'),
    );
    expect(findCheckThenWrites([f]).length).toBe(0);
  });

  it('INV-8 反向自检: 备了语句但**也**即用即弃地执行 → 仍要被抓 (收紧不许放过真的)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-inv8-'));
    const f = join(dir, 'mixed.ts');
    writeFileSync(
      f,
      [
        'export function mixed(db: any) {',
        '  const qPrepared = db.query(`SELECT 1`);', // 预备 —— 抹掉
        '  const n = db.query(`SELECT count(*) AS n FROM t`).get() as any;', // 执行 —— 留
        '  if (n.n > 0) db.query(`UPDATE t SET y = 1`).run();', // 执行 —— 留
        '  return qPrepared;',
        '}',
      ].join('\n'),
    );
    const hits = findCheckThenWrites([f]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.hasImmediate).toBe(false);
  });

  it('INV-8 白名单每条 reason 必填且必须含「纯读/单条写/单写者/SELECT 在 tx 体外/写 在 tx 体外/纯 INSERT」之一', () => {
    expect(INV8_WHITELIST.length).toBeGreaterThan(0);
    for (const w of INV8_WHITELIST) {
      expect(w.reason.length).toBeGreaterThan(0);
      expect(w.reason).toMatch(
        /纯读|单条写|单写者|SELECT 在 tx 体外|写 在 tx 体外|纯 INSERT|tx 内只|纯 SELECT|get\(.+\) 在 tx 体外/,
      );
    }
  });
});
