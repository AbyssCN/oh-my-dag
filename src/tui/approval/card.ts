/**
 * src/tui/approval/card —— 审批单的**渲染面**(纯函数,零 pi-tui import,L1 可直测)。
 *
 * 形状照 v5 设计稿第六节那张单:标题行(档位 + 工具)· 要做什么 · 触发原因 · 键位行;
 * `d` 展开详情(diff / 内容 / 命令全文)。占住输入区由 tui.ts 的 DialogHost 负责,
 * 这里只产字符串。
 *
 * ⚠ 字形纪律:这里的每一句 chrome 都进 `render/glyphs.test.ts` 的样本表;
 * 详情区是**数据**(模型给的内容),不要求干净,靠 Text 组件折行兜住宽度。
 */
import { rule } from '../design/tokens';
import type { ApprovalRequest } from './gate';

/**
 * 详情分隔线的宽度。**定宽而不是跟着终端宽** —— 卡片正文是一段不认识宽度的字符串
 * (宽度在渲染那层才知道),这里跟着宽会要求把宽度一路传进来,不值得。
 */
const PREVIEW_RULE_WIDTH = 8;

/** 对话框标题行。 */
export function approvalTitle(req: ApprovalRequest): string {
  return `Approval needed · ${req.tier} · ${req.tool}`;
}

/** 键位行 —— admin 档没有 `a`(强制审批,不管多有把握)。 */
export function approvalKeysLine(req: ApprovalRequest): string {
  const grant = req.canGrant ? ` · a allows the same tier for ${Math.max(1, Math.round(req.ttlSec / 60))} min` : '';
  return `d shows details · y allows once${grant} · Esc denies`;
}

/** 卡片正文(不含标题)。`detail` = `d` 展开后。 */
export function approvalBody(req: ApprovalRequest, o: { detail: boolean }): string {
  const lines = [`what      ${req.summary}`, `why       ${req.reasons.join(' + ') || req.tier}`, approvalKeysLine(req)];
  if (o.detail && req.preview.length > 0) {
    lines.push(rule(PREVIEW_RULE_WIDTH), ...req.preview);
  }
  return lines.join('\n');
}
