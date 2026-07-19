/**
 * plan/readonly-gate —— **已退役 (D-5: 开放 src)**。
 *
 * 曾经: plan mode = 只读审议座舱, 此文件的纯判定 (isWriteTool / isBashMutation / isDocWritePath)
 * 驱动 plan-extension 的 tool_call 闸, 硬拦一切 src 写。
 *
 * 现在 (D-1 + D-5): plan mode 移除, shift+tab 改绑 pathfinder。pathfinder 是**工作台不是上锁座舱**
 * —— **不设硬只读闸**, src 写直接放行。deliberate/build 边界**迁到更高接缝**:
 * slice → /execute → G3 审查 → owner 签字 (+ prototype 票在 worktree 隔离, D-13)。
 * 唯一保留的硬闸是 hooks/dangerous-cmd (拦不可逆破坏, 任何模式), 那是**另一个正交 hook**, 不在此处。
 *
 * 故此文件的写闸判定全部删除 (ponytail: 删掉迁走后的死代码)。保留文件为落点占位 + 记录迁移决策。
 */

export {};
