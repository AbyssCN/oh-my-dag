/**
 * src/mcp/tools/dag-exec.test.ts — S2 执行进程化 (SDD 2026-08-10 §2) 的母进程侧闸。
 *
 * 钉的是**母进程 handler 的新契约** (dag_run / dag_research 从「进程内 fire-and-forget」
 * 变成「校验 → spawn detached 子进程 → 立即返回 runId」) + 只读盘接缝 (dag_status/dag_runs
 * 读子进程写的盘、孤儿 stalled 判据、dag_cancel 的标记+SIGTERM)。
 *
 * 子进程侧 (scripts/dag-exec.ts 的引导序/接手/轮询/写穿核验) 由 G1/G2 探针在真机验
 * (scripts/probes/), 单测不模拟真进程。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, utimesSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRegistry } from '../run-registry';
import { createRunStore } from '../run-store';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import { createDagTools, type DagEngine } from './dag-tools';
import { createDagResearchTool, type ResearchFanout } from './research';
import { createRunsTools } from './runs';
import type { OmdMcpTool } from '../server';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types';

const stubResult = (): ExecutorDagResult =>
  ({
    plan: { name: 'p', nodes: { n1: { goal: 'g' } } },
    sessionId: 's',
    levels: [['n1']],
    results: { n1: { id: 'n1', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 1, out: 1 } } },
    reusedNodes: [],
    usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

/** 永不完成的引擎 —— spawn 契约测试要证明 handler **不碰引擎**。 */
const neverEngine: DagEngine = {
  runExecutorDag: async () => {
    throw new Error('spawn 路径不该调引擎 (引擎在子进程里)');
  },
  runExecutorDagWithPlan: async () => {
    throw new Error('spawn 路径不该调引擎 (引擎在子进程里)');
  },
};

type SpawnRecord = { spec: unknown; called: number };

function fakeSpawn(rec: SpawnRecord) {
  return (spec: unknown) => {
    rec.spec = spec;
    rec.called += 1;
    return { ok: true as const, pid: 4242, logPath: '/tmp/fake-exec.log' };
  };
}

/** 临时 continuity 根 —— 起跑会往 `<repoRoot>/.omd/continuity/<runId>/` 写点火档案。 */
const tmpContinuity = () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-dexec-cont-'));
  return { manager: new CheckpointManager(root), repoRoot: root };
};

const call = (tool: OmdMcpTool, args: Record<string, unknown>) =>
  (tool.handler as (a: Record<string, unknown>, e?: unknown) => unknown)(args, {}) as Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;

describe('dag_run 母进程 spawn 契约 (S2)', () => {
  test('校验通过 → spawn 一次 (tool/runId/cwd/args 正确), 返回 runId+running, 引擎不被碰', async () => {
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      // continuity 给个临时根: 起跑要在 `<cwd>/.omd/continuity/<runId>/` 留点火档案
      // (run-ignition-wiring.test.ts 钉的那根线), 不给就落进本仓真的 .omd/ 里。
      continuity: tmpContinuity(),
      spawnDagExec: fakeSpawn(rec),
    });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, {
      task: '把活干了',
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxFanout: 3,
    });
    expect(rec.called).toBe(1);
    const spec = rec.spec as { tool: string; runId: string; cwd: string; args: Record<string, unknown> };
    expect(spec.tool).toBe('dag_run');
    expect(typeof spec.runId).toBe('string');
    expect(spec.args).toEqual({ task: '把活干了', conductorModel: 'c:m', leafModel: 'l:m', maxFanout: 3 });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toMatch(/^runId: .+\nstatus: running/);
  });

  test('座位自检失败 → 当场 isError, **不 spawn** (省一个注定失败的进程)', async () => {
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: new RunRegistry(),
      defaultConfig: () => {
        throw new Error('座位未配 (INV-MODEL-5)');
      },
      spawnDagExec: fakeSpawn(rec),
    });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: 'x' });
    expect(out.isError).toBe(true);
    expect(rec.called).toBe(0);
  });

  test('leafModel 缺 → 当场 isError, 不 spawn', async () => {
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m' }, // 无 leafModel
      spawnDagExec: fakeSpawn(rec),
    });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: 'x' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('leafModel required');
    expect(rec.called).toBe(0);
  });

  test('resume 冲突要含**盘上** (子进程 run 不在本进程内存) — running 拒绝, 不 spawn', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'omd-dexec-')), 'runs.db');
    // 注册表 A 造一条 running (属主 = 测试进程, 活着), 关掉 —— 模拟"另一个 dag-exec 在跑"。
    const a = new RunRegistry(undefined, { store: createRunStore({ path: dbPath }) });
    a.register('r-running', { goal: 'x' });
    a.start('r-running');
    a.close();
    // 注册表 B = 母进程视角: hydrate 后内存有 running (属主活着 → 非孤儿)。
    const b = new RunRegistry(undefined, { store: createRunStore({ path: dbPath }) });
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: b,
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      spawnDagExec: fakeSpawn(rec),
    });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: 'x', resume: 'r-running' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('当前 running');
    expect(rec.called).toBe(0);
    b.close();
  });

  test('母进程**不登记** run (属主必须是子进程) — spawn 后盘上无此 run', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'omd-dexec-')), 'runs.db');
    const reg = new RunRegistry(undefined, { store: createRunStore({ path: dbPath }) });
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: reg,
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      continuity: tmpContinuity(), // 同上: 点火档案落临时根, 不脏本仓
      spawnDagExec: fakeSpawn(rec),
    });
    await call(tools.find((t) => t.name === 'dag_run')!, { task: 'x' });
    const spec = rec.spec as { runId: string };
    // 反向自检: 若母进程抢先 register, 这里会读到 running —— 子进程 hydrate 会把它判成
    // "属主已死 → failed", 把正在跑的 run 冤枉成打断。
    expect(reg.diskRecord(spec.runId)).toBeNull();
    reg.close();
  });
});

