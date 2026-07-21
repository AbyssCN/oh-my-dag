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
import {
  TUNABLE_CONFIG_ROLES,
  applyPresetHeadless,
  configSnapshot,
  setKeyHeadless,
  setRoleHeadless,
  toggleHud,
  type KeyTarget,
} from '../../harness/init/headless-config';

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
      'Override one engine role model coord → .omd/config.json, immediate. Roles: conductor/leaf/verifier/dream (no plan).',
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
          'config 角色 (conductor/leaf/verifier/dream):',
          ...s.roles.map((r) => `  ${r.role.padEnd(10)} ${r.resolved.padEnd(34)} [${r.source}] ${mark(r.hasCredential)}`),
        ];
        if (s.envRoles.length) {
          lines.push('', '引擎 env 子角色:');
          for (const e of s.envRoles) lines.push(`  ${e.label.padEnd(16)} ${e.coord.padEnd(34)} ${mark(e.hasCredential)}`);
        }
        if (s.multimodalPool.length) lines.push('', `多模态池: ${s.multimodalPool.join(', ')}`);
        if (s.customApis.length) lines.push('', `自定 API: ${s.customApis.map((a) => `${a.id} (${a.baseUrl})`).join(', ')}`);
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
