/**
 * plan/sdd-template —— `/sdd` canonical plan 的 SDD 增强段 (骨架续写区)。
 *
 * ledger.crystallize 出**共享骨架** (目标/决策/refs + Contracts/红测/落点), /crystallize 与 /sdd 两路同源;
 * 这里是 /sdd 独有的 canonical-plan 增强: 接缝纪律 / 先红 / oracle 硬闸 / 文件边界 / review gate 分级 /
 * D-number 决策表 —— 它们只对「交给 /execute 与 fleet 的正式 plan」有意义, session 纪要 (/crystallize) 不背。
 * 常量字节稳定 (无时间戳/随机), 占位行 `(…)` 风格与 ledger 骨架一致, omd 在 plan mode 续写填充。
 */

/** /sdd 附加段 (append 在共享骨架之后)。 */
export const SDD_EXTRA_SECTIONS = `## 测试接缝 (Seams)
(列出本 feature 的测试接缝 — 每条: 接缝位置 + 注入方式)
纪律: 优先复用现有接缝, 越少越好 (理想=1); 必须新开则取最高位 (最外层可注入点)。
**接缝需 owner 确认后才进实现。**

## 先红纪律
实现前先在预定接缝写红测试 (红→绿→重构), 不许先写实现再补测。
Oracle-cmd 必须包含这些测试。

## Oracle-cmd
(最小确定性绿命令集, exit 0 = pass — /execute 与 dag-build 的硬闸)
\`\`\`bash
# 例: bun run typecheck && bun test <scoped>
\`\`\`

## Allowed files / Forbidden files
(本 slice 允许/禁止触碰的文件清单 — fleet 越界即违约)
- Allowed: (…)
- Forbidden: (…)

## Review Gate
(本 slice 定级 + 理由; 默认 G2, 摸到敏感面即 G3)
- G0 文档/纯机械 → 免审
- G1 骨架 → tsc + scoped test
- G2 常规逻辑 → G1 + 多维对抗审查
- G3 敏感 (schema/auth/安全边界/不可逆) → G2 + Spec 轴对照 + owner 终审

## 决策记录 (D-numbers)
| D# | 决策 | 理由 | 被否替代方案 |
|----|------|------|--------------|
| D-1 | (…) | (…) | (…) |
无法裁决的标 \`?\` 附倾向+理由上报 owner。
`;

/** 组装 /sdd 落盘全文: 共享骨架 (ledger.crystallize 产出) + SDD 增强段。 */
export function renderSddDoc(base: string): string {
  return `${base.replace(/\n*$/, '\n\n')}${SDD_EXTRA_SECTIONS}`;
}
