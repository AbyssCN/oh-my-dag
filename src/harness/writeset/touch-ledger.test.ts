/**
 * touch-ledger 的闸 —— SDD S3 碰撞台账写入面 (docs/plan/2026-08-09-claude-驱动-omd-conductor-远程指挥接缝-执行契约-sdd.md §1-S3)。
 *
 * 只记不拦的第一刀, 这张网钉的是判据的**两半**:
 *   ① pair = 同一 abs_path + ≥2 个不同 session + **至少一侧 op='write'** —— read-read / 单 session 永不进 pair;
 *   ② 证据分档不许合并: strict 与 inferred 分两列报; hash 的 NULL (没算) 与 '' (算过, 空内容) 不许互相冒充。
 * 外加 pruneExpired 的「过期 ≠ 没记」: 清理必须留证据 (warn + 库内 prunes 摘要行), 不许静默 DELETE。
 *
 * 每条闸的反向自检 (**实跑过**): 临时改动 touch-ledger.ts 的对应判据 → 下面标 ★ 的用例当场红 → 还原。
 * 证伪方式写在各用例注释里; 换证伪时注意 —— 同一条闸换错判据会"假绿", 必须落到真正守住它的那行代码上。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTouchLedger } from './touch-ledger';
import { logger } from '../logger';

/** 临时接管 logger.warn 收集证据 (用完必须还原 —— logger 是模块级单例, 别的文件也用它)。 */
const captureWarns = (): { msgs: string[]; restore: () => void } => {
  const msgs: string[] = [];
  const orig = logger.warn;
  logger.warn = (_obj, msg) => {
    msgs.push(msg ?? '');
  };
  return { msgs, restore: () => (logger.warn = orig) };
};

/** ':memory:' 注入 (照 dag-record.test.ts 的姿势)。 */
const mem = () => openTouchLedger({ db: new Database(':memory:') });

/** 绝对路径 fixture —— 与 root 解析无关, pair 判据只认 abs_path。 */
const F = '/tmp/omd-touch/x.md';

describe('crossSessionPairs —— pair 判据的两半', () => {
  test('判据1 ★ 两个不同 session 各 write 同一文件 → 查询面出现 cross-session pair', () => {
    const l = mem();
    l.recordTouch({ path: F, session: 'run-A', op: 'write', source: 'strict', hash: 'hA' });
    l.recordTouch({ path: F, session: 'run-B', op: 'write', source: 'strict', hash: 'hB' });
    const pairs = l.crossSessionPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!).toMatchObject({
      absPath: F, sessionA: 'run-A', sessionB: 'run-B',
      strict: true, inferred: false, // B 只带了 strict 证据
    });
    l.close();
  });

  test('判据2 ★ 同一 session 两次 read 同一文件 → 不报 pair', () => {
    const l = mem();
    l.recordTouch({ path: F, session: 'run-A', op: 'read', source: 'cli' });
    l.recordTouch({ path: F, session: 'run-A', op: 'read', source: 'cli' });
    expect(l.crossSessionPairs()).toEqual([]);
    l.close();
  });

  test('同一 session 两次 write → 也不报 pair (≥2 个不同 session 是硬条件, 不只看 write)', () => {
    const l = mem();
    l.recordTouch({ path: F, session: 'run-A', op: 'write', source: 'strict', hash: 'h1' });
    l.recordTouch({ path: F, session: 'run-A', op: 'write', source: 'strict', hash: 'h2' });
    expect(l.crossSessionPairs()).toEqual([]);
    l.close();
  });

  test('★ read-read 永不进 pair (两个不同 session 各只读一次)', () => {
    const l = mem();
    l.recordTouch({ path: F, session: 'run-A', op: 'read', source: 'cli' });
    l.recordTouch({ path: F, session: 'run-B', op: 'read', source: 'cli' });
    expect(l.crossSessionPairs()).toEqual([]);
    l.close();
  });

  test('★ 至少一侧 write 即算 pair (另一侧可以只是 read)', () => {
    const l = mem();
    l.recordTouch({ path: F, session: 'run-A', op: 'read', source: 'cli' });
    l.recordTouch({ path: F, session: 'run-B', op: 'write', source: 'strict', hash: 'hB' });
    const [p] = l.crossSessionPairs();
    expect(p).toBeDefined();
    expect(p!.absPath).toBe(F);
    expect(p!.strict).toBe(true); // B 的 strict 证据
    expect(p!.inferred).toBe(false);
    l.close();
  });
});

