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
    "dream":     "opencode-go:glm-5.2",
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

Role path (`conductor/leaf/verifier/dream/continuity/review`) and node path
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
| **GPT (ChatGPT Plus)** | `openai-codex:gpt-5.6-sol` | ⚠️ none in omd | The token is minted by the external **pi / codex CLI**; omd only reads it. When `expires` passes, omd uses the stale token (requests 401) until the pi/codex side refreshes it. Keep that CLI logged in; re-run its login if 401s appear. |
| **Claude** | `anthropic:claude-opus-4-8` (etc.) | ⚠️ not wired as OAuth | Two options below. |

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
