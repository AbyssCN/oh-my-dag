/**
 * src/tui/logging —— **把日志从终端上挪走**(TUI SDD §8,切片 S3)。
 *
 * ## 为什么这是「唯一一条会静默毁掉 UI 的路」
 *
 * TUI 独占 stdout,而 **stderr 打在同一个终端上,一样会花屏**。所以不是"改道 stderr"就完事
 * (那是 MCP 入口的做法,它只需要保 stdout 纯协议帧),TUI 要的是**两个都不许**。
 *
 * 这条路会**静默**毁 UI:引擎一条 `logger.warn` 插进画面中间,屏幕错位、下一帧覆盖不齐,
 * 而没有任何一处报错。所以它必须在 `runOmdTui()` **之前**生效 —— 之后再改就已经晚了。
 *
 * ## 开不出文件时:静默,不是花屏
 *
 * `mkdir`/`open` 失败(只读 cwd、配额满)有两条出路,选哪条是判断不是反射:
 * 继续让日志打在终端上 = 一个必然花屏的 UI;把 logger 关掉 = 这一程没有日志。
 * **选后者**,因为前者毁的是用户当下正在用的东西,而后者只丢一份诊断。
 *
 * 但「fail-open 可以吞异常,不许吞证据」—— 所以失败原因**存在 `reason` 里**,
 * 并在 `close()`(TUI 已经拆完终端之后)原样打到 stderr。三态靠**另一列**分,不靠猜:
 *   `path=string, reason=null` → 改道成功 · `path=null, reason=string` → 整程静默且说得出为什么。
 */
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { logger, setLoggerDestination } from '../logger';

export interface TuiLogHandle {
  /** 日志文件绝对路径;`null` = 开不出文件,本程日志已整程关闭(原因见 `reason`)。 */
  readonly path: string | null;
  /** 关闭日志的原因;`null` = 没关,正常改道。与 `path` 恰好互补,不会同时为空。 */
  readonly reason: string | null;
  /** 还原日志汇。**必须在 TUI 停掉之后调** —— 它可能往 stderr 写一行原因。 */
  close(): void;
}

/**
 * 把进程内所有 pino 输出改道到 `<cwd>/.omd/logs/omd-tui-<ts>.log`。
 *
 * @param opts.now 时钟注入 —— 文件名可测,不靠"跑两次名字不一样"来判断。
 */
export function redirectTuiLogs(opts: { cwd: string; now?: () => number }): TuiLogHandle {
  const dir = join(opts.cwd, '.omd', 'logs');
  let fd: number;
  let path: string;
  try {
    mkdirSync(dir, { recursive: true });
    path = join(dir, `omd-tui-${(opts.now ?? Date.now)()}.log`);
    fd = openSync(path, 'a');
  } catch (err) {
    const reason = `[omd/tui] 日志文件开不出 → 本程日志已关闭 (${dir}): ${(err as Error).message}`;
    const restoreLevel = logger.level;
    logger.level = 'silent';
    let closed = false;
    return {
      path: null,
      reason,
      close() {
        if (closed) return;
        closed = true;
        logger.level = restoreLevel;
        // 证据出口: 此刻 TUI 已经拆完终端, 往 stderr 写不会再花屏。
        process.stderr.write(`${reason}\n`);
      },
    };
  }

  setLoggerDestination(fd);
  let closed = false;
  return {
    path,
    reason: null,
    close() {
      if (closed) return;
      closed = true;
      // ⚠ 顺序不可换: 先把汇改回 stderr 再关 fd。反过来的话, 关闭之后任何一条 log 都会
      // writeSync 到一个已关闭的 fd → EBADF 抛在别人的 fail-open 路径上。
      setLoggerDestination(2);
      closeSync(fd);
    },
  };
}
