/**
 * src/harness/dag/run-id —— task-based run id mint (owner 选 A, 2026-09-XX)。
 *
 * ## 形状
 *
 * `<slug>-<6hex>` —— 例 `tui-palette-redesign-a3f2be`。
 * - slug = goal/title 文本归一化后小写 + 非 `[a-z0-9{CJK}]` 收为 `-`, 掐 40, 头尾 trim。
 * - 6hex = `crypto.randomUUID()` 去 dash 取前 6 —— 同 slug 撞名时不再撞。
 * - goal 缺席/归一后为空 → 仅 6hex (纯数字/默认 uuid 视觉), 向下兼容。
 *
 * ## 为什么归一里**保留 CJK**
 *
 * omd 是中文宿主, 大半 task 描述是中文 (例: `为 omd TUI 加一个去往选单`)。
 * 若把 CJK 全部 strip → 所有中文 run 都退化成纯 uuid 后缀 → 这条改造的初衷
 * (好分辨) 在宿主最常用的语言上**反生效**。保留 CJK + 6hex 防撞,
 * 文件系统/CLI argv 对 UTF-8 路径都吃得住 (`run-ignition.ts:60-61` 的
 * `[^\w.-]` sanitize 在归一之后已经是字面 a-z/0-9/-/CJK, 不需二次转)。
 *
 * ## 真相键仍是 runId 字符串本身, **不存 alias**
 *
 * - file: `.omd/continuity/<runId>/`
 * - registry: `runId` 主键
 * - checkpoint: `runId` 锚
 * - `/resume <runId>`: 直接透传 (palette 也走同一字符串)
 *
 * 不引入第二列 (alias/title) → schema 不变, 老 uuid 仍是合法的 runId 字符串。
 */
const SLUG_STRIP_RE = /[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g;
const SLUG_TRIM_RE = /^-+|-+$/g;
const SLUG_TRAIL_RE = /-+$/;
const SLUG_MAX = 40;

/**
 * 任务文本 → 文件/UI 安全的 slug。
 * 返空串 ≠ 失败: 调用方据此判定是否走「仅 6hex」分支。
 */
export function slugifyGoal(text: string | undefined | null): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const collapsed = lower.replace(SLUG_STRIP_RE, '-').replace(SLUG_TRIM_RE, '');
  if (collapsed.length <= SLUG_MAX) return collapsed;
  return collapsed.slice(0, SLUG_MAX).replace(SLUG_TRAIL_RE, '');
}

/** 默认 6hex: 剥 dash 的 uuid 取前 6。 */
function defaultHex(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 6);
}

/**
 * Mint 一个 runId。
 * @param goal 任务/裁决文本; 缺席/归一后空 → 仅 6hex。
 * @param randomHex 注入接缝 (测试定值)。默认 = uuid 头 6 位。
 */
export function mintRunId(goal: string | undefined | null, randomHex: () => string = defaultHex): string {
  const slug = slugifyGoal(goal);
  const hex = randomHex();
  return slug ? `${slug}-${hex}` : hex;
}