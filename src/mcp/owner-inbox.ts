/**
 * src/mcp/owner-inbox —— **owner 收件箱**: 待决岔口 + owner 指令的持久面 (S3, 2026-07-31)。
 *
 * ## 它是什么
 *
 * 两张表, 一进一出, 都挂在 run 上:
 *
 * ```
 *   引擎 ──铸票──▶ fork (待决岔口)  ──owner 裁决──▶ ruling
 *                      │                              │
 *                      └──── dag_triage 看得见 ───────┘
 *   owner ──────────▶ directive (逐字指令) ──▶ 下一轮 prompt
 * ```
 *
 * ## 为什么在 run 级, 不在子图里 (这条是 OpenAI Agents SDK 的 HITL 教的)
 *
 * 我的第一版设计是把 owner 指令挂在内环的 `<上一轮未通过>` 通道上 —— 那是**子图级**。
 * 而子图**每轮重画**, 内容寻址 id 每轮都变: 一个挂在子节点上的岔口, 下一轮就没有对应物了。
 *
 * OpenAI 的做法是: 嵌套 agent-as-tool 里的审批**仍然冒到外层 run**, 在外层批, 从外层 resume。
 * 同一个道理 —— **岔口的身份必须活在比环更久的那一层**。这里那一层就是 runId。
 *
 * ## 三条纪律
 *
 * 1. **owner 的话逐字保存、逐字注入**。不摘要、不改写、不"帮他润色"。
 *    观测者在这条链上只是**信使**: 它改写了, 失真的地方 owner 自己看不见 —— 这正是本仓撞过
 *    三次的那种静默失效 (报得对但读者拿不到)。
 * 2. **消费一次就记账**。`consumedAtRound` 防同一条指令每轮重放 —— 重放会让 conductor 以为
 *    owner 在反复强调同一件事。
 * 3. **裁决 ≠ 假设**。fork 带着 agent 的 `assumption` 继续跑 (D-R 自裁); 裁决回来若与假设不同,
 *    调用方要据此毒掉建立在该假设上的产出。本模块只**如实记录两者**, 不替调用方做那个判断。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderTrustedOwnerBlock } from '../harness/prompt-fence';

/** 一个待 owner 决策的岔口。 */
export interface OwnerFork {
  id: string;
  runId: string;
  /** 哪个节点撞到的 (运行期 id; 只作审计线索, owner 读的是 question)。 */
  nodeId: string;
  round: number;
  /** 待决问题 —— 写给人看的一句话。 */
  question: string;
  /** agent 的推荐答案 (D-R: 大部分岔口 owner 的答案就是它)。 */
  recommendation: string;
  /** 它据以继续跑的显式假设。裁决与它不同 = 下游要重算。 */
  assumption: string;
  /**
   * 红线: true = 图**真停**在这儿等人 (选错了继续跑就是烧钱且产出全废);
   * false = 带着假设继续跑, 裁决回来再纠。
   */
  blocking: boolean;
  status: 'open' | 'ruled';
  ruling?: string;
  createdAt: string;
  ruledAt?: string;
}

/** owner 给某个 run 的一条指令 (逐字)。 */
export interface OwnerDirective {
  id: string;
  runId: string;
  /** **逐字原文**。任何改写都是 bug。 */
  text: string;
  /** 由哪个 fork 的裁决产生 (人工直接下指令时为空)。 */
  forkId?: string;
  createdAt: string;
  /** 已被哪一轮消费 (undefined = 待消费)。 */
  consumedAtRound?: number;
}

export interface OwnerInbox {
  openFork(f: Omit<OwnerFork, 'status' | 'createdAt'> & { createdAt?: string }): OwnerFork;
  /** 裁决一个岔口 —— 同时**自动生成一条 directive**, 因为裁决的用处就是喂给下一轮。 */
  rule(forkId: string, ruling: string, now?: string): { fork: OwnerFork; directive: OwnerDirective } | null;
  /** owner 直接下指令 (不针对具体岔口)。 */
  addDirective(runId: string, text: string, opts?: { forkId?: string; id?: string; now?: string }): OwnerDirective;
  /** 该 run 的未消费指令 (时间序)。 */
  pendingDirectives(runId: string): OwnerDirective[];
  /** 标记消费 (幂等: 已消费的不再改)。 */
  markConsumed(ids: readonly string[], round: number): void;
  /** 待决岔口; runId 省略 = 全部 run。 */
  openForks(runId?: string): OwnerFork[];
  getFork(id: string): OwnerFork | null;
  close(): void;
}

interface ForkRow {
  id: string; run_id: string; node_id: string; round: number; question: string;
  recommendation: string; assumption: string; blocking: number; status: string;
  ruling: string | null; created_at: string; ruled_at: string | null;
}
interface DirRow {
  id: string; run_id: string; text: string; fork_id: string | null;
  created_at: string; consumed_round: number | null;
}

const toFork = (r: ForkRow): OwnerFork => ({
  id: r.id, runId: r.run_id, nodeId: r.node_id, round: r.round, question: r.question,
  recommendation: r.recommendation, assumption: r.assumption, blocking: r.blocking === 1,
  status: r.status as OwnerFork['status'],
  ...(r.ruling ? { ruling: r.ruling } : {}),
  createdAt: r.created_at,
  ...(r.ruled_at ? { ruledAt: r.ruled_at } : {}),
});
const toDir = (r: DirRow): OwnerDirective => ({
  id: r.id, runId: r.run_id, text: r.text,
  ...(r.fork_id ? { forkId: r.fork_id } : {}),
  createdAt: r.created_at,
  ...(r.consumed_round === null ? {} : { consumedAtRound: r.consumed_round }),
});

