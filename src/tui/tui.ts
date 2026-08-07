/**
 * src/tui/tui —— `omd tui` 的主循环骨架(SDD §4,切片 S2)。
 *
 * ## S2 的边界:这一片**只**证明"壳立得住"
 *
 * 起 TUI → 显示 → 收键 → Ctrl+C 干净退出。**没有对话、没有引擎、没有 HUD** ——
 * 那些是 S8/S10/S11。这一片存在的理由是 SDD §10 第二次重排给出的:
 * `reachability.test.ts` 的根只有 `cli.ts` + `scripts/*.ts` 且**刻意不把测试当根**,
 * 所以 `render/` `context.ts` 这些件在有一条**从 cli.ts 走得到的入口**之前全是孤儿。
 * **先立入口,再填件** —— 这一片就是那条入口。
 *
 * ## §4.1 五条不可协商的约束,这一片兑现了哪几条
 *
 * 1. **自己拦 Ctrl+C** —— ✅ 本片。raw mode 下 Ctrl+C **不产生 SIGINT**,它是 `\x03`
 *    走普通输入;不拦就永远退不出去。双击 500ms 内退出,单击是"预备"。
 * 2. 每行 render 过宽度闸 —— ✅ 本片用 pi 的 `Text`(实读 `components/text.js:55`:
 *    走 `wrapTextWithAnsi` **折行**,不会超宽)。自己写的渲染件进来时(S5)这条要重新过。
 * 3. 日志不进 stdout/stderr —— ⏳ **S3**。本片不打任何日志,所以暂时不冲突;
 *    但 `omd tui` 一旦接上引擎(它会 warn)就必须先做 S3,否则一条 pino 就把 UI 打花。
 * 4. `setInterval` 幂等 + `unref` —— ⏳ 本片无定时器(无动画)。加动画时这条要兑现,
 *    不 unref 会吊住事件循环,`runOmdTui()` 返回后进程不退。
 * 5. 退出前先停动画再拆传输 —— ✅ 形状已就位(`requestExit` 里 stopAnimations 先于
 *    `tui.stop()`),只是本片没有动画可停。
 *
 * ## 可测性:时钟与退出都从外面注入
 *
 * 双击判定是纯函数({@link decideCtrlC}),不碰 `Date.now`;硬退走注入的 `exit`。
 * 于是 L1 能直接测判定,L3 只需要验"真 PTY 里这条链接得起来"。
 */