describe('★ strict 与 inferred 分两列报, 不合并成一个数 (⑧.6)', () => {
  test('三档 pair (只有 inferred / 只有 strict / 两档都有) 各自可辨', () => {
    const l = mem();
    const Y = '/tmp/omd-touch/y.md';
    const Z = '/tmp/omd-touch/z.md';
    // 只有 inferred 证据的 pair
    l.recordTouch({ path: F, session: 'sA', op: 'write', source: 'inferred' });
    l.recordTouch({ path: F, session: 'sB', op: 'write', source: 'inferred' });
    // 只有 strict 证据的 pair
    l.recordTouch({ path: Y, session: 'sA', op: 'write', source: 'strict', hash: 'h' });
    l.recordTouch({ path: Y, session: 'sB', op: 'write', source: 'strict', hash: 'h2' });
    // 两档都有的 pair —— 两列都 true, 不折成一个数
    l.recordTouch({ path: Z, session: 'sA', op: 'write', source: 'strict', hash: 'h' });
    l.recordTouch({ path: Z, session: 'sB', op: 'write', source: 'inferred' });
    const byPath = Object.fromEntries(l.crossSessionPairs().map((p) => [p.absPath, p]));
    // 证伪 (实跑过): 把 touch-ledger.ts 的 `strict: r.strict === 1` 改成 `strict: r.strict === 1 || r.inferred === 1`
    //   (两列合并成一个真值) → 下面第一行断言 `strict: false` 当场红。
    expect(byPath[F]!).toMatchObject({ strict: false, inferred: true });
    expect(byPath[Y]!).toMatchObject({ strict: true, inferred: false });
    expect(byPath[Z]!).toMatchObject({ strict: true, inferred: true });
    l.close();
  });
});

describe('hash 的 NULL ≠ 0 纪律', () => {
  test('★ 没算 hash → 落 NULL; 算过 (空内容) → 落空串; 两者在库里分得开', () => {
    const db = new Database(':memory:');
    const l = openTouchLedger({ db });
    l.recordTouch({ path: F, session: 's', op: 'write' }); // 没算 → NULL
    l.recordTouch({ path: F, session: 's', op: 'write', hash: '' }); // 算过, 空内容 → ''
    const rows = db.query('SELECT hash FROM touches ORDER BY rowid').all() as Array<{ hash: string | null }>;
    // 证伪 (实跑过): 把 touch-ledger.ts 的 `input.hash ?? null` 改成 `input.hash ?? ''`
    //   (NULL 落成空串) → 下面第一行断言 `toBeNull()` 当场红。
    expect(rows[0]!.hash).toBeNull();
    expect(rows[1]!.hash).toBe('');
    expect(rows[0]!.hash).not.toBe(rows[1]!.hash);
    l.close();
  });
});

