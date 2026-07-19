/**
 * init barrel —— omd 首次配置向导 (检测 + 交互配置 + 探针 + .env 落盘)。
 */
export {
  detectRuntimeConfig,
  runInitWizard,
  probeProvider,
  upsertEnv,
  providerById,
  PROVIDERS,
  type ProviderDef,
  type RuntimeConfigStatus,
  type WizardIO,
  type InitWizardDeps,
  type InitWizardResult,
  type ProbeResult,
  applyRolePreset,
  type PresetPersistDeps,
} from './wizard';
export {
  ROLE_PRESETS,
  ROLE_ENV_ALLOWLIST,
  coordProvider,
  OPENCODE_GO_BASE_URL,
  type RolePreset,
  type RolePresetCustomApi,
  type RolePresetKeyPrompt,
  type RolePresetConfigRole,
} from './role-presets';
export { createReadlineIO } from './readline-io';
