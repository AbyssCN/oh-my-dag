/**
 * src/mcp/run-store —— `RunRegistry` 的**持久面** (S2, 2026-08-03)。
 *
 * ## 它补的洞
 *
 * `RunRegistry` 是这个 server 唯一那份"哪些 run 在飞"的真相, 而它**纯内存**: server 一重启,
 * 哪些 run 存在、跑到哪了、`dag_cancel` 的把手, 全部消失。D-P 当时如实记着这条 (「把手不在
 * (server 重启后内存态丢) 时如实说没停到」), 但那只是把症状说清楚, 没修。
 *
 * 而 MCP server 是 stdio 传输 + **客户端消失即自杀** (server.ts 的退出双保险) —— 也就是说
 * "重启"不是异常路径, 是每次 Claude 会话结束都会发生的事。checkpoint 一直在盘上, 但**没人记得
 * 那个 runId 存在过**, 于是"掉线了之后接着跑"这件事缺的正是这一格。
 *
 * ## 存什么, 不存什么
 *
 * 存**身份与状态**: runId / status / goal / meta / error / 时间戳 / 属主进程。
 * S2 进程化 (SDD 2026-08-10 §2) 起, **result / nodeDetails / progress 也存** —— 此前不存的
 * 理由是"重启后权威来源是 continuity checkpoint", 而进程化后 server 侧 `dag_status`/`dag_result`
 * **只读盘** (子进程写, server 不再写该 run 状态), 内存里根本没有子进程 run 的这三样;
 * 不存 = 子进程跑完的结果与进度在盘上永远读不到。体量问题用 JSON 列 + fail-open 兜:
 * 这是 detached run 唯一出口, 不是可选项。
 *
 * ## 属主进程 (这条是关键, 不是记账)
 *
 * 光把 `running` 存下来是**有害**的: 重启之后你会看到一个永远"在跑"的 run, 而根本没有进程在跑它。
 * 所以每条 running 记录带上属主 pid; 加载时 pid 不存活 = 它没在跑, 是**跑到一半被打断了**。
 *
 * 打断之后该干什么 —— 与 failed / cancelled 完全一样: `resume`。按本仓那条纪律 (D-P 给 `cancelled`
 * 单独立一个词, 理由是"两个不同的下一步不该读同一个词"), 反过来同样成立: **下一步一样就不该
 * 造新词**。故打断的 run 落 `failed`, 原因写清是进程没了而不是活干砸了。
 */
import { Database } from 'bun:sqlite';
import { logger } from '../logger';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 一条持久化的 run 记录 (身份 + 状态 + 终态产物 —— 见模块注)。 */
export interface PersistedRun {
  runId: string;
  status: string;
  goal: string;
  meta: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** 写这条记录时正在跑它的进程。终态记录里没有意义, 只在 pending/running 上判活。 */
  ownerPid: number | null;
  /** 终态结果 (dag_result 消费; 子进程 run 只能从盘上拿)。 */
  result?: unknown;
  /** 节点明细 (dag_node_output 消费; 同上)。 */
  nodeDetails?: Record<string, { status: string; output: string; error?: string }>;
  /** 活体进度 (dag_status 消费; 子进程每次节点事件写穿)。 */
  progress?: {
    planned: Array<{ id: string; kind: string }>;
    started: string[];
    startedAt: Record<string, string>;
    settled: Array<{ id: string; status: 'done' | 'failed' | 'skipped'; kind: string; model?: string }>;
  };
}

export interface RunStore {
  /** 写入/覆盖一条 (upsert; 每次状态变动调一次)。失败 → 静默 (fail-open, 同 checkpoint 纪律)。 */
  put(rec: PersistedRun): void;
  /** 全部记录 (启动时 hydrate 用)。 */
  all(): PersistedRun[];
  /** 单条 (server 侧 dag_status/dag_cancel 只读盘接缝 —— 不整表 load)。 */
  get(runId: string): PersistedRun | null;
  close(): void;
}

interface Row {
  run_id: string;
  status: string;
  goal: string;
  meta: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  owner_pid: number | null;
  result: string | null;
  node_details: string | null;
  progress: string | null;
}

