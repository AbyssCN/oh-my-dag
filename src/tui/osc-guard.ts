/**
 * src/tui/osc-guard —— **OSC 应答尾字节守卫**(2026-09-02)。
 *
 * ## 实测出来的坑 (PTY 注入, 见 handoff 53)
 *
 * 终端对 `OSC 11 ; ?`(背景色查询)的应答形如 `ESC ] 11 ; rgb:0c0c/0c0c/0c0c BEL`。
 * pi-tui 的 `StdinBuffer` 把不完整的 ESC 序列**攒 10ms** 就放行 —— 应答若在结尾 BEL 之前断开
 * 超过 10ms(ConPTY / WSL 这条管道上常见),前半段作为一段「未知 ESC 序列」放行,
 * 而落单的 `\x07` 紧接着到达,**就是 Ctrl+G 的字节** ⇒ omd 的 input listener 把它当成
 * 「切换 DAG 全屏」。用户看到的是:没按键,全屏视图自己弹出来。
 *
 * 复现读数 (scripts 见 /tmp 实验, 已记 handoff): 整段到达 → 不触发; 5ms 断 → 不触发;
 * 30ms 断 → **触发一次**。同一实验里 focus-in/out、DA1、DSR 997、kitty flags 应答都不触发。
 *
 * ## 守卫做什么
 *
 * 纯函数状态机,放在 listener 最前面:
 *   - 收到一段**没有终止符的 OSC 前缀**(`ESC ]` 开头,且不以 BEL / `ESC \` 结尾)→ 吞掉,
 *     记「等尾巴」,窗口 `WINDOW_MS`。
 *   - 等尾巴期间收到 `\x07` 或 `ESC \` → 吞掉(那是应答的尾巴,不是按键),清状态。
 *   - 等尾巴期间收到任何别的东西 → 清状态,原样放行(用户真在打字,不扣押)。
 *   - 没在等尾巴时的 `\x07` → 原样放行(那就是 Ctrl+G)。
 *
 * ⚠ 它不修 StdinBuffer 的 10ms(那在 pi-tui 里,不可配),只在 omd 这一侧把「应答的尾巴」
 * 和「按键」分开。修 pi-tui 是上游的事。
 */

export const OSC_TAIL_WINDOW_MS = 1_000;

/** 不完整的 OSC 前缀: `ESC ]` 开头, 且**没有**以 BEL 或 ST (`ESC \`) 收尾。 */
export function isDanglingOscPrefix(data: string): boolean {
  if (!data.startsWith('\x1b]')) return false;
  return !(data.endsWith('\x07') || data.endsWith('\x1b\\'));
}

export interface OscTailGuard {
  /** `swallow` = 这段不是按键, 别往下分派; `pass` = 正常按键。 */
  feed(data: string, nowMs: number): 'swallow' | 'pass';
}

export function createOscTailGuard(windowMs: number = OSC_TAIL_WINDOW_MS): OscTailGuard {
  let pendingUntil = -1;
  return {
    feed(data, nowMs) {
      if (isDanglingOscPrefix(data)) {
        pendingUntil = nowMs + windowMs;
        return 'swallow';
      }
      if (pendingUntil >= 0) {
        const inWindow = nowMs <= pendingUntil;
        pendingUntil = -1;
        if (inWindow && (data === '\x07' || data === '\x1b\\')) return 'swallow';
      }
      return 'pass';
    },
  };
}
