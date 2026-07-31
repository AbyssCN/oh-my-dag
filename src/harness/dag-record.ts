/**
 * src/harness/dag-record —— omd DAG 运行**留痕层** (轻量持久, 治"无 node 记录/重建")。
 *
 * 把每次 runExecutorDag 的 ExecutorDagResult 落独立 SQLite (omd_dag_runs 表): plan / 拓扑层 /
 * 每 node {kind, status, deps} / token usage。→ 运行记录 + 审计 + **node 图谱可回溯重建**。
 *
 * 跟 OmdMemory (facts, Tier-1) 分开: 这是操作/审计数据, 不是认知 facts。也跟 omd PG DAG 分开:
 * 这只留**记录** (轻量), 不做 CAS/lease/多租户/跨进程 resume (那是 omd 的活)。三同心圈的中间地带。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutorDagResult } from './executor-dag';

export interface DagRunNode {
  id: string;
  kind: string;
  status: string;
  deps: string[];
  /**
   * `executor:'command'` 节点真正跑的那条命令 (其余 kind → undefined)。
   *
   * 记它是为了让**风险分级读数**成立 (R1, 2026-07-31): 分级是 `commandRiskTier(command)` 的
   * 纯函数结果, 所以留痕层只需要存原始命令, 不存级别 —— 级别的定义以后会改, 命令不会。
   * 存派生值等于把一份会漂的东西写进历史记录里, 而历史记录的全部价值是它不漂。
   */
  command?: string;
  /**
   * §8.5 效果指标 `[总写次数, no-op 次数]`(来自 `DagNodeResult.writeCounts`)。
   * **缺席 ≠ [0,0]**: 缺席 = 这条链上没人报(inproc/command 节点, 或早于 2026-07-31 的记录);
   * `[0,0]` = 这个节点跑了但一次文件都没写。
   */
  writeCounts?: [total: number, noop: number];
}
export interface DagRunRecord {
  id: string;
  createdAt: number;
  planName: string;
  nodeCount: number;
  question: string | null;
  /**
   * 引擎 runId (continuity/checkpoint 用的那个)。**一个 runId 可以有多条记录** ——
   * `dag_goal` 一次跑两段图 (`goal-contract` / `goal-execute`), 各落一条。
   * 想算「这次 goal 花了多少」就按它归组, 而不是按主键。null = 记录方没给 (老行/图外调用)。
   */
  runId: string | null;
  /** 拓扑层 (node 图谱模式) — 可据此重建执行结构。 */
  levels: string[][];
  nodes: DagRunNode[];
  usage: { conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number };
}

export interface DagRecorder {
  /** 落一次运行, 返回这条记录的主键 (**不是** runId — 见 DagRunRecord.runId)。 */
  record(result: ExecutorDagResult, meta?: { question?: string; id?: string; now?: number; runId?: string }): string;
  /** 取一次运行 (重建 node 图谱)。 */
  get(id: string): DagRunRecord | null;
  /** 最近 N 次运行 (默认 50)。 */
  list(limit?: number): DagRunRecord[];
  /** 同一个引擎 runId 的全部记录 (时间序; goal 两段各一条)。 */
  listByRun(runId: string): DagRunRecord[];
  close(): void;
}

interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  question: string | null;
  run_id: string | null;
  levels: string;
  nodes: string;
  usage: string;
}

function rowToRecord(row: Row): DagRunRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    planName: row.plan_name,
    nodeCount: row.node_count,
    question: row.question,
    runId: row.run_id ?? null,
    levels: JSON.parse(row.levels),
    nodes: JSON.parse(row.nodes),
    usage: JSON.parse(row.usage),
  };
}

