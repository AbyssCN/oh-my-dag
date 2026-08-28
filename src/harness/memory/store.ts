/**
 * src/harness/memory/store — omd Tier-1 self-memory over bun:sqlite (SDD §7).
 *
 * One SQLite file = one agent's own memory. Three concerns in one substrate:
 *   - facts        → validated L3 facts (write-gated by the shared SAFEGUARD
 *                    functions from src/memory/safeguards — one guard, two tiers)
 *   - facts_fts    → FTS5 (real BM25) lexical leg of hybrid retrieval
 *   - omd_edges  → temporal KG (via {@link SqliteEdgeStore}, app-enforced
 *                    no-overlap), exposed as `.edges`
 *
 * Retrieval = vector(brute-force cosine) ⊕ lexical(FTS5 BM25) fused by RRF
 * (k=60), the algorithm ported from .claude/memory/lib/hybrid.ts. No ANN index:
 * a Tier-1 store is <10k facts ("尺度不够" — SDD §7), so exact brute force is
 * both correct and fast.
 *
 * The write pipeline is REJECT-by-default and supersedes same-identity facts via
 * the confidence self-evolve lock — see {@link WriteFactResult}.
 */
import { Database } from 'bun:sqlite';
import {
  validateFactWrite,
} from '../../memory/safeguards/validator';
import { checkEvolve, isExpired, type CheckEvolveOpts } from '../../memory/safeguards/evolution-lock';

/** writeFact 选项 = 自我进化锁选项 + 密钥脱敏开关 (仅自动学习路径置 true)。 */
export type WriteFactOpts = CheckEvolveOpts & { scanSecrets?: boolean };
import { detectConflict } from '../../memory/safeguards/conflict-detector';
import {
  DEFAULT_SAFEGUARD,
  type ValidatedFact,
  type AssembledSafeguard,
} from '../../memory/safeguards/namespaces';
import { SqliteEdgeStore } from './edge-store';
import { defaultEmbed } from './embed';
import type { EmbedFn, MemoryHit, StoredFact, WriteFactResult } from './types';

// RRF + retrieval-pool constants (ported from hybrid.ts).
const RRF_K = 60;
/**
 * 合流准入阈值:两条检索腿都要把它排进前 N 才收。实测 3–15 整段完美分离, 取中段。
 * 见 {@link OmdMemory.retrieve} 的方法头注(含分离度表与"真语义 embedder 时要放宽"的前提)。
 */
export const AGREEMENT_TOP_N = 10;
const VEC_POOL = 50;
const BM_POOL = 50;

export interface OmdMemoryOptions {
  /** SQLite file path. Default ':memory:' (ephemeral, per-process). */
  path?: string;
  /** Pre-opened Database (overrides `path`) — e.g. shared across components. */
  db?: Database;
  /** Vector-leg embedder. Default = zero-dep deterministic {@link defaultEmbed}. */
  embed?: EmbedFn;
  /**
   * 注入的 namespace 闸料 (P1#1 phase-2)。决定哪些 namespace 可写 + ban + identity。默认
   * DEFAULT_SAFEGUARD (通用+a sibling project, back-compat)。domain-free 前端 (TUI omd 自我记忆) 注入
   * UNIVERSAL_SAFEGUARD → 只收 user 与 omd namespace。
   */
  safeguard?: AssembledSafeguard;
}

interface FactRow {
  id: string;
  namespace: string;
  identity_key: string;
  text: string;
  payload: string;
  embedding: Uint8Array;
  created_at: number;
  deleted_at: number | null;
}

/** Cosine similarity; dim mismatch ⇒ 0 (provider drift, scoring meaningless). */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

function vecToBlob(v: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(v).buffer);
}
function blobToVec(b: Uint8Array): number[] {
  // Copy into an aligned buffer — the row blob may be a view at an odd offset.
  const f32 = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return Array.from(f32);
}

