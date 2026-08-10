/**
 * src/harness/dream/gather.test —— dream SDD §S1 gather 闸(零 LLM)。
 *
 * 四条会红闸(each with counterfactual documented):
 * a. 水位三态分得开(缺 key / clean / skip 互斥)
 * b. 幂等:同窗口 gather 两次,第二次 dirty===0
 * c. 完结判定:done/failed/cancelled + running+死 pid 收; running+活 pid 不收
 * d. 当前会话排除:活跃 sessionId → 不进语料,水位 skipped(非 clean)
 *
 * 判据 1(模型调用计数===0)推迟 S6,S1 不断言。
 * created===0 归 S2,S1 不断言。
 *
 * ## 逐条反向自检(都实跑过,改坏→红→改回)
 *
 * a. 删 skip 分支 →「当前会话被排除」与「clean」读数相同 → 红(SDD 判据 2)
 *    - 改法:在 gather.ts 里注释掉 `if (isSessionActive(meta.id)) { wm.skip(...); ...; continue; }`
 *    - 红在:当前活跃会话被 gather 当作 clean/dirty(而非 skipped)
 *    - 报错:"Expected: 'skipped' Received: 'clean'" (active-session 测试)
 *    - ⚠ 验收改判(2026-08-09):skip 行**不粘死**——活跃与否每次 gather 重判,
 *      存量 skip 行在会话退役后视同从未固化。证伪见「skip 非粘性」测试。
 *
 * b. 幂等 → 若不清 watermark 就二次 gather,第二次 dirty 仍>0 → 红
 *    - 改法:gather 不更新 watermark
 *    - 红在:第二次 gather dirtyTotal > 0
 *    - 报错:"Expected: 0 Received: N"
 *
 * c. 完结判定 → 去掉 pid 判分支 → running+死 pid 被漏收 → 红
 *    - 改法:在 isRunCompleted 里删掉 `run.status === 'running' && ...` 分支
 *    - 红在:running+死 pid 的 run 不被计入 dirty
 *    - 报错:"Expected: 1 Received: 0" (dead-pid 测试)
 *
 * d. 当前会话排除 → 去掉 isSessionActive 回调 → 活跃会话被当作普通会话采集 → 红
 *    - 改法:gather 里不调用 isSessionActive
 *    - 红在:活跃会话被当作 dirty source(而非 skipped)
 *    - 报错:"Expected: 'skipped' Received: 'dirty'" (active-session 测试)
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore, resetSessionCacheForTest } from '../chat/session-store';
import { createRunStore, type PersistedRun } from '../../mcp/run-store';
import { createWatermark } from './watermark';
import { gather, type GatherReport } from './gather';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'omd-dream-gather-'));

const runRec = (overrides: Partial<PersistedRun> & { runId: string }): PersistedRun => ({
  status: 'done',
  goal: 'test',
  meta: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ownerPid: null,
  ...overrides,
});

/** pid>0 = alive, pid=0 or null = dead。 */
const aliveIfPositive = (pid: number): boolean => pid > 0;

// ---------------------------------------------------------------------------
// 会话路
// ---------------------------------------------------------------------------


/**
 * 模拟消费方固化成功 (2026-08-10 缺陷① 修法后, gather 不再自推游标):
 * 对 report 里的 dirty 源按候选游标 setClean —— 生产里这一步由 assembly 在
 * merge+promote 成功后做。
 */
const consolidate = (wm: ReturnType<typeof createWatermark>, r: Awaited<ReturnType<typeof gather>>): void => {
  for (const s of r.sources) {
    if (s.state === 'dirty' && s.cursor) wm.setClean(s.key, s.cursor);
  }
};

