/**
 * src/mcp/tools/config-tools — omd 配置工具族 (omd init 的 MCP 面, D-config-mcp)。
 *
 * omd 跑在 Claude 里时"掌舵"= Opus, 配置不再走独立 TUI wizard; 这组工具让 Opus/​slash 直接
 * 改引擎配置 (key/角色/preset/HUD) 且**当前 MCP 子进程即时生效** (headless-config 双写: 落盘 +
 * 活注入)。5 工具:
 *   omd_set_key       —— 落 provider key → auth.json(pi)/ .env(native) + re-register
 *   omd_apply_preset  —— 套角色矩阵预设 (cn-trio 等) → .env + config.json
 *   omd_set_role      —— 单角色 (conductor/leaf/verifier/dream) → config.json
 *   omd_config_status —— 当前角色→模型 + 每 provider 凭证状态 + 无凭证告警
 *   omd_toggle_hud    —— 装/卸 DAG/pathfinder 实时底栏 HUD
 *
 * Pure-fn factory: createConfigTools({cwd}) → OmdMcpTool[]。密钥只落 auth.json/.env, 永不碰 .mcp.json。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import { ROLE_PRESETS } from '../../harness/init/role-presets';
import { runAutoAssign } from '../../model/auto-assign';
import { langfuseStatus } from '../../model/langfuse';
import { checkSeats, usable as coordUsable } from '../../model/role-fallback';
import { renderPoolReport, reportPools } from '../../model/pool-report';
import {
  TUNABLE_CONFIG_ROLES,
  applyPresetHeadless,
  configSnapshot,
  setKeyHeadless,
  setRoleHeadless,
  toggleHud,
  type KeyTarget,
} from '../../harness/init/headless-config';
import {
  listCustomProviderStatus,
  modelsJsonPath,
  upsertModel,
  upsertProvider,
  type ModelPatch,
} from '../../model/models-json';

export interface ConfigToolDeps {
  /** repo 根 (写 .env / config.json / .claude 的基准)。 */
  cwd: string;
  /** bandit 路由器 (可选) — config_status 展示 arm 学习状态 (bucket/model/n/meanReward)。 */
  router?: { arms(): { bucket: string; model: string; n: number; meanReward: number }[] };
}

const ok = (text: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text' as const, text }],
});
const err = (text: string): { content: { type: 'text'; text: string }[]; isError: true } => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

export function createConfigTools(deps: ConfigToolDeps): OmdMcpTool[] {
  const { cwd } = deps;
  return [
    // -----------------------------------------------------------------------
    makeSetKey(cwd),
    makeApplyPreset(cwd),
    makeSetRole(),
    makeModelsAuto(),
    makeRegisterProvider(),
    makeSetModel(),
    makeConfigStatus(deps.router),
    makeToggleHud(cwd),
  ];
}

// ---------------------------------------------------------------------------

