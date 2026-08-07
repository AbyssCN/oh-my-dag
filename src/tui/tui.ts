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
import { Container, Editor, ProcessTerminal, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import { logger } from '../logger';
import type { OmdBackend } from './backend';
import { ChatLog } from './components/chat-log';
import { StatusLine } from './components/status-line';
import { type ContextFile, formatContextLine, loadConductorContext } from './context';
import { type OmdTuiTheme, createTheme } from './theme';

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
 * **全部 chrome 文案的唯一出处**(S6)。
 *
 * 集中在一处不是整洁癖:字形闸(`render/glyphs.test.ts`)就扫这一个对象。
 * 文案散在 `runOmdTui` 里的话,闸只能扫到我记得列进去的那几条 —— 而漏掉的那条
 * 正好是会超宽的那条。**新增任何 chrome 文案都加到这里**,否则它不过闸。
 *
 * ⚠ 头部原本用 em dash `—`,S6 探针当场判它**歧义宽度**(EAW = A:CJK locale 画 2 列、
 * 别处画 1 列),已改 ASCII `-`。这是探针抓到的第一个真问题。
 */
export const CHROME = {
  header: (cwd: string) => `omd tui - ${cwd}`,
  hint: '打字后回车发一轮;Ctrl+C 两次退出。',
  /** 后端明确拒绝(**断链说明卡**):说出是谁拒的,不编一个回复。 */
  refused: (url: string) => `后端拒绝了这一轮 (${url}): 引擎尚未接通, 这一轮没有发给任何模型`,
  /** 后端抛了:错误原文进屏,同时进日志文件。 */
  failed: (reason: string) => `这一轮发不出去: ${reason}`,
  footer: (url: string) => `[${url}]  Ctrl+C 两次退出`,
  footerArmed: (url: string) => `[${url}]  再按一次 Ctrl+C 退出`,
} as const;

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
  /**
   * conductor 的上下文装配(S4)。省略 → `loadConductorContext(cwd)`。
   *
   * 现在只用来**显示装了哪几份**;S10 接 `runChatTurn` 时同一个数组原样传进
   * `contextFiles` —— 屏上看到的与模型吃到的是同一份,不会各读各的。
   */
  contextFiles?: ContextFile[];
  /** 主题注入(S18 换 Catppuccin 逐值;测试用它固定关色)。省略 → `createTheme()`。 */
  theme?: OmdTuiTheme;
  /** 会话 id。S10 之前只有一条会话,给个稳定默认值即可。 */
  sessionId?: string;
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

  const contextFiles = opts.contextFiles ?? loadConductorContext(opts.cwd);
  const theme = opts.theme ?? createTheme();

  // 三条状态行走 StatusLine (截断, 不折行) —— 状态行一折, 下面所有东西的行号整体下移,
  // 而 HUD 是按行差分画的, 结果是布局错位。对话正文走 ChatLog (折行是对的)。
  const header = new StatusLine(CHROME.header(opts.cwd));
  const harness = new StatusLine(formatContextLine(contextFiles, { cwd: opts.cwd }));
  const chatLog = new ChatLog(theme);
  const editor = new Editor(tui, theme.editor);
  const footer = new StatusLine(CHROME.footer(opts.backend.connection.url));

  chatLog.appendNotice(CHROME.hint);

  const root = new Container();
  root.addChild(header);
  root.addChild(harness);
  root.addChild(chatLog);
  root.addChild(editor);
  root.addChild(footer);
  tui.addChild(root);
  // 焦点给 editor: 打字直接进输入框。Ctrl+C 仍抢在它前面 (input listener 先于焦点分派)。
  tui.setFocus(editor);

  const sessionId = opts.sessionId ?? 'tui';
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

  /**
   * 提交一轮。**这里是 S10 唯一要换的地方** —— 换掉的是 `opts.backend` 的实现,
   * 不是这段代码:UI 只认 `OmdBackend` 那一个形状(SDD §3.1)。
   *
   * ⚠ 拒绝要**画成 notice 不是 assistant**:一句"引擎没接通"若被画成助手发言,
   * 读起来就像模型在回答 —— 那正是本仓 S-1 那一族(看起来在动,其实一次都没生效)。
   */
  async function submit(prompt: string): Promise<void> {
    chatLog.appendUser(prompt);
    editor.setText('');
    editor.addToHistory(prompt);
    tui.requestRender();
    try {
      const res = await opts.backend.sendChat({ sessionId, prompt });
      // `ok:false` 是**响亮的否**, 不是空回复。stub 后端现在走的就是这条。
      if (!res.ok) chatLog.appendNotice(CHROME.refused(opts.backend.connection.url));
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 错误原文进屏, 同时进日志文件 (已改道)。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, sessionId }, '[omd/tui] sendChat 抛了');
      chatLog.appendNotice(CHROME.failed(reason));
    }
    tui.requestRender();
  }

  editor.onSubmit = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return; // 空回车不算一轮 —— 否则会往会话里塞空消息
    void submit(prompt);
  };

  // ⚠ 必须走 addInputListener 而不是组件的 handleInput: 实读 `tui.js:558`,
  // input listener 在**焦点分派之前**跑, 且 `consume: true` 能截住 —— Ctrl+C 必须
  // 抢在任何组件之前, 否则将来 editor 一拿到焦点就把它吃了。
  tui.addInputListener((data: string) => {
    if (data === '\x03') {
      if (decideCtrlC(armedAt, now()) === 'exit') {
        requestExit();
      } else {
        armedAt = now();
        footer.setText(CHROME.footerArmed(opts.backend.connection.url));
        tui.requestRender();
      }
      return { consume: true };
    }
    // 任何非 Ctrl+C 的键都解除预备 —— 否则"按了 C、过一会儿又按 C"会被当成双击。
    if (armedAt !== null) {
      armedAt = null;
      footer.setText(CHROME.footer(opts.backend.connection.url));
      tui.requestRender();
    }
    // ⚠ **不 consume** —— 键要接着往下走到 editor。S2 时这里是 `consume: true` 加自己回显,
    // 那是"还没有输入框"时的临时形态;现在截住等于键盘全废。
    return undefined;
  });

  opts.backend.start();
  tui.start();
  await done;
  await opts.backend.stop();
}
