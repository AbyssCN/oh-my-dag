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
import { hostname } from 'node:os';
import { CombinedAutocompleteProvider, Container, Editor, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, type Terminal } from '@earendil-works/pi-tui';
import { logger } from '../logger';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from './approval/gate';
import { approvalBody, approvalTitle } from './approval/card';
import type { OmdBackend } from './backend';
import { ChatLog } from './components/chat-log';
import { DialogBox, ESC as DIALOG_ESC, type DialogHost, confirm as dialogConfirm, input as dialogInput, select as dialogSelect } from './components/dialog';
import { DagHud } from './components/dag-hud';
import { type PathReader, PathHud, createPathReader } from './components/path-hud';
import { StatusLine } from './components/status-line';
import { type ContextFile, formatContextLine, loadConductorContext } from './context';
import { formatSeatRows, parseSeatCommand, seatRows } from './seat-picker';
import { formatSessions, newSessionId, parseSessionCommand } from './sessions';
import { buildSettings, formatSettings, parseSettingsCommand } from './settings';
import { STARTUP_HINT, formatHelp, parseHelpCommand, slashCommands } from './commands';
import { choiceLabel, listModelChoices, parseModelsCommand, sortChoices } from './model-picker';
import { renderLogo } from './render/logo';
import { summarizeToolArg } from './render/tool-arg';
import { formatStatusLine, formatUsageLine } from './render/statusbar';
import { renderTable } from './render/table';
import type { TuiUsageLedger } from './usage/ledger';
import { inTmux, readWorkspaceInfo, sshSegment } from './workspace';
import { formatGroupMembers, formatSkillAll, formatSkillList, groupSkills, listSkills, loadSkillBlock, parseGroupCommand, parseSkillCommand } from './skills';
import { type OmdTuiTheme, colorEnabled, createTheme, truecolorEnabled } from './theme';

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
  hint: STARTUP_HINT,
  /**
   * 欢迎屏的**正文**(字标由 `render/logo` 出,颜色由调用方分层上)。
   *
   * ⚠ 只列**这一屏之外看不到**的事实(引擎坐标 / 会话 id),不复述顶栏已经写着的 cwd ——
   * 首屏重复一遍同一件事,读者会以为那是两个不同的东西。
   *
   * ⚠ 提示行用 ASCII `>` 而不是 Kun 那个 `›`:后者(U+203A)**没进过字形表**,
   * 判定是 `unmeasured` —— 好看程度不值得拿一个没量过的字形去赌布局。
   */
  welcomeBody: (o: { engine: string; session: string; width: number }) =>
    [
      ...renderTable(
        [
          ['引擎', o.engine],
          ['会话', o.session],
        ],
        o.width,
      ),
      '',
      `  > ${STARTUP_HINT}`,
      '  > PgUp / PgDn 回看历史',
    ].join('\n'),
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
  // 行③帮助条。`omd tui` 字样留在这 —— 顶栏没了(v5: 信息下沉), 这一串同时是 PTY 的启动信标。
  footer: (url: string) => `omd tui · /help 看命令 · Ctrl+C 两次退出  [${url}]`,
  footerArmed: (url: string) => `omd tui · 再按一次 Ctrl+C 退出  [${url}]`,
  // ── 审批层(切片①)。裁决回执要进对话记录 —— 卡片关掉之后, "刚才批没批过"得能回看。 ──
  approvalDenied: (summary: string) => `审批: 已拒绝 ${summary}`,
  approvalOnce: (summary: string) => `审批: 已批准这一次 ${summary}`,
  approvalGranted: (summary: string, min: number) => `审批: 已批准 ${summary} (同档 ${min} 分钟内免审)`,
  /** 对话框被占时新到的审批单按拒绝处理(fail-closed)—— 说出为什么, 别静默拒。 */
  approvalBusy: (summary: string) => `审批: 另一个对话框开着, 已按拒绝处理 ${summary}`,
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
  /**
   * 扩展加载结果(S15a)。**被拒的也要传进来** —— 设置面板要说出缺了什么,
   * 藏在日志里等于加载期硬失败白做了。
   */
  extensions?: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[];
  /**
   * 审批闸(切片①)。UI 在这里把 ask handler 接上 —— 审批单占住输入区,
   * `d` 看详情 · `y` 批准一次 · `a` 批准同档一段时间(admin 没有) · Esc 拒绝。
   * 省略 = 没有审批面(fixture 之外的生产装配都该给)。
   */
  approvals?: ApprovalGate;
  /**
   * 调用账本(切片②)。底栏行①的「会话/5h」与行②的 in/out/cache + provider 段全从它取。
   * 省略 = 那些段**不画**(没有账本不是 $0 —— segment 模型)。
   */
  usage?: TuiUsageLedger;
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
  /**
   * **全屏**(S-1,2026-08-07)。立项时裁的是"不做全屏",那条被 owner 的新判据翻掉:
   * 输入框钉底 + 左侧栏这两件事在 inline 模式下**做不出来** —— inline 只能从上往下堆,
   * 底下永远是空的(基线截图 40 行里空了 25 行,就是这个)。
   *
   * ⚠ 代价是终端 scrollback 不再留对话 → 由 {@link dumpTranscript} 在退出时补回主屏。
   * 那是 owner 明确要的约束,不是可选项:一退什么都没了比不好看严重得多。
   */
  const tui = new TuiAltScreen(terminal);

  const contextFiles = opts.contextFiles ?? loadConductorContext(opts.cwd);
  const theme = opts.theme ?? createTheme();

  // 状态行走 StatusLine (截断, 不折行) —— 状态行一折, 下面所有东西的行号整体下移,
  // 而 HUD 是按行差分画的, 结果是布局错位。对话正文走 ChatLog (折行是对的)。
  // ⚠ 顶栏(`omd tui - cwd`)已去掉 —— v5 裁决: 信息下沉到底部三行, 仓名/分支在行①。
  const harness = new StatusLine(formatContextLine(contextFiles, { cwd: opts.cwd }));
  const chatLog = new ChatLog(theme);
  // HUD 在没有 run 的时候 `render()` 返回空数组 (无源恒缺席), 所以恒挂着不用条件添加。
  const dagHud = new DagHud(theme, () => opts.backend.connection.url.replace(/^embedded:\/\//, '') || null);
  // A4: pathfinder 前沿票。一张图都没有时 `render()` 返回空数组, 所以恒挂着。
  const pathHud = new PathHud(theme, opts.pathReader ?? createPathReader(opts.cwd));
  pathHud.refresh();
  const editor = new Editor(tui, theme.editor);
  // 补全:**行首 `/` 出命令,其余出文件** —— 走 pi-tui 的 `CombinedAutocompleteProvider`。
  // ⚠ 此前只挂了自写的文件补全, 于是打 `/settings` 弹出来的是一堆文件名(owner 截图抓到的)。
  //   斜杠开头本该出命令, 而这件事 pi-tui 本来就做好了。
  // S-6: skill 组也进补全(`/omd` `/lark` …)。**启动时算一次** —— 见 commands.ts 的说明。
  const startupGroups = groupSkills(listSkills()).groups.map((g) => ({ name: g.name, count: g.members.length }));
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(startupGroups), opts.cwd));
  const footer = new StatusLine(CHROME.footer(opts.backend.connection.url));
  // 底栏行①② (切片②, v5 第一节样张)。segment 模型: 没数据的段不画,
  // 所以启动时行②多半是空串 (窗口里没记录) —— 那不是 bug, 是「还没烧过」的真值。
  const statusLine = new StatusLine('');
  const usageLine = new StatusLine('');

  /**
   * 欢迎屏(S-3)。字标走 brand(整屏最亮的一处),正文走 dim —— **分层是判据不是口味**:
   * 一屏里两处同等亮度就没有"第一眼落在哪"这回事了。
   *
   * ⚠ 宽度取的是**启动那一刻**的列数。终端后来被拉窄不会重画这一块(它已经是历史消息了),
   * 但字标本身不折行、窄了会被 ChatLog 截断,不会顶花布局。
   */
  const bannerWidth = terminal.columns || 100;
  chatLog.appendBanner(
    [
      // 顶栏与字标之间留一行 —— 贴着画时字标第一行读起来像是顶栏的一部分。
      '',
      ...renderLogo(bannerWidth).map(theme.chrome.brand),
      '',
      ...CHROME.welcomeBody({
        engine: opts.backend.connection.url,
        session: opts.sessionId ?? 'tui',
        width: bannerWidth,
      })
        .split('\n')
        .map(theme.chrome.dim),
    ].join('\n'),
  );

  // editor 住在自己的容器里 —— 对话框**换掉容器内容**而不是叠 overlay(SDD §7.1 已裁决:
  // 0.84 的 overlay 焦点恢复状态机会在下一次按键夺回焦点, 换 container 没有那个状态机)。
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  /**
   * 对话框自己的槽位 —— **编辑器一直挂着,不再被换出去**(S-1 修回归)。
   *
   * 原来的做法是 `editorContainer.clear()` 把 editor 摘掉、放进对话框,关掉再放回来。
   * 换成全屏布局树之后这条路有个**静默**症状:对话框开关一轮之后,编辑器还能打字、
   * 还有焦点,但**斜杠补全再也不弹**(实测:不开对话框直接打 `/res` 弹得出 `→ resume <runId>`;
   * 开一次 `/settings` 再 Esc 关掉,同样打 `/res` 就什么都没有)。单变量对照过 ——
   * 只按 Esc 不开对话框,补全正常,所以怪的是摘挂不是 Esc。
   *
   * 不去猜 pi-tui 内部为什么:**编辑器根本不该被摘下来**。对话框开在它上方的独立槽位,
   * 它只是不收键 —— claude code / pi 的选择器也都是这个形状(输入框一直在)。
   */
  const dialogSlot = new Container();

  /**
   * 对话区吃掉**所有剩余高度** —— 于是输入框与状态行被顶到屏底(rubric V3)。
   *
   * ⚠ `grow` 必须给在 ScrollView 上,不能给 chatLog:chatLog 的高度就是内容高度,
   * 给它 grow 只会让它长出屏幕外。"占住位置且可滚"是 viewport 的语义,不是内容的。
   */
  const transcript = new ScrollView(chatLog, { follow: 'end', primary: true, scrollbar: 'auto' });

  /**
   * ★ **只有 transcript 可压,chrome 一律 `shrink: 0`。**
   *
   * `allocateStackSizes` 的规则(实读 `components/stack.js:99`):先取各条目的**固有高度**,
   * 总和小于屏高就按 `grow` 分,**大于屏高就按 `shrink` 压** —— 而默认是人人可压。
   * transcript 的固有高度是**全部对话的行数**,只要说过几句话就必然超屏,
   * 于是每一条 chrome 都跟着被按比例压掉。
   *
   * 症状极阴,我为此走了两个错假设:输入框还在、还能打字、还有焦点,但**斜杠补全不弹了**——
   * 因为补全是编辑器多长出来的那一行,而它恰好被压没了。空对话时不复现(那时是 grow 不是
   * shrink),一回车就复现。**HEAD 原版正常、我的版本坏**,对照实验才把它钉住。
   */
  const chrome = { shrink: 0 } as const;
  const root = new VStack();
  root.addChild(harness, chrome);
  root.addChild(transcript, { grow: 1, shrink: 1, minSize: 3 });
  root.addChild(dagHud, chrome);
  root.addChild(pathHud, chrome);
  root.addChild(dialogSlot, chrome);
  root.addChild(editorContainer, chrome);
  root.addChild(statusLine, chrome);
  root.addChild(usageLine, chrome);
  root.addChild(footer, chrome);
  // 全屏走 `setLayoutRoot` 而不是 `addChild` —— 后者进的是隐式 ScrollView, 于是
  // `grow` 无处可分(可用高度是"内容高度"而不是"一屏"), 布局会退化回 inline 的样子。
  tui.setLayoutRoot(root);
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
      dialogSlot.addChild(component);
      tui.setFocus(focus);
      return true;
    },
    close() {
      if (!dialogOpen) return; // 幂等
      dialogOpen = false;
      dialogSlot.clear();
      tui.setFocus(editor);
      tui.requestRender();
    },
    requestRender: () => tui.requestRender(),
  };

  /**
   * ★ 审批单(切片①,G-1)。**占住输入区**(v5:审批单那张图),键位自绘:
   * `y` 一次 · `a` 发同档 token(admin 档收不到这个键)· `d` 展开详情 · Esc 拒绝。
   *
   * ⚠ 对话框被占(用户正开着 /settings 之类)→ **按拒绝处理并说明**,不排队 ——
   * 排队的单会在用户关掉框的下一瞬弹出来,像是"Esc 又弹回来了"。模型收到拒绝会自己重试或改道。
   */
  function askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      let detail = false;
      const body = new Text(approvalBody(req, { detail }));
      const finish = (d: ApprovalDecision): void => {
        dialogs.close();
        const note =
          d === 'deny'
            ? CHROME.approvalDenied(req.summary)
            : d === 'once'
              ? CHROME.approvalOnce(req.summary)
              : CHROME.approvalGranted(req.summary, Math.max(1, Math.round(req.ttlSec / 60)));
        chatLog.appendNotice(note);
        tui.requestRender();
        resolve(d);
      };
      const box = new DialogBox(theme, approvalTitle(req), body, (data) => {
        if (DIALOG_ESC.has(data)) return finish('deny');
        if (data === 'y') return finish('once');
        if (data === 'a' && req.canGrant) return finish('grant');
        if (data === 'd') {
          detail = !detail;
          body.setText(approvalBody(req, { detail }));
          tui.requestRender(); // setText 不触发重绘 (AGENTS.md §5), 必须自己请求
        }
        return undefined;
      });
      if (!dialogs.open(box, box)) {
        chatLog.appendNotice(CHROME.approvalBusy(req.summary));
        tui.requestRender();
        resolve('deny');
        return;
      }
      tui.requestRender();
    });
  }
  if (opts.approvals) opts.approvals.setAsk(askApproval);

  let sessionId = opts.sessionId ?? 'tui';
  const seats = opts.seats ?? defaultSeatFace();

  /**
   * 底栏行①②的取数与重画(切片②)。**只在启动时与每轮结束后调**,不在 render 里 ——
   * 它会 spawn git 三次、扫一遍账本,每帧一次就是自找的卡顿。
   */
  const sshHost = sshSegment(process.env, hostname());
  const tmux = inTmux();
  let ws = readWorkspaceInfo(opts.cwd);
  function updateStatusBar(o: { refreshGit?: boolean } = {}): void {
    if (o.refreshGit) ws = readWorkspaceInfo(opts.cwd);
    const win = opts.usage?.window() ?? null;
    const session = opts.usage?.sessionTotal() ?? null;
    statusLine.setText(
      formatStatusLine({
        ws,
        seat: opts.backend.connection.url.replace(/^embedded:\/\//, ''),
        pressure: lastPressure,
        session: session && session.calls > 0 ? session : null,
        win,
      }),
    );
    usageLine.setText(formatUsageLine(win, { ssh: sshHost, tmux }));
  }
  /** 已唤起、等着挂到下一句上的 skill 正文。**用完即清** —— 一条 skill 只管一轮。 */
  let pendingSkill: string | null = null;
  /** 最近一轮的上下文压力 —— 设置面板要显示它。`null` = 还没跑过一轮(**不是 0**)。 */
  let lastPressure: import('../harness/chat/usage').ContextPressure | null = null;
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
    dumpTranscript();
    resolveExit();
  }

  /**
   * 退出时把 transcript 吐回主屏(owner 2026-08-07 明确约束)。
   *
   * 全屏退出会**还原主屏**,于是这一程的对话在终端里一个字都不剩。那比"不好看"严重得多:
   * 人是靠 scrollback 回看刚才发生过什么的。所以停完之后按当前宽度把 ChatLog 整个重画一遍
   * 写进 stdout,让它留在主屏里。
   *
   * ⚠ 必须在 `tui.stop()` **之后**:停之前写 stdout 会被渲染器的下一帧覆盖掉,
   * 症状是"偶尔留下半截"。
   */
  function dumpTranscript(): void {
    const width = Math.max(20, terminal.columns || 80);
    const lines = chatLog.render(width);
    if (lines.length === 0) return;
    process.stdout.write(`${lines.join('\n')}\n`);
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
      const p = e.payload as { phase?: string; name?: string; ok?: boolean; id?: string; args?: unknown };
      const name = p?.name ?? '?';
      // 一个工具**一行**, end 原地更新 —— 不再 start/end 各追加一条 notice。
      // S-5: 带上参数那半句 —— 只画 `✓ read` 的话, 改对文件和改错文件在屏上长得一模一样。
      if (p?.phase === 'start') chatLog.toolStart(name, { id: p?.id, detail: summarizeToolArg(p?.args) });
      else chatLog.toolEnd(name, p?.ok !== false, { id: p?.id });
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
      lastPressure = p?.pressure ?? lastPressure;
      // 切片②: 一轮跑完 → 底栏行①②重取数 (账本刚被 backend 记过, git 可能被这一轮改过)。
      updateStatusBar({ refreshGit: true });
      // 一轮跑完可能动过地图 (conductor 有 map_* 工具) → 重读一次。
      // 不在 render 里读盘: render 每帧都调, 那会变成每帧一次目录扫描。
      pathHud.refresh();
      tui.requestRender();
    }
  };
  // 启动即画一次: git 段立刻可见, 5h 窗口读的是账本落盘的历史 (跨重启存活正是它的意义)。
  updateStatusBar();

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
      // footer 与行① 重读 `connection.url` —— backend 那边是 getter, 座位一改它就变。
      footer.setText(CHROME.footer(opts.backend.connection.url));
      updateStatusBar();
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
    const coord = await modelPicker(role, now);
    if (coord === null || !coord.trim()) return; // Esc 或空:什么都不改
    applySeat(role, coord.trim());
  }

  /** 目录里没有的坐标走这条 —— 手输仍然保留,不是所有 provider 都在 models.json 里登记过。 */
  const MANUAL_COORD = '\u0000manual';

  /**
   * ★ **模型选单**(S-7)。此前这里是一个 `dialogInput`:让人**凭记忆敲** `provider:model`。
   *
   * 敲错一个字符的代价不是报错,是座位被改成一个**不存在的坐标**而回执照样说"改好了"
   * (applySeat 只写文件,不校验坐标可解析)—— 那正是必须用选单的理由。
   *
   * ⚠ 目录空(没配 models.json / provider 没注册)时**退回手输**,不开空框。
   * 开一个空框等于把人锁在一个只能按 Esc 的界面里。
   */
  async function modelPicker(role: string, now: string): Promise<string | null> {
    const current = now.startsWith('(') ? null : now;
    const choices = sortChoices(listModelChoices(), current);
    const manual = (): Promise<string | null> =>
      dialogInput(dialogs, theme, {
        title: `${role} 换成哪个坐标? (provider:model)`,
        initial: current ?? '',
      });
    if (choices.length === 0) return manual();
    const picked = await dialogSelect(dialogs, theme, {
      title: `${role} 换成哪个模型? (${choices.length} 个)`,
      options: [
        ...choices.map((c) => ({ value: c.coord, label: choiceLabel(c, current) })),
        { value: MANUAL_COORD, label: '手动输入坐标…', description: '目录里没有登记的 provider:model' },
      ],
      search: true,
      maxVisible: 12,
    });
    if (picked === null) return null;
    return picked === MANUAL_COORD ? manual() : picked;
  }

  /**
   * `/models` —— 直接给**对话位**(conductor)换模型。
   *
   * 与 `/seat` 的分野:`/seat` 是"改哪个座位"(先选角色), `/models` 是最常做的那件事的直达口 ——
   * 人想换模型时想的是"换个模型", 不是"改 conductor 这个座位的坐标"。
   */
  async function handleModels(text: string): Promise<void> {
    const t = text.trim();
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    const { current } = readSeats();
    const now = current.conductor ?? '';
    const coord = await modelPicker('conductor', now);
    if (coord !== null && coord.trim()) applySeat('conductor', coord.trim());
    tui.requestRender();
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
  /** 唤起一条 skill 并画回执。找不到就说没有 —— **不静默注入空块**。 */
  function armSkill(name: string, rest: string): void {
    const loaded = loadSkillBlock(name, rest);
    if (!loaded) {
      chatLog.appendNotice(CHROME.skillMissing(name));
      return;
    }
    pendingSkill = loaded.block;
    chatLog.appendNotice(CHROME.skillArmed(loaded.name));
  }

  function handleSkill(text: string): boolean {
    const cmd = parseSkillCommand(text);
    if (!cmd) return false;
    chatLog.appendUser(text);
    editor.setText('');
    if (cmd.kind === 'list') chatLog.appendNotice(formatSkillList(listSkills()));
    else if (cmd.kind === 'all') chatLog.appendNotice(formatSkillAll(listSkills()));
    else armSkill(cmd.name, cmd.rest);
    tui.requestRender();
    return true;
  }

  /**
   * ★ **组命令**(S-6 umbrella,owner 点名):`/lark` 列成员,`/lark im ...` 唤起。
   *
   * 组名是**运行时从磁盘扫出来的**,不是写死的清单 —— owner 要的是"下载了 skill 自动发现",
   * 写死一份清单等于每装一条 skill 都要改一次代码。
   *
   * ⚠ 组名每次现算而不是启动时算死:装了新 skill 之后不用重启 TUI 就认得出。
   * 代价是每条斜杠命令多一次目录扫描 —— 一百来个目录的 readdir,量级上无所谓。
   */
  function handleSkillGroup(text: string): boolean {
    const skills = listSkills();
    const { groups } = groupSkills(skills);
    const cmd = parseGroupCommand(text, groups.map((g) => g.name));
    if (!cmd) return false;
    chatLog.appendUser(text);
    editor.setText('');
    const group = groups.find((g) => g.name === cmd.group);
    if (!group) return true; // parseGroupCommand 只认清单内的名字, 走不到这里
    if (cmd.member === null) chatLog.appendNotice(formatGroupMembers(group));
    else armSkill(cmd.member, cmd.rest);
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

  /**
   * `/settings` —— owner 指出"设置完全没有"。
   *
   * 面板只列**真的有数**的项:每一项都答得出"现在是什么值"。答不上来的不进表 ——
   * 一堆"点了没反应"的行正是断链说明卡禁止的东西。
   */
  async function handleSettings(text: string): Promise<boolean> {
    if (!parseSettingsCommand(text)) return false;
    chatLog.appendUser(text);
    editor.setText('');
    const { current, err } = readSeats();
    let sessionCount: number | null = null;
    try {
      sessionCount = (await opts.backend.listSessions()).length;
    } catch {
      // 读不到就是 null —— 与"一条都没有"分得开(本仓 NULL ≠ 0)。
    }
    const items = buildSettings({
      seats: current,
      seatsError: err,
      sessionId,
      sessionCount,
      pressure: lastPressure,
      color: colorEnabled(),
      truecolor: truecolorEnabled(),
      extensions: opts.extensions ?? [],
    });
    chatLog.appendNotice(formatSettings(items));
    tui.requestRender();

    const pick = await dialogSelect(dialogs, theme, {
      title: '改哪一项?',
      options: items.map((it) => ({
        value: it.action ? it.key : '',
        label: `${it.action ? '' : '(只读) '}${it.label}: ${it.value}`,
        ...(it.detail ? { description: it.detail } : {}),
      })),
      maxVisible: 12,
    });
    // 只读行的 value 是空串 —— 选中它什么都不做, 这是刻意的(它本来就只是现状)。
    if (pick === null || pick === '') return true;
    if (pick.startsWith('seat:')) await seatPicker();
    else if (pick === 'session') await handleSession('/session');
    else if (pick === 'ext') chatLog.appendNotice('扩展清单在 `.omd/extensions.json`(入口写绝对路径)。改完重启 omd tui 生效。');
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
    // 与 `/settings` 同一条形状:解析是同步的, 处理是异步的 —— 分发这一层不是 async。
    if (parseModelsCommand(prompt)) {
      void handleModels(prompt);
      return;
    }
    if (handleSkill(prompt)) return;
    // S-6: 组命令排在 handleSkill 之后 —— `/skill` 本身不是组名, 顺序上不会互吃。
    if (handleSkillGroup(prompt)) return;
    if (parseSettingsCommand(prompt)) {
      void handleSettings(prompt);
      return;
    }
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