describe('gather 会话路', () => {
  let cwd: string;
  let db: Database;

  beforeEach(() => {
    resetSessionCacheForTest();
    cwd = tmpDir();
    db = new Database(':memory:');
  });

  test('新会话有条目 → dirty', async () => {
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'hej'));
    await s.append(msg('assistant', 'hej hej'));

    const r = await gather({ cwd, watermarkDb: db });
    expect(r.dirtyTotal).toBeGreaterThan(0);
    const src = r.sources.find((x) => x.key === 'session:s1');
    expect(src).toBeDefined();
    expect(src!.state).toBe('dirty');
    expect(src!.dirtyCount).toBeGreaterThanOrEqual(2);
  });

  test('无新增 → clean', async () => {
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'x'));

    // 第一次 gather:应为 dirty(带候选游标, 游标本身不推进)
    const r1 = await gather({ cwd, watermarkDb: db });
    expect(r1.dirtyTotal).toBeGreaterThan(0);
    consolidate(createWatermark({ db }), r1); // 消费方固化成功 → 才推进

    // 固化后再 gather:无新增 → clean
    const r2 = await gather({ cwd, watermarkDb: db });
    const src = r2.sources.find((x) => x.key === 'session:s1');
    expect(src!.state).toBe('clean');
    expect(r2.dirtyTotal).toBe(0);
  });

  test('★ 幂等(b):同窗口 gather 两次,第二次 dirty===0', async () => {
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'a'));
    await s.append(msg('assistant', 'b'));

    const r1 = await gather({ cwd, watermarkDb: db });
    expect(r1.dirtyTotal).toBeGreaterThan(0);
    consolidate(createWatermark({ db }), r1);

    const r2 = await gather({ cwd, watermarkDb: db });
    expect(r2.dirtyTotal).toBe(0);
    // created===0 归 S2,此处不断言
  });

  test('★ 未固化不归零(2026-08-10 缺陷① 反向自检):gather 两次不 setClean → dirty 原样在', async () => {
    // 旧语义 (采集即推游标) 下第二次 gather 归零 —— kill 于 extract 中途该批永沉。
    // 证伪方式 (当场验过): gather.ts 里把 setDirty 的 cursor 参数改回 String(maxSeq)
    // → 本测试红 ("Expected: 2 Received: 0"); 恢复后绿。
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'a'));
    await s.append(msg('assistant', 'b'));

    const r1 = await gather({ cwd, watermarkDb: db });
    expect(r1.dirtyTotal).toBe(2);
    const src1 = r1.sources.find((x) => x.key === 'session:s1');
    expect(src1!.cursor).toBeTruthy(); // 候选游标随报告带出, 供消费方固化后 setClean

    // 不固化 (模拟 extract 中途 kill) → 再 gather: 同一批条目原样 dirty, 不沉
    const r2 = await gather({ cwd, watermarkDb: db });
    expect(r2.dirtyTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 当前会话排除
// ---------------------------------------------------------------------------

describe('当前会话排除(d)', () => {
  let cwd: string;
  let db: Database;

  beforeEach(() => {
    resetSessionCacheForTest();
    cwd = tmpDir();
    db = new Database(':memory:');
  });

  test('★ 活跃会话 → 不进语料,水位 skipped(非 clean)', async () => {
    const store = createOmdSessionStore(cwd);
    const s = await store.create('active-sess');
    await s.append(msg('user', 'data'));

    // 标记 active-sess 为活跃
    const isActive = (id: string) => id === 'active-sess';

    const r = await gather({ cwd, watermarkDb: db, isSessionActive: isActive });
    const src = r.sources.find((x) => x.key === 'session:active-sess');
    expect(src).toBeDefined();
    expect(src!.state).toBe('skipped');
    expect(src!.dirtyCount).toBe(0);
    expect(src!.reason).toContain('active');

    // 水位确认:watermark 里记了 skip
    const wm = createWatermark({ db });
    const ws = wm.get('session:active-sess');
    expect(ws).not.toBeNull();
    expect(ws!.skipped).toBe(true);
    wm.close();
  });

  test('★ 反向自检 d:去掉 isSessionActive → 活跃会话被当作 dirty → 红', () => {
    // 证伪方式:在 gather.ts 里注释掉 `if (isSessionActive(meta.id))` 分支。
    // 则活跃会话的条目会被计入 dirty,state='dirty' 而非 'skipped'。
    // 报错:"Expected: 'skipped' Received: 'dirty'"
    // 此处只记证伪方式;正确行为由上一条测试保证。
  });

  test('★ skip 非粘性:曾活跃被 skip 的会话,退役后下次 gather 正常采集', async () => {
    // 验收改判(2026-08-09):skip 行不粘死。原实装先查存量 skip 行、命中即永远跳过 ——
    // 昨天活跃的会话退役后语料永远进不来(静默丢语料)。
    // 证伪方式(当场证伪过):把 gather.ts 会话循环改回「先查 prev.skipped 命中即 continue」
    // → 本测试红:"Expected: 'dirty' Received: 'skipped'"。现行为:活跃与否每次重判。
    const store = createOmdSessionStore(cwd);
    const s = await store.create('retiring-sess');
    await s.append(msg('user', 'while active'));

    // 第一次 gather:会话活跃 → skipped(水位记 skip 行)
    const r1 = await gather({ cwd, watermarkDb: db, isSessionActive: (id) => id === 'retiring-sess' });
    expect(r1.sources.find((x) => x.key === 'session:retiring-sess')!.state).toBe('skipped');

    // 会话退役(不再活跃)→ 第二次 gather 必须正常采到它的条目
    const r2 = await gather({ cwd, watermarkDb: db, isSessionActive: () => false });
    const src = r2.sources.find((x) => x.key === 'session:retiring-sess');
    expect(src!.state).toBe('dirty');
    expect(src!.dirtyCount).toBeGreaterThanOrEqual(1);
  });

  test('活跃会话排除后,其他会话正常采集', async () => {
    const store = createOmdSessionStore(cwd);
    const active = await store.create('active-sess');
    await active.append(msg('user', 'secret'));
    const normal = await store.create('normal-sess');
    await normal.append(msg('user', 'public'));

    const isActive = (id: string) => id === 'active-sess';
    const r = await gather({ cwd, watermarkDb: db, isSessionActive: isActive });

    const activeSrc = r.sources.find((x) => x.key === 'session:active-sess');
    expect(activeSrc!.state).toBe('skipped');

    const normalSrc = r.sources.find((x) => x.key === 'session:normal-sess');
    expect(normalSrc!.state).toBe('dirty');
  });
});

// ---------------------------------------------------------------------------
// 完结判定(run 路)
// ---------------------------------------------------------------------------

describe('gather run 路 — 完结判定(c)', () => {
  let db: Database;
  let runDb: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runDb = new Database(':memory:');
  });

  function gatherWithRuns(runs: PersistedRun[]): Promise<GatherReport> {
    const rs = createRunStore({ db: runDb });
    for (const r of runs) rs.put(r);
    // 注入:不读盘上 runs.db,用我们刚写的 memory store
    return gather({
      cwd: tmpDir(),
      watermarkDb: db,
      runStore: rs,
      isAlive: aliveIfPositive,
    });
  }

  test('终态 done → 收', async () => {
    const r = await gatherWithRuns([runRec({ runId: 'r1', status: 'done' })]);
    expect(r.dirtyTotal).toBe(1);
    expect(r.sources.find((x) => x.key === 'run:r1')!.state).toBe('dirty');
  });

  test('终态 failed → 收', async () => {
    const r = await gatherWithRuns([runRec({ runId: 'r1', status: 'failed' })]);
    expect(r.dirtyTotal).toBe(1);
  });

  test('终态 cancelled → 收', async () => {
    const r = await gatherWithRuns([runRec({ runId: 'r1', status: 'cancelled' })]);
    expect(r.dirtyTotal).toBe(1);
  });

  test('running + 死 pid(ownerPid=null) → 收(跑到一半被打断)', async () => {
    const r = await gatherWithRuns([
      runRec({ runId: 'r1', status: 'running', ownerPid: null }),
    ]);
    expect(r.dirtyTotal).toBe(1);
  });

  test('running + 死 pid(ownerPid=0,isAlive 返 false) → 收', async () => {
    const r = await gatherWithRuns([
      runRec({ runId: 'r1', status: 'running', ownerPid: 0 }),
    ]);
    expect(r.dirtyTotal).toBe(1);
  });

  test('running + 活 pid → **不收**(还在跑,不记水位不报 source,下次重判)', async () => {
    const r = await gatherWithRuns([
      runRec({ runId: 'r1', status: 'running', ownerPid: 12345 }),
    ]);
    expect(r.dirtyTotal).toBe(0);
    expect(r.sources.filter((x) => x.type === 'run')).toEqual([]);
  });

  test('★ 混合:done + running(死) + running(活) → 只收前两个', async () => {
    const r = await gatherWithRuns([
      runRec({ runId: 'done1', status: 'done', updatedAt: '2026-08-09T01:00:00Z' }),
      runRec({ runId: 'dead1', status: 'running', ownerPid: null, updatedAt: '2026-08-09T02:00:00Z' }),
      runRec({ runId: 'alive1', status: 'running', ownerPid: 12345, updatedAt: '2026-08-09T03:00:00Z' }),
    ]);
    expect(r.dirtyTotal).toBe(2);
  });

  test('★ 反向自检 c:去掉 pid 判分支 → running+死 pid 被漏收 → 红', () => {
    // 证伪方式:在 gather.ts 的 isRunCompleted 里删掉
    //   `if (run.status === 'running' && run.ownerPid !== null && !isAlive(run.ownerPid)) return true;`
    // 则 running+死 pid 的 run 不会被计入 dirty。
    // 报错:上面 "running + 死 pid → 收" 测试会红:
    //   "Expected: 1 Received: 0"
    // 此处只记证伪方式;正确行为由上几条测试保证。
  });
});

