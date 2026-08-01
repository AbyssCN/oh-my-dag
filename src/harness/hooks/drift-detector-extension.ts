/**
 * drift-detector 的**交互-TUI 侧**接线 (pi `main()` 那条路)。
 *
 * 与检测核 (`drift-detector.ts`) 分成两个文件, 理由同 `hashline-extension.ts`: 只有这一侧需要
 * `pi-coding-agent`, 而 agent leaf 那条路径要对 CLI 包保持零引用 —— 那件事只有在文件级别才验得动。
 */
import type { ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';
import { createDriftTracker, type DriftDetectorConfig } from './drift-detector';

/**
 * 造 drift-detector **交互-TUI extension** (pi `main()` 那条路)。检测逻辑全在
 * {@link createDriftTracker} 里, 这里只是把它接到 pi 的事件面上。
 */
export function createDriftDetectorHook(config: DriftDetectorConfig = {}): ExtensionFactory {
  return (pi) => {
    const tracker = createDriftTracker(config);

    pi.on('agent_start', () => tracker.reset());

    pi.on('tool_call', (event: ToolCallEvent, _ctx) => {
      tracker.note(event.toolName, event.input);
      // 观察者模式: 不 block, 不放行 (返回 {} = pass through)。
      return {};
    });

    pi.on('context', (event, _ctx) => {
      const text = tracker.takeInjection();
      if (!text) return;
      event.messages.push({ role: 'user' as const, content: [{ type: 'text' as const, text }] } as never);
      logger.debug('[omd/drift] stuck-checklist injected via context');
      return { messages: event.messages };
    });
  };
}