/** Lexical projection of a fact's value fields (excludes provenance/identity). */
const NON_TEXT_FIELDS = new Set([
  'namespace',
  'source_event_id',
  'source_doc_id',
  'confidence',
  // 代码锚是 provenance 不是 value (2026-08-28)。放进来会把 16 位 hex 指纹塞进 FTS 与 embedding,
  // 那是纯噪声; 而且 text 是召回预算与截断的计量对象, 让它被证据撑长等于挤掉真正的内容。
  'evidence',
]);
function factToText(fact: ValidatedFact): string {
  const rec = fact as unknown as Record<string, unknown>;
  const parts: string[] = [fact.namespace.replace(/[._]/g, ' ')];
  for (const [k, v] of Object.entries(rec)) {
    if (NON_TEXT_FIELDS.has(k)) continue;
    if (v == null) continue;
    if (v instanceof Date) parts.push(`${k} ${v.toISOString().slice(0, 10)}`);
    else if (typeof v === 'object') parts.push(`${k} ${JSON.stringify(v)}`);
    else parts.push(`${k} ${String(v)}`);
  }
  return parts.join(' ');
}

/** Build a safe FTS5 MATCH expr (OR of quoted tokens) — never raw user text. */
function ftsMatchExpr(query: string): string | null {
  const toks = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return toks.length === 0 ? null : toks.join(' OR ');
}

export class OmdMemory {
  private readonly db: Database;
  private readonly embed: EmbedFn;
  /** 注入的 namespace 闸料 (allowlist/ban/identity)。默认 DEFAULT_SAFEGUARD。 */
  private readonly safeguard: AssembledSafeguard;
  /** Temporal-KG sub-store over the same SQLite file (EDGE-INV-1 enforced). */
  readonly edges: SqliteEdgeStore;

