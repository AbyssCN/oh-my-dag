/**
 * src/tui/render/tool-result —— **工具行右半句:结果**(2026-08-13,owner 点名)。
 *
 * ## 为什么值得单开一片(与 `tool-arg` 同一个理由的另一半)
 *
 * `tool-arg` 治的是「看得出它动了手,看不出它动了什么」。这一片治的是剩下那一半:
 * **看得出它搜了,看不出它搜到了什么**。屏上一行 `✓ grep thinking_delta in src/`
 * 之后什么都没有 —— 命中 0 处还是 300 处,读的人分不出来,而这两件事该做的下一步完全不同。
 *
 * ## 料来自 `details`,不是正文
 *
 * omd 的每个工具都返回**结构化 `details`**(`agent-tools.ts` 的 `OmdTool<T>` 那个类型参数):
 * `grep → {matches, files, walked, walkCapped, skippedMounts}`、`read → {lines, truncated}`、
 * `bash → {exitCode, truncated}` …… 拿它渲染而不是去解析正文,是因为正文是给**模型**看的、
 * 随时可能改措辞,而 `details` 是契约。解析正文那条路第一次改文案就会静默失效。
 *
 * ## 后端只传数据,展示决策在这里
 *
 * 与 `tool-arg` 同一条纪律(`backend-embedded.ts` 那句「`args` 原样透传, 由 UI 去挑那半句」):
 * 后端把 `details` 原样发出来,**挑哪几格、怎么措辞是排版**,归 UI。
 */

/** 千分位 —— 四位数以上的读数不加分隔符在一行里读不出量级。 */
const n = (v: number): string => v.toLocaleString('en-US');

/** `details` 的松类型面:各工具形状不同,这里只按字段名取。 */
type Details = Record<string, unknown>;

const num = (d: Details, k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
const bool = (d: Details, k: string): boolean => d[k] === true;

/**
 * 工具 `details` → 工具行右半句。挑不出 → `null`(调用方就不画右半句,**不编一个占位**)。
 *
 * ⚠ 每个工具只挑「人在意的那一格或两格」,不铺全部字段 —— 铺开就变回流水账,
 * 而工具行折叠成一行本来就是为了不让流水账挤掉真正的回复。
 */
export function summarizeToolResult(tool: string, details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const d = details as Details;

  if (tool === 'grep') {
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
  }

  if (tool === 'read') {
    const lines = num(d, 'lines');
    if (lines === null) return null;
    return bool(d, 'truncated') ? `${n(lines)} lines · truncated` : `${n(lines)} lines`;
  }

  if (tool === 'ls') {
    const count = num(d, 'count');
    return count === null ? null : `${n(count)} entr${count === 1 ? 'y' : 'ies'}`;
  }

  if (tool === 'write') {
    const bytes = num(d, 'bytes');
    return bytes === null ? null : `${n(bytes)} B`;
  }

  if (tool === 'edit') {
    return d.replaced === true ? '1 replaced' : null;
  }

  if (tool === 'bash') {
    const exitCode = num(d, 'exitCode');
    // ⚠ `exitCode` 可以是 `undefined`(被中止/超时杀掉)—— 那与 `exit 0` **不是一回事**,
    //   压成 `exit 0` 就是把"没跑完"画成"跑成功了"。分不出来时说 `no exit code`。
    const head = exitCode === null ? 'no exit code' : `exit ${exitCode}`;
    return bool(d, 'truncated') ? `${head} · output truncated` : head;
  }

  return null;
}
