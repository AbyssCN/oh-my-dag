/**
 * src/valar/memory/store — valar Tier-1 self-memory over bun:sqlite (SDD §7).
 *
 * One SQLite file = one agent's own memory. Three concerns in one substrate:
 *   - facts        → validated L3 facts (write-gated by the shared SAFEGUARD
 *                    functions from src/memory/safeguards — one guard, two tiers)
 *   - facts_fts    → FTS5 (real BM25) lexical leg of hybrid retrieval
 *   - valar_edges  → temporal KG (via {@link SqliteEdgeStore}, app-enforced
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
const VEC_POOL = 50;
const BM_POOL = 50;

export interface ValarMemoryOptions {
  /** SQLite file path. Default ':memory:' (ephemeral, per-process). */
  path?: string;
  /** Pre-opened Database (overrides `path`) — e.g. shared across components. */
  db?: Database;
  /** Vector-leg embedder. Default = zero-dep deterministic {@link defaultEmbed}. */
  embed?: EmbedFn;
  /**
   * 注入的 namespace 闸料 (P1#1 phase-2)。决定哪些 namespace 可写 + ban + identity。默认
   * DEFAULT_SAFEGUARD (通用+a sibling project, back-compat)。domain-free 前端 (TUI valar 自我记忆) 注入
   * UNIVERSAL_SAFEGUARD → 只收 user 与 valar namespace。
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

export class ValarMemory {
  private readonly db: Database;
  private readonly embed: EmbedFn;
  /** 注入的 namespace 闸料 (allowlist/ban/identity)。默认 DEFAULT_SAFEGUARD。 */
  private readonly safeguard: AssembledSafeguard;
  /** Temporal-KG sub-store over the same SQLite file (EDGE-INV-1 enforced). */
  readonly edges: SqliteEdgeStore;

  constructor(opts: ValarMemoryOptions = {}) {
    this.db = opts.db ?? new Database(opts.path ?? ':memory:');
    this.embed = opts.embed ?? defaultEmbed;
    this.safeguard = opts.safeguard ?? DEFAULT_SAFEGUARD;
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
    if ((evolve.action === 'evolve' || evolve.action === 'replace') && existing) {
      this.tombstoneByIdentity(fact.namespace, identityKey, `superseded:${evolve.action}`);
    }
    const id = await this.insertFact(fact, identityKey);
    return { status: 'written', id, action: evolve.action };
  }

  private async insertFact(fact: ValidatedFact, identityKey: string): Promise<string> {
    const id = crypto.randomUUID();
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

  /** Tombstone all live facts of a (namespace, IDENTITY) — SHRINK-INV-3 soft. */
  private tombstoneByIdentity(namespace: string, identityKey: string, _reason: string): void {
    const rows = this.db
      .query(
        `SELECT id FROM facts WHERE namespace = ? AND identity_key = ? AND deleted_at IS NULL`,
      )
      .all(namespace, identityKey) as { id: string }[];
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(`UPDATE facts SET deleted_at = ? WHERE id = ?`, [now, r.id]);
        this.db.run(`DELETE FROM facts_fts WHERE fact_id = ?`, [r.id]);
      }
    });
    tx();
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
   * 某 namespace 的所有 live (未 tombstone) fact (含全 confidence 级)。skill-miner 读 valar.pattern 用;
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

  private bmLeg(query: string): Array<{ id: string }> {
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
   */
  async retrieve(query: string, k = 10): Promise<MemoryHit[]> {
    const [vec, bm] = await Promise.all([this.vecLeg(query), Promise.resolve(this.bmLeg(query))]);

    const fused = new Map<
      string,
      { rrf: number; vecRank?: number; bmRank?: number; vecSim?: number }
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
      } else {
        fused.set(h.id, { rrf: contribution, bmRank: i + 1 });
      }
    });

    const ranked = [...fused.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, k);
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
export function createValarMemory(opts: ValarMemoryOptions = {}): ValarMemory {
  return new ValarMemory(opts);
}