/**
 * 造收件箱。与 `runs.db` **同一个库**: 同一个 run 的身份、状态、待决岔口不该分三个文件,
 * 分开早晚对不上 (D-P 把取消把手放进 RunRegistry 是同一条理由)。
 */
export function createOwnerInbox(opts: { path?: string; db?: Database } = {}): OwnerInbox {
  const path = opts.path ?? '.omd/runs.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA busy_timeout = 20000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_owner_forks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, round INTEGER NOT NULL,
      question TEXT NOT NULL, recommendation TEXT NOT NULL, assumption TEXT NOT NULL,
      blocking INTEGER NOT NULL, status TEXT NOT NULL, ruling TEXT,
      created_at TEXT NOT NULL, ruled_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_owner_directives (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, fork_id TEXT,
      created_at TEXT NOT NULL, consumed_round INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS omd_forks_run ON omd_owner_forks (run_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS omd_dirs_run ON omd_owner_directives (run_id, consumed_round)`);

  const insFork = db.query(
    `INSERT INTO omd_owner_forks (id, run_id, node_id, round, question, recommendation, assumption, blocking, status, ruling, created_at, ruled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
  );
  const forkById = db.query(`SELECT * FROM omd_owner_forks WHERE id = ?`);
  const forksOpen = db.query(`SELECT * FROM omd_owner_forks WHERE status = 'open' ORDER BY created_at ASC`);
  const forksOpenRun = db.query(`SELECT * FROM omd_owner_forks WHERE status = 'open' AND run_id = ? ORDER BY created_at ASC`);
  const ruleFork = db.query(`UPDATE omd_owner_forks SET status = 'ruled', ruling = ?, ruled_at = ? WHERE id = ? AND status = 'open'`);
  const insDir = db.query(
    `INSERT INTO omd_owner_directives (id, run_id, text, fork_id, created_at, consumed_round) VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  const dirsPending = db.query(`SELECT * FROM omd_owner_directives WHERE run_id = ? AND consumed_round IS NULL ORDER BY created_at ASC`);
  const markDir = db.query(`UPDATE omd_owner_directives SET consumed_round = ? WHERE id = ? AND consumed_round IS NULL`);

  const nowIso = () => new Date().toISOString();

  return {
    openFork(f) {
      const createdAt = f.createdAt ?? nowIso();
      insFork.run(f.id, f.runId, f.nodeId, f.round, f.question, f.recommendation, f.assumption, f.blocking ? 1 : 0, createdAt);
      return { ...f, blocking: f.blocking, status: 'open', createdAt };
    },
    rule(forkId, ruling, now) {
      const at = now ?? nowIso();
      ruleFork.run(ruling, at, forkId);
      const row = forkById.get(forkId) as ForkRow | null;
      if (!row || row.status !== 'ruled') return null;
      const fork = toFork(row);
      // 裁决**自动变成一条 directive** —— 裁决的全部用处就是喂给下一轮; 让调用方再手动加一次
      // 就是给"裁完了但没生效"留一个静默失效的口子。
      const dirId = `${forkId}::ruling`;
      const text = `关于「${fork.question}」的裁决: ${ruling}`;
      try {
        insDir.run(dirId, fork.runId, text, forkId, at);
      } catch {
        /* 同一个 fork 重复裁决 → 主键冲突, 保留第一条 (裁决是一次性的) */
      }
      const drow = db.query(`SELECT * FROM omd_owner_directives WHERE id = ?`).get(dirId) as DirRow;
      return { fork, directive: toDir(drow) };
    },
    addDirective(runId, text, o = {}) {
      const id = o.id ?? `dir-${runId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const createdAt = o.now ?? nowIso();
      insDir.run(id, runId, text, o.forkId ?? null, createdAt);
      return { id, runId, text, ...(o.forkId ? { forkId: o.forkId } : {}), createdAt };
    },
    pendingDirectives(runId) {
      return (dirsPending.all(runId) as DirRow[]).map(toDir);
    },
    markConsumed(ids, round) {
      for (const id of ids) markDir.run(round, id);
    },
    openForks(runId) {
      return ((runId ? forksOpenRun.all(runId) : forksOpen.all()) as ForkRow[]).map(toFork);
    },
    getFork(id) {
      const r = forkById.get(id) as ForkRow | null;
      return r ? toFork(r) : null;
    },
    close() {
      try { db.close(); } catch { /* 关不上不值得抛 */ }
    },
  };
}

/**
 * 把待消费指令渲染成给下一轮 conductor 的一段。
 *
 * ⚠ **与 `<引擎观察>` 刻意分开的块** (D-S)。两者共用同一条运输管道 (环唯一的信息通道),
 * 但内容的**可错性完全不同**: 观察者说"我算出一个事实", owner 说"照我说的做"。
 * 合成一个数组, 下一轮的 conductor 分不清哪句必须服从; 再往后没人说得清一句话是机器算的
 * 还是人说的。
 *
 * ⚠ **逐字**。这里不许有任何摘要/改写/润色 —— 有测试逐字比对。
 */
export function renderOwnerDirectives(dirs: readonly OwnerDirective[], nonce: string): string {
  if (!dirs.length) return '';
  // A8 (2026-07-31): 块**必须带本轮 token**。此前这个块与抓回来的网页正文在同一条 prompt 里、
  // 用同一套带内标记 —— 探针实证一段外部正文可以闭合 `<upstream>` 再原样伪造出这个块,
  // 连"优先级高于你自己的判断"那句都是从这里抄的。token 是伪造品复制不了的那一位。
  return renderTrustedOwnerBlock(nonce, dirs.map((d) => d.text).join('\n'));
}
