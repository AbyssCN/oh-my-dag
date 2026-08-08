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
import type { ApprovalRequest } from './gate';

/** 对话框标题行。 */
export function approvalTitle(req: ApprovalRequest): string {
  return `需要审批 · ${req.tier} · ${req.tool}`;
}

/** 键位行 —— admin 档没有 `a`(强制审批,不管多有把握)。 */
export function approvalKeysLine(req: ApprovalRequest): string {
  const grant = req.canGrant ? ` · a 批准 ${Math.max(1, Math.round(req.ttlSec / 60))} 分钟内同档` : '';
  return `d 看详情 · y 批准这一次${grant} · Esc 拒绝`;
}

/** 卡片正文(不含标题)。`detail` = `d` 展开后。 */
export function approvalBody(req: ApprovalRequest, o: { detail: boolean }): string {
  const lines = [`要做什么  ${req.summary}`, `触发原因  ${req.reasons.join(' + ') || req.tier}`, approvalKeysLine(req)];
  if (o.detail && req.preview.length > 0) {
    lines.push('────────', ...req.preview);
  }
  return lines.join('\n');
}
