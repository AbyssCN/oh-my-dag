/**
 * src/tui/render/link —— **OSC-8 可点路径**(2026-08-21)。
 *
 * ## 为什么现在做
 *
 * omd 满屏 `file:line`(工具行、票板、run 板、错误行),而它们全是**死文本** ——
 * 要跳过去只能人手抄一遍。pi-tui 一直提供 `hyperlink(text, url)`
 * (`dist/terminal-image.js:486`),omd **一次都没用过**(131 个导出里没接上的那 90 个之一)。
 *
 * ## 三条前提都验过, 不是想当然
 *
 * ① **宽度安全**:`visibleWidth` 走 `stripTerminalSequences`,OSC-8 计 **0 列**
 *    (实测 `visibleWidth(plain) === visibleWidth(hyperlink(plain, url))` = 25)。
 *    所以既有的 `fitLine` / `truncateToWidth` 全部不受影响。
 * ② **截断不破坏链接**:`truncateToWidth(linked, 12, '…')` 出来仍是完整的 open/close 对(实测)。
 * ③ **不支持的终端只是看不见**:pi 的 d.ts 原话「In terminals that do not support OSC 8,
 *    the escape sequences are ignored and only the plain text is displayed」。
 *    ⚠ 但 **screen 例外** —— 它不转发 OSC 8,`detectCapabilities`
 *    (`dist/terminal-image.js:47`)在 screen 下把 `hyperlinks` 置 false;tmux 下则真去探一次
 *    (`:15-29` 读 `tmux show -gv @hyperlinks`)。所以能力位必须问它,不能假设。
 *
 * ## 默认**关**, 由 TUI 启动时开一次
 *
 * 与 `createTheme({color})` 同一个惯例。理由不是保守,是本仓那条纪律:
 * 「关色下重拼必须逐字节等于原行」—— 渲染函数默认吐转义会让一票按字节断言的测试
 * (`ticket-board` / `tool-arg` / `chat-log`)在**与它们无关的维度**上变红。
 * ⇒ 纯函数默认恒等,开关由宿主拨。`OMD_NO_HYPERLINKS` 是用户侧的一票否决(照 `NO_COLOR` 的形)。
 */
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui';
import { isAbsolute, resolve } from 'node:path';

let enabled = false;

/**
 * 按终端能力开/关。**只在 TUI 启动时调一次**;不调 = 全程恒等(测试即此态)。
 *
 * @param force 覆盖能力探测(测试注入)。省略 = 问 `getCapabilities().hyperlinks`。
 * @returns 最终是否开启 —— 调用方要印这一位就有得印。
 */
export function initHyperlinks(env: NodeJS.ProcessEnv = process.env, force?: boolean): boolean {
  // 用户一票否决优先于能力探测:能画不等于想要。存在即生效(哪怕空串), 同 NO_COLOR 的判据。
  if (env.OMD_NO_HYPERLINKS !== undefined) enabled = false;
  else enabled = force ?? getCapabilities().hyperlinks;
  return enabled;
}

/** @internal 测试用:回到默认(关)。 */
export function resetHyperlinks(): void {
  enabled = false;
}

export function hyperlinksOn(): boolean {
  return enabled;
}

/**
 * 路径 → `file://` URL。**纯函数**,与开关无关。
 *
 * 相对路径按 `cwd` 解析 —— 终端拿到相对路径无从跳转。
 * ⚠ 不做存在性检查:渲染层不碰盘(一次 `stat` 乘以每行每帧是不能接受的),
 * 而链到一个不存在的文件,后果只是点了没反应,不是画错。
 */
export function fileUrl(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  // 只编码真会歧义的那几个:空格与 `#`/`?`。整串 encodeURI 会把 CJK 路径变成一长串 %xx,
  // 而 OSC-8 的 URL 本来就允许 UTF-8 —— 编了反而在终端的 tooltip 里读不出来。
  return `file://${abs.replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** `path:line` / `path:line:col` 里把行号剥出来 —— 链接指文件, 行号留在可见文本里。 */
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

/**
 * 把一段**可见文本**包成指向 `path` 的 OSC-8 链接。
 *
 * 关着 / 终端不支持 → **原样返回**(逐字节相同,调用方不必分支)。
 *
 * @param text 屏上要显示的字(可能已被截断过 —— 那正是期望的调用顺序:先截再包)
 * @param path 真实路径,可带 `:行号` 后缀
 */
export function linkPath(text: string, path: string, cwd: string): string {
  if (!enabled) return text;
  const bare = path.replace(LINE_SUFFIX, '');
  if (!bare.trim()) return text;
  return hyperlink(text, fileUrl(bare, cwd));
}
