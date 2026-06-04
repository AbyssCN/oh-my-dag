/**
 * weak/grounding-gate —— L2 grounding 的 **reactive** TUI 接线 (软闸默认)。
 *
 * GROUNDING_NUDGE (scaffold.ts) 是 grounding 的**软 preventive** 半边 (prompt 提醒模型带源);
 * 此处是 **reactive** 半边: 经 `message_end` 观测助手最终输出 → checkProseGrounding → 按 severity
 * 动作。**开源默认 EMPTY_LEXICON + 'annotate'** → 通用部署 inert (零 pattern 什么都不触发);
 * 即便注入词表, annotate 也只在消息尾追加一行 ⚠️ 免责声明, **绝不拦/不改正文**。
 *
 * a sibling project 审计部署经 opts 注入 a sibling project + severity:'block' (+ D 的 RAG verifier),
 * 才把无源/验真失败的回答硬标记为不可信。这条注入接缝镜像 ValalMemory 的 safeguard 注入 (R5):
 * core tui 跑 domain-free 默认, domain 部署在边界注入词表。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { checkProseGrounding, type GroundingConfig } from './grounding';

/** 接线选项 = grounding 机制层 config (lexicon/severity/verifier)。默认 = 开源 domain-free inert。 */
export type GroundingGateOptions = GroundingConfig;

/**
 * 造 grounding reactive 闸 extension。`message_end` 上观测助手散文, 检出无源法定声明时按 severity:
 *   - 'pass'/'off'  → 不动 (开源无词表时恒走此路)
 *   - 'annotate'    → 消息尾追加 ⚠️ 免责声明 (默认, 软接不拦)
 *   - 'block'       → 追加 🚫 不可信标记 (a sibling project 审计 profile; 真 re-prompt 重答待 agent_end loop)
 */
export function createGroundingGateExtension(opts: GroundingGateOptions = {}): ExtensionFactory {
  return (pi) => {
    pi.on('message_end', (event) => {
      const msg = event.message;
      if (msg.role !== 'assistant') return;
      // 只取文本块 (thinking/toolCall 不是面向用户的散文断言)。
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const verdict = checkProseGrounding(text, opts);
      if (verdict.action === 'pass') return;

      const notice =
        verdict.action === 'block'
          ? `🚫 [grounding] 此回答含未经核验的法定数字, 已标记为不可信: ${verdict.claims
              .map((c) => c.span)
              .join(' / ')}`
          : (verdict.notice ?? '');
      if (!notice) return;

      // message_end 可 return { message } 替换最终消息 (须保持 role)。追加一个文本块, 不动原文。
      return {
        message: {
          ...msg,
          content: [...msg.content, { type: 'text' as const, text: `\n\n${notice}` }],
        },
      };
    });
  };
}
