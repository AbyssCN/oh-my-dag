/**
 * src/tui/bang —— `!` bash 直通的纯函数半(解析 + 入上下文的格式)。
 *
 * pi / claude code / dsh 都有的形状:行首 `!` 在**本地**跑命令,输出**进上下文**
 * (下一轮模型看得见)。跑命令那半在 `tui.ts`(它握着 cwd 与 backend),
 * 这里只有可单测的部分 —— `tree-picker` 同款分层理由。
 */

/** `!cmd` / `! cmd` 都认;裸 `!` 交空串(处理层画用法);`!!` 开头不认(历史扩展语义,别抢)。 */
export function parseBang(text: string): { cmd: string } | null {
  const t = text.trim();
  if (!t.startsWith('!') || t.startsWith('!!')) return null;
  return { cmd: t.slice(1).trim() };
}

/** 输出上限(字符)。上下文是要花钱的 —— 一条 `bun test` 几万字全量入账等于把工具输出复制进每一轮。 */
export const BANG_OUTPUT_CAP = 4000;

/**
 * 进会话的那一条(user 角色,模型下一轮读它)。
 *
 * - **尾部**保留不是头部:命令输出的结论(错误、汇总)几乎总在尾巴上。
 * - 截断要**说出截了多少** —— 一段被裁过的输出读起来必须不像完整输出。
 * - exit code 恒印:`0` 与"没跑成"在屏上必须分得开。
 */
export function formatBangEntry(cmd: string, exitCode: number | null, output: string, cap = BANG_OUTPUT_CAP): string {
  const head = `[local shell] $ ${cmd}\n(exit ${exitCode === null ? 'signal' : exitCode})`;
  const trimmed = output.replace(/\s+$/, '');
  if (!trimmed) return `${head}\n(no output)`;
  if (trimmed.length <= cap) return `${head}\n${trimmed}`;
  const tail = trimmed.slice(-cap);
  return `${head}\n[... ${trimmed.length - cap} chars truncated, tail kept ...]\n${tail}`;
}