describe('pruneExpired —— 过期 ≠ 没记', () => {
  test('★ 清理留证据: warn + 库内 prunes 摘要行, 不许静默 DELETE', () => {
    const db = new Database(':memory:');
    const l = openTouchLedger({ db });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // 直插老行 (recordTouch 用 Date.now(), 造不出过期数据)
    db.query('INSERT INTO touches (abs_path, session, op, hash, source, ts) VALUES (?,?,?,?,?,?)')
      .run('/old.md', 's1', 'write', null, 'strict', now - 10 * DAY);
    db.query('INSERT INTO touches (abs_path, session, op, hash, source, ts) VALUES (?,?,?,?,?,?)')
      .run('/fresh.md', 's2', 'write', 'h', 'strict', now - DAY);
    const { msgs, restore } = captureWarns();
    try {
      const pruned = l.pruneExpired({ ttlMs: 7 * DAY, now });
      expect(pruned).toBe(1);
      expect((db.query('SELECT count(*) AS n FROM touches').get() as { n: number }).n).toBe(1); // 只剩 fresh
      // 证伪 (实跑过): 把 touch-ledger.ts 里 prunes 表的 INSERT 摘掉 (只留 DELETE) →
      //   下面两条断言 (`prunes` 有行 / warn 有痕) 同时红 —— 那就是"静默 DELETE"。
      const [pr] = db.query('SELECT pruned, ttl_ms, reason FROM prunes').all() as Array<{ pruned: number; ttl_ms: number; reason: string }>;
      expect(pr!.pruned).toBe(1);
      expect(pr!.ttl_ms).toBe(7 * DAY);
      expect(pr!.reason).toContain(String(now - 7 * DAY)); // 依据: cutoff
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('[omd/touch-ledger]');
    } finally {
      restore();
      l.close();
    }
  });

  test('没得清 → 不 warn 不插摘要 (零清理是正常态, 不该留噪音)', () => {
    const db = new Database(':memory:');
    const l = openTouchLedger({ db });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    db.query('INSERT INTO touches (abs_path, session, op, hash, source, ts) VALUES (?,?,?,?,?,?)')
      .run('/fresh.md', 's1', 'write', 'h', 'strict', now - DAY);
    const { msgs, restore } = captureWarns();
    try {
      expect(l.pruneExpired({ ttlMs: 7 * DAY, now })).toBe(0);
      expect((db.query('SELECT count(*) AS n FROM prunes').get() as { n: number }).n).toBe(0);
      expect(msgs).toEqual([]);
    } finally {
      restore();
      l.close();
    }
  });
});

describe('fail-open: 台账写失败不许扰动调用方', () => {
  test('★ 库已关 → recordTouch warn 留痕, 不抛 (工具出口照常成功)', () => {
    const db = new Database(':memory:');
    const l = openTouchLedger({ db });
    db.close(); // 之后任何写都炸 —— 台账不许把炸传给调用方
    const { msgs, restore } = captureWarns();
    try {
      // 证伪 (实跑过): 把 touch-ledger.ts 的 recordTouch 去掉 try/catch (直插 INSERT) →
      //   下面 `not.toThrow()` 当场红, warn 也消失。
      expect(() => l.recordTouch({ path: F, session: 's', op: 'write' })).not.toThrow();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('[omd/touch-ledger]');
    } finally {
      restore();
    }
  });
});

describe('锚定: 相对路径解析 + 存盘位置', () => {
  test('相对路径对 root 解析成绝对再落库', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-touch-ledger-'));
    const db = new Database(':memory:');
    const l = openTouchLedger({ db, root }); // 给 db 时 root 只用于相对路径解析
    l.recordTouch({ path: 'docs/a.md', session: 's', op: 'write' });
    const row = db.query('SELECT abs_path FROM touches').get() as { abs_path: string };
    expect(row.abs_path).toBe(join(root, 'docs/a.md')); // 绝对路径, 不是相对原文
    expect(l.crossSessionPairs()).toEqual([]); // 单条 touch 不成 pair
    l.close();
  });

  test('openTouchLedger({ root }) 落库到 <root>/.omd/touch.db (触碰发生的工作根, 不是主仓根)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-touch-ledger-'));
    const l = openTouchLedger({ root });
    l.recordTouch({ path: 'a.md', session: 's', op: 'read' });
    l.close();
    expect(existsSync(join(root, '.omd', 'touch.db'))).toBe(true);
  });
});