  constructor(opts: OmdMemoryOptions = {}) {
    this.db = opts.db ?? new Database(opts.path ?? ':memory:');
    this.embed = opts.embed ?? defaultEmbed;
    this.safeguard = opts.safeguard ?? DEFAULT_SAFEGUARD;
    this.db.run('PRAGMA busy_timeout = 20000');
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS facts (
        id           TEXT PRIMARY KEY,
        namespace    TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        text         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        embedding    BLOB NOT NULL,
        created_at   INTEGER NOT NULL,
        deleted_at   INTEGER
      )
    `);
    // ── 墓碑的两列证据 (2026-08-26) ──────────────────────────────────────────
    // 此前 `tombstoneByIdentity(ns, key, _reason)` 的 reason **带下划线前缀丢掉了** ——
    // 盘上只剩一个 `deleted_at`。于是「被 evolve 顶掉」「被 replace 顶掉」「被 shrink 剪掉」
    // 「被人 retract」四种死法长得一模一样, 而且**没有指向继任者的链**, 一次自我进化写坏了
    // 也回不去。这正是本仓 §静默坑 1 (NULL ≠ 0 ≠ 不适用) 的形状: 分辨靠另一列, 不靠猜。
    //
    // 老库要能原地升: `ALTER TABLE ADD COLUMN` 只在缺列时跑 (SQLite 没有 IF NOT EXISTS)。
    // 升级前写的行两列都是 NULL —— 那是**第三种值**「本次升级之前就死了, 死因无记录」,
    // 与「死于 evolve」和「还活着」都不同, 读面不许把它折成前两者之一。
    const cols = new Set(
      (this.db.query(`PRAGMA table_info(facts)`).all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has('deleted_reason')) this.db.run(`ALTER TABLE facts ADD COLUMN deleted_reason TEXT`);
    if (!cols.has('superseded_by')) this.db.run(`ALTER TABLE facts ADD COLUMN superseded_by TEXT`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS facts_ns_identity ON facts (namespace, identity_key)`,
    );
    // Standalone FTS5 (fact_id UNINDEXED so it round-trips without being tokenised).
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(fact_id UNINDEXED, text)`,
    );
    this.edges = new SqliteEdgeStore(this.db);
  }

  /** Parse a stored row back into a ValidatedFact (restores Date fields). */
  private rowToFact(row: FactRow): ValidatedFact {
    // 装配 union schema 是 z.ZodTypeAny → parse 返 unknown; 运行时已 reparse, cast 回 ValidatedFact。
    return this.safeguard.schema.parse(JSON.parse(row.payload)) as ValidatedFact;
  }

  /** The single live fact for a (namespace, IDENTITY), or null. */
  /** 该 fact 的 per-namespace IDENTITY key (grounding 归因 / 升级追踪外部消费用)。 */
  identityKeyOf(fact: ValidatedFact): string {
    return this.safeguard.identityKeyOf(fact);
  }

  /** 同 (namespace, IDENTITY) 当前 live fact (无则 null)。confidence-adjuster 熔断器读它。 */
  liveByIdentity(namespace: string, identityKey: string): ValidatedFact | null {
    const row = this.db
      .query(
        `SELECT * FROM facts WHERE namespace = ? AND identity_key = ? AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get(namespace, identityKey) as FactRow | null;
    return row ? this.rowToFact(row) : null;
  }

  /**
   * Write a fact through the full SAFEGUARD pipeline. REJECT-by-default; same
   * (namespace, entityKey) facts are superseded per the self-evolve lock; an
   * immutable human_verified fact stands (with a raise payload on divergence).
   */
  async writeFact(input: unknown, opts: WriteFactOpts = {}): Promise<WriteFactResult> {
    // 1. Floor — malformed / banned / unlisted-namespace / no-anchor / confidence.
    //    scanSecrets 仅自动学习路径置 true (显式 remember 默认绕过密钥闸 = 用户主权)。
    const v = validateFactWrite(input, this.safeguard, { scanSecrets: opts.scanSecrets });
    if (!v.ok) return { status: 'rejected', reason: v.reason, banned: v.banned };
    const fact = v.validated;
    // Supersession identity = per-namespace IDENTITY fields (entity + discriminators),
    // NOT entityKeyOf — see NAMESPACE_IDENTITY_FIELDS. Using entityKeyOf here would
    // silently tombstone sibling facts (e.g. a client's lark pref clobbering wecom,
    // or food-rate VAT clobbering general-rate VAT). [review P1, commit 583af4f]
    const identityKey = this.safeguard.identityKeyOf(fact);

    // 2. Self-evolve lock over the same (namespace, IDENTITY) live fact.
    const existing = this.liveByIdentity(fact.namespace, identityKey);
    const evolve = checkEvolve(existing, fact, opts);

    if (evolve.action === 'reject') {
      // Immutable human_verified fact stands. If the incoming value diverges,
      // surface a raise so the owner can decide to retract — never silent overwrite.
      const conflict = existing ? detectConflict(fact, [existing]) : { conflict: false as const };
      return {
        status: 'rejected',
        reason: evolve.reason,
        ...(conflict.conflict ? { raiseToInbox: conflict.raiseToInbox } : {}),
      };
    }

    // 3. Supersede the predecessor (evolve/replace) then store the incoming.
    //    id **先生成再顶替**: 墓碑要写 `superseded_by = 继任者 id`, 而顺序反过来的话那一列
    //    只能事后补写 —— 补写就意味着中途崩溃会留下一个没有继任者的墓碑, 那正是回滚要用的链。
    const id = crypto.randomUUID();
    if ((evolve.action === 'evolve' || evolve.action === 'replace') && existing) {
      this.tombstoneByIdentity(fact.namespace, identityKey, `superseded:${evolve.action}`, id);
    }
    await this.insertFact(fact, identityKey, id);
    return { status: 'written', id, action: evolve.action };
  }

  private async insertFact(fact: ValidatedFact, identityKey: string, presetId?: string): Promise<string> {
    const id = presetId ?? crypto.randomUUID();
    const text = factToText(fact);
    const embedding = vecToBlob(await this.embed(text));
    const createdAt = Date.now();
    const payload = JSON.stringify(fact);
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO facts (id, namespace, identity_key, text, payload, embedding, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [id, fact.namespace, identityKey, text, payload, embedding, createdAt],
      );
      this.db.run(`INSERT INTO facts_fts (fact_id, text) VALUES (?, ?)`, [id, text]);
    });
    tx();
    return id;
  }

  /**
   * Tombstone all live facts of a (namespace, IDENTITY) — SHRINK-INV-3 soft.
   *
   * `reason` / `supersededBy` **落盘** (2026-08-26)。此前 reason 是个 `_` 前缀的形参、
   * 一个字都没写出去 —— 见构造函数里那两列的注。
   */
  private tombstoneByIdentity(
    namespace: string,
    identityKey: string,
    reason: string,
    supersededBy?: string,
  ): void {
    const rows = this.db
      .query(
        `SELECT id FROM facts WHERE namespace = ? AND identity_key = ? AND deleted_at IS NULL`,
      )
      .all(namespace, identityKey) as { id: string }[];
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(`UPDATE facts SET deleted_at = ?, deleted_reason = ?, superseded_by = ? WHERE id = ?`, [
          now,
          reason,
          supersededBy ?? null,
          r.id,
        ]);
        this.db.run(`DELETE FROM facts_fts WHERE fact_id = ?`, [r.id]);
      }
    });
    tx();
  }

  /**
   * 一条已死事实的墓志铭 (2026-08-26)。**三种返回值互不折叠**:
   *   - `null`                                → 这个 id 不存在, 或它还活着
   *   - `{reason: null, supersededBy: null}`  → 死于本次升级之前, 死因无记录 (老行)
   *   - `{reason: '…', supersededBy?}`        → 有据可查的死
   *
   * 第二种存在的唯一理由是不许把"没记"伪装成"没原因"。
   */
  epitaph(id: string): { deletedAt: number; reason: string | null; supersededBy: string | null } | null {
    const row = this.db
      .query(`SELECT deleted_at, deleted_reason, superseded_by FROM facts WHERE id = ?`)
      .get(id) as { deleted_at: number | null; deleted_reason: string | null; superseded_by: string | null } | null;
    if (!row || row.deleted_at === null) return null;
    return { deletedAt: row.deleted_at, reason: row.deleted_reason, supersededBy: row.superseded_by };
  }

  /**
   * **按 id 回滚一次自我进化** —— 把墓碑翻回 live 并把它的继任者顶掉 (2026-08-26)。
   *
   * 为什么需要它: 一条基于偶然成功写下的事实, 和一条真教训, 在库里长得一模一样, 而且都会影响
   * 后面每一轮。回滚机制的存在**不是**说进化不该发生, 是承认它会写错 —— 写错了要有路走回去。
   *
   * 返回 false 的两种情形 (调用方要分开处置, 别都当"没这条"):
   *   - id 不存在 / 它还活着            → 无事可做
   *   - 它的继任者已经又被别人顶掉了     → 链断了, 这时强行复活会同时出现两条 live 同 identity,
   *                                       破坏 supersession 不变量。**拒绝**, 交给人看。
   */
  revertSupersession(id: string): boolean {
    // INV-8: check-then-write **整段**进 `tx.immediate()` —— 读(找继任者/判链断没断)与写(翻墓碑)
    // 之间若插进另一个进程的一次 supersede, 我们就会拿着过期的链去复活, 结果是同 identity 两条 live。
    // 读在事务外的版本不是"慢一点", 是不变量本身失效。
    let done = false;
    const tx = this.db.transaction(() => {
      const row = this.db
        .query(`SELECT namespace, identity_key, superseded_by, text FROM facts WHERE id = ? AND deleted_at IS NOT NULL`)
        .get(id) as { namespace: string; identity_key: string; superseded_by: string | null; text: string } | null;
      if (!row || !row.superseded_by) return;
      const heir = this.db
        .query(`SELECT deleted_at FROM facts WHERE id = ?`)
        .get(row.superseded_by) as { deleted_at: number | null } | null;
      if (!heir || heir.deleted_at !== null) return; // 链断了 —— 见上注
      this.db.run(`UPDATE facts SET deleted_at = ?, deleted_reason = ?, superseded_by = ? WHERE id = ?`, [
        Date.now(),
        `reverted-to:${id}`,
        id,
        row.superseded_by,
      ]);
      this.db.run(`DELETE FROM facts_fts WHERE fact_id = ?`, [row.superseded_by]);
      this.db.run(`UPDATE facts SET deleted_at = NULL, deleted_reason = NULL, superseded_by = NULL WHERE id = ?`, [id]);
      this.db.run(`INSERT INTO facts_fts (fact_id, text) VALUES (?, ?)`, [id, row.text]);
      done = true;
    });
    tx.immediate();
    return done;
  }

  /** Soft-delete a single fact by id (idempotent). */
  tombstone(id: string): void {
    // SHRINK-INV guard: human_verified facts cannot be tombstoned.
    const stored = this.get(id);
    if (stored && stored.fact.confidence.level === 'human_verified') {
      return;
    }
    const tx = this.db.transaction(() => {
      this.db.run(`UPDATE facts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [
        Date.now(),
        id,
      ]);
      this.db.run(`DELETE FROM facts_fts WHERE fact_id = ?`, [id]);
    });
    tx();
  }

  /**
   * Soft-delete every live fact whose guardian considers it expired
   * (currently only `agent_tentative` facts with a TTL). Returns the
   * number of facts tombstoned.
   */
  public prune(now: Date = new Date()): number {
    const rows = this.db
      .query(`SELECT * FROM facts WHERE deleted_at IS NULL`)
      .all() as FactRow[];
    let count = 0;
    for (const row of rows) {
      const fact = this.rowToFact(row);
      if (isExpired(fact, now)) {
        this.tombstone(row.id);
        count++;
      }
    }
    return count;
  }

  /** 所有 live (未 tombstone) 的 agent_tentative fact —— confidence-adjuster 升级扫描入口。 */
  liveTentativeFacts(): { id: string; namespace: string; identityKey: string; fact: ValidatedFact }[] {
    const rows = this.db
      .query(`SELECT id, namespace, identity_key, payload FROM facts WHERE deleted_at IS NULL`)
      .all() as { id: string; namespace: string; identity_key: string; payload: string }[];
    const out: { id: string; namespace: string; identityKey: string; fact: ValidatedFact }[] = [];
    for (const r of rows) {
      const fact = this.safeguard.schema.parse(JSON.parse(r.payload)) as ValidatedFact;
      if (fact.confidence.level === 'agent_tentative') {
        out.push({ id: r.id, namespace: r.namespace, identityKey: r.identity_key, fact });
      }
    }
    return out;
  }

  /**
   * 同 (namespace, IDENTITY) 所有 fact (含 tombstoned 软删) 的 source_event_ids 并集 = 证据账本。
   * Schema 约束 tentative.source_event_ids≤2 → 单条 fact 装不下全部跨-session 证据; 历史 (tombstone
   * 是软删, payload 保留) 是天然账本 → 零新表。读 raw payload (不过 schema.parse, 容 tombstoned)。
   */
  collectIdentityEvidence(namespace: string, identityKey: string): string[] {
    const rows = this.db
      .query(`SELECT payload FROM facts WHERE namespace = ? AND identity_key = ?`)
      .all(namespace, identityKey) as { payload: string }[];
    const ids = new Set<string>();
    for (const r of rows) {
      const raw = JSON.parse(r.payload) as {
        source_event_id?: unknown;
        confidence?: { source_event_ids?: unknown };
      };
      if (typeof raw.source_event_id === 'string' && raw.source_event_id) ids.add(raw.source_event_id);
      const seids = raw.confidence?.source_event_ids;
      if (Array.isArray(seids)) for (const e of seids) if (typeof e === 'string' && e) ids.add(e);
    }
    return [...ids];
  }

  /**
   * 某 namespace 的所有 live (未 tombstone) fact (含全 confidence 级)。skill-miner 读 omd.pattern 用;
   * 调用方自行按 confidence/outcome 过滤 (store 不懂 miner 的资格规则 — 关注点分离)。索引 facts_ns_identity 命中。
   */
  liveFactsByNamespace(namespace: string): { id: string; identityKey: string; fact: ValidatedFact }[] {
    const rows = this.db
      .query(`SELECT id, identity_key, payload FROM facts WHERE namespace = ? AND deleted_at IS NULL`)
      .all(namespace) as { id: string; identity_key: string; payload: string }[];
    return rows.map((r) => ({
      id: r.id,
      identityKey: r.identity_key,
      fact: this.safeguard.schema.parse(JSON.parse(r.payload)) as ValidatedFact,
    }));
  }

  /** Count of live (non-tombstoned) facts. */
  count(): number {
    const r = this.db.query(`SELECT count(*) AS n FROM facts WHERE deleted_at IS NULL`).get() as {
      n: number;
    };
    return r.n;
  }

  // -------------------------------------------------------------------------
  // Hybrid retrieval — vector ⊕ BM25 fused by RRF.
  // -------------------------------------------------------------------------

  private bmLeg(query: string): Array<{ id: string; score: number }> {
    const expr = ftsMatchExpr(query);
    if (!expr) return [];
    const rows = this.db
      .query(
        `SELECT fact_id AS id, bm25(facts_fts) AS score
           FROM facts_fts WHERE facts_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(expr, BM_POOL) as Array<{ id: string; score: number }>;
    return rows; // already ascending bm25 (more negative = better) = best first
  }

  private async vecLeg(query: string): Promise<Array<{ id: string; sim: number }>> {
    const q = await this.embed(query);
    const rows = this.db
      .query(`SELECT id, embedding FROM facts WHERE deleted_at IS NULL`)
      .all() as Array<{ id: string; embedding: Uint8Array }>;
    const scored = rows.map((r) => ({ id: r.id, sim: cosineSim(q, blobToVec(r.embedding)) }));
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, VEC_POOL);
  }

  /**
   * Hybrid recall: top-`k` facts by RRF over the vector + BM25 legs. A query
   * matching neither leg returns []. Tombstoned facts are never returned.
   *
   * ## 准入与排序是两件事(2026-08-28)
   *
   * **RRF 分数不能拿来判相关性。** 它只编码名次:任何查询的第一名恒是 `1/(60+1)=0.0164`,
   * 不管库里有没有一条真相关的。实测(A/B 装置的 7 条查询):cold 查询("括号 嵌套 深度")
   * 照样返 5 条,其中一条 `vecSim=0.481` 比 anchored 查询的尾巴还高 —— 因为默认
   * `hashEmbed` 是哈希词袋,「深度」「匹配」这种常用词到处都撞。**所以单一分数下限也切不干净。**
   *
   * 真正分得开的是**两条腿的合流**:两条独立检索腿都把同一条排进前 N = 真信号;
   * 只有一条腿捞到 = 那条腿自己的噪声。实测分离度(anchored 3 查询 / cold 5 查询,各取 20):
   *
   * | N | anchored 保留 | cold 保留 |
   * |---|---|---|
   * | 3 | 4 | **0** |
   * | 10 | 21 | **0** |
   * | 15 | 36 | **0** |
   * | 20 | 49 | 1 |
   * | 30 | 60 | 2 |
   *
   * N 在 3–15 之间**整段**都是完美分离(不是刀刃上的点), 取中段 10。
   *
   * ⚠ **这条判据假定两条腿"独立但相关"。** 今天默认 `hashEmbed` 是词法代理, 所以合流其实是
   * "用两种方式各自词法命中"。哪天注入**真语义** embedder, 一条纯语义命中(零词法重合)会被
   * 这道闸滤掉 —— 那时要把 `agreementTopN` 放宽或关掉(传 `null`)。这不是缺陷, 是前提变了。
   *
   * @param opts.agreementTopN 合流准入:两条腿都要进前 N 才收。`null` = 关闭(旧行为)。
   */
  async retrieve(query: string, k = 10, opts: { agreementTopN?: number | null } = {}): Promise<MemoryHit[]> {
    const [vec, bm] = await Promise.all([this.vecLeg(query), Promise.resolve(this.bmLeg(query))]);

    const fused = new Map<
      string,
      // `bmScore` 一直在 `MemoryHit` 类型里但从没被填过(2026-08-28 接上)——
      // 读侧要判相关性就得看得见原始腿分, 而不是只看名次融合后的 rrf。
      { rrf: number; vecRank?: number; bmRank?: number; vecSim?: number; bmScore?: number }
    >();
    vec.forEach((h, i) => {
      fused.set(h.id, { rrf: 1 / (RRF_K + i + 1), vecRank: i + 1, vecSim: h.sim });
    });
    bm.forEach((h, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const cur = fused.get(h.id);
      if (cur) {
        cur.rrf += contribution;
        cur.bmRank = i + 1;
        cur.bmScore = h.score;
      } else {
        fused.set(h.id, { rrf: contribution, bmRank: i + 1, bmScore: h.score });
      }
    });

    // ── 准入:两条腿的合流(见方法头注)。排序仍归 RRF —— 两件事分开。 ──
    const topN = opts.agreementTopN === undefined ? AGREEMENT_TOP_N : opts.agreementTopN;
    const admitted =
      topN === null
        ? [...fused.entries()]
        : [...fused.entries()].filter(
            ([, m]) => m.vecRank !== undefined && m.bmRank !== undefined && m.vecRank <= topN && m.bmRank <= topN,
          );

    const ranked = admitted.sort((a, b) => b[1].rrf - a[1].rrf).slice(0, k);
    if (ranked.length === 0) return [];

    // Fetch only the winners' full rows (parse cost paid for top-k, not the pool).
    const ids = ranked.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT * FROM facts WHERE id IN (${placeholders})`)
      .all(...ids) as FactRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    const hits: MemoryHit[] = [];
    for (const [id, m] of ranked) {
      const row = byId.get(id);
      if (!row) continue; // tombstoned between leg + fetch (single-writer: rare)
      hits.push({
        id,
        fact: this.rowToFact(row),
        text: row.text,
        rrf: m.rrf,
        vecRank: m.vecRank,
        bmRank: m.bmRank,
        vecSim: m.vecSim,
        bmScore: m.bmScore,
      });
    }
    return hits;
  }

  /** Read a single live fact by id (null if absent or tombstoned). */
  get(id: string): StoredFact | null {
    const row = this.db
      .query(`SELECT * FROM facts WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as FactRow | null;
    if (!row) return null;
    return {
      id: row.id,
      fact: this.rowToFact(row),
      namespace: row.namespace,
      identityKey: row.identity_key,
      text: row.text,
      embedding: blobToVec(row.embedding),
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    };
  }

  /** Release the SQLite handle (no-op for ':memory:' beyond GC). */
  close(): void {
    this.db.close();
  }
}

/** Convenience factory — wires the default embedder + (optional) durable path. */
export function createOmdMemory(opts: OmdMemoryOptions = {}): OmdMemory {
  return new OmdMemory(opts);
}