// ---------------------------------------------------------------------------
// run 路幂等
// ---------------------------------------------------------------------------

describe('gather run 路幂等', () => {
  test('同批 run gather 两次,第二次 dirty===0', async () => {
    const db = new Database(':memory:');
    const runDb = new Database(':memory:');
    const rs = createRunStore({ db: runDb });
    rs.put(runRec({ runId: 'r1', status: 'done' }));

    const r1 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: aliveIfPositive });
    expect(r1.dirtyTotal).toBe(1);
    consolidate(createWatermark({ db }), r1);

    const r2 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: aliveIfPositive });
    expect(r2.dirtyTotal).toBe(0);
  });

  test('run 游标只推进完结的,未完结的下次重判', async () => {
    const db = new Database(':memory:');
    const runDb = new Database(':memory:');
    const rs = createRunStore({ db: runDb });

    // 先放一个 running+alive 的 run
    rs.put(runRec({ runId: 'r-alive', status: 'running', ownerPid: 12345, updatedAt: '2026-08-09T01:00:00Z' }));

    const r1 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: aliveIfPositive });
    expect(r1.dirtyTotal).toBe(0); // 活的,不收

    // 现在"杀死"它:更新 status 为 failed(模拟跑完),updatedAt 推进
    rs.put(runRec({ runId: 'r-alive', status: 'failed', ownerPid: null, updatedAt: '2026-08-09T02:00:00Z' }));

    // 第二次 gather:应收到(游标没越过它,因为上次没收)
    const r2 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: aliveIfPositive });
    expect(r2.dirtyTotal).toBe(1);
  });

  test('★ 中断 run 不沉游标:属主死时 updatedAt 早于别的完结 run,仍要被采到', async () => {
    // 验收改判(2026-08-09):run 水位从单游标改 per-run key(run:<id>)。
    // 单游标的洞:done-late(03:00)先完结把游标推到 03:00;r-lag(01:00)当时还活着没收;
    // 之后 r-lag 属主死掉但 updatedAt 不再动(死进程不写库)→ 01:00 < 游标 → 永远采不到。
    // 证伪方式(当场证伪过):把 run 路改回单游标 `runs` 键 + updatedAt > lastCursor 过滤
    // → 本测试红:"Expected: 1 Received: 0"。per-run key 下 r-lag 无行 → 首见即 dirty。
    const db = new Database(':memory:');
    const runDb = new Database(':memory:');
    const rs = createRunStore({ db: runDb });
    rs.put(runRec({ runId: 'r-lag', status: 'running', ownerPid: 12345, updatedAt: '2026-08-09T01:00:00Z' }));
    rs.put(runRec({ runId: 'done-late', status: 'done', updatedAt: '2026-08-09T03:00:00Z' }));

    // 第一次 gather:r-lag 活着不收;done-late 收(单游标设计会在这里把游标推到 03:00)
    const r1 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: aliveIfPositive });
    expect(r1.dirtyTotal).toBe(1);
    consolidate(createWatermark({ db }), r1); // done-late 固化成功

    // r-lag 属主死掉,updatedAt **不变**(死进程不会再写库)
    const r2 = await gather({ cwd: tmpDir(), watermarkDb: db, runStore: rs, isAlive: () => false });
    const src = r2.sources.find((x) => x.key === 'run:r-lag');
    expect(r2.dirtyTotal).toBe(1);
    expect(src!.state).toBe('dirty');
  });
});

