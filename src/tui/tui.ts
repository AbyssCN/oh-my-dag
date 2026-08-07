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
import { type DialogHost, confirm as dialogConfirm, input as dialogInput, select as dialogSelect } from './components/dialog';
import { DagHud } from './components/dag-hud';
import { type PathReader, PathHud, createPathReader } from './components/path-hud';
import { StatusLine } from './components/status-line';
import { type ContextFile, formatContextLine, loadConductorContext } from './context';
import { formatSeatRows, parseSeatCommand, seatRows } from './seat-picker';
import { formatSessions, newSessionId, parseSessionCommand } from './sessions';
import { STARTUP_HINT, formatHelp, parseHelpCommand } from './commands';
import { createFileCompleteProvider } from './file-complete';
import { formatPressure } from './render/pressure';
import { formatSkillList, listSkills, loadSkillBlock, parseSkillCommand } from './skills';
import { type OmdTuiTheme, createTheme } from './theme';

/**
 * HUD 滚动键 → 位移(`0` = 回顶/跟随)。
 *
 * 各终端对 Alt 组合的编码不止一种,所以**几种都收** —— 只认一种的话
 * 换个终端这个功能就静默没了(而 UI 上还写着 `Alt+↑↓ 滚动`)。
 */
const HUD_SCROLL: Record<string, number> = {
  '\x1b[1;3A': -1, // Alt+↑ (xterm 修饰键)
  '\x1b[1;3B': 1, // Alt+↓
  '\x1b\x1b[A': -1, // Alt+↑ (ESC 前缀式, 部分终端)
  '\x1b\x1b[B': 1,
  '\x1b[1;3H': 0, // Alt+Home
  '\x1b[1;3~': 0,
};

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
  hint: STARTUP_HINT,
  /** 后端明确拒绝(**断链说明卡**):说出是谁拒的,不编一个回复。 */
  refused: (url: string) => `后端拒绝了这一轮 (${url}): 引擎尚未接通, 这一轮没有发给任何模型`,
  /** 后端抛了:错误原文进屏,同时进日志文件。 */
  failed: (reason: string) => `这一轮发不出去: ${reason}`,
  /** 工具在跑 / 跑完。真事件真名字, 没有事件就不画这一行。 */
  toolStart: (name: string) => `${name} ...`,
  toolEnd: (name: string, ok: boolean) => `${name} ${ok ? 'ok' : '失败'}`,
  /** 切座位成功 —— 说出改了哪个文件, 别让人猜它生效了没。 */
  seatChanged: (role: string, coord: string) => `座位已改: ${role} -> ${coord} (写入 .omd/config.json, 下一句生效)`,
  seatFailed: (reason: string) => `座位没改成: ${reason}`,
  /** 座位读不出来 (没配过 omd 的仓)。原因原样贴出来 —— 那一格的真值就是解析不到。 */
  seatUnresolved: (reason: string) => `当前座位解析不到: ${reason}`,
  /** 切会话回执 —— 说清切到哪、回放了几条,别让人猜切没切成。 */
  sessionSwitched: (id: string, n: number) => `已切到会话 ${id}(回放 ${n} 条历史)`,
  sessionNew: (id: string) => `已新开会话 ${id}(说第一句话时才真正建文件)`,
  sessionFailed: (reason: string) => `切不过去: ${reason}`,
  /** skill 已挂在**下一句**上 —— 说清它什么时候生效, 别让人以为已经跑了。 */
  skillArmed: (name: string) => `已挂上 skill 「${name}」: 它会作为**下一句**的额外纪律注入 (只这一轮, 不写进会话)`,
  skillMissing: (name: string) => `没有这条 skill: ${name} (用 /skill 看有哪些)`,
  /** 这个后端没有 run 能力(fixture / 远程未实现)。**说出缺的是什么**,不画一个点了没反应的入口。 */
  noRunCapability: (what: string) => `这个后端没有 ${what} 能力 (能力探测: 该方法不存在)`,
  resumeStarted: (runId: string, text: string) => `续跑 ${runId}: ${text}`,
  resumeRefused: (runId: string, text: string) => `续不了 ${runId}: ${text}`,
  footer: (url: string) => `[${url}]  Ctrl+C 两次退出`,
  footerArmed: (url: string) => `[${url}]  再按一次 Ctrl+C 退出`,
} as const;

