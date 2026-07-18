/**
 * src/harness/learning/tool-failure-signal — `tool_failure` 信号生产者 (闸门 I 白名单第 2 个 emitter)。
 *
 * 背景: signal-bus 白名单允许 6 类事件进 dream 学习管线, 但此前**只有 drift_stuck 有 producer**。这是
 * 第 2 个: pi `tool_result` hook 上 `isError===true` = 工具**契约层**失败 (≠ 系统崩溃; 是"这么用工具不对"
 * 的可学教训, 见 signal-bus DREAM_ALLOWED_EVENT_TYPES 注释)。
 *
 * 观测-only: 返 {} 不改 result (区别于 output-sandbox 的 patch hook)。经 onFailure 回调发信号 —— producer
 * 保持 bus-agnostic (emit 在 tui 接 signalBus, 镜像 drift onSpinning / grounding onGrounded 的解耦)。
 * error 文本截断有界; 真正的密钥防护在下游 writeFact(scanSecrets) (自动学习路径), 此处只是 runtime 信号。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { contentText, type ToolResultLike } from '../mcp/output-sandbox-extension';
import { logger } from '../../logger';

/** error 文本入信号前截断 (有界 runtime_events row; 不是密钥闸 —— 那在 writeFact)。 */
const MAX_ERR = 500;

export interface ToolFailureSignalOpts {
  /** isError 工具结果 → 发信号 (tui 接 signalBus.emit tool_failure)。 */
  onFailure: (info: { toolName: string; error: string }) => void;
}

/** tool_result hook: isError → onFailure({toolName, error})。观测-only, 失败软降级。 */
export function createToolFailureSignalExtension(opts: ToolFailureSignalOpts): ExtensionFactory {
  return (pi) => {
    pi.on('tool_result', (event) => {
      try {
        const e = event as ToolResultLike;
        if (e.isError) {
          opts.onFailure({ toolName: e.toolName, error: contentText(e.content).slice(0, MAX_ERR) });
        }
      } catch (err) {
        logger.debug({ err: String(err) }, '[omd/learning] tool_failure signal skip');
      }
      return {};
    });
  };
}
