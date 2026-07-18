/**
 * src/harness/plan/types — shared types for MomusGate + MetisStage (SDD D-4 / P2).
 *
 * All types model-agnostic (OPS-1). Zero AI calls (MG-4).
 */
// ── Momus Gate ────────────────────────────────────────────────────────

export interface MomusThresholds {
  fileRefCoverage: number;      // default 1.0 (100%)
  referenceSourceRatio: number; // default 0.8
  testableAcceptance: number;   // default 0.9
  businessAssumptions: number;  // always 0 (fixed)
  criticalRedFlags: number;     // always 0 (fixed)
}

export const DEFAULT_THRESHOLDS: MomusThresholds = {
  fileRefCoverage: 1.0,
  referenceSourceRatio: 0.8,
  testableAcceptance: 0.9,
  businessAssumptions: 0,
  criticalRedFlags: 0,
};

export interface MomusScores {
  fileRefCoverage: number;
  referenceSourceRatio: number;
  testableAcceptance: number;
  businessAssumptions: number;
  criticalRedFlags: number;
}

export interface MomusResult {
  pass: boolean;
  scores: MomusScores;
  failures: string[];
}

// ── Plan metrics (extracted from SDD markdown) ─────────────────────────

export interface PlanMetrics {
  /** Total files declared in implementation scope table. */
  totalDeclaredFiles: number;
  /** Files that have a verifiable reference (path exists + readable). */
  filesWithRef: number;
  /** Total tasks in implementation scope. */
  totalTasks: number;
  /** Tasks that have an explicit reference source (doc/code/API). */
  tasksWithSource: number;
  /** Tasks that have testable acceptance criteria. */
  tasksWithTestableAcceptance: number;
  /** Tasks requiring business logic assumptions. */
  tasksWithBusinessAssumptions: number;
  /** Tasks flagged as critical red flag. */
  tasksWithCriticalRedFlags: number;
}

// ── Metis Stage ─────────────────────────────────────────────────────────

export type GapSeverity = 'blocker' | 'major' | 'minor';

export interface Gap {
  severity: GapSeverity;
  description: string;
  impactScope: string;
  suggestedFix: string;
}

export interface CoverageMap {
  /** Files that ARE referenced in the plan. */
  covered: string[];
  /** Files that should be covered but aren't. */
  uncovered: string[];
}

export interface MetisReport {
  gaps: Gap[];
  coverage: CoverageMap;
  assumptions: string[];
}
