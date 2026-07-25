# Memory system

[← README](../README.md) · [architecture](architecture.md)

Most agents forget everything the moment the context window scrolls. omd gives each
project a **Tier-1 self-memory** — one SQLite file that survives sessions, clients, and
machines.

- **Facts + hybrid retrieval.** Recall fuses two legs — a vector leg (cosine over
  embeddings) and a lexical leg (FTS5 real BM25) — with Reciprocal Rank Fusion (k=60),
  so a query hits both by-meaning and by-exact-term. A Tier-1 store is under ~10k
  facts, so retrieval is exact brute force: correct and fast, no ANN index to tune.
- **A temporal knowledge graph.** Facts are linked by time-bounded edges
  (`omd_edges`) with app-enforced no-overlap, so "what was true when" is a first-class
  query, not a guess from timestamps.
- **A write pipeline that rejects by default.** Every write passes namespace
  safeguards: out-of-namespace, banned, and (on the automatic learning path) secret-
  bearing facts are refused. A **confidence self-evolve lock** supersedes an
  existing same-identity fact only when the new one clears the bar — memory sharpens
  instead of accreting contradictions. Explicit `memory_remember` trusts you and skips
  the secret scan (your sovereignty over your own store).
- **Dream consolidation.** `dream_consolidate` runs one pump round that folds the
  recent raw-event window into layered facts (**L0–L6**), returning per-layer stats.
  Raw noise becomes durable, ranked knowledge — the next session recalls the distilled
  version, not the transcript.

## Session handoff

`/start` and `/handoff` distil a session into a checkpoint the next session reads, so a
new window opens knowing what the last one decided rather than re-deriving it.
