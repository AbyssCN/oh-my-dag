/**
 * src/valar/memory/edge-store — temporal-KG seam, two enforcement substrates.
 *
 * The no-overlap invariant (EDGE-INV-1) is the same contract everywhere; only
 * WHO enforces it differs:
 *   - PG   → `btree_gist EXCLUDE (... validity WITH &&)` — the database refuses
 *            the overlapping INSERT (23P01). See src/memory/temporal.ts for the
 *            domain (Tier-2) tables already doing this.
 *   - SQLite → no EXCLUDE primitive, so the invariant moves into application
 *              code: check-before-insert inside a transaction. This is SOUND for
 *              valar's Tier-1 store because valar is its single writer — there is
 *              no concurrent writer that could slip an overlap between the check
 *              and the insert.
 *
 * SqliteEdgeStore is the load-bearing Tier-1 implementation (valar self-memory).
 * PgEdgeStore is a typed seam kept in the established `NotImplementedUntilPhase`
 * shape (cf. src/memory/host-adapter.ts) — the PG-enforced temporal mechanism is
 * a Tier-2 / domain concern (R5: domain logic does not live in valar core), so
 * its concrete wiring lands when a generic `valar_edges` PG table is needed, not
 * before. Both satisfy one interface so swapping substrate is a constructor swap.
 */
import { Database } from 'bun:sqlite';
import type { EdgeStore, TemporalEdge } from './types';

interface EdgeRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
  payload: string | null;
}

const POS_INF = Number.POSITIVE_INFINITY;

/** Half-open [aFrom,aTo) vs [bFrom,bTo) overlap; null upper bound ⇒ +∞. */
function rangesOverlap(
  aFrom: number,
  aTo: number | null,
  bFrom: number,
  bTo: number | null,
): boolean {
  const aEnd = aTo ?? POS_INF;
  const bEnd = bTo ?? POS_INF;
  return aFrom < bEnd && bFrom < aEnd;
}

function rowToEdge(r: EdgeRow): TemporalEdge {
  return {
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    validFrom: new Date(r.valid_from),
    validTo: r.valid_to == null ? null : new Date(r.valid_to),
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : undefined,
  };
}

export class EdgeOverlapError extends Error {
  constructor(identity: string, at: string) {
    super(`[valar/edge] EDGE-INV-1 violated: ${identity} already has a live edge overlapping ${at}`);
    this.name = 'EdgeOverlapError';
  }
}

/**
 * SQLite-backed temporal edge store with application-enforced no-overlap.
 * Shares a `Database` with {@link ValarMemory} (one SQLite file = one agent's
 * Tier-1 memory). Idempotent DDL so constructing over an existing db is safe.
 */
