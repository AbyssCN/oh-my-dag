/**
 * 配置读取的结构化 issue (C2, dsh/cordis 吸收计划线 C, 2026-08-17)。
 *
 * 三条配置主干 (config-discovery / .omd/mcp.json / .omd/extensions.json) 的 fail-open
 * 行为不变 —— 坏配置照旧跳过、进程照旧不砖; 变的是证据形态: 此前只有 warn 日志一闪而过,
 * 现在每次跳过都能落成一条可收集的 issue (字段路径 + 原文), 供 `omd config dump` (C3)
 * 一次性打给用户看。sink 是可选参数 —— 不传 = 今天的行为逐字不变。
 */
export interface ConfigIssue {
  /** 哪份配置: 文件路径 (相对/绝对照原样) 或 'env'。 */
  source: string;
  /** 字段路径, 如 `declaredPlans[2].kind` / `mcpServers.foo.args`; 整文件问题为 ''。 */
  path: string;
  message: string;
}

/** issue 收集 sink。省略 = 不收集 (行为与证据面都与引入前一致)。 */
export type ConfigIssueSink = ConfigIssue[];

/** zod SafeParseError 的 issues → ConfigIssue[] (字段路径拼进 path)。 */
export function zodIssues(
  source: string,
  basePath: string,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ConfigIssue[] {
  return issues.map((i) => ({
    source,
    path: [basePath, ...i.path.map(String)].filter(Boolean).join('.'),
    message: i.message,
  }));
}
