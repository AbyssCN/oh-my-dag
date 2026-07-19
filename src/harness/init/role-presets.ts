/**
 * init/role-presets —— 角色模型矩阵预设 (wizard 步骤⑥的数据源)。
 *
 * 模型 id 字符串只住这里 (provider 换代改这一个文件); wizard 泛化消费:
 * env 合并进 updates → keyPrompt 补缺 key → persistCustomApi / persistMultimodalPool /
 * persistMultimodalPoolPremium / persistRoleModel 落 config.json → 汇总表。
 *
 * 三档哲学:
 *   ① 基础档 base-opencode-go —— 一把 OPENCODE_API_KEY 走 opencode go 网关, 多家族混编:
 *     deepseek-v4 掌舵/铺量, qwen3.7-plus agent+多模态, glm-5.2 合成+verifier (跨家族一把 key 实现)。
 *   ② 中间档 cn-standard —— deepseek v4 直连: pro 关键角色, flash 铺量;
 *     mimo-2.5 管多模态池 + verifier 跨家族。
 *   ③ 顶配档 cn-ultimate —— kimi k3 掌舵, deepseek pro 评判/合成, qwen 干活+verifier,
 *     zhipu glm-5.2 审查 Spec 轴 + premium 多模态, mimo ultraspeed 极速多模态。
 */
import type { ModelRole } from '../../model/role-models';

/** opencode go 网关默认 base URL (常量易改)。 */
export const OPENCODE_GO_BASE_URL = 'https://api.opencode.ai/v1';
/** Kimi (Moonshot) OpenAI 兼容端点。 */
export const KIMI_BASE_URL = 'https://api.moonshot.cn/v1';
/** Qwen (DashScope) OpenAI 兼容端点。 */
export const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** Zhipu (bigmodel) OpenAI 兼容端点。 */
export const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

// —— 模型坐标 (provider:model) · 换代只改这里 ——
const DS_FLASH = 'deepseek:deepseek-v4-flash';
const DS_PRO = 'deepseek:deepseek-v4-pro';
const MIMO_25 = 'mimo:mimo-2.5';
const MIMO_ULTRASPEED = 'mimo:mimo-2.5-pro-ultraspeed';
const KIMI_K3 = 'kimi:kimi-k3';
const QWEN_PLUS = 'qwen:qwen3.7-plus';
const QWEN_MAX = 'qwen:qwen3.7-max';
const ZHIPU_GLM = 'zhipu:glm-5.2';
// opencode go 网关坐标 (同一把 key, 网关侧多家族)
const OC_DS_PRO = 'opencode-go:deepseek-v4-pro';
const OC_DS_FLASH = 'opencode-go:deepseek-v4-flash';
const OC_QWEN_PLUS = 'opencode-go:qwen3.7-plus';
const OC_GLM = 'opencode-go:glm-5.2';

/** 引擎认识的角色矩阵 env 全集 (role-presets.test.ts 白名单校验用)。 */
export const ROLE_ENV_ALLOWLIST: readonly string[] = [
  'OMD_RUNTIME_PROVIDER',
  'OMD_RUNTIME_MODEL',
  'OMD_CG_CONDUCTOR_MODEL',
  'OMD_CG_LEAF_MODEL',
  'OMD_CG_AGENT_MODEL',
  'OMD_ITER_CONDUCTOR_MODEL',
  'OMD_ITER_LEAF_MODEL',
  'OMD_ITER_AGENT_MODEL',
  'OMD_CONDUCTOR_ESCALATION_MODEL',
  'OMD_PLAN_MODEL',
  'OMD_LENS_MODEL',
  'OMD_REASON_MODEL',
  'OMD_REDUCE_MODEL',
  'OMD_JUDGE_MODEL',
  'OMD_REVIEW_SPEC_MODEL',
  'OMD_LEAF_OVERFLOW_MODEL',
  'OMD_ROUTER_POOL_INPROC',
  'OMD_ROUTER_POOL_AGENT',
];

export interface RolePresetKeyPrompt {
  /** API key 的 env 变量名。 */
  env: string;
  /** 提示语 (人话说明这 key 干嘛的)。 */
  label: string;
  /** 该 key 对应的 provider id — key 跳过时, 该 provider 的 pool/configRoles 写入随之跳过。 */
  provider?: string;
}

