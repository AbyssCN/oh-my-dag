/**
 * src/harness/tool-render —— 工具**规范值 → 展示串**的纯函数投影(H6, issue #187)。
 *
 * ## 这条缝是干什么的
 *
 * 工具的 `execute` 返回 `{ content, details }`:`content` 是给**模型**看的正文,
 * `details` 是**规范值**(结构化契约)。本文件放的是 `details → 人看的那半句` 的投影 ——
 * **纯函数,不碰 IO,不重跑工具**。于是同一份 `details` 可以被反复重投影:
 * 回放一条历史工具调用、eval 采 fixture、给人/给模型投两种详略,都不必再跑一次工具。
 *
 * ## 为什么从 `tui/render/tool-result.ts` 搬到这里(owner 2026-08-20 裁 A 案)
 *
 * 原先这 6 段投影是 UI 里一个**按工具名字符串派发的 switch**:
 * `if (tool === 'grep') … if (tool === 'read') …` 未命中落 `return null`。两个后果:
 *
 *  - **加一个工具要改第二处** —— 与 `OmdTool` docstring 自己写的「工具与怎么跟模型介绍它
 *    长在一起,加一个工具不必再改第二处」(promptSnippet 那条)直接矛盾;
 *  - **改名即静默失效** —— 名字对不上就落 `null`,屏上那半句**无声消失**,无报错无日志。
 *
 * 现在投影随工具走(`OmdTool.render`),名字改了投影跟着改;覆盖完整性另有闸
 * (`tool-render.test.ts`)钉死,不再靠巧合。
 *
 * ⚠ **措辞就是展示决策**,而它现在长在工具这边 —— 这一条**取代**了
 * `backend-embedded.ts` 与 `tui/render/tool-result.ts` 早先记的「后端只传数据、
 * 挑哪几格怎么措辞归 UI」。取代的理由见上面两条,owner 2026-08-20 裁。
 * UI 仍然决定**画不画**、画在哪一栏;它不再决定**怎么措辞**。
 */

/** 千分位 —— 四位数以上的读数不加分隔符在一行里读不出量级。 */
const n = (v: number): string => v.toLocaleString('en-US');

/** `details` 的松类型面:各工具形状不同,这里只按字段名取。 */
type Details = Record<string, unknown>;

const num = (d: Details, k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
const bool = (d: Details, k: string): boolean => d[k] === true;

/**
 * 一个工具的投影签名。挑不出 → `null`(调用方就不画那半句,**不编一个占位**)。
 *
 * ⚠ 每个工具只挑「人在意的那一格或两格」,不铺全部字段 —— 铺开就变回流水账,
 * 而工具行折叠成一行本来就是为了不让流水账挤掉真正的回复。
 */
export type ToolRender = (details: unknown) => string | null;

/** 非对象 / 数组 / 空 → 投不出东西(所有投影共用的前置)。 */
function asDetails(details: unknown): Details | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return details as Details;
}

export const renderGrepResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  const matches = num(d, 'matches');
  if (matches === null) return null;
  const files = num(d, 'files') ?? 0;
  // 0 命中要**说成 0**,不是留空 —— 「没搜到」是一个读数,不是"没读数"。
  const head = matches === 0 ? 'no match' : `${n(matches)} in ${n(files)} file${files === 1 ? '' : 's'}`;
  // 截断与剪枝**必须跟着命中数一起出现**:`no match` 单独出现读起来是"那儿没有",
  // 而它可能只是"我没走到那儿"。这两条是 agent-tools 那边同一条纪律的屏幕侧。
  const flags: string[] = [];
  if (bool(d, 'walkCapped')) flags.push('capped');
  const skipped = num(d, 'skippedMounts') ?? 0;
  if (skipped > 0) flags.push(`${n(skipped)} mount${skipped === 1 ? '' : 's'} skipped`);
  return flags.length > 0 ? `${head} · ${flags.join(' · ')}` : head;
};

export const renderReadResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  const lines = num(d, 'lines');
  if (lines === null) return null;
  return bool(d, 'truncated') ? `${n(lines)} lines · truncated` : `${n(lines)} lines`;
};

export const renderLsResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  const count = num(d, 'count');
  return count === null ? null : `${n(count)} entr${count === 1 ? 'y' : 'ies'}`;
};

export const renderWriteResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  const bytes = num(d, 'bytes');
  return bytes === null ? null : `${n(bytes)} B`;
};

export const renderEditResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  return d.replaced === true ? '1 replaced' : null;
};

export const renderBashResult: ToolRender = (details) => {
  const d = asDetails(details);
  if (!d) return null;
  const exitCode = num(d, 'exitCode');
  // ⚠ `exitCode` 可以是 `undefined`(被中止/超时杀掉)—— 那与 `exit 0` **不是一回事**,
  //   压成 `exit 0` 就是把"没跑完"画成"跑成功了"。分不出来时说 `no exit code`。
  const head = exitCode === null ? 'no exit code' : `exit ${exitCode}`;
  return bool(d, 'truncated') ? `${head} · output truncated` : head;
};

/**
 * 手工具名 → 投影。**只有一份**:`agent-tools.ts` 给每个工具挂 `render` 时从这里取,
 * 覆盖闸也读这里 —— 两处读同一份,不会各拼一次(S-1 那一族)。
 */
export const HAND_TOOL_RENDERERS: ReadonlyMap<string, ToolRender> = new Map<string, ToolRender>([
  ['grep', renderGrepResult],
  ['read', renderReadResult],
  ['ls', renderLsResult],
  ['write', renderWriteResult],
  ['edit', renderEditResult],
  ['bash', renderBashResult],
]);
