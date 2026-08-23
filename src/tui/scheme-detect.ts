/**
 * src/tui/scheme-detect —— **终端亮暗探测**(W4②)。
 *
 * 发 OSC 11 查询背景色,响应解析用 pi-tui 现成件(`parseOsc11BackgroundColor`),
 * 亮度判定在 `theme.ts`(纯函数)。**fail-open 全链**:非 TTY / 终端不答(200ms)/
 * 解析不出 → `null`,调用方回落暗色 —— 探测失败不许拦启动,但要留一行日志证据。
 *
 * 优先级:`OMD_THEME=light|dark` 显式覆盖 > 探测 > 暗色默认 ——
 * 探测毕竟在猜(tmux/嵌套终端会转发失真),人说的算。
 *
 * ⚠ 探测窗口内用户敲的键会被本监听吃掉(不是 OSC 响应就丢)。200ms × 启动一次,
 * 撞上的概率可忽略;真撞上丢的是一次按键不是一段输入。
 */
import { parseOsc11BackgroundColor } from '@earendil-works/pi-tui';
import { schemeFromBackground, type ColorScheme } from './theme';

export function schemeFromEnv(env: NodeJS.ProcessEnv = process.env): ColorScheme | null {
  const v = env.OMD_THEME;
  return v === 'light' || v === 'dark' ? v : null;
}

/** 真探测(impure)。测试面在 `schemeFromEnv` + `schemeFromBackground`,这一层只做 IO 装配。 */
export function detectTerminalScheme(timeoutMs = 200): Promise<ColorScheme | null> {
  const env = schemeFromEnv();
  if (env !== null) return Promise.resolve(env);
  if (!process.stdout.isTTY || !process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    let settled = false;
    const done = (v: ColorScheme | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(v);
    };
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      // 响应没到齐时 parse 返 undefined → 继续攒; 到齐解得出就收。到齐但解不出的
      // 垃圾串走不到 done —— 由 timeout 收尾成 null (等 200ms, 不误判)。
      const rgb = parseOsc11BackgroundColor(buf);
      if (rgb) done(schemeFromBackground(rgb));
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on('data', onData);
      process.stdout.write('\x1b]11;?\x07');
    } catch {
      done(null); // 写不进终端等同不答 —— fail-open, 证据由调用方记
    }
  });
}