describe('findings —— 与 pairs 分开读的写碰撞聚合', () => {
  test('按 abs_path 聚合, 只含 write 参与的; 只读过的文件不进', () => {
    const l = mem();
    // f1: A、B 都写过 → 进 findings (strict 与 inferred 各算各的)
    l.recordTouch({ path: '/a.md', session: 'A', op: 'write', source: 'strict', hash: 'h' });
    l.recordTouch({ path: '/a.md', session: 'B', op: 'write', source: 'inferred' });
    // f2: 只被 A 读过 → 不进 findings
    l.recordTouch({ path: '/b.md', session: 'A', op: 'read', source: 'cli' });
    const fs = l.findings();
    expect(fs).toHaveLength(1);
    expect(fs[0]!.absPath).toBe('/a.md');
    expect(fs[0]!.sessions).toBe(2);
    expect(fs[0]!.writeSessions).toBe(2);
    expect(fs[0]!.strictWrites).toBe(1);
    expect(fs[0]!.inferredWrites).toBe(1);
    l.close();
  });
});

describe('stats —— 让「零碰撞」与「台账没接上」分得开 (#253 收尾)', () => {
  test('★ 空库: rows/计数全 0, 而 lastTs/firstTs **缺席不是 0** (0 会读成 1970 年记过一次)', () => {
    const l = mem();
    const st = l.stats();
    expect(st.rows).toBe(0);
    expect(st.sessions).toBe(0);
    expect(st.writeRows).toBe(0);
    expect(st.readRows).toBe(0);
    expect(st.bySource).toEqual({ strict: 0, inferred: 0, cli: 0 });
    // 证伪方式: 把 stats() 里 `r.last_ts === null ? {} : {...}` 改成 `?? 0` → 这两条当场红。
    // 那正是本条闸要守的那行 —— 计数列的 NULL 是真 0, 时间列的 NULL 是缺席, 两者不许同款处理。
    expect(st.lastTs).toBeUndefined();
    expect(st.firstTs).toBeUndefined();
    l.close();
  });

  test('★ findings 空但 rows>0 = 真的没撞 (这正是 #253 之后主树库的常态, 不是故障)', () => {
    const l = mem();
    // 单 session 写两个文件: 撞不起来, 但库是活的。
    l.recordTouch({ path: '/a.md', session: 'run-A', op: 'write', source: 'strict', hash: 'h' });
    l.recordTouch({ path: '/b.md', session: 'run-A', op: 'read', source: 'strict' });
    expect(l.findings()).toHaveLength(0);
    const st = l.stats();
    expect(st.rows).toBe(2);
    expect(st.sessions).toBe(1);
    expect(st.writeRows).toBe(1);
    expect(st.readRows).toBe(1);
    expect(st.lastTs).toBeGreaterThan(0); // 库在记 → 上面那个 0 findings 可以按"没撞"读
    l.close();
  });

  test('证据档位分三列不合并 (与 pairs 的 strict/inferred 同一条纪律)', () => {
    const l = mem();
    l.recordTouch({ path: '/a.md', session: 'A', op: 'write', source: 'strict', hash: 'h' });
    l.recordTouch({ path: '/a.md', session: 'B', op: 'write', source: 'inferred' });
    l.recordTouch({ path: '/a.md', session: 'C', op: 'write', source: 'cli' });
    const st = l.stats();
    expect(st.bySource).toEqual({ strict: 1, inferred: 1, cli: 1 });
    expect(st.sessions).toBe(3);
    l.close();
  });

  test('pruneExpired 之后 stats 只数活行 (清理过的不许还算在"库是活的"里)', () => {
    const l = mem();
    l.recordTouch({ path: '/old.md', session: 'A', op: 'write', source: 'strict', hash: 'h' });
    expect(l.stats().rows).toBe(1);
    // ttl=0 + now 取未来 → 现存行全部过期。
    l.pruneExpired({ ttlMs: 0, now: Date.now() + 1000 });
    const st = l.stats();
    expect(st.rows).toBe(0);
    expect(st.lastTs).toBeUndefined(); // 清空后回到"缺席", 不是停在旧时间戳
    l.close();
  });
});
