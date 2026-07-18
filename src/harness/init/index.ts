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
} from './wizard';
export { createReadlineIO } from './readline-io';