/** JSON 列宽容解析: 坏 JSON/缺列 → undefined (老库行/损坏行不阻断读)。 */
const parseJson = <T>(s: string | null): T | undefined => {
  if (s === null) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

const toRec = (r: Row): PersistedRun => ({
  runId: r.run_id,
  status: r.status,
  goal: r.goal,
  meta: JSON.parse(r.meta) as Record<string, unknown>,
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ownerPid: r.owner_pid,
  ...(parseJson<unknown>(r.result) !== undefined ? { result: parseJson(r.result) } : {}),
  ...(parseJson(r.node_details) !== undefined ? { nodeDetails: parseJson(r.node_details) } : {}),
  ...(parseJson(r.progress) !== undefined ? { progress: parseJson(r.progress) } : {}),
});


/**
 * 造一个 run 持久器。path 默认 `.omd/runs.db`; `:memory:` 或注入 db = 瞬时/测试。
 *
 * 写全部 fail-open: 持久化挂了不该把一次真跑带走 —— 与 continuity checkpoint 写失败只 WARN 同源。
 */
export function createRunStore(opts: { path?: string; db?: Database } = {}): RunStore {
  const path = opts.path ?? '.omd/runs.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_runs (
      run_id       TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      goal         TEXT NOT NULL,
      meta         TEXT NOT NULL,
      error        TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      owner_pid    INTEGER,
      result       TEXT,
      node_details TEXT,
      progress     TEXT
    )
  `);
  // S2 进程化加的 JSON 列: 老库 (2026-08-10 前建) 没有这三列 —— 逐列 ALTER 补上
  // (列已存在 → SQLite 抛 duplicate column, 跳过即可; 这是幂等迁移不是新逻辑)。
  const cols = new Set((db.query('PRAGMA table_info(omd_runs)').all() as { name: string }[]).map((c) => c.name));
  for (const col of ['result', 'node_details', 'progress']) {
    if (!cols.has(col)) db.run(`ALTER TABLE omd_runs ADD COLUMN ${col} TEXT`);
  }
  const up = db.query(
    `INSERT INTO omd_runs (run_id, status, goal, meta, error, created_at, updated_at, owner_pid, result, node_details, progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       status = excluded.status, goal = excluded.goal, meta = excluded.meta, error = excluded.error,
       updated_at = excluded.updated_at, owner_pid = excluded.owner_pid,
       result = excluded.result, node_details = excluded.node_details, progress = excluded.progress`,
  );
  const list = db.query(`SELECT * FROM omd_runs ORDER BY created_at ASC`);
  const one = db.query(`SELECT * FROM omd_runs WHERE run_id = ?`);

  const toPersisted = (r: Row): PersistedRun => toRec(r);

  const put = (rec: PersistedRun): void => {
    up.run(
      rec.runId,
      rec.status,
      rec.goal,
      JSON.stringify(rec.meta),
      rec.error ?? null,
      rec.createdAt,
      rec.updatedAt,
      rec.ownerPid,
      rec.result === undefined ? null : JSON.stringify(rec.result),
      rec.nodeDetails === undefined ? null : JSON.stringify(rec.nodeDetails),
      rec.progress === undefined ? null : JSON.stringify(rec.progress),
    );
  };

  return {
    put(rec) {
      try {
        put(rec);
      } catch (e) {
        // fail-open: 持久化不该把一次真跑带走。
        //
        // ⚠ **但静默的 fail-open 是另一回事** (2026-08-02 实测教训): 一次 30 分钟的 live
        // `dag_goal` 在这里丢了终态 —— 内存已是 `done` (worker 据此报"终态 done"并退出),
        // 盘上永远停在 `running`, **两层 catch 一声不吭**, 于是"跑完了"与"没人知道跑完了"
        // 无法区分。对 detached run 这不是"重启后少认得一个 runId", 盘上那条**就是**唯一的出口。
        // 吞掉异常仍然对 (不炸真跑), 吞掉**证据**不对。
        logger.warn(
          { runId: rec.runId, status: rec.status, err: (e as Error).message },
          '[omd/run-store] run 状态落盘失败 —— 内存与盘上从此不一致 (fail-open 继续跑)',
        );
      }
    },
    all() {
      try {
        return (list.all() as Row[]).map(toPersisted);
      } catch {
        return [];
      }
    },
    get(runId) {
      try {
        const row = one.get(runId) as Row | null;
        return row ? toPersisted(row) : null;
      } catch {
        return null;
      }
    },
    close() {
      try {
        db.close();
      } catch {
        /* 关不上不值得抛 */
      }
    },
  };
}

/** pid 是否存活。默认 `process.kill(pid, 0)` (与 pathfinder dispatch 的在途去重同款 idiom)。 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