describe('dag_research 母进程 spawn 契约 (S2)', () => {
  test('question 校验过 → spawn tool=dag_research, 返回 runId+running', async () => {
    const rec: SpawnRecord = { spec: null, called: 0 };
    const fanout: ResearchFanout = async () => {
      throw new Error('spawn 路径不该调 fanout (在子进程里)');
    };
    const tool = createDagResearchTool(fanout, {
      runRegistry: new RunRegistry(),
      spawnDagExec: fakeSpawn(rec),
    });
    const out = await call(tool, { question: 'q', council: true, rounds: 2 });
    const spec = rec.spec as { tool: string; runId: string; args: Record<string, unknown> };
    expect(spec.tool).toBe('dag_research');
    expect(spec.args).toEqual({ question: 'q', council: true, rounds: 2 });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toMatch(/^runId: .+\nstatus: running/);
  });

  test('缺 question → InvalidParams 抛错, 不 spawn', async () => {
    const rec: SpawnRecord = { spec: null, called: 0 };
    const tool = createDagResearchTool(async () => ({ runId: 'r', reportPath: '/tmp/r.md', summary: 's' }), {
      runRegistry: new RunRegistry(),
      spawnDagExec: fakeSpawn(rec),
    });
    await expect(call(tool, {})).rejects.toThrow('question');
    expect(rec.called).toBe(0);
  });
});

describe('孤儿检测 (S2, dag_status 只读盘)', () => {
  function statusTool(reg: RunRegistry, opts: { isAlive?: (p: number) => boolean } = {}) {
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: reg,
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      isAlive: opts.isAlive,
    });
    return tools.find((t) => t.name === 'dag_status')!;
  }

  test('running + 属主 pid 死 + continuity mtime 龄 >5min → 输出 stalled 行 + 判定依据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-stall-'));
    const reg = new RunRegistry(undefined, { store: createRunStore({ path: join(root, 'runs.db') }) });
    reg.register('r-orphan', { goal: 'g' });
    reg.start('r-orphan'); // ownerPid = 本测试进程 (活着) — 用 isAlive 接缝模拟它死了
    // continuity 目录: 10 分钟前写过 checkpoint (mtime 老化)。
    const cont = join(root, '.omd', 'continuity', 'r-orphan');
    mkdirSync(cont, { recursive: true });
    writeFileSync(join(cont, '_dag.json'), '{}');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(cont, old, old);

    const out = await call(statusTool(reg, { isAlive: () => false }), { runId: 'r-orphan' });
    // stalled 是**追加块** (content[1]), 不在 summary 的 content[0] —— 拼起来断言。
    const text = out.content.map((c) => c.text).join('\n');
    // 反向自检: 把 isAlive 换成 () => true → 本行消失 (测试红); 把 mtime 拨回现在 → 本行消失。
    expect(text).toContain('stalled:');
    expect(text).toContain('pid');
    expect(text).toContain('(>5min)');
    reg.close();
  });

  test('属主 pid 活着 → 不标 stalled (活着的子进程 run 不能被冤枉)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-live-'));
    const reg = new RunRegistry(undefined, { store: createRunStore({ path: join(root, 'runs.db') }) });
    reg.register('r-live', { goal: 'g' });
    reg.start('r-live');
    const cont = join(root, '.omd', 'continuity', 'r-live');
    mkdirSync(cont, { recursive: true });
    const out = await call(statusTool(reg, { isAlive: () => true }), { runId: 'r-live' });
    // 必须拼起来断言: 只看 content[0] 的话, stalled 真出现时 content[0] 也不含它 → 假绿。
    const text = out.content.map((c) => c.text).join('\n');
    expect(text).not.toContain('stalled:');
    reg.close();
  });
});