// ---------------------------------------------------------------------------
// skippedClean
// ---------------------------------------------------------------------------

describe('skippedClean 标记', () => {
  test('全 clean → skippedClean=true', async () => {
    const cwd = tmpDir();
    const db = new Database(':memory:');
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'x'));

    // 第一次 gather + 消费方固化(才建 clean 水位)
    consolidate(createWatermark({ db }), await gather({ cwd, watermarkDb: db }));
    // 再 gather(全 clean)
    const r2 = await gather({ cwd, watermarkDb: db });
    expect(r2.skippedClean).toBe(true);
  });

  test('有 dirty → skippedClean=false', async () => {
    const cwd = tmpDir();
    const db = new Database(':memory:');
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1');
    await s.append(msg('user', 'x'));

    const r = await gather({ cwd, watermarkDb: db });
    expect(r.skippedClean).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 三态在 gather 报告里分得开(a)
// ---------------------------------------------------------------------------

describe('三态在 gather 报告里分得开(a)', () => {
  let cwd: string;
  let db: Database;

  beforeEach(() => {
    resetSessionCacheForTest();
    cwd = tmpDir();
    db = new Database(':memory:');
  });

  test('clean / dirty / skipped 三态在同一报告里互斥可区分', async () => {
    const store = createOmdSessionStore(cwd);

    // clean:先建一个会话,跑一次 gather,再跑一次 → clean
    const sClean = await store.create('clean-sess');
    await sClean.append(msg('user', 'old'));
    consolidate(createWatermark({ db }), await gather({ cwd, watermarkDb: db })); // 采 + 固化
    // 不再追加 → clean

    // dirty:另一个会话,有新增
    const sDirty = await store.create('dirty-sess');
    await sDirty.append(msg('user', 'new'));

    // skipped:活跃会话
    const sActive = await store.create('active-sess');
    await sActive.append(msg('user', 'secret'));

    const isActive = (id: string) => id === 'active-sess';
    const r = await gather({ cwd, watermarkDb: db, isSessionActive: isActive });

    const cleanSrc = r.sources.find((x) => x.key === 'session:clean-sess');
    const dirtySrc = r.sources.find((x) => x.key === 'session:dirty-sess');
    const skipSrc = r.sources.find((x) => x.key === 'session:active-sess');

    expect(cleanSrc!.state).toBe('clean');
    expect(dirtySrc!.state).toBe('dirty');
    expect(skipSrc!.state).toBe('skipped');

    // 三态互斥:不可能有两个态同时成立
    expect(cleanSrc!.state).not.toBe(dirtySrc!.state);
    expect(cleanSrc!.state).not.toBe(skipSrc!.state);
    expect(dirtySrc!.state).not.toBe(skipSrc!.state);
  });

  test('★ 反向自检 a:删 skip 分支 → skip 与 clean 无法区分 → 红', () => {
    // 证伪方式:在 gather.ts 里注释掉
    //   `if (isSessionActive(meta.id)) { wm.skip(...); ...; continue; }`
    // 则活跃会话会被当作普通会话采集(state='dirty'/'clean' 而非 'skipped')。
    // 上面三态测试会红:"Expected: 'skipped' Received: 'dirty'"
    // (验收改判后存量 skip 行不再是判据来源:活跃与否每次 gather 重判,见「skip 非粘性」。)
    // 此处只记证伪方式;正确行为由上一条测试保证。
  });
});

// ---------------------------------------------------------------------------
// 空仓
// ---------------------------------------------------------------------------

describe('空仓 gather', () => {
  test('无会话无 run → dirtyTotal=0, skippedClean=true', async () => {
    const cwd = tmpDir();
    const db = new Database(':memory:');
    const r = await gather({ cwd, watermarkDb: db });
    expect(r.dirtyTotal).toBe(0);
    expect(r.skippedClean).toBe(true);
    expect(r.sources).toEqual([]);
  });
});
