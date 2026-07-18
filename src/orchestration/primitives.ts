/**
 * Control-flow primitives (mimo-leaf contract piece 2).
 *
 * These are model-agnostic by construction (INV-5): this module imports no
 * provider and no `src/model` — the unit of work is an injected {@link LeafFn},
 * so the same `parallel`/`pipeline`/… drive a mimo single-shot leaf or a spawned
 * agent interchangeably. A thrown leaf is isolated to `null` and never sinks the
 * batch (INV-6); in-flight work is capped (INV-7). The primitives hold no state —
 * crash consistency lives in the L1 DAG node that runs them (INV-8).
 */
import { availableParallelism } from 'node:os';

/** A unit of work. The single injection point — mimo callModel or a spawned agent. */
export type LeafFn<T> = () => Promise<T>;

/**
 * Max leaves in flight at once (INV-7). 「leaf 开大」旋钮 (契约 D72 VAL-DAG-7):
 * env `OMD_MAX_FANOUT` (正整数) 覆盖 → 否则 CPU 默认 min(16, cores−2), 至少 1。
 * 调用方仍可经 `parallel(thunks, {concurrency})` / leaf `fanout.max` per-call 覆盖。
 */
function resolveDefaultConcurrency(): number {
  const raw = process.env.OMD_MAX_FANOUT;
  const env = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(env) && env > 0) return env;
  return Math.max(1, Math.min(16, availableParallelism() - 2));
}
export const DEFAULT_CONCURRENCY = resolveDefaultConcurrency();

/**
 * Worker-pool over `thunks` with at most `limit` running concurrently. Each
 * result lands at its input index; a thrown thunk becomes `null` (INV-6). The
 * `cursor++` read is atomic on the single-threaded loop, so no two workers claim
 * the same index.
 */
async function runWithLimit<T>(thunks: LeafFn<T>[], limit: number): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(thunks.length).fill(null);
  if (thunks.length === 0) return results;
  const bound = Math.max(1, Math.min(limit, thunks.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < thunks.length) {
      const i = cursor++;
      const thunk = thunks[i];
      if (!thunk) continue;
      try {
        results[i] = await thunk();
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

/** Run all `thunks` concurrently (barrier) under the concurrency cap; isolate failures. */
export function parallel<T>(
  thunks: LeafFn<T>[],
  opts?: { concurrency?: number },
): Promise<(T | null)[]> {
  return runWithLimit(thunks, opts?.concurrency ?? DEFAULT_CONCURRENCY);
}

/** A pipeline stage: receives the previous result, the original item, and its index. */
export type Stage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;

/**
 * Push each item through every stage independently — no barrier between stages,
 * so item A can be at stage 3 while item B is still at stage 1. A stage that
 * throws drops that item to `null` and skips its remaining stages (INV-6). Items
 * run concurrently under the cap (INV-7).
 */
export function pipeline(
  items: unknown[],
  ...stages: Stage[]
): Promise<(unknown | null)[]> {
  const thunks: LeafFn<unknown>[] = items.map((item, index) => async () => {
    let acc: unknown = item;
    for (const stage of stages) acc = await stage(acc, item, index);
    return acc;
  });
  return runWithLimit(thunks, DEFAULT_CONCURRENCY);
}

/**
 * Run `step` sequentially, accumulating results, until `done(acc)` is true or
 * `maxIterations` (default 100) is hit. Sequential by design — a discovery loop
 * whose next step may read the accumulated state — so a thrown step propagates
 * (it is a real error, not an isolated leaf).
 */
export async function loopUntil<T>(
  step: LeafFn<T>,
  done: (acc: T[]) => boolean,
  opts?: { maxIterations?: number },
): Promise<T[]> {
  const acc: T[] = [];
  const max = opts?.maxIterations ?? 100;
  for (let i = 0; i < max; i++) {
    if (done(acc)) break;
    acc.push(await step());
  }
  return acc;
}

/** One verifier's verdict. Verifiers should default to `refuted: true` when uncertain. */
export interface Verdict {
  refuted: boolean;
  reason?: string;
}

/** Distinct angles so N verifiers attack a claim differently, not redundantly. */
const DEFAULT_LENSES = [
  'correctness',
  'security',
  'consistency',
  'edge-case',
  'reproducibility',
  'completeness',
];

/**
 * Spawn `n` verifiers (each a distinct lens) to try to refute `claim`; the claim
 * survives only with a majority of non-refuting verdicts. A null verdict (the
 * verifier itself errored) counts as a refusal — a crashed skeptic must never
 * green-light a claim.
 */
export async function adversarialVerify(
  claim: string,
  n: number,
  verify: (lens: string) => LeafFn<Verdict>,
): Promise<boolean> {
  if (!claim) throw new Error('adversarialVerify: claim required');
  if (n <= 0) throw new Error('adversarialVerify: n must be >= 1');
  const lenses = Array.from(
    { length: n },
    (_, i) => DEFAULT_LENSES[i % DEFAULT_LENSES.length]!,
  );
  const verdicts = await parallel(lenses.map((lens) => verify(lens)));
  const notRefuted = verdicts.filter((v): v is Verdict => v !== null && !v.refuted).length;
  return notRefuted >= Math.ceil(n / 2);
}

/**
 * Run independent `attempts`, score each surviving candidate, return the highest.
 * Failed attempts and failed scorings drop out; a null score is treated as the
 * worst possible. Throws only if every attempt failed.
 */
export async function judgePanel<T>(
  attempts: LeafFn<T>[],
  score: (candidate: T) => LeafFn<number>,
): Promise<T> {
  if (attempts.length === 0) throw new Error('judgePanel: at least one attempt required');
  const produced = await parallel(attempts);
  // A null here is a failed attempt (INV-6), not a legitimate result — drop it.
  const candidates = produced.filter((c) => c !== null) as T[];
  if (candidates.length === 0) throw new Error('judgePanel: all attempts failed');

  const scores = await parallel(candidates.map((c) => score(c)));
  let best: T = candidates[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  candidates.forEach((candidate, i) => {
    const raw = scores[i];
    const value = typeof raw === 'number' ? raw : Number.NEGATIVE_INFINITY;
    if (value > bestScore) {
      bestScore = value;
      best = candidate;
    }
  });
  return best;
}

// `nested` has no API by design: primitives compose directly — e.g.
// `parallel(items.map(it => () => pipeline([it], stageA, stageB)))` — because
// each takes and returns plain thunks/values (contract §3 note).
