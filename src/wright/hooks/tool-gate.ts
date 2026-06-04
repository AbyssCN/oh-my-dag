/**
 * tool-gate —— wright 的 L1 fail-closed 工具闸 (SDD §11.2 `tool_call` 行 / §6 L1 承重柱 / GP-5)。
 *
 * 弱模型不自觉 → 把约束下沉成代码强制。两道闸, 命中即 block (返 ToolCallEventResult.block):
 *   ① dangerous-cmd: bash 命令过 classifyCommand, 不可逆破坏拦下 (安全, fail-closed)。
 *   ② tool allowlist: 配了 allowedTools 则只放行白名单内工具 (缩小方案空间, GP-5)。
 * 两道都配 null 逃生 (allowedTools 省略 = 放行全部; dangerousCommandGuard:false = 关 ① )。
 *
 * 注: pi 已对 customTool 做 typebox schema 校验 (call 层), 故 schema 闸不在此重复造 (anti-slop)。
 * 此闸只管 pi 不替我们管的两件: 物理破坏命令 + 工具范围。
 */
import { isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';
import { classifyCommand, type CommandVerdict } from './dangerous-cmd';

export interface ToolGateConfig {
  /** bash 不可逆命令 fail-closed 拦截。默认 true (安全侧)。设 false = null 逃生关闸。 */
  dangerousCommandGuard?: boolean;
  /** 工具白名单。省略/undefined = 放行全部 (null 逃生); 给数组 = 只放行表内工具名。 */
  allowedTools?: readonly string[];
}

/**
 * 造 tool_call fail-closed 闸 extension。纯配置 → ExtensionFactory, 无副作用闭包外状态。
 */
export function createToolGateHook(config: ToolGateConfig = {}): ExtensionFactory {
  const guardDangerous = config.dangerousCommandGuard !== false; // 默认开
  const allowlist = config.allowedTools ? new Set(config.allowedTools) : null;

  return (pi) => {
    pi.on('tool_call', (event) => {
      // 闸 ②: 白名单 (先于命令检查 —— 不在范围内的工具直接拒, 不必看参数)。
      if (allowlist && !allowlist.has(event.toolName)) {
        const reason = `工具 ${event.toolName} 不在 wright 白名单内 (L1 闸 / GP-5)`;
        logger.warn({ tool: event.toolName }, '[wright/gate] tool blocked: not allowlisted');
        return { block: true, reason };
      }

      // 闸 ①: bash 不可逆命令 fail-closed。
      if (guardDangerous && isToolCallEventType('bash', event)) {
        const cmd = event.input?.command;

        // Codex G2 H1: bash 调用缺 command = 畸形输入 → fail-closed 拦 (不放行)。
        if (cmd === undefined || cmd === null || cmd === '') {
          logger.warn({ tool: event.toolName }, '[wright/gate] bash call with no command — blocking (fail-closed)');
          return { block: true, reason: 'BLOCKED: bash 调用缺 command 字段 (畸形输入, fail-closed)' };
        }

        // Codex G2 H2: 分类器抛错 = 拦 (不放行) —— fail-closed 契约不能因异常变 fail-open。
        let verdict: CommandVerdict;
        try {
          verdict = classifyCommand(cmd);
        } catch (err) {
          logger.error({ cmd, err: (err as Error).message }, '[wright/gate] classifyCommand threw — blocking (fail-closed)');
          return { block: true, reason: 'BLOCKED: 命令分类器异常 (fail-closed)' };
        }

        if (verdict.dangerous) {
          const reason = `BLOCKED 不可逆命令 [${verdict.label}]: ${verdict.reason}`;
          logger.warn(
            { label: verdict.label, command: cmd },
            '[wright/gate] dangerous command blocked (fail-closed)',
          );
          return { block: true, reason };
        }
      }

      return {};
    });
  };
}
