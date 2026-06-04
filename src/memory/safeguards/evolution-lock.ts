/**
 * src/memory/safeguards/evolution-lock.ts — self-evolve guard (PLAN D54 §5.3).
 *
 * Design source: agent-memory-frameworks-2026-05-29.md §5.3 + §5.7.
 *
 * MemOS self-evolution (and the Dream engine, D55) can revise existing L3 facts.
 * This module decides — given the *existing* fact and an *incoming* revision —
 * whether the write inserts / replaces / evolves / is rejected, and emits the
 * evolution-log entry the caller must persist to keep the revision chain
 * auditable. It does NOT touch storage; it is a pure decision function.
 *
 * Confidence rules (§5.3):
 *   - existing null            → insert
 *   - existing human_verified  → reject (immutable, unless the owner explicitly
 *                                retracts via an authenticated opts.humanRetraction)
 *   - existing agent_confident → evolve (chain preserved; new version stays
 *                                agent_confident)
 *   - existing agent_tentative → replace (short log)
 *
 * isExpired: an agent_tentative fact with no new evidence for >30 days expires.
 */
import type { ValidatedFact, ConfidenceLevel } from './namespaces';

export type EvolveAction = 'insert' | 'replace' | 'evolve' | 'reject';

/** One link in a fact's revision chain — caller persists it (we do not). */
export interface EvolutionLogEntry {
  from: ValidatedFact;
  to: ValidatedFact;
  at: Date;
}

export interface CheckEvolveResult {
  action: EvolveAction;
  reason: string;
  evolutionLogEntry?: EvolutionLogEntry;
}

/**
 * Proof that a human_verified fact retraction was authorised by the owner through an
 * AUTHENTICATED channel — never agent/LLM-supplied text.
 *
 * SECURITY (Sprint 2 review P1): this is the ONLY thing that can mutate an
 * otherwise-immutable human_verified fact. The caller MUST construct it solely
 * from a verified the owner action — a verified WeCom/Lark sender id, or an explicit
 * human-in-the-loop inbox approval — and MUST NOT thread any agent- or
 * LLM-controllable value into it. An agent that can populate this object forges
 * a the owner retraction and overwrites an immutable fact, with the evolution log
 * laundering the agent write as the owner's. There is no production caller yet; wire
 * the `verified-actor → HumanRetraction` seam BEFORE connecting checkEvolve to
 * the L3 write path.
 */
export interface HumanRetraction {
  authorizedBy: 'nick';
  /** Channel that authenticated the owner's authority — recorded in the audit log. */
  via: 'wecom-verified-sender' | 'lark-verified-sender' | 'hitl-inbox-approval';
  reason: string;
}

export interface CheckEvolveOpts {
  /** Authenticated human retraction — the ONLY override for human_verified.
   *  See {@link HumanRetraction}; must derive from a verified the owner action. */
  humanRetraction?: HumanRetraction;
  /** Injectable clock for deterministic logs/tests. Defaults to now. */
  now?: Date;
}

function confidenceLevel(fact: ValidatedFact): ConfidenceLevel {
  return fact.confidence.level;
}

export function checkEvolve(
  existing: ValidatedFact | null,
  incoming: ValidatedFact,
  opts: CheckEvolveOpts = {},
): CheckEvolveResult {
  const now = opts.now ?? new Date();

  // No prior fact → straight insert.
  if (existing === null) {
    return { action: 'insert', reason: 'no-existing' };
  }

  const level = confidenceLevel(existing);

  switch (level) {
    case 'human_verified': {
      // Immutable — only an authenticated the owner retraction may replace it. The
      // structured HumanRetraction (not a bare flag) makes the trust boundary
      // explicit; a write with no retraction (the agent self-evolve path) is
      // always rejected.
      const retraction = opts.humanRetraction;
      if (retraction && retraction.authorizedBy === 'nick') {
        return {
          action: 'replace',
          reason: `human-verified-retracted-by-nick:${retraction.via}`,
          evolutionLogEntry: { from: existing, to: incoming, at: now },
        };
      }
      return { action: 'reject', reason: 'human-verified-immutable' };
    }

    case 'agent_confident': {
      // Revisable, but the chain MUST be preserved. New version stays confident
      // (incoming confidence is the caller's concern; the action is 'evolve').
      return {
        action: 'evolve',
        reason: 'agent-confident-evolve',
        evolutionLogEntry: { from: existing, to: incoming, at: now },
      };
    }

    case 'agent_tentative': {
      // Cheap to overwrite — short log, no chain obligation.
      return { action: 'replace', reason: 'agent-tentative-replace' };
    }
  }
}

/** 30-day idle window for tentative facts (§5.3). */
export const TENTATIVE_TTL_DAYS = 30;
const TENTATIVE_TTL_MS = TENTATIVE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * An agent_tentative fact with no new evidence for >30 days is expired.
 * Boundary: exactly 30 days is NOT expired (strict `>`); 30 days + 1ms is.
 * Non-tentative facts never expire on this rule (return false).
 */
export function isExpired(fact: ValidatedFact, now: Date = new Date()): boolean {
  if (fact.confidence.level !== 'agent_tentative') return false;
  const ageMs = now.getTime() - fact.confidence.created_at.getTime();
  return ageMs > TENTATIVE_TTL_MS;
}
