/**
 * omd hooks kernel —— 原生 in-process Pi 事件 handler 装配 (V2-HOOK)。
 *
 * 取代 V1 的子进程桥 (`src/runtime/harness/hook-bridge.ts`, 已删): 不再 Bun.spawn .mjs 子进程跑
 * omd dev-harness hook (那些写 .claude/ 状态的 31 个属 omd 的 Claude Code session, 非 omd runtime)。
 * omd 的 runtime hook 就这一套**自有最小 fail-closed 集**, 灵魂里能内核化的 (认知 M1-M7/身份) 已进
 * OMD_IDENTITY (V2.0), sibling 关注点各归其位 (见下方 deferred slots)。
 *
 * V2-HOOK 落点 = `tool_call` fail-closed 闸 (承重)。后续子模块往 createOmdHooks 增量加 handler:
 *   - V2-MEM   → tool_execution_end memory-capture
 *   - V2-WEAK  → message_end L2 grounding + L3 repair
 *   - V2-ECON  → before_provider_request 三分区冻结前缀 + 账本
 *   - (verify-gate 硬 block 需 re-prompt loop —— pi 的 agent_end 无 result 不能 block, defer)
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createToolGateHook, type ToolGateConfig } from './tool-gate';
import { createDriftDetectorHook, type DriftDetectorConfig } from './drift-detector';

export interface OmdHookConfig {
  /** L1 工具闸 (dangerous-cmd + 白名单)。省略 = 默认开 (安全侧, 仅 dangerous-cmd guard); 设 null = 整闸关 (逃生)。 */
  toolGate?: ToolGateConfig | null;
  /** L0 漂移检测 (spinning detection)。opt-in: 省略/undefined=关; 给对象=开 (默认阈值4, 仅真 spinning 注 stuck-checklist); null=逃生关。
   *  注: drift 注入改消息流 (比 tool-gate 只 block 更具侵入性), 故 opt-in 非全局默认; 交互 TUI 显式开 (tui.ts)。 */
  driftDetector?: DriftDetectorConfig | null;
}

/**
 * 装配 omd runtime 原生 hook → ExtensionFactory[] (喂 controller.hooks / DefaultResourceLoader)。
 * 默认: tool-gate 开 (dangerous-cmd fail-closed)。toolGate:null = 不挂闸 (null 逃生)。
 */
export function createOmdHooks(config: OmdHookConfig = {}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (config.toolGate !== null) {
    factories.push(createToolGateHook(config.toolGate ?? {}));
  }
  // opt-in (省略=关): drift-detector 改消息流, 由前端显式开 (tui.ts 交互 omd 开)。null/undefined 都不挂。
  if (config.driftDetector !== undefined && config.driftDetector !== null) {
    factories.push(createDriftDetectorHook(config.driftDetector));
  }
  return factories;
}

export { createToolGateHook, type ToolGateConfig } from './tool-gate';
export { createDriftDetectorHook, type DriftDetectorConfig } from './drift-detector';
export { createSandboxGuardHook } from './sandbox-guard';
export {
  classifyCommand,
  DANGEROUS_PATTERNS,
  type CommandVerdict,
  type DangerousPattern,
} from './dangerous-cmd';
