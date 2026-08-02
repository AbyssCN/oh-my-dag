# Model configuration — one place, every seat

Two orthogonal questions, two files, never tangled:

| Question | Answered by | This doc |
|---|---|---|
| **Which model runs seat X?** (role → coord) | `.omd/config.json` → `models` | §1 |
| **How is model X reached?** (provider → endpoint/key) | `~/.pi/agent/models.json` + `auth.json` | §2–3 |

## 1 · The single surface: `.omd/config.json` `models`

Set a seat once here and **every resolver reads the same value** — the daemon-role path, the
per-node path, and the engine-default path all resolve a seat to the same coordinate. No more
"the status shows conductor = A but the DAG ran B".

```json
{
  "models": {
    "conductor": "openai-codex:gpt-5.6-sol",
    "leaf":      "mimo:mimo-v2.5",
    "agent":     "mimo:mimo-v2.5-pro",
    "judge":     "openai-codex:gpt-5.6-sol",
    "reason":    "kimi-coding:k3",
    "verifier":  "opencode-go:glm-5.2",
    "reduce":    "mimo:mimo-v2.5-pro",
    "lens":      "mimo:mimo-v2.5-pro",
    "expand":    "mimo:mimo-v2.5-pro",
    "distill":   "mimo:mimo-v2.5-pro",
    "overflow":  "mimo:mimo-v2.5-pro",
    "escalation":"openai-codex:gpt-5.6-sol",
    "review-spec":"opencode-go:glm-5.2"
  }
}
```