export class SqliteEdgeStore implements EdgeStore {
  constructor(private readonly db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS valar_edges (
        id         TEXT PRIMARY KEY,
        subject    TEXT NOT NULL,
        predicate  TEXT NOT NULL,
        object     TEXT NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to   INTEGER,
        payload    TEXT
      )
    `);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS valar_edges_identity
         ON valar_edges (subject, predicate, object)`,
    );
  }

  /** Rows sharing the (subject,predicate,object) identity of `edge`. */
  private siblings(subject: string, predicate: string, object: string): EdgeRow[] {
    return this.db
      .query(
        `SELECT * FROM valar_edges
           WHERE subject = ? AND predicate = ? AND object = ?`,
      )
      .all(subject, predicate, object) as EdgeRow[];
  }

  async put(edge: TemporalEdge): Promise<void> {
    const from = edge.validFrom.getTime();
    const to = edge.validTo == null ? null : edge.validTo.getTime();
    if (to != null && to <= from) {
      throw new Error('[valar/edge] put: validTo must be strictly after validFrom');
    }
    // Check-before-insert inside a transaction (single-writer ⇒ no TOCTOU).
    const tx = this.db.transaction(() => {
      for (const r of this.siblings(edge.subject, edge.predicate, edge.object)) {
        if (rangesOverlap(from, to, r.valid_from, r.valid_to)) {
          throw new EdgeOverlapError(
            `${edge.subject}-${edge.predicate}->${edge.object}`,
            edge.validFrom.toISOString(),
          );
        }
      }
      this.db.run(
        `INSERT INTO valar_edges (id, subject, predicate, object, valid_from, valid_to, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          edge.subject,
          edge.predicate,
          edge.object,
          from,
          to,
          edge.payload ? JSON.stringify(edge.payload) : null,
        ],
      );
    });
    tx();
  }

  async asOf(
    t: Date,
    filter: { subject?: string; predicate?: string } = {},
  ): Promise<TemporalEdge[]> {
    const at = t.getTime();
    const clauses = ['valid_from <= ?', '(valid_to IS NULL OR valid_to > ?)'];
    const params: unknown[] = [at, at];
    if (filter.subject !== undefined) {
      clauses.push('subject = ?');
      params.push(filter.subject);
    }
    if (filter.predicate !== undefined) {
      clauses.push('predicate = ?');
      params.push(filter.predicate);
    }
    const rows = this.db
      .query(`SELECT * FROM valar_edges WHERE ${clauses.join(' AND ')} ORDER BY valid_from DESC`)
      .all(...(params as [])) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async invalidate(
    identity: { subject: string; predicate: string; object: string },
    at: Date,
    successor: Omit<TemporalEdge, 'validFrom'>,
  ): Promise<void> {
    const atMs = at.getTime();
    const tx = this.db.transaction(() => {
      // 1. Find the currently-open edge(s) for this identity (valid at `at`).
      //    EDGE-INV-1 guarantees at most one; query .all() + assert rather than
      //    .get()-trust, so a violated invariant (e.g. a future PG-migration
      //    double-write, or a direct INSERT bypassing put) surfaces LOUDLY here
      //    instead of silently leaving a residual open edge that overlaps the
      //    successor. [review P1, commit 583af4f]
      const opens = this.db
        .query(
          `SELECT * FROM valar_edges
             WHERE subject = ? AND predicate = ? AND object = ?
               AND valid_from <= ? AND valid_to IS NULL`,
        )
        .all(identity.subject, identity.predicate, identity.object, atMs) as EdgeRow[];
      if (opens.length === 0) {
        throw new Error(
          `[valar/edge] invalidate: no open edge for ${identity.subject}-${identity.predicate}->${identity.object} at ${at.toISOString()}`,
        );
      }
      if (opens.length > 1) {
        throw new EdgeOverlapError(
          `${identity.subject}-${identity.predicate}->${identity.object}`,
          `${at.toISOString()} (EDGE-INV-1 violated: ${opens.length} open edges)`,
        );
      }
      const open = opens[0]!;
      // 2. Close it at `at` (half-open ⇒ successor starting at `at` abuts cleanly).
      this.db.run(`UPDATE valar_edges SET valid_to = ? WHERE id = ?`, [atMs, open.id]);
      // 3. Insert successor [at, successor.validTo). No overlap: predecessor now
      //    ends exactly at `at`.
      const succTo =
        successor.validTo == null ? null : successor.validTo.getTime();
      if (succTo != null && succTo <= atMs) {
        throw new Error('[valar/edge] invalidate: successor validTo must be after `at`');
      }
      this.db.run(
        `INSERT INTO valar_edges (id, subject, predicate, object, valid_from, valid_to, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          successor.subject,
          successor.predicate,
          successor.object,
          atMs,
          succTo,
          successor.payload ? JSON.stringify(successor.payload) : null,
        ],
      );
    });
    tx();
  }
}

// ---------------------------------------------------------------------------
// PgEdgeStore — typed seam for the PG-enforced (DB EXCLUDE) substrate.
// ---------------------------------------------------------------------------

/** Typed sentinel mirroring src/memory/host-adapter.ts's convention. */
export class EdgeStoreNotImplemented extends Error {
  constructor(method: string) {
    super(
      `[valar/edge] PgEdgeStore.${method} not-impl: the PG (DB-EXCLUDE) substrate ` +
        `is a Tier-2/domain concern — see src/memory/temporal.ts for the domain ` +
        `tables. Wire a generic valar_edges PG table before enabling.`,
    );
    this.name = 'EdgeStoreNotImplemented';
  }
}

/**
 * Placeholder for the PG-enforced EdgeStore. Carries the final signature so call
 * sites type-check against the seam today; throws until a generic `valar_edges`
 * PG table + btree_gist EXCLUDE migration lands (R5: not in valar core scope).
 */
export class PgEdgeStore implements EdgeStore {
  async put(_edge: TemporalEdge): Promise<void> {
    throw new EdgeStoreNotImplemented('put');
  }
  async asOf(_t: Date): Promise<TemporalEdge[]> {
    throw new EdgeStoreNotImplemented('asOf');
  }
  async invalidate(): Promise<void> {
    throw new EdgeStoreNotImplemented('invalidate');
  }
}
