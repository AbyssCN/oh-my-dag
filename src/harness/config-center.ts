/**
 * src/harness/config-center —— 统一配置中心 (`/setup` + `/config`)。
 *
 * 一处配齐: ❶角色模型 (plan/conductor/leaf/verifier/dream) ❷多模态 leaf 池 (多选) ❸Web 搜索 key
 * ❹能力开关 ❺语言。分区菜单循环 (omd 美学 header), 即时落盘:
 *   - 角色 / 多模态池 → .omd/config.json (经 role-models persist*)
 *   - key / 开关 → .env (经 upsertEnv, 同步 process.env 本次即生效)
 * 自定 provider 登记已迁 `~/.pi/agent/models.json` (统一-registry D-6, 走 MCP omd_register_provider / 手写)。
 *
 * UX = 分区 select 循环 (非全屏 custom 组件 — 健壮 + 不崩; 全屏 focusable page 是后续 polish)。
 * 角色/池的 provider 列表取自 **callModel registry** (listProviders, 含内置 + 自定 API), 因角色经
 * callModel 跑 — 必须是 callModel-可解析的 provider, 不是 pi 会话 registry 的全集。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProviders, getProvider } from '../model';
import {
  listRoleModels,
  persistRoleModel,
  resolveMultimodalPool,
  persistMultimodalPool,
  type ModelRole,
} from '../model/role-models';
import { persistLang, setLang, type Lang } from './i18n';
import { upsertEnv } from './init/wizard';
import { fg, bold } from './branding';
import { m } from './i18n';

/** ctx.ui 的最小切面 (decoupled + 测试可注入)。 */
export interface ConfigUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

export interface ConfigCenterOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const ROLE_LABEL: Record<ModelRole, string> = {
  plan: 'Plan',
  conductor: 'Conductor',
  leaf: 'Leaf',
  verifier: 'Verifier',
  dream: 'Dream',
  // continuity 不在 MODEL_ROLES(opt-in 后台角色)→ 不进本 TUI 列表;此 label 仅满足类型完整。
  continuity: 'Continuity',
};

const WEB_KEYS = ['TAVILY_API_KEY', 'ANYSEARCH_API_KEY', 'FIRECRAWL_API_KEY', 'JINA_API_KEY'] as const;