function makeSetKey(cwd: string): OmdMcpTool {
  return {
    name: 'omd_set_key',
    description:
      'Store a provider API key → auth.json (pi providers) or .env (native). Immediate, no reconnect. Never writes .mcp.json.',
    inputSchema: {
      provider: z.string().describe("Provider id, e.g. 'kimi-coding', 'deepseek', 'mimo'"),
      key: z.string().describe('The API key value'),
      target: z
        .enum(['auto', 'authjson', 'env'])
        .default('auto')
        .describe("Where to write: 'auto' routes by provider (default), 'authjson' or 'env' to force"),
    },
    handler: async ({ provider, key, target }) => {
      try {
        const r = setKeyHeadless(provider as string, key as string, (target as KeyTarget) ?? 'auto', {
          cwd,
          env: process.env,
        });
        const lines = [
          `✓ ${r.provider} key 已写 → ${r.target === 'authjson' ? '~/.pi/agent/auth.json (api_key)' : `${cwd}/.env`}`,
          r.immediate ? '  即时生效 (当前 MCP 进程已注入, 无需重连)' : '  需重连 MCP 生效',
          ...r.warnings.map((w) => `  ⚠ ${w}`),
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`omd_set_key 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeApplyPreset(cwd: string): OmdMcpTool {
  const ids = ROLE_PRESETS.map((p) => p.id).join(', ');
  return {
    name: 'omd_apply_preset',
    description:
      'Apply a role-model preset to .env + .omd/config.json (roles/pools/apis). Immediate. Set keys separately via omd_set_key.',
    inputSchema: {
      presetId: z.string().describe(`Preset id — one of: ${ids}`),
    },
    handler: async ({ presetId }) => {
      try {
        const r = applyPresetHeadless(presetId as string, { cwd, env: process.env });
        const lines = [
          `✓ 预设 '${r.presetId}' 已套用 (即时生效)`,
          `  env 角色矩阵: ${r.wroteEnv.length} 项 → ${cwd}/.env`,
          ...(r.configRoles.length
            ? [`  config 角色: ${r.configRoles.map((c) => `${c.role}=${c.coord}`).join(', ')}`]
            : []),
          ...(r.multimodalPool.length ? [`  多模态池: ${r.multimodalPool.join(', ')}`] : []),
          ...(r.customApis.length ? [`  自定 API: ${r.customApis.join(', ')}`] : []),
          ...(r.missingKeys.length
            ? [
                `  ⚠ 无凭证 (用 omd_set_key 补): ${r.missingKeys
                  .map((m) => `${m.provider}→${m.where}`)
                  .join(', ')}`,
              ]
            : ['  ✓ 全角色 provider 凭证就绪']),
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`omd_apply_preset 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeSetRole(): OmdMcpTool {
  const roles = TUNABLE_CONFIG_ROLES.join(', ');
  return {
    name: 'omd_set_role',
    description:
      // 座位名**不在这里抄** —— 手抄的那份写的是 conductor/leaf/verifier/dream, 其中 dream 座
      // 2026-08-02 已摘 (ADR-0003), 另外 13 个座能设却没写在这。全表由 role 参数的 describe
      // 从登记表派生 (D-11 限死本行 ≤120 字符, 16 个座位名塞不进来 —— 那正是该放参数上的理由)。
      'Override one engine seat model coord → .omd/config.json, immediate. Seat list: see the role param.',
    inputSchema: {
      role: z.string().describe(`Role — one of: ${roles}`),
      coord: z.string().describe("Model coordinate 'provider:model', e.g. 'kimi-coding:k3'"),
    },
    handler: async ({ role, coord }) => {
      try {
        const r = setRoleHeadless(role as string, coord as string);
        return ok(`✓ 角色 ${r.role} → ${r.coord} (config.json, 即时生效)`);
      } catch (e) {
        return err(`omd_set_role 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeModelsAuto(): OmdMcpTool {
  return {
    name: 'omd_models_auto',
    description:
      'Auto-assign per-node models by channel economics; persists to .omd/config.json autoAssigned. env still overrides.',
    inputSchema: {},
    handler: async () => {
      try {
        const map = runAutoAssign(process.env);
        const entries = Object.entries(map);
        if (entries.length === 0) {
          return ok(
            'auto-assign: 无可用渠道/评级 → 未写入 (全 node 落 env/写死默认)。先配持仓 (omd_set_key / 声明 plan)。',
          );
        }
        const lines = [
          `✓ auto-assign 已落盘 ${entries.length} node → .omd/config.json autoAssigned (即时生效)`,
          ...entries.map(
            ([node, a]) => `  ${node} → ${a.coord} [${a.channelId}] (intel ${a.intelligence})`,
          ),
          '  per-node OMD_<NODE>_MODEL env 仍高于本层; 想改直接编 config.json autoAssigned 段。',
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`omd_models_auto 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeRegisterProvider(): OmdMcpTool {
  return {
    name: 'omd_register_provider',
    description:
      'Register/update a custom OpenAI/Anthropic provider → models.json. Key as $KEYENV ref (set via omd_set_key).',
    inputSchema: {
      id: z.string().describe("Provider id (coord prefix), e.g. 'zhipu', 'minimax-cn'"),
      baseUrl: z.string().describe('OpenAI/Anthropic-compatible base URL'),
      keyEnv: z.string().describe("Env var name holding the API key (stored as $NAME), e.g. 'ZHIPU_API_KEY'"),
      api: z
        .string()
        .optional()
        .describe("pi api name (default 'openai-completions'; use 'anthropic-messages' for Anthropic-shaped)"),
      models: z
        .array(
          z.object({
            id: z.string().describe('Model id (coord suffix)'),
            maxTokens: z.number().optional().describe('Max output tokens'),
            contextWindow: z.number().optional().describe('Context window size'),
          }),
        )
        .optional()
        .describe('Model entries to upsert (merged by id; omitted models preserved)'),
    },
    handler: async ({ id, baseUrl, keyEnv, api, models }) => {
      try {
        const r = upsertProvider({
          id: id as string,
          baseUrl: baseUrl as string,
          keyEnv: keyEnv as string,
          ...(api ? { api: api as string } : {}),
          ...(models ? { models: models as ModelPatch[] } : {}),
        });
        const lines = [
          `✓ provider '${id}' ${r.created ? '已登记' : '已更新'} → ${modelsJsonPath()}`,
          `  baseUrl=${baseUrl} · apiKey=$${keyEnv} · api=${api ?? 'openai-completions'}`,
          ...(Array.isArray(models) && models.length
            ? [`  models: ${(models as ModelPatch[]).map((m) => m.id).join(', ')}`]
            : []),
          '  两栈 (callModel + agent-leaf) 下次解析即读; key 未设 → 用 omd_set_key 补。',
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`omd_register_provider 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeSetModel(): OmdMcpTool {
  return {
    name: 'omd_set_model',
    description:
      'Update a model maxTokens/contextWindow → models.json. Provider must exist (register it first).',
    inputSchema: {
      coord: z.string().describe("Model coordinate 'provider:model', e.g. 'zhipu:glm-4.6'"),
      maxTokens: z.number().optional().describe('Max output tokens'),
      contextWindow: z.number().optional().describe('Context window size'),
    },
    handler: async ({ coord, maxTokens, contextWindow }) => {
      try {
        const patch = {
          ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
          ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
        };
        if (Object.keys(patch).length === 0) {
          return err('omd_set_model: maxTokens 或 contextWindow 至少给一个');
        }
        const r = upsertModel(coord as string, patch);
        if (!r.providerFound) {
          return err(
            `omd_set_model: provider '${r.provider}' 不在 models.json — 先用 omd_register_provider 登记它。`,
          );
        }
        return ok(
          `✓ model '${coord}' ${r.created ? '已加' : '已更新'} (${Object.entries(patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}) → ${modelsJsonPath()}`,
        );
      } catch (e) {
        return err(`omd_set_model 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeConfigStatus(router?: ConfigToolDeps['router']): OmdMcpTool {
  return {
    name: 'omd_config_status',
    description:
      'Show engine role→model bindings, per-provider credential status, multimodal pool and custom APIs.',
    inputSchema: {},
    handler: async () => {
      try {
        const s = configSnapshot({ env: process.env });
        const mark = (b: boolean): string => (b ? '✓' : '✗无凭证');
        const lines = [
          'omd 引擎配置:',
          '',
          'config 角色:', // 座位名逐行印在下面, 别在标题里再抄一份会漂的清单
          ...s.roles.map((r) => `  ${r.role.padEnd(10)} ${r.resolved.padEnd(34)} [${r.source}] ${mark(r.hasCredential)}`),
        ];
        if (s.envRoles.length) {
          lines.push('', '引擎 env 子角色:');
          for (const e of s.envRoles) lines.push(`  ${e.label.padEnd(16)} ${e.coord.padEnd(34)} ${mark(e.hasCredential)}`);
        }
        // 全座位自检 (INV-MODEL-5): 16 座一览 —— 未配 / 无凭证在这里一眼看见, 而不是跑到一半 402。
        const seats = checkSeats(process.env);
        const badSeats = seats.filter((c) => c.status !== 'ok');
        lines.push('', `全座位自检 (${seats.length} 座, ${badSeats.length} 个不可用):`);
        for (const c of seats) {
          const state = c.status === 'ok' ? '✓' : c.status === 'unset' ? '✗未配' : '✗无凭证';
          lines.push(`  ${c.seat.padEnd(12)} ${(c.coord ?? '—').padEnd(34)} ${state}`);
        }
        if (s.multimodalPool.length) lines.push('', `多模态池: ${s.multimodalPool.join(', ')}`);
        // ── 池: 生效坐标 + **来自哪一层** (2026-08-05) ──────────────────────────
        // owner 一天内连撞三处漂移, 每处都得 grep 全仓才翻得出来 —— 缺的不是配置项,
        // 是一处"能一眼看全 + 说得出来源"的读数。池不经过座位链, 上面那张座位表看不见它们。
        const poolRows = reportPools(process.env);
        lines.push('', '池 (不经过座位链 — 座位表看不见它们):');
        lines.push(...renderPoolReport(poolRows, (c) => `${c}${coordUsable(c, process.env) ? '' : ' ✗无凭证'}`));
        // 可观测出口 (2026-07-31): **开没开要能一眼看见, 没开要说得出缺哪个 env**。
        // 这一行本身是在防这个文件治的那个病 —— 一个"配了以为生效、其实没生效"的观测层
        // 比没有观测层更坏 (你会以为看过了)。
        lines.push('', `Langfuse trace: ${langfuseStatus(process.env)}`);
        // models.json 自定 provider (统一-registry 单一真源, 两栈共读; pi-native 只读, 经 omd_register_provider 写)。
        const customProviders = listCustomProviderStatus(process.env);
        if (customProviders.length) {
          lines.push('', 'models.json 自定 provider (~/.pi/agent/models.json, 两栈共读):');
          for (const cp of customProviders) {
            const models = cp.models.length ? cp.models.map((m) => m.id).join(', ') : '(端点级, 无 per-model)';
            const keyNote = cp.keyEnv ? `$${cp.keyEnv}` : '字面 key';
            lines.push(`  ${cp.id.padEnd(16)} ${mark(cp.hasKey)} ${keyNote} · ${cp.baseUrl}`);
            lines.push(`  ${' '.repeat(16)}   models: ${models}`);
          }
        }
        // bandit 学习状态 (ROUTER-5 成本 reward): 让"静默学习"可见 — n=拉取次数, meanReward=均值。
        const arms = router?.arms() ?? [];
        if (arms.length) {
          lines.push('', 'bandit 选型 (arm 学习状态):');
          for (const a of arms) lines.push(`  [${a.bucket}] ${a.model.padEnd(34)} n=${a.n} meanReward=${a.meanReward.toFixed(3)}`);
        }
        if (s.warnings.length) lines.push('', '⚠ 告警:', ...s.warnings.map((w) => `  ${w}`));
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`omd_config_status 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function makeToggleHud(cwd: string): OmdMcpTool {
  return {
    name: 'omd_toggle_hud',
    description:
      "Install (on=true) or remove (on=false) the DAG/pathfinder live HUD status line in this repo's settings.local.json.",
    inputSchema: {
      on: z.boolean().describe('true = install HUD, false = remove'),
    },
    handler: async ({ on }) => {
      try {
        const r = toggleHud(cwd, on as boolean, { cwd });
        if (r.status === 'failed') return err(`omd_toggle_hud 失败: ${r.reason ?? '未知'}`);
        const msg: Record<Exclude<typeof r.status, 'failed'>, string> = {
          installed: `✓ HUD 已装 → ${r.path} (Claude Code 里打开本 repo 即见, 每 2s 刷新)`,
          already: `HUD statusLine 已在 — 无变更 (${r.path})`,
          removed: `✓ HUD 已移除 (${r.path})`,
          'not-present': 'HUD statusLine 不在本 repo — 无变更',
        };
        return ok(msg[r.status]);
      } catch (e) {
        return err(`omd_toggle_hud 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