export interface RolePresetCustomApi {
  /** provider 名 (坐标前半)。 */
  id: string;
  /** OpenAI 兼容 base URL。 */
  baseUrl: string;
  /** 读 key 的 env 变量名。 */
  keyEnv: string;
}

export interface RolePresetConfigRole {
  /** config.json models 段的角色 (persistRoleModel)。 */
  role: ModelRole;
  coord: string;
}

export interface RolePreset {
  id: string;
  label: string;
  /** 写进 .env 的角色矩阵 (key 必须 ∈ ROLE_ENV_ALLOWLIST)。 */
  env: Record<string, string>;
  /** 多模态便宜层池 (persistMultimodalPool 整体替换; provider key 跳过则剔除该坐标)。 */
  multimodalPool?: string[];
  /** 多模态贵层池 (persistMultimodalPoolPremium; 置信不足/显式深读时升级)。 */
  multimodalPoolPremium?: string[];
  /** 需注册的自定 OpenAI 兼容 API (persistCustomApi 按 id upsert)。 */
  customApis?: RolePresetCustomApi[];
  /** 缺则提示粘贴的 key (回车跳过)。 */
  keyPrompts?: RolePresetKeyPrompt[];
  /** config.json 角色写入 (如 verifier 跨家族)。 */
  configRoles?: RolePresetConfigRole[];
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'base-opencode-go',
    label: '基础档 (opencode go 网关) — 一把 OPENCODE_API_KEY 走多家族 (deepseek/qwen/glm)',
    env: {
      // deepseek-v4-pro 掌关键角色 (runtime/规划/评判/终审/升级)
      OMD_RUNTIME_PROVIDER: 'opencode-go',
      OMD_RUNTIME_MODEL: 'deepseek-v4-pro',
      OMD_PLAN_MODEL: OC_DS_PRO,
      OMD_JUDGE_MODEL: OC_DS_PRO,
      OMD_REASON_MODEL: OC_DS_PRO,
      OMD_CONDUCTOR_ESCALATION_MODEL: OC_DS_PRO,
      // deepseek-v4-flash 铺量 (分解/inproc leaf/镜头)
      OMD_CG_CONDUCTOR_MODEL: OC_DS_FLASH,
      OMD_ITER_CONDUCTOR_MODEL: OC_DS_FLASH,
      OMD_CG_LEAF_MODEL: OC_DS_FLASH,
      OMD_ITER_LEAF_MODEL: OC_DS_FLASH,
      OMD_LENS_MODEL: OC_DS_FLASH,
      // qwen3.7-plus agent 干活 (own-loop leaf)
      OMD_CG_AGENT_MODEL: OC_QWEN_PLUS,
      OMD_ITER_AGENT_MODEL: OC_QWEN_PLUS,
      // glm-5.2 合成 (synth reduce)
      OMD_REDUCE_MODEL: OC_GLM,
    },
    multimodalPool: [OC_QWEN_PLUS],
    multimodalPoolPremium: [OC_GLM],
    // verifier 跨家族 (glm ≠ deepseek 主力) — 一把网关 key 即可实现。
    configRoles: [{ role: 'verifier', coord: OC_GLM }],
    customApis: [{ id: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL, keyEnv: 'OPENCODE_API_KEY' }],
    keyPrompts: [
      { env: 'OPENCODE_API_KEY', label: 'opencode go 网关 API key (一把 key 全家族)', provider: 'opencode-go' },
    ],
  },
  {
    id: 'cn-standard',
    label: '中间档 (deepseek v4 + mimo) — pro 关键角色, flash 铺量, mimo 多模态 + verifier',
    env: {
      // pro 掌关键角色 (runtime/规划/评判/终审/升级)
      OMD_RUNTIME_PROVIDER: 'deepseek',
      OMD_RUNTIME_MODEL: 'deepseek-v4-pro',
      OMD_PLAN_MODEL: DS_PRO,
      OMD_JUDGE_MODEL: DS_PRO,
      OMD_REASON_MODEL: DS_PRO,
      OMD_CONDUCTOR_ESCALATION_MODEL: DS_PRO,
      // flash 铺量 (分解/执行/镜头/合成)
      OMD_CG_CONDUCTOR_MODEL: DS_FLASH,
      OMD_ITER_CONDUCTOR_MODEL: DS_FLASH,
      OMD_CG_LEAF_MODEL: DS_FLASH,
      OMD_ITER_LEAF_MODEL: DS_FLASH,
      OMD_CG_AGENT_MODEL: DS_FLASH,
      OMD_ITER_AGENT_MODEL: DS_FLASH,
      OMD_LENS_MODEL: DS_FLASH,
      OMD_REDUCE_MODEL: DS_FLASH,
    },
    multimodalPool: [MIMO_25],
    // verifier 跨家族 (mimo ≠ deepseek 主力, 避同源盲点)。
    configRoles: [{ role: 'verifier', coord: MIMO_25 }],
    keyPrompts: [
      { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (主力)', provider: 'deepseek' },
      { env: 'MIMO_API_KEY', label: 'MiMo API key (多模态池 + verifier)', provider: 'mimo' },
    ],
  },
  {
    id: 'cn-ultimate',
    label: '顶配档 (kimi k3 掌舵 + deepseek 评判 + qwen 干活 + zhipu 审查 + mimo 极速多模态)',
    env: {
      // kimi k3 掌舵: runtime + 规划 + 分解 + 升级
      OMD_RUNTIME_PROVIDER: 'kimi',
      OMD_RUNTIME_MODEL: 'kimi-k3',
      OMD_PLAN_MODEL: KIMI_K3,
      OMD_CG_CONDUCTOR_MODEL: KIMI_K3,
      OMD_ITER_CONDUCTOR_MODEL: KIMI_K3,
      OMD_CONDUCTOR_ESCALATION_MODEL: KIMI_K3,
      // deepseek pro 评判/终审/合成
      OMD_JUDGE_MODEL: DS_PRO,
      OMD_REASON_MODEL: DS_PRO,
      OMD_REDUCE_MODEL: DS_PRO,
      // zhipu glm-5.2 审 review 的 Spec 轴 (review 管线另行消费)
      OMD_REVIEW_SPEC_MODEL: ZHIPU_GLM,
      // qwen plus 干活 (inproc leaf/lens/agent leaf)
      OMD_CG_LEAF_MODEL: QWEN_PLUS,
      OMD_ITER_LEAF_MODEL: QWEN_PLUS,
      OMD_LENS_MODEL: QWEN_PLUS,
      OMD_CG_AGENT_MODEL: QWEN_PLUS,
      OMD_ITER_AGENT_MODEL: QWEN_PLUS,
      // router bandit 候选池 (pool[0] = 静态默认)
      OMD_ROUTER_POOL_INPROC: `${QWEN_PLUS},${MIMO_ULTRASPEED}`,
      OMD_ROUTER_POOL_AGENT: `${QWEN_PLUS},${QWEN_MAX}`,
    },
    multimodalPool: [QWEN_PLUS, MIMO_ULTRASPEED],
    multimodalPoolPremium: [ZHIPU_GLM, KIMI_K3],
    // verifier 跨家族 → qwen max (≠ kimi 掌舵 / deepseek 评判)
    configRoles: [{ role: 'verifier', coord: QWEN_MAX }],
    customApis: [
      { id: 'kimi', baseUrl: KIMI_BASE_URL, keyEnv: 'KIMI_API_KEY' },
      { id: 'qwen', baseUrl: QWEN_BASE_URL, keyEnv: 'QWEN_API_KEY' },
      { id: 'zhipu', baseUrl: ZHIPU_BASE_URL, keyEnv: 'ZHIPU_API_KEY' },
    ],
    keyPrompts: [
      { env: 'KIMI_API_KEY', label: 'Kimi (Moonshot) API key (掌舵 + premium 多模态)', provider: 'kimi' },
      { env: 'QWEN_API_KEY', label: 'Qwen (DashScope) API key (干活 + verifier + 多模态)', provider: 'qwen' },
      { env: 'ZHIPU_API_KEY', label: 'Zhipu API key (review Spec 轴 + premium 多模态)', provider: 'zhipu' },
      { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (评判 + 合成)', provider: 'deepseek' },
      { env: 'MIMO_API_KEY', label: 'MiMo API key (极速多模态)', provider: 'mimo' },
    ],
  },
];

/** 取坐标的 provider 前半 ('deepseek:xx' → 'deepseek'; 裸名原样返)。 */
export function coordProvider(coord: string): string {
  const sep = coord.indexOf(':');
  return sep === -1 ? coord : coord.slice(0, sep);
}