Edit this file (or `omd_set_role` / TUI `/config` for the four visible roles), and the change is
picked up on the next resolve — no restart. A coordinate is `provider:modelId` (or a bare
`provider`, which uses that provider's `defaultModel`).

### Resolution order (highest wins)

```
explicit (script flag / node.model in the plan)
  → .omd/config.json  models[seat]        ← THE hand-config surface
    → OMD_<SEAT>_MODEL env                 ← fallback for seats you didn't pin
      → .omd/config.json  autoAssigned[seat]  ← omd_models_auto proposal
        → hardcoded tier default
```

Role path (`conductor/leaf/verifier/continuity/review`) and node path
(`judge/reason/reduce/lens/…`) now share the **same `models` table at the same priority** — that
is the fix that makes a seat's model consistent across every code path
(`resolveRoleModel`, `resolveRoleModelConfigured`, and the engine's `resolveEngineModels`).

- **`autoAssigned`** (written by `omd_models_auto` from channel economics) is a **proposer**, not a
  competing source. It only fills seats absent from `models`. To adopt a proposal, copy it into
  `models`. Run `omd_models_auto` to refresh proposals; nothing it writes overrides what you pinned.
- **`pools`** (strong/mid/cheap/multimodal) drive the stamp pass's sibling-spread and are derived
  from the `models` coords when you don't set them explicitly.
- **env vars** are a fallback for unpinned seats and an escape hatch for CI. Do **not** set
  `OMD_ITER_*` / `OMD_RUNTIME_*` in the MCP registration to force engine models — that path now
  falls through to `models`, which is the point. (Removed from `~/.claude.json` on this machine.)

## 1.5 · The seats — what each does, weak or strong

omd resolves **14 seats** in 5 functional classes. Auto-assign (`omd_models_auto`) fills them by
**channel economics** — amortize the cheapest / flat-subscription channel that can do the job — not
by spreading model families for its own sake. Family diversity is injected only where it changes the
answer: **verify** (a checker from the author's own family shares its blind spots) and, ideally,
**research lenses** (multi-perspective wants multiple minds).

| Seat | Class | What it does | Weak / Strong | Why |
|---|---|---|---|---|
| `conductor` | decomposer | Decomposes a task into the typed plan graph | **Strong** | The one call that shapes everything downstream; SOTA brain pays off. |
| `escalation` | decomposer | Re-plans / patches a failed subgraph | **Strong** | Reasoning over a failure; sparse, high-value. |
| `judge` | judge_synth | Scores attempts, picks a winner | **Strong** | Judgement quality caps best-of-N; a weak judge picks wrong. |
| `reason` | judge_synth | Gap analysis, deep reasoning steps | Strong-ish | Long-prompt reasoning (k3); mid-frequency. |
| `reduce` | judge_synth | Folds fan-out results into one | Mid | High-frequency, mechanical merge — cheap is fine. |
| `leaf` | worker | One-shot generation, no tools | **Cheap** | Volume execution behind an oracle gate. |
| `agent` | worker | Writes files (tool loop, bwrap jail) | Mid | Needs capability to edit correctly; fewer than inproc leaves. |
| `lens` | worker | A research perspective in a fan-out | Mid **+ diverse** | Multi-perspective — see the note below. |
| `expand` | worker | Rewrites a query for recall | Cheap | Mechanical; oracle-free but low-stakes. |
| `distill` | worker | Cleans / distils a source | Cheap–Mid | Extraction; capable-cheap suffices. |
| `overflow` | worker | Fallback when a channel is saturated | Cheap | Safety valve, not a quality seat. |
| `verifier` | verify | Cross-family adversarial check | Mid **· cross-family** | **Must differ** from the author's family (INV-3). |
| `review-spec` | verify | Spec/contract review | Mid · cross-family | Same cross-family rule. |

**Why most worker seats land on one cheap model (e.g. `mimo-v2.5-pro`)** — the six worker seats are
the highest-frequency traffic. Auto-assign keeps them on a big-quota **flat/prepaid** channel because
scattering them onto a shared-dollar pool burns money fast (Kimi K3 drains the shared bucket ~288×
faster than a prepaid one — which is exactly why the *brain* seats get a dedicated prepaid bucket, not
the shared pool). For worker tasks — generate a defined thing, extract, fold — **quality is gated by
the oracle (tsc/test/verifier), not by the model family**, and eval showed cheap models buy execution,
not divergence. So one capable cheap model across the worker bucket is the right call; spreading it
across families buys nothing and costs money.

**The distribution is already multi-family across *roles*:** GPT (brain: conductor/judge/escalation) ·
Kimi K3 (reason) · GLM-5.2 (verify, deliberately off the author's family) · MiMo (workers). Mono-family
only *within* the worker bucket, by design.

**The one seat where more diversity genuinely pays: `lens`.** Research lenses are multiple *viewpoints*.
The repo's own rule — "three research lenses on one family share its blind spots" — means mono-family
lenses are multi-prompt but single-mind. Spreading the lens/cheap pool across families
(MiMo + GLM + Qwen + Kimi) so the stamp pass's sibling-spread rotates each lens onto a different family
would improve real divergence. `reduce → deepseek` instead of MiMo is marginal by comparison (reduce is
a mechanical fold, and it is high-frequency, so it stays on the cheap prepaid bucket).

## 2 · Provider catalog — where a model lives

A coordinate `provider:modelId` resolves **own registry → pi-ai catalog → error**:

- **Own registry** (`src/model/providers.ts`): OpenAI-compatible or `anthropic-messages` endpoints
  registered from `*_BASE_URL` + `*_API_KEY` env (e.g. `mimo`, `deepseek`) or from `models.json`.
- **pi-ai catalog** (`~/.pi/agent/models.json`): custom providers `{ baseUrl, apiKey: "$ENV", api, models[] }`.
  Add/update via `omd_register_provider` (writes models.json, key as a `$KEYENV` reference).

Set a key with `omd_set_key <provider> <key>` — it lands in `~/.pi/agent/auth.json` (pi providers)
or `.env` (native), then re-registers. It never touches `.mcp.json`.

## 3 · OAuth & subscription channels (Claude / GPT / Kimi)

Subscriptions authenticate by **OAuth**, stored in `~/.pi/agent/auth.json` as
`{ type: "oauth", access, refresh, expires }`. omd reads that file; whether it can **refresh** an
expired token depends on whether omd has a built-in OAuth handler for that provider.

| Sub | Coordinate | omd OAuth handler? | How to log in / keep alive |
|---|---|---|---|
| **Kimi** | `kimi-coding:k3` | ✅ built-in (device-code, `src/model/kimi-oauth.ts`) | omd TUI **`/login`** runs the device-code flow and writes auth.json; auto-refreshes. When the refresh token itself dies → `/login` again. |
| **GPT (ChatGPT Plus)** | `openai-codex:gpt-5.6-sol` | ✅ built-in (`src/model/openai-codex-oauth.ts`) | Initial login is done once by the external **pi / codex CLI** (writes auth.json); from then on omd **auto-refreshes** the access token via the `refresh_token` grant when it expires. Only when the refresh token itself is revoked do you re-run the codex login. |
| **Claude** | `anthropic:claude-opus-4-8` (etc.) | ⚠️ not wired as OAuth | Two options below (an omd handler like codex's could be added by wiring pi-ai's `anthropic` flow). |

**Registering Claude:**
- **Reliable — API key:** `omd_set_key anthropic <sk-ant-…>` then
  `omd_register_provider` with `api: "anthropic-messages"`, `baseUrl: "https://api.anthropic.com"`,
  `models: ["claude-opus-4-8", …]`. Coordinate `anthropic:claude-opus-4-8`. Cost rates for these are
  already in `src/model/cost-ledger.ts`.
- **Subscription token (best-effort):** a Claude Code OAuth token (`sk-ant-oat01-…`, present as
  `CLAUDE_CODE_OAUTH_TOKEN`) can be tried as the bearer for a native `anthropic-messages` provider,
  but the messages API may require OAuth-beta headers omd does not send — treat as untested until a
  live call confirms. For a stable seat, prefer the API key.

**Adding any new OAuth provider that omd should refresh itself** (like kimi) needs an OAuth handler
module (`*-oauth.ts`) wired into `getOAuthProvider` in `src/model/pi-transport.ts`. Without one, omd
can *use* an externally-minted token but cannot refresh it.

---

### The resolution map, one call chain

`assemble.ts:resolveEngineModels` (engine conductor/leaf) → `role-models.ts:resolveRoleModelConfigured`
(per node) and `resolveRoleModel` (the 6 daemon roles) → both read `.omd/config.json` `models` →
coordinate resolved by `index.ts:resolveModel` (own registry → pi catalog). Change `models`, and all
of it moves together.