describe('dag_cancel 子进程 run (S2: 标记 + SIGTERM)', () => {
  test('内存无把手 + 盘上 running 属主活着 → 写 cancel 标记 + SIGTERM, 回"已请求"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-cancel-'));
    const reg = new RunRegistry(undefined, { store: createRunStore({ path: join(root, 'runs.db') }) });
    reg.register('r-child', { goal: 'g' });
    reg.start('r-child');
    const killed: number[] = [];
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: reg,
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      continuity: { manager: undefined as never, repoRoot: root },
      isAlive: () => true,
      killPid: (pid) => killed.push(pid),
    });
    const out = await call(tools.find((t) => t.name === 'dag_cancel')!, { runId: 'r-child', reason: '够了' });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain('SIGTERM');
    expect(killed).toEqual([process.pid]); // 属主 = 写记录的进程 (本测试)
    expect(readFileSync(join(root, '.omd', 'continuity', 'r-child', 'cancel'), 'utf-8')).toBe('够了');
    reg.close();
  });

  test('属主 pid 已死 → 如实说没停到 (孤儿, isError)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-cancel-'));
    const reg = new RunRegistry(undefined, { store: createRunStore({ path: join(root, 'runs.db') }) });
    reg.register('r-dead', { goal: 'g' });
    reg.start('r-dead');
    const tools = createDagTools({
      engine: neverEngine,
      runRegistry: reg,
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      isAlive: () => false,
    });
    const out = await call(tools.find((t) => t.name === 'dag_cancel')!, { runId: 'r-dead' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('没有活进程可停');
    reg.close();
  });
});

describe('dag_runs 读盘合并 (S2)', () => {
  test('盘上子进程 run 并入列表 (状态原样), 孤儿标 stalled (子进程 mid-session 死)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-runs-'));
    // 母进程先 boot (hydrate 时盘上还没有这个 run) —— 子进程 run 是**之后**才登记到盘上的。
    const reg2 = new RunRegistry(undefined, { store: createRunStore({ path: join(root, 'runs.db') }) });
    // 子进程登记 running 然后死: 直写盘, 属主 pid = 不存在的 999999 (mid-session 死亡的形状)。
    const store = createRunStore({ path: join(root, 'runs.db') });
    store.put({
      runId: 'r-child',
      status: 'running',
      goal: '子进程跑的',
      meta: { tool: 'dag_run' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerPid: 999999,
    });
    store.close();
    // continuity 目录 10 分钟没写过 checkpoint (mtime 老化)。
    const cont = join(root, '.omd', 'continuity', 'r-child');
    mkdirSync(cont, { recursive: true });
    writeFileSync(join(cont, '_dag.json'), '{}');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(cont, old, old);
    const runs = createRunsTools({ runRegistry: reg2, cwd: root });
    const out = await call(runs[0]!, {});
    const text = out.content[0]!.text;
    expect(text).toContain('r-child');
    expect(text).toContain('stalled');
    // 反向自检: 把 mtime 拨回现在 → 不标 stalled (测试红)。注意启动期 hydrate 读它 → failed
    // 是**另一条同样诚实**的路 (boot 后打断), 不是本判据的 bug。
    reg2.close();
  });
});

describe('run-store S2 持久面 (result/nodeDetails/progress 写穿)', () => {
  test('round-trip: 新连接读到三样 (子进程 run 的结果是 parent 唯一出口)', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'omd-store-')), 'runs.db');
    const s1 = createRunStore({ path: dbPath });
    s1.put({
      runId: 'r-1',
      status: 'done',
      goal: 'g',
      meta: { tool: 'dag_run' },
      createdAt: 't0',
      updatedAt: 't1',
      ownerPid: null,
      result: { done: 2, outputs: { n1: 'ok' } },
      nodeDetails: { n1: { status: 'done', output: 'ok' } },
      progress: { planned: [{ id: 'n1', kind: 'leaf' }], started: [], startedAt: {}, settled: [{ id: 'n1', status: 'done', kind: 'leaf', model: 'm' }] },
    });
    s1.close();
    const s2 = createRunStore({ path: dbPath });
    const rec = s2.get('r-1')!;
    expect(rec.result).toEqual({ done: 2, outputs: { n1: 'ok' } });
    expect(rec.nodeDetails).toEqual({ n1: { status: 'done', output: 'ok' } });
    expect(rec.progress?.settled).toEqual([{ id: 'n1', status: 'done', kind: 'leaf', model: 'm' }]);
    s2.close();
  });

  test('老库迁移: 5 列旧 schema 打开即 ALTER 补列, put/get 不炸', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'omd-mig-')), 'runs.db');
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(dbPath);
    db.run(`CREATE TABLE omd_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, goal TEXT NOT NULL,
      meta TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_pid INTEGER)`);
    db.run(`INSERT INTO omd_runs VALUES ('old-1','failed','g','{}',NULL,'t0','t1',NULL)`);
    db.close();
    const s = createRunStore({ path: dbPath });
    expect(s.get('old-1')!.status).toBe('failed');
    s.put({ runId: 'new-1', status: 'running', goal: 'g', meta: {}, createdAt: 't', updatedAt: 't', ownerPid: 1 });
    expect(s.get('new-1')!.status).toBe('running');
    s.close();
  });
});
