/**
 * src/wright/config-center —— 统一配置中心 (`/setup` + `/config`)。
 *
 * 一处配齐: ❶角色模型 (plan/conductor/leaf/verifier/dream) ❷多模态 leaf 池 (多选) ❸自定 API (随意加,
 * 不限某一个) ❹Web 搜索 key ❺能力开关 ❻语言。分区菜单循环 (羲和美学 header), 即时落盘:
 *   - 角色 / 多模态池 / API 列表 → .wright/config.json (经 role-models persist*)
 *   - key / 开关 → .env (经 upsertEnv, 同步 process.env 本次即生效)
 *
 * UX = 分区 select 循环 (非全屏 custom 组件 — 健壮 + 不崩; 全屏 focusable page 是后续 polish)。
 * 角色/池的 provider 列表取自 **callModel registry** (listProviders, 含内置 + 自定 API), 因角色经
 * callModel 跑 — 必须是 callModel-可解析的 provider, 不是 pi 会话 registry 的全集。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProviders, getProvider, registerCustomApis } from '../model';
import {
  listRoleModels,
  persistRoleModel,
  resolveMultimodalPool,
  persistMultimodalPool,
  listCustomApis,
  persistCustomApi,
  removeCustomApi,
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
async function pickCoord(ui: ConfigUi, opts?: { multimodalOnly?: boolean }): Promise<string | undefined> {
  let providers = listProviders();
  if (opts?.multimodalOnly) {
    // 多模态资格: 内置 provider (deepseek/mimo 等, 无 per-model 元数据) 放行让用户自选;
    // 仅**排除** config.apis 里 multimodal !== true 的自定 API。
    const nonMultimodal = new Set(listCustomApis().filter((a) => a.multimodal !== true).map((a) => a.id));
    providers = providers.filter((p) => !nonMultimodal.has(p));
  }
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
      const coord = await pickCoord(ui, { multimodalOnly: true });
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

async function editApis(ui: ConfigUi, cwd: string, env: Record<string, string | undefined>): Promise<void> {
  for (;;) {
    const apis = listCustomApis();
    const summary = apis.length ? apis.map((a) => a.id).join(', ') : m({ en: '(none)', zh: '(无)' });
    const ADD = m({ en: '+ Add API', zh: '+ 添加 API' });
    const DEL = m({ en: '- Remove API', zh: '- 移除 API' });
    const DONE = m({ en: '✓ Done', zh: '✓ 完成' });
    const opts = apis.length ? [ADD, DEL, DONE] : [ADD, DONE];
    const pick = await ui.select(m({ en: `Custom APIs: ${summary}`, zh: `自定 API: ${summary}` }), opts);
    if (!pick || pick === DONE) return;
    if (pick === ADD) {
      const id = ((await ui.input(m({ en: 'API id (e.g. gemini)', zh: 'API id (如 gemini)' }))) ?? '').trim();
      if (!id) continue;
      const baseUrl = ((await ui.input(m({ en: 'Base URL (OpenAI-compatible)', zh: 'Base URL (OpenAI 兼容)' }))) ?? '').trim();
      if (!baseUrl) continue;
      const keyEnv = ((await ui.input(m({ en: 'Key env var', zh: 'Key 环境变量名' }), `${id.toUpperCase()}_API_KEY`)) ?? '').trim() || `${id.toUpperCase()}_API_KEY`;
      const defaultModel = ((await ui.input(m({ en: 'Default model id (optional)', zh: '默认 model id (可选)' }))) ?? '').trim();
      const multimodal = await ui.confirm(m({ en: 'Multimodal capable?', zh: '有多模态能力?' }), m({ en: 'Mark this API as multimodal (selectable in the multimodal pool)', zh: '标记为多模态 (可选进多模态池)' }));
      const apiDef = { id, baseUrl, keyEnv, defaultModel: defaultModel || undefined, multimodal };
      persistCustomApi(apiDef);
      const key = ((await ui.input(m({ en: `API key for ${id} (written to .env ${keyEnv})`, zh: `${id} 的 API key (写入 .env ${keyEnv})` }))) ?? '').trim();
      if (key) writeEnvUpdates(cwd, env, { [keyEnv]: key });
      // 即时注册进 callModel registry (key 已在 process.env, 同步可读) → 当场可在角色/池 picker 选到, 不必重启。
      const ok = registerCustomApis([apiDef], env).length > 0;
      ui.notify(
        ok
          ? m({ en: `Added API ${id} — registered, selectable now`, zh: `已加 API ${id} — 已注册, 现可选` })
          : m({ en: `Added API ${id} — set its key (${keyEnv}) to register`, zh: `已加 API ${id} — 补 key (${keyEnv}) 后可用` }),
        'info',
      );
    } else if (pick === DEL) {
      const victim = await ui.select(m({ en: 'Remove which', zh: '移除哪个' }), apis.map((a) => a.id));
      if (victim) {
        removeCustomApi(victim);
        ui.notify(m({ en: `Removed ${victim}`, zh: `已移除 ${victim}` }), 'info');
      }
    }
  }
}

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
  const budget = ((await ui.input(m({ en: `Budget USD ceiling (now: ${env.XIHE_BUDGET_USD ?? 'none'}; blank = keep)`, zh: `预算上限 USD (当前: ${env.XIHE_BUDGET_USD ?? '无'}; 空 = 保持)` }))) ?? '').trim();
  if (budget) updates.XIHE_BUDGET_USD = budget;
  const fanout = ((await ui.input(m({ en: `Max fanout (now: ${env.XIHE_MAX_FANOUT ?? 'default'}; blank = keep)`, zh: `fanout 上限 (当前: ${env.XIHE_MAX_FANOUT ?? '默认'}; 空 = 保持)` }))) ?? '').trim();
  if (fanout) updates.XIHE_MAX_FANOUT = fanout;
  const verifyOn = await ui.confirm(m({ en: 'Cross-model verification ON?', zh: '跨模型校验开?' }), m({ en: 'No = sets XIHE_VERIFY=0 (disable verifier)', zh: '否 = 设 XIHE_VERIFY=0 (关校验)' }));
  updates.XIHE_VERIFY = verifyOn ? '1' : '0';
  const hashlineOn = await ui.confirm(m({ en: 'Hashline edit ON?', zh: 'Hashline 编辑开?' }), m({ en: 'No = sets XIHE_HASHLINE_TUI=0', zh: '否 = 设 XIHE_HASHLINE_TUI=0' }));
  updates.XIHE_HASHLINE_TUI = hashlineOn ? '1' : '0';
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
  const header = `${bold(fg('cinnabar', '◉ 羲和 · XIHE'))} ${fg('riceMuted', m({ en: 'config center', zh: '配置中心' }))}`;
  const SEC = {
    roles: m({ en: '❶ Role models', zh: '❶ 角色模型' }),
    mm: m({ en: '❷ Multimodal pool', zh: '❷ 多模态池' }),
    apis: m({ en: '❸ Custom APIs', zh: '❸ 自定 API' }),
    web: m({ en: '❹ Web search keys', zh: '❹ Web 搜索 key' }),
    cap: m({ en: '❺ Capabilities', zh: '❺ 能力开关' }),
    lang: m({ en: '❻ Language', zh: '❻ 语言' }),
    done: m({ en: '✓ Exit', zh: '✓ 退出' }),
  };
  for (;;) {
    const pick = await ui.select(header, [SEC.roles, SEC.mm, SEC.apis, SEC.web, SEC.cap, SEC.lang, SEC.done]);
    if (!pick || pick === SEC.done) return;
    if (pick === SEC.roles) await editRoles(ui);
    else if (pick === SEC.mm) await editMultimodalPool(ui);
    else if (pick === SEC.apis) await editApis(ui, cwd, env);
    else if (pick === SEC.web) await editWebKeys(ui, cwd, env);
    else if (pick === SEC.cap) await editCapabilities(ui, cwd, env);
    else if (pick === SEC.lang) await editLang(ui);
  }
}
