/**
 * src/tui/render/tool-arg —— **工具行的那半句参数**(S-5,2026-08-07)。
 *
 * ## 为什么值得单开一片
 *
 * 实测那张验收截图里,transcript 上是三行 `✓ read` / `✓ edit` / `✓ bash` ——
 * **看得出它动了手,看不出它动了什么**。而"动了哪个文件"恰恰是人唯一想确认的事:
 * 一个改错文件的 agent 和一个改对文件的 agent,在那张屏上长得一模一样。
 *
 * ## 只挑一个字段,不铺参数
 *
 * 铺全部参数就变回了流水账(那正是 `toolStart/toolEnd` 折叠成一行要解决的问题)。
 * 每个工具只有一个"人在意的那一格":文件工具是路径,bash 是命令,grep 是模式。
 * 挑不出来就**什么都不画**,不编一个 `{...}` 占位 —— 空着至少诚实。
 */
import { fitLine } from './line';

/** 参数摘要最多占多少列。整行还要留给工具名与标记。 */
export const ARG_BUDGET = 56;

/**
 * 按**优先级**挑那一格。顺序即语义强度:显式路径 > 命令 > 模式 > 通用兜底。
 *
 * ⚠ 不做 `Object.values()[0]` 这种兜底猜测:参数顺序不是契约,猜出来的那一格
 * 换个工具就指向别的东西 —— 而屏幕上看不出它猜错了。
 */
const FIELDS: readonly string[] = ['path', 'file_path', 'command', 'pattern', 'query', 'name', 'runId', 'goal'];

/**
 * ★ **搜索是两格,不是一格**(2026-08-13,owner 原话「搜了什么文件…能看到」)。
 *
 * 上面那张优先级表把 `path` 排在 `pattern` 前面 —— 对文件工具是对的,对搜索**是反的**:
 * `grep(pattern:'thinking_delta', path:'src/')` 画出来是 `grep src/`,
 * **搜索词一个字都不在屏上**。而"搜的是什么"恰恰是搜索这一步唯一的信息;
 * 范围(`src/`)是次要的,缺了顶多不知道搜哪,缺了搜索词就等于只知道"它搜了"。
 *
 * 所以搜索类单独一条:`词 in 范围`,范围缺席就只画词。**不进 FIELDS 表** ——
 * 那张表的语义是"挑一格",而这里本来就要两格,塞进去会把表的契约改掉。
 */
const SEARCH_TOOLS = new Set(['grep', 'search', 'codegraph_search']);

/**
 * 工具参数 → 一行里的那半句。挑不出 → `null`(调用方画光秃秃的工具名)。
 *
 * `tool` 给了且属于搜索一族 → 走「词 in 范围」两格;省略 = 老行为逐字不变
 * (`summarizeToolArg` 有别的调用点,不能因为多了一个可选参数就改它们的读数)。
 */
export function summarizeToolArg(args: unknown, budget = ARG_BUDGET, tool?: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const rec = args as Record<string, unknown>;
  if (tool && SEARCH_TOOLS.has(tool)) {
    const pattern = typeof rec.pattern === 'string' && rec.pattern.trim() ? rec.pattern.trim() : null;
    const scope = typeof rec.path === 'string' && rec.path.trim() ? rec.path.trim() : null;
    // 词缺席就退回通用挑格 —— 搜索工具没给 pattern 是反常, 但不该因此什么都不画。
    if (pattern) return fitLine(scope ? `${pattern} in ${scope}` : pattern, budget, '…');
  }
  for (const key of FIELDS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return fitLine(v.trim(), budget, '…');
    // 数字也画(如 offset/limit 场景下的 runId 之类);布尔与对象不画 —— 画出来读不出信息。
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** 工具行正文:`read config.txt` / `grep foo in src/` / 挑不出参数时就 `read`。标记由调用方加。 */
export function formatToolLine(name: string, args: unknown, budget = ARG_BUDGET): string {
  const arg = summarizeToolArg(args, budget, name);
  return arg ? `${name} ${arg}` : name;
}
