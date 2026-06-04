/**
 * src/valar/dag-record —— valar DAG 运行**留痕层** (轻量持久, 治"无 node 记录/重建")。
 *
 * 把每次 runExecutorDag 的 ExecutorDagResult 落独立 SQLite (valar_dag_runs 表): plan / 拓扑层 /
 * 每 node {kind, status, deps} / token usage。→ 运行记录 + 审计 + **node 图谱可回溯重建**。
 *
 * 跟 ValarMemory (facts, Tier-1) 分开: 这是操作/审计数据, 不是认知 facts。也跟 valinor PG DAG 分开:
 * 这只留**记录** (轻量), 不做 CAS/lease/多租户/跨进程 resume (那是 valinor 的活)。三同心圈的中间地带。
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
}
export interface DagRunRecord {
  id: string;
  createdAt: number;
  planName: string;
  nodeCount: number;
  question: string | null;
  /** 拓扑层 (node 图谱模式) — 可据此重建执行结构。 */
  levels: string[][];
  nodes: DagRunNode[];
  usage: { conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number };
}

export interface DagRecorder {
  /** 落一次运行, 返回 run id。 */
  record(result: ExecutorDagResult, meta?: { question?: string; id?: string; now?: number }): string;
  /** 取一次运行 (重建 node 图谱)。 */
  get(id: string): DagRunRecord | null;
  /** 最近 N 次运行 (默认 50)。 */
  list(limit?: number): DagRunRecord[];
  close(): void;
}

interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  question: string | null;
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
    levels: JSON.parse(row.levels),
    nodes: JSON.parse(row.nodes),
    usage: JSON.parse(row.usage),
  };
}

/**
 * 造一个运行留痕器。path 默认 '.valar/dag-runs.db' (持久); ':memory:' 或注入 db = 瞬时/测试。
 */
export function createDagRecorder(opts: { path?: string; db?: Database } = {}): DagRecorder {
  const path = opts.path ?? '.valar/dag-runs.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS valar_dag_runs (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      plan_name  TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      question   TEXT,
      levels     TEXT NOT NULL,
      nodes      TEXT NOT NULL,
      usage      TEXT NOT NULL
    )
  `);
  const ins = db.query(
    `INSERT INTO valar_dag_runs (id, created_at, plan_name, node_count, question, levels, nodes, usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.query(`SELECT * FROM valar_dag_runs WHERE id = ?`);
  const recent = db.query(`SELECT * FROM valar_dag_runs ORDER BY created_at DESC LIMIT ?`);

  return {
    record(result, meta = {}) {
      const id = meta.id ?? crypto.randomUUID();
      const createdAt = meta.now ?? Date.now();
      const nodes: DagRunNode[] = Object.values(result.results).map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        deps: r.deps,
      }));
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
    close() {
      db.close();
    },
  };
}
