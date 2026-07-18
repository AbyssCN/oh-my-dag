/**
 * createIdentityExtension —— 把 omd 灵魂注入任何 Pi 前端的唯一干净路径。
 *
 * 裁决 (SDD §4 V2.0 唯一未定技术点, 2026-06-01 实测锁):
 *   pi `main(args, { extensionFactories })` **只收 extensionFactories**, 没有 appendSystemPrompt 入口,
 *   CLI 也无 `--append-system-prompt` flag。而 `before_agent_start` 事件可返回 `{ systemPrompt }`
 *   覆盖/链式拼接本轮系统提示 (BeforeAgentStartEventResult.systemPrompt, "If multiple extensions
 *   return this, they are chained")。∴ 灵魂注入 = 一个 before_agent_start handler, append 到 Pi
 *   自己组装好的 systemPrompt 之后。
 *
 * 这条路径终端 TUI (pi main) 与 daemon (PiRuntime 经 DefaultResourceLoader.extensionFactories) 通用,
 * 所以 OmdController 把灵魂封进这个 extension, 所有前端共享同一注入机制 (VAL-INV-11)。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * 造一个把 `identity` append 到本轮 systemPrompt 的 extension 工厂。
 * 幂等: identity 已在 systemPrompt 内 (重复挂载 / 重复轮次) → 不再追加, 防字节膨胀污染 cache。
 */
export function createIdentityExtension(identity: string): ExtensionFactory {
  const block = identity.trim();
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      if (!block) return {};
      if (event.systemPrompt.includes(block)) return {};
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  };
}