/**
 * 真座位面:读 `resolveEngineModels`,写 `.omd/config.json`。
 *
 * 动态 import 是为了让**测试注入替身时这两个模块根本不被加载** —— 它们会碰真机配置。
 */
function defaultSeatFace(): NonNullable<RunOmdTuiOpts['seats']> {
  return {
    read: () => {
      // 同步读: 这条路径在渲染回调里, 不能 await。两个模块在 `omd tui` 启动时已被 cli 加载过。
      const { resolveEngineModels } = require('../mcp/assemble') as typeof import('../mcp/assemble');
      const m = resolveEngineModels(process.env);
      // ⚠ `resolveEngineModels` 只出 conductor / leaf 两档 —— verifier 不在它的返回里。
      // 那一格**留空让视图画 `(未解析)`**,不拿 leafModel 冒充:冒充之后
      // "verifier 到底用的什么"这个问题就再也问不出真答案了。
      return { conductor: m.conductorModel, leaf: m.leafModel };
    },
    set: (role: string, coord: string) => {
      const { setRoleHeadless } = require('../harness/init/headless-config') as typeof import('../harness/init/headless-config');
      return setRoleHeadless(role, coord);
    },
  };
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
  /**
   * 座位面(S12)。`read` 给当前三个可调座位的坐标,`set` 写 `.omd/config.json`。
   *
   * 走注入而不是直接 import,是因为**测试不许改真机的 config.json** ——
   * 而这条路径的判据恰恰是"文件真被改了"。省略 → 真的那一套。
   */
  seats?: {
    read: () => Record<string, string>;
    set: (role: string, coord: string) => { role: string; coord: string };
  };
  /** pathfinder 读侧(A4)。省略 → `createPathReader(cwd)` 扫 `docs/plan/pathfinder/`。 */
  pathReader?: PathReader;
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
  // HUD 在没有 run 的时候 `render()` 返回空数组 (无源恒缺席), 所以恒挂着不用条件添加。
  const dagHud = new DagHud(theme, () => opts.backend.connection.url.replace(/^embedded:\/\//, '') || null);
  // A4: pathfinder 前沿票。一张图都没有时 `render()` 返回空数组, 所以恒挂着。
  const pathHud = new PathHud(theme, opts.pathReader ?? createPathReader(opts.cwd));
  pathHud.refresh();
  const editor = new Editor(tui, theme.editor);
  // 模糊文件补全(原生实现 pi-fff 那个能力):打 `@` 或够长的一段路径就弹。
  editor.setAutocompleteProvider(createFileCompleteProvider({ cwd: opts.cwd }));
  const footer = new StatusLine(CHROME.footer(opts.backend.connection.url));
  // 上下文压力行:**跑过一轮才画**(还没跑过时 formatPressure 返回 null → 这一行是空串,
  // 而不是一行全零 —— 全零会读成"跑过了、没花钱")。
  const pressureLine = new StatusLine('');

  chatLog.appendNotice(CHROME.hint);

  // editor 住在自己的容器里 —— 对话框**换掉容器内容**而不是叠 overlay(SDD §7.1 已裁决:
  // 0.84 的 overlay 焦点恢复状态机会在下一次按键夺回焦点, 换 container 没有那个状态机)。
  const editorContainer = new Container();
  editorContainer.addChild(editor);

  const root = new Container();
  root.addChild(header);
  root.addChild(harness);
  root.addChild(chatLog);
  root.addChild(dagHud);
  root.addChild(pathHud);
  root.addChild(editorContainer);
  root.addChild(pressureLine);
  root.addChild(footer);
  tui.addChild(root);
  // 焦点给 editor: 打字直接进输入框。Ctrl+C 仍抢在它前面 (input listener 先于焦点分派)。
  tui.setFocus(editor);

  /**
   * 对话框宿主。**一次只开一个** —— 叠加之后"哪个在收键""Esc 关哪个"都说不清。
   */
  let dialogOpen = false;
  const dialogs: DialogHost = {
    get busy() {
      return dialogOpen;
    },
    open(component, focus) {
      if (dialogOpen) return false;
      dialogOpen = true;
      editorContainer.clear();
      editorContainer.addChild(component);
      tui.setFocus(focus);
      return true;
    },
    close() {
      if (!dialogOpen) return; // 幂等
      dialogOpen = false;
      editorContainer.clear();
      editorContainer.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
    },
    requestRender: () => tui.requestRender(),
  };

  let sessionId = opts.sessionId ?? 'tui';
  const seats = opts.seats ?? defaultSeatFace();
  /** 已唤起、等着挂到下一句上的 skill 正文。**用完即清** —— 一条 skill 只管一轮。 */
  let pendingSkill: string | null = null;
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
    // A7: skill 正文前置到这一句上。**用完即清** —— 不清的话它会在往后每一轮里重复出现。
    const withSkill = pendingSkill ? `${pendingSkill}\n\n${prompt}` : prompt;
    pendingSkill = null;
    editor.setText('');
    editor.addToHistory(prompt);
    tui.requestRender();
    try {
      const res = await opts.backend.sendChat({ sessionId, prompt: withSkill });
      // `ok:false` 是**响亮的否**, 不是空回复。
      if (!res.ok) chatLog.appendNotice(CHROME.refused(opts.backend.connection.url));
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 错误原文进屏, 同时进日志文件 (已改道)。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, sessionId }, '[omd/tui] sendChat 抛了');
      chatLog.appendNotice(CHROME.failed(reason));
    }
    // 无论成败都收尾: 抛错那条路上 `session` 事件不会来, 不收尾的话下一轮会续进这条气泡。
    chatLog.closeStreaming();
    tui.requestRender();
  }

  /**
   * 后端事件 → 屏幕。**这是流式装配的落点**(S8 的 ChatLog 在这里被喂)。
   *
   * ⚠ `chat/delta` 走 `appendAssistantChunk`(追加进**同一条**消息),
   * `session` 事件收尾。收尾这一下不能省:少了它,下一轮的第一片会续到上一轮的气泡里。
   */
  opts.backend.onEvent = (e) => {
    if (e.event === 'chat') {
      const p = e.payload as { type?: string; text?: string };
      if (p?.type === 'delta' && p.text) {
        chatLog.appendAssistantChunk(p.text);
        tui.requestRender();
      }
      return;
    }
    if (e.event === 'tool') {
      const p = e.payload as { phase?: string; name?: string; ok?: boolean };
      const name = p?.name ?? '?';
      chatLog.appendNotice(p?.phase === 'start' ? CHROME.toolStart(name) : CHROME.toolEnd(name, p?.ok !== false));
      tui.requestRender();
      return;
    }
    if (e.event === 'dag') {
      const p = e.payload as { runId?: string; node?: { type?: string } };
      // 换了 run → 清空上一个 run 的节点, 否则两个 run 的节点混成一张表。
      if (p?.node?.type === 'planned' && p.runId) dagHud.beginRun(p.runId);
      if (p?.node) dagHud.apply(p.node as never);
      tui.requestRender();
      return;
    }
    if (e.event === 'session') {
      chatLog.closeStreaming();
      const p = e.payload as { pressure?: import('../harness/chat/usage').ContextPressure; usage?: import('../model/types').ModelUsage };
      const line = formatPressure(p?.pressure ?? null, p?.usage ?? null);
      if (line) pressureLine.setText(line);
      // 一轮跑完可能动过地图 (conductor 有 map_* 工具) → 重读一次。
      // 不在 render 里读盘: render 每帧都调, 那会变成每帧一次目录扫描。
      pathHud.refresh();
      tui.requestRender();
    }
  };

  /**
   * `/seat` —— **本地处理,不发给模型**(S12)。
   *
   * ⚠ 这不是一个 slash 命令注册表(那个方案 SDD L117 已裁决撤回),就是一个前缀判断。
   * 之所以不让 conductor 去调工具改座位:改座位是**有后果的动作**,而且用户此刻要的是
   * 立刻看到 footer 变,不是等一轮模型往返。
   */
  /** 读当前座位。读不出按「未解析」处理并留原因 —— 没配过 omd 的仓里敲 /seat 不该把 UI 掀掉。 */
  function readSeats(): { current: Record<string, string>; err: string | null } {
    // ⚠ `resolveEngineModels` 在座位没配时**抛** (INV-MODEL-5 计划期响亮失败) ——
    // 那对 DAG 起跑是对的, 但对"我就想看看现在都是什么座位"这条只读路径不对
    // (PTY 第一跑就是这么红的)。
    try {
      return { current: seats.read(), err: null };
    } catch (err) {
      return { current: {}, err: err instanceof Error ? err.message : String(err) };
    }
  }

  function applySeat(role: string, coord: string): void {
    try {
      const r = seats.set(role, coord);
      chatLog.appendNotice(CHROME.seatChanged(r.role, r.coord));
      // footer 重读 `connection.url` —— backend 那边是 getter, 座位一改它就变。
      footer.setText(CHROME.footer(opts.backend.connection.url));
    } catch (err) {
      // 拒绝的原因原样进屏 (非法 role / 坐标格式不对), 不吞成一句"失败了"。
      chatLog.appendNotice(CHROME.seatFailed(err instanceof Error ? err.message : String(err)));
    }
    tui.requestRender();
  }

  /**
   * 座位选择器:先挑座位,再改坐标。
   *
   * ⚠ 两步都能 Esc 取消,取消**什么都不改** —— 一个改了一半的座位比没改更糟。
   */
  async function seatPicker(): Promise<void> {
    const { current } = readSeats();
    const rows = seatRows(current);
    const role = await dialogSelect(dialogs, theme, {
      title: '改哪个座位?',
      options: rows.map((r) => ({
        value: r.role,
        label: `${r.role}  ${r.coord}`,
        ...(r.recommend ? { description: r.recommend } : {}),
      })),
    });
    if (role === null) return; // Esc:什么都不改
    const now = rows.find((r) => r.role === role)?.coord ?? '';
    const coord = await dialogInput(dialogs, theme, {
      title: `${role} 换成哪个坐标? (provider:model)`,
      initial: now.startsWith('(') ? '' : now,
    });
    if (coord === null || !coord.trim()) return; // Esc 或空:什么都不改
    applySeat(role, coord.trim());
  }

  function handleSeat(text: string): boolean {
    const cmd = parseSeatCommand(text);
    if (!cmd) return false;
    chatLog.appendUser(text);
    editor.setText('');
    if (cmd.kind === 'list') {
      // 列表照旧进记录(它是可回看的文本), **再**开选择器 —— 两者不互斥:
      // 记录留痕给以后翻, 选择器给现在改。
      const { current, err } = readSeats();
      chatLog.appendNotice(formatSeatRows(seatRows(current)));
      if (err) chatLog.appendNotice(CHROME.seatUnresolved(err));
      tui.requestRender();
      void seatPicker();
      return true;
    }
    if (cmd.kind === 'usage') chatLog.appendNotice(cmd.reason);
    else applySeat(cmd.role, cmd.coord);
    tui.requestRender();
    return true;
  }

  /**
   * `/runs` 与 `/resume <runId>` —— **本地直调装配层工具,不经模型**(S14)。
   *
   * 能力靠**字段在不在**探测(`backend.listRuns ?`),不靠标志位。
   * 后端没有这个能力时说出缺的是什么,而不是画一个点了没反应的入口。
   */
  async function handleRuns(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/runs' && !t.startsWith('/resume')) return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    try {
      if (t === '/runs') {
        if (!opts.backend.listRuns) chatLog.appendNotice(CHROME.noRunCapability('listRuns'));
        else chatLog.appendNotice(await opts.backend.listRuns());
      } else {
        const runId = t.split(/\s+/)[1];
        if (!runId) chatLog.appendNotice('用法: /resume <runId> (先 /runs 看有哪些)');
        else if (!opts.backend.resumeRun) chatLog.appendNotice(CHROME.noRunCapability('resumeRun'));
        else {
          const r = await opts.backend.resumeRun({ runId });
          chatLog.appendNotice(r.ok ? CHROME.resumeStarted(runId, r.text) : CHROME.resumeRefused(runId, r.text));
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, cmd: t }, '[omd/tui] run 命令抛了');
      chatLog.appendNotice(CHROME.failed(reason));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/skill` —— 唤起一条**方法论**(A7)。
   *
   * ⚠ 唤起 ≠ 执行:它把 skill 正文挂到**下一句**上,作为那一轮的额外纪律。
   * 立刻发一轮是错的 —— 用户唤起 skill 是为了"接下来按这套办",而不是"现在就照它跑一遍"。
   */
  function handleSkill(text: string): boolean {
    const cmd = parseSkillCommand(text);
    if (!cmd) return false;
    chatLog.appendUser(text);
    editor.setText('');
    if (cmd.kind === 'list') {
      chatLog.appendNotice(formatSkillList(listSkills()));
    } else {
      const loaded = loadSkillBlock(cmd.name, cmd.rest);
      // 找不到就说没有 —— **不静默注入一个空块**(那会让下一轮以为纪律已经在了)。
      if (!loaded) chatLog.appendNotice(CHROME.skillMissing(cmd.name));
      else {
        pendingSkill = loaded.block;
        chatLog.appendNotice(CHROME.skillArmed(loaded.name));
      }
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/session` —— 列 / 切 / 新开(2026-08-07)。
   *
   * ⚠ **切过去必须清屏并回放那条会话的历史**。不清的话上一条的消息会留着冒充这一条的上下文,
   * 于是模型看到的(ChatStore 里那条)与人看到的(屏上这堆)是两回事 ——
   * 两边都"有内容"、只是不是同一份,那是最难查的一种。
   */
  /** 切过去 + 回放。抽出来是因为**文本命令与选择器两条路都要走它** —— 两份必漂。 */
  async function switchTo(id: string): Promise<void> {
    const history = await opts.backend.loadHistory({ sessionId: id });
    sessionId = id;
    chatLog.replay(history as never);
    chatLog.appendNotice(CHROME.sessionSwitched(id, history.length));
  }

  async function handleSession(text: string): Promise<boolean> {
    const cmd = parseSessionCommand(text);
    if (!cmd) return false;
    chatLog.appendUser(text);
    editor.setText('');
    tui.requestRender();
    try {
      if (cmd.kind === 'list') {
        const list = await opts.backend.listSessions();
        chatLog.appendNotice(formatSessions(list, sessionId));
        tui.requestRender();
        // 列表留痕 + 选择器现挑。一条都没有时 `select` 自己不开框(开个空框让人按 Esc 是耍人)。
        const pick = await dialogSelect(dialogs, theme, {
          title: '切到哪条会话?',
          options: list.map((m) => ({
            value: m.id,
            label: `${m.id === sessionId ? '* ' : '  '}${m.id}`,
            ...(m.title ? { description: m.title } : {}),
          })),
        });
        if (pick !== null && pick !== sessionId) await switchTo(pick);
      } else if (cmd.kind === 'usage') {
        chatLog.appendNotice(cmd.reason);
      } else if (cmd.kind === 'new') {
        sessionId = cmd.id ?? newSessionId();
        chatLog.clear();
        chatLog.appendNotice(CHROME.sessionNew(sessionId));
      } else {
        await switchTo(cmd.id);
      }
    } catch (err) {
      // 切失败时**不许改 sessionId** —— 半切过去会让下一句发进一条不存在的会话。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, cmd: text }, '[omd/tui] session 命令抛了');
      chatLog.appendNotice(CHROME.sessionFailed(reason));
    }
    footer.setText(CHROME.footer(opts.backend.connection.url));
    tui.requestRender();
    return true;
  }

  editor.onSubmit = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return; // 空回车不算一轮 —— 否则会往会话里塞空消息
    if (parseHelpCommand(prompt)) {
      chatLog.appendUser(prompt);
      editor.setText('');
      chatLog.appendNotice(formatHelp());
      tui.requestRender();
      return;
    }
    if (handleSeat(prompt)) return;
    if (handleSkill(prompt)) return;
    void handleSession(prompt).then((handledSession) => {
      if (handledSession) return;
      void handleRuns(prompt).then((handled) => {
        if (!handled) void submit(prompt);
      });
    });
    return;
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
    // HUD 滚动:Alt+↑ / Alt+↓ / Alt+Home。
    // ⚠ 为什么走 input listener 而不是组件的 handleInput:焦点在 editor 上,
    // 组件路由不到这几个键。这里在**焦点分派之前**截,与 Ctrl+C 同一条路。
    // ⚠ 为什么选 Alt 组合:PgUp/PgDn 与方向键都可能是 editor 的绑定,抢了会让输入框残废。
    const scrolled = HUD_SCROLL[data];
    if (scrolled !== undefined) {
      const moved = scrolled === 0 ? dagHud.scrollToTop() : dagHud.scrollBy(scrolled);
      if (moved) tui.requestRender();
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
