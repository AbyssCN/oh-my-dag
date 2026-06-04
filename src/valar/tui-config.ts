/**
 * src/valar/tui-config —— TUI 部署期策略 (纯函数, 无副作用, 可单测)。
 *
 * `tui.ts` 是 top-level `await main()` 的入口脚本 (import 即启 TUI), 测试不可 import 它。
 * 凡"部署期判定"逻辑都搬到这里, 让策略可证伪 (Valar: 证据 > 直觉), tui.ts 只剩薄接线。
 *
 * 核心原则 (the owner 锁): **我们不 bake 任何模型**。controller 缺 provider/model 直接抛错;
 * tui.ts 的模型来自 env (VALAR_RUNTIME_*) 或部署默认。
 *
 * 注: "弱模型行为脚手架"已退役 (the owner 校准 2026-06-02: 模型迭代快, 行为级 hand-holding ROI 低)。
 * 保留的 hashline (机制级正确性+效率守卫) 收益 model-independent —— 行锚定 patch 不复现 old_string
 * (省 token + 消除 mismatch 错误类) + 快照 stale 检测防腐烂 + 改后返新标签链式连编。任何模型都该用
 * → **默认全开**, 不按强弱门控; `VALAR_HASHLINE_TUI=0` 给偏好 native edit 的人显式关。
 * (通用抗幻觉 grounding 软提示由 controller 默认挂, 不在此门控。)
 */

/**
 * 解析 bool 型 env。
 * `1/true/yes/on` → true · `0/false/no/off` → false · 缺/空/无法识别 → undefined。
 * undefined = "未表态", 让调用方落到自己的默认 (不把无法识别静默当 false)。
 */
export function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return undefined;
}

/**
 * 是否启用 hashline-in-TUI —— 注入 hashline_read/hashline_edit + block 原生 edit。
 *
 * **默认全开 (不按模型门控)**: hashline 对改已存在文件是 model-independent 净赢 —— 行锚定 patch 不复现
 * old_string (省 token + 消除 mismatch 错误类) + stale 检测防腐烂 + 改后返新标签链式连编 (无连续编辑
 * 重读代价)。任何模型 (含 frontier) 都受益, 故不按强弱门控。`VALAR_HASHLINE_TUI=0` 给偏好 native edit
 * 的人显式关 (env 是唯一旋钮)。
 */
export function resolveHashlineEdit(opts: { envValue: string | undefined }): boolean {
  return envBool(opts.envValue) ?? true;
}