import { Container, ProcessTerminal, Text, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import type { OmdBackend } from './backend';

/** 双击 Ctrl+C 的窗口。openclaw / pi 一致,不发明新数。 */
export const CTRL_C_WINDOW_MS = 500;

/**
 * 第二次 Ctrl+C 落在窗口内 → 退出;否则 → 预备(并把这次的时刻记下)。
 *
 * 纯函数,时钟从外面给 —— 这样"窗口边界上到底算不算"能被直接测,
 * 而不是靠在测试里 sleep 出一个不确定的读数。
 *
 * @param armedAt 上一次 Ctrl+C 的时刻;`null` = 没有预备中的
 */
export function decideCtrlC(armedAt: number | null, now: number, windowMs = CTRL_C_WINDOW_MS): 'exit' | 'arm' {
  if (armedAt !== null && now - armedAt <= windowMs) return 'exit';
  return 'arm';
}

/**
 * 可打印输入的过滤。**两步,顺序重要**:
 *  ① 先整条剥掉 ESC 序列(CSI `\x1b[...` / SS3 `\x1bO...` / 裸 ESC);
 *  ② 再剥剩下的单个控制字符。
 *
 * ⚠ 只做 ② 是不够的 —— 那样上箭头 `\x1b[A` 会剩下 `[A` 画在屏上,
 * 一个**看起来像用户真打了字**的假回显。剥就要整条剥。
 */
export function printableOnly(data: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端输入本来就是控制码
  const withoutEscapes = data.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
  return withoutEscapes.replace(/[\x00-\x1f\x7f]/g, '');
}

export interface RunOmdTuiOpts {
  /** 唯一接缝(SDD §3.1)。S2 只用它的 `connection` / `start` / `stop`。 */
  backend: OmdBackend;
  cwd: string;
  /** 测试注入(L3 用真 `ProcessTerminal`,L1/L2 可给替身)。 */
  terminal?: Terminal;
  /** 时钟注入 —— 双击窗口的判定要可测。 */
  now?: () => number;
  /** 硬退注入:第二次 `requestExit` 的兜底路径,测试里不许真杀进程。 */
  exit?: (code: number) => void;
}

/**
 * 起 TUI 并**一直 await 到有人要求退出**(SDD §4.2)。
 *
 * ⚠ 刻意**不靠事件循环空转返回** —— 那样"什么时候算结束"取决于有没有别的东西还挂着
 * 定时器,是隐式的。这里只由 `requestExit()` 兑现一个 Promise,结束条件是显式的一处。
 */
export async function runOmdTui(opts: RunOmdTuiOpts): Promise<void> {
  const now = opts.now ?? Date.now;
  const hardExit = opts.exit ?? ((code: number) => process.exit(code));
  const terminal = opts.terminal ?? new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  const header = new Text(`omd tui — ${opts.cwd}`);
  const body = new Text('输入任意字符会在这里回显。');
  const footer = new Text(`[${opts.backend.connection.url}]  Ctrl+C 两次退出`);

  const root = new Container();
  root.addChild(header);
  root.addChild(body);
  root.addChild(footer);
  tui.addChild(root);

  let typed = '';
  let armedAt: number | null = null;
  let exiting = false;
  let resolveExit: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  /**
   * 幂等。第二次调用**直接硬退** —— 那是"第一次退出卡住了"的唯一出路
   * (openclaw 同款:`requestExit` 二次进入即 `process.exit(130)`)。
   */
  function requestExit(): void {
    if (exiting) {
      hardExit(130);
      return;
    }
    exiting = true;
    // §4.1 第 5 条:先停动画再拆传输。S2 无动画,留住顺序本身 ——
    // 等 S11 的 HUD 有了动画, 这里已经是对的位置, 不用再想一次。
    stopAnimations();
    tui.stop();
    resolveExit();
  }

  /** S2 无动画;保留这个函数是为了让 §4.1 第 5 条的**顺序**先于动画存在。 */
  function stopAnimations(): void {}

  // ⚠ 必须走 addInputListener 而不是组件的 handleInput: 实读 `tui.js:558`,
  // input listener 在**焦点分派之前**跑, 且 `consume: true` 能截住 —— Ctrl+C 必须
  // 抢在任何组件之前, 否则将来 editor 一拿到焦点就把它吃了。
  tui.addInputListener((data: string) => {
    if (data === '\x03') {
      if (decideCtrlC(armedAt, now()) === 'exit') {
        requestExit();
      } else {
        armedAt = now();
        footer.setText(`[${opts.backend.connection.url}]  再按一次 Ctrl+C 退出`);
        tui.requestRender();
      }
      return { consume: true };
    }
    // 任何非 Ctrl+C 的键都解除预备 —— 否则"按了 C、过一会儿又按 C"会被当成双击。
    armedAt = null;
    const printable = printableOnly(data);
    if (printable) {
      typed += printable;
      body.setText(`> ${typed}`);
      // ⚠ `setText` 只清组件自己的行缓存, **不触发重绘** (实读 `components/text.js:20-25`)。
      // 少了这一句, 屏幕会停在首帧, 而组件状态其实一直在变 —— 一个"看起来 UI 挂了"
      // 而实际逻辑全对的假象。S2 的 PTY lane 第一次跑就是死在这里。
      tui.requestRender();
    }
    return { consume: true };
  });

  opts.backend.start();
  tui.start();
  await done;
  await opts.backend.stop();
}