/**
 * 造一个 `ExecutorDagConfig.onComplete` 钩子, 把每张跑完的图记进留痕器。
 *
 * 存在的理由是**别让两个调用面各写一遍**: `dag_run`/`dag_run_plan` 与 `dag_goal` 都要记, 而
 * "记什么/怎么归组"这件事只该有一处定义 —— 尤其 `runId` 那一位: 记漏了, 「一次 goal 花了多少」
 * 就永远算不出来 (goal 一次落两条, 不按 runId 归组就是两笔无主的账)。
 *
 * `prev` 给了就先调它 —— 调用方自己的 onComplete 不许被留痕悄悄吃掉。
 */
export function recordDagRun(
  recorder: DagRecorder,
  meta: { runId: string; question?: string },
  prev?: (result: ExecutorDagResult) => void | Promise<void>,
): (result: ExecutorDagResult) => Promise<void> {
  return async (result) => {
    if (prev) await prev(result);
    recorder.record(result, { runId: meta.runId, ...(meta.question ? { question: meta.question } : {}) });
  };
}

/**
 * 造一个运行留痕器。path 默认 '.omd/dag-runs.db' (持久); ':memory:' 或注入 db = 瞬时/测试。
 */
export function createDagRecorder(opts: { path?: string; db?: Database } = {}): DagRecorder {
  const path = opts.path ?? '.omd/dag-runs.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_dag_runs (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      plan_name  TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      question   TEXT,
      run_id     TEXT,
      levels     TEXT NOT NULL,
      nodes      TEXT NOT NULL,
      usage      TEXT NOT NULL
    )
  `);
  // 就地补列: `CREATE TABLE IF NOT EXISTS` 对**已存在**的老表一个字都不改, 于是 2026-08-02 之前
  // 建过库的机器会拿着无 run_id 的表跑进 INSERT 然后崩。查 pragma 再 ALTER (老行 run_id = NULL,
  // 正是 DagRunRecord.runId 契约里说的那一格)。
  const cols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('run_id')) db.run(`ALTER TABLE omd_dag_runs ADD COLUMN run_id TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS omd_dag_runs_run_id ON omd_dag_runs (run_id)`);
  const ins = db.query(
    `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, levels, nodes, usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.query(`SELECT * FROM omd_dag_runs WHERE id = ?`);
  const recent = db.query(`SELECT * FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`);
  const byRun = db.query(`SELECT * FROM omd_dag_runs WHERE run_id = ? ORDER BY created_at ASC`);

  return {
    record(result, meta = {}) {
      const id = meta.id ?? crypto.randomUUID();
      const createdAt = meta.now ?? Date.now();
      // 命令从 **plan** 取而不是从 result 取: result 里没有它 (`DagNodeResult` 只记执行面),
      // 而 plan 是这次跑的那张图的原文。plan 里没有对应 id (map 动态扇出的子节点) → undefined, 不编。
      const planNodes = result.plan.nodes as Record<string, { command?: string } | undefined>;
      const nodes: DagRunNode[] = Object.values(result.results).map((r) => {
        const cmd = planNodes[r.id]?.command;
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          deps: r.deps,
          ...(typeof cmd === 'string' && cmd.trim() ? { command: cmd } : {}),
          ...(r.writeCounts ? { writeCounts: r.writeCounts } : {}),
        };
      });
      const usage = {
        conductorIn: result.usage.conductor.in,
        conductorOut: result.usage.conductor.out,
        leavesIn: result.usage.leavesIn,
        leavesOut: result.usage.leavesOut,
        leavesCacheHit: result.usage.leavesCacheHit,
      };
      ins.run(
        id,
        createdAt,
        result.plan.name,
        Object.keys(result.plan.nodes).length,
        meta.question ?? null,
        meta.runId ?? null,
        JSON.stringify(result.levels),
        JSON.stringify(nodes),
        JSON.stringify(usage),
      );
      return id;
    },
    get(id) {
      const row = byId.get(id) as Row | null;
      return row ? rowToRecord(row) : null;
    },
    list(limit = 50) {
      return (recent.all(limit) as Row[]).map(rowToRecord);
    },
    listByRun(runId) {
      return (byRun.all(runId) as Row[]).map(rowToRecord);
    },
    close() {
      db.close();
    },
  };
}
