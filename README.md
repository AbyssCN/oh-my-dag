<div align="center">

# Valinor

### The system around the model.

**Most agents are a prompt wrapped around one frontier model.**
Valinor makes the opposite bet: reliability lives in the *code around* the model —
gates, validators, deterministic orchestration, a memory that consolidates itself —
**not in the prompt.** Give it any LLM, even a small or cheap one, and the harness
makes it behave like a disciplined engineer.

> The model is the engine. Valinor is the chassis.

</div>

---

## The bet: reliability from *outside* the model

An LLM alone forgets last session, charges ahead without a plan, trusts its own
formatting, and hands you the average answer. A frontier model papers over this with
raw capability — expensively, and only for that one model.

Valinor treats the model as **leverage** and the harness as the **fulcrum**. Everywhere
an LLM is unreliable, there is code *outside* the model holding the invariant:

- It **can't** write code until the plan is aligned — a read-only gate enforces it, not a polite instruction.
- It **doesn't** trust the model's JSON — it validates in code and retries.
- It **doesn't** hope the model remembers — a memory it consolidates itself does.

The payoff is **model-agnostic by design**: swap DeepSeek, MiMo, Qwen, Claude — the
reliability comes from the system, so it travels with *you*, not with the model. That is
what lets a weak or cheap model run work you'd normally reserve for a frontier one.

---

## What's inside

### 🧭 Plan mode — deliberate before you act
`shift+tab` drops into a **read-only deliberation cockpit**. Writes are *code-blocked*,
not discouraged — the model can only think, discuss, ingest the links you paste, and
stress-test the plan until it's aligned, then emit an SDD + TDD skeleton. A ledger
re-injects the decisions every turn so it can't quietly drift.
`/grill` adversarial questioning · `/council` multi-perspective synthesis · `/sdd` canonical plan doc.

### ⚡ Code mode — multi-tool work in one round-trip
Instead of N tool calls each round-tripping their results through the context window, the
model writes one snippet that chains tools, loops, and filters — and **only the final
result returns.** The raw intermediate data never touches context.

> Measured on real tasks: **88%** fewer tokens fetching + summarizing 10 sources ·
> **99.5%** analyzing 16 files. Savings scale with how hard you reduce the data.

### 🌿 Leaf fan-out — concurrent execution
A **conductor** decomposes a task into a DAG of executor **leaves**; independent leaves
run **concurrently** (hundreds in flight on a high-concurrency backend). Roles are
decoupled — conductor *plans*, executor *runs*, verifier *checks* — and each role binds to
whatever model fits, swappable from config. Wide over deep: maximize parallel siblings
that share a cached frozen prefix.

### 🔮 Fan-out & best-of-N — many minds, then pick
For wide-open decisions, generate N candidates from **diverse personas** (not the same
prompt resampled N times), judge them through multiple lenses, then synthesize the winner
while grafting the runners-up's best ideas. Diversity over volume.

### 🧠 A memory that consolidates itself
Runtime signals → a *dream* pass distills them into facts → facts that **recur across
sessions** get promoted from tentative to confident → confident facts ground the agent's
behavior next time. A TTL sweep keeps it bounded. Every write passes safeguards
(namespace validation, reject-by-default) — no domain leakage, no unbounded growth.

### 🔁 Self-learning flywheel
Five signal producers — getting stuck, tool failures, memory misses, user corrections,
hard-problems-solved — feed the consolidation loop. Patterns that prove out get **mined
into new skills**, proposed for your approval. The harness gets better at *your* work the
more it does it.

### 🔌 MCP router — hundreds of tools, no context tax
Every MCP server collapses behind one router: the menu stays resident, full schemas hide
behind on-demand lookup. **~70%** token reduction on the tool surface; large tool outputs
auto-offload to a searchable sandbox (**~98%** on big blobs).

### 📦 Curated skill bundle
Twelve hand-picked skills — session lifecycle, verification, root-cause investigation,
retro, audit, memory recall, fan-out — self-evolving via an eval flywheel and an episodic
miner that drafts new ones from what actually worked.

---

## Quick start

```bash
bun install

# point it at any supported / OpenAI-compatible backend
export VALAR_RUNTIME_PROVIDER=deepseek
export VALAR_RUNTIME_MODEL=deepseek-v4-pro

bun run valar             # interactive terminal agent
bun run valar -p "..."    # one-shot, non-interactive
```

Requires [Bun](https://bun.sh) ≥ 1.3. Built on the [pi](https://pi.dev) coding-agent runtime.

---

## Meet Valar

**Valinor** is the runtime. **Valar** is its first agent — a terminal coding agent. More
agents will live on the same chassis: the plan-before-act discipline, the self-consolidating
memory, the deterministic fan-out, and the model-agnostic spine are the platform, not the agent.

---

## Philosophy

> Reliability comes from outside the model, not inside it.
> The model decides; the system keeps it correct.

Valinor is built as a harness that arms a single developer with the leverage of a frontier
model and the discipline of a real engineering system — and the taste to tell the
difference. Put the model inside a reliable system; don't bury reliability inside a prompt.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE). The *methodology* is shared via articles/docs; the source is not open for copy or reuse.