/** 把一组 env 更新落 .env (非破坏性 upsert) + 同步 process.env (本次 boot 即可用)。 */
function writeEnvUpdates(cwd: string, env: Record<string, string | undefined>, updates: Record<string, string>): void {
  const path = join(cwd, '.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertEnv(existing, updates), 'utf8');
  for (const [k, v] of Object.entries(updates)) (env as Record<string, string>)[k] = v;
}

/** 选一个 provider:model 坐标 (从 callModel registry)。取消 → undefined。 */
async function pickCoord(ui: ConfigUi): Promise<string | undefined> {
  // 已注册 provider (内置 + models.json 自定) 全放行让用户自选 —— 自定 provider 的多模态元数据不再在
  // config 层维护 (统一-registry: 属性归 models.json, 无 multimodal 标记), 与内置 provider 一致。
  const providers = listProviders();
  if (providers.length === 0) {
    ui.notify(m({ en: 'No provider registered — configure a backend / API first', zh: '无已注册 provider — 先配后端 / API' }), 'warning');
    return undefined;
  }
  const provider = await ui.select(m({ en: 'Pick provider', zh: '选 provider' }), providers);
  if (!provider) return undefined;
  const def = getProvider(provider)?.defaultModel ?? '';
  const model = (await ui.input(m({ en: `Model id for ${provider} (blank = default)`, zh: `${provider} 的 model id (空 = 默认)` }), def)) ?? '';
  const mid = model.trim();
  return mid ? `${provider}:${mid}` : provider;
}

// --- sections ---

async function editRoles(ui: ConfigUi): Promise<void> {
  const cur = listRoleModels();
  const items = cur.map((e) => `${ROLE_LABEL[e.role]}: ${e.resolved} (${e.source})`);
  const picked = await ui.select(m({ en: 'Pick a role to change', zh: '选要改的角色' }), items);
  if (!picked) return;
  const role = cur[items.indexOf(picked)]!.role;
  const coord = await pickCoord(ui);
  if (!coord) return;
  try {
    persistRoleModel(role, coord);
    ui.notify(m({ en: `${ROLE_LABEL[role]} → ${coord} (saved)`, zh: `${ROLE_LABEL[role]} → ${coord} (已存)` }), 'info');
  } catch (e) {
    ui.notify(m({ en: `Save failed: ${String(e)}`, zh: `保存失败: ${String(e)}` }), 'error');
  }
}

async function editMultimodalPool(ui: ConfigUi): Promise<void> {
  for (;;) {
    const pool = resolveMultimodalPool();
    const summary = pool.length ? pool.join(', ') : m({ en: '(empty)', zh: '(空)' });
    const ADD = m({ en: '+ Add model', zh: '+ 添加模型' });
    const DEL = m({ en: '- Remove model', zh: '- 移除模型' });
    const DONE = m({ en: '✓ Done', zh: '✓ 完成' });
    const opts = pool.length ? [ADD, DEL, DONE] : [ADD, DONE];
    const pick = await ui.select(m({ en: `Multimodal leaf pool: ${summary}`, zh: `多模态 leaf 池: ${summary}` }), opts);
    if (!pick || pick === DONE) return;
    if (pick === ADD) {
      const coord = await pickCoord(ui);
      if (coord && !pool.includes(coord)) {
        persistMultimodalPool([...pool, coord]);
        ui.notify(m({ en: `Added ${coord}`, zh: `已加 ${coord}` }), 'info');
      }
    } else if (pick === DEL) {
      const victim = await ui.select(m({ en: 'Remove which', zh: '移除哪个' }), pool);
      if (victim) {
        persistMultimodalPool(pool.filter((c) => c !== victim));
        ui.notify(m({ en: `Removed ${victim}`, zh: `已移除 ${victim}` }), 'info');
      }
    }
  }
}

// 自定 provider 的登记已迁 `~/.pi/agent/models.json` (统一-registry D-6): 交互式加 API 的入口去掉,
// 改走 MCP omd_register_provider / 手写 models.json (两栈共读单一真源)。此处仅保留角色/池/key/能力/语言分区。

async function editWebKeys(ui: ConfigUi, cwd: string, env: Record<string, string | undefined>): Promise<void> {
  const updates: Record<string, string> = {};
  for (const k of WEB_KEYS) {
    const has = env[k] ? '✓' : '·';
    const v = ((await ui.input(m({ en: `${has} ${k} (blank = keep)`, zh: `${has} ${k} (空 = 保持)` }))) ?? '').trim();
    if (v) updates[k] = v;
  }
  if (Object.keys(updates).length) {
    writeEnvUpdates(cwd, env, updates);
    ui.notify(m({ en: `Web keys saved (${Object.keys(updates).join(', ')})`, zh: `Web key 已存 (${Object.keys(updates).join(', ')})` }), 'info');
  }
}

async function editCapabilities(ui: ConfigUi, cwd: string, env: Record<string, string | undefined>): Promise<void> {
  const updates: Record<string, string> = {};
  const budget = ((await ui.input(m({ en: `Budget USD ceiling (now: ${env.OMD_BUDGET_USD ?? 'none'}; blank = keep)`, zh: `预算上限 USD (当前: ${env.OMD_BUDGET_USD ?? '无'}; 空 = 保持)` }))) ?? '').trim();
  if (budget) updates.OMD_BUDGET_USD = budget;
  const fanout = ((await ui.input(m({ en: `Max fanout (now: ${env.OMD_MAX_FANOUT ?? 'default'}; blank = keep)`, zh: `fanout 上限 (当前: ${env.OMD_MAX_FANOUT ?? '默认'}; 空 = 保持)` }))) ?? '').trim();
  if (fanout) updates.OMD_MAX_FANOUT = fanout;
  const verifyOn = await ui.confirm(m({ en: 'Cross-model verification ON?', zh: '跨模型校验开?' }), m({ en: 'No = sets OMD_VERIFY=0 (disable verifier)', zh: '否 = 设 OMD_VERIFY=0 (关校验)' }));
  updates.OMD_VERIFY = verifyOn ? '1' : '0';
  const hashlineOn = await ui.confirm(m({ en: 'Hashline edit ON?', zh: 'Hashline 编辑开?' }), m({ en: 'No = sets OMD_HASHLINE_TUI=0', zh: '否 = 设 OMD_HASHLINE_TUI=0' }));
  updates.OMD_HASHLINE_TUI = hashlineOn ? '1' : '0';
  writeEnvUpdates(cwd, env, updates);
  ui.notify(m({ en: 'Capabilities saved to .env (restart for some to apply)', zh: '能力已存 .env (部分需重启生效)' }), 'info');
}

async function editLang(ui: ConfigUi): Promise<void> {
  const pick = await ui.select(m({ en: 'Language', zh: '语言' }), ['English (en)', '中文 (zh)']);
  if (!pick) return;
  const l: Lang = pick.startsWith('中文') ? 'zh' : 'en';
  persistLang(l);
  setLang(l);
  ui.notify(m({ en: `Language → ${l}`, zh: `语言 → ${l}` }), 'info');
}

/**
 * 跑统一配置中心: 分区菜单循环, 选完区即落盘, 选"完成"/取消退出。
 */
export async function runConfigCenter(ui: ConfigUi, opts: ConfigCenterOpts = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const header = `${bold(fg('cinnabar', '◉ oh-my-dag · OMD'))} ${fg('riceMuted', m({ en: 'config center', zh: '配置中心' }))}`;
  const SEC = {
    roles: m({ en: '❶ Role models', zh: '❶ 角色模型' }),
    mm: m({ en: '❷ Multimodal pool', zh: '❷ 多模态池' }),
    web: m({ en: '❸ Web search keys', zh: '❸ Web 搜索 key' }),
    cap: m({ en: '❹ Capabilities', zh: '❹ 能力开关' }),
    lang: m({ en: '❺ Language', zh: '❺ 语言' }),
    done: m({ en: '✓ Exit', zh: '✓ 退出' }),
  };
  for (;;) {
    const pick = await ui.select(header, [SEC.roles, SEC.mm, SEC.web, SEC.cap, SEC.lang, SEC.done]);
    if (!pick || pick === SEC.done) return;
    if (pick === SEC.roles) await editRoles(ui);
    else if (pick === SEC.mm) await editMultimodalPool(ui);
    else if (pick === SEC.web) await editWebKeys(ui, cwd, env);
    else if (pick === SEC.cap) await editCapabilities(ui, cwd, env);
    else if (pick === SEC.lang) await editLang(ui);
  }
}
