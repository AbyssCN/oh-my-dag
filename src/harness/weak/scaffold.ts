/**
 * weak/scaffold —— **"弱模型脚手架"概念已退役** (the owner 校准 2026-06-02)。
 *
 * 原 L4 三条 (推理在前 / 置信外显 / 来源外显) 中:
 *   - 推理在前: 对 reasoning 模型 (MiMo-pro / ds-pro) 冗余; 对我们刻意非-reasoning 的 flash
 *     (conductor, 要快不要二次设计) 有害 → 删。
 *   - 置信外显: 任务级输出偏好, 非模型强弱所属 + 膨胀输出 token → 删。
 *   - 来源外显: **保留并升为通用** —— 法定数字幻觉是 model-agnostic (Opus 也 stale: ALV 25.5%
 *     在多数训练 cutoff 之后), 故对**所有模型**注入这一条。
 *
 * 行为级"弱模型 hand-holding"不再做 (模型迭代快, ROI 低)。真正值得的是**模型外的通用 harness**:
 * 这里的软提示 (GROUNDING_NUDGE) 只是 grounding 的**软**半边, 与 L2 硬闸 (grounding.ts
 * checkProseGrounding + 上层数字-对-权威源校验) 配对 —— 软标签本身不足信, 真护栏在硬闸。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createIdentityExtension } from '../identity-extension';

/** 通用抗幻觉软提示: 法定数字必带源或答"需查证", 不凭记忆 (任何模型记忆都可能 stale)。lean = 控 token。 */
export const GROUNDING_NUDGE = `
<grounding-contract>
任何法定数字 (税率/ALV/截止日/法规条款) 必带引文 [source:…] 或 finlex/vero URL; 无可靠来源时答
"需查证", 绝不凭记忆给数字 (法定数字会变, 任何模型的记忆都可能 stale)。
</grounding-contract>
`.trim();

/**
 * 造通用 grounding 软提示注入 extension (append 本轮 systemPrompt, 幂等)。所有模型默认挂 (universal),
 * 复用身份注入的幂等 append 机制 (与身份语义正交)。
 */
export function createGroundingNudgeExtension(nudge: string = GROUNDING_NUDGE): ExtensionFactory {
  return createIdentityExtension(nudge);
}
