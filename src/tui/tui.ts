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
 * 5. 退出前先停动画再拆传输 —— ✅ 形状已就位(`requestCleanExit` 里 stopAnimations 先于
 *    `tui.stop()`),只是本片没有动画可停。
 *
 * ## 可测性:时钟与退出都从外面注入
 *
 * 双击判定是纯函数({@link decideCtrlC}),不碰 `Date.now`;硬退走注入的 `exit`。
 * 于是 L1 能直接测判定,L3 只需要验"真 PTY 里这条链接得起来"。
 */
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { type Component, Container, HStack, Loader, ProcessTerminal, ScrollView, Spacer, Text, TuiAltScreen, VStack, type Terminal } from '@earendil-works/pi-tui';
import { HintedEditor } from './components/hinted-editor';
import { logger } from '../logger';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from './approval/gate';
import { approvalBody, approvalTitle } from './approval/card';
import type { OmdBackend } from './backend';
import { ChatLog } from './components/chat-log';
import { DialogBox, ESC as DIALOG_ESC, type DialogHost, type InputOpts, type SelectOpts, confirm as dialogConfirm, input as dialogInput, select as dialogSelect } from './components/dialog';
import { DagHud } from './components/dag-hud';
import { DagTree } from './components/dag-tree';
import { type PathReader, PathHud, createPathReader } from './components/path-hud';
import { renderGantt } from './render/dag-gantt';
import { type PathViewData, buildPathViewData, renderDelta, renderFogLine } from './render/path-fog';
import { fitLine } from './render/line';
import { renderLayers } from './render/dag-layers';
import { StatusLine } from './components/status-line';
import { type ContextFile, formatContextLine, loadConductorContext } from './context';
import { formatSeatRows, parseSeatCommand, seatRows } from './seat-picker';
import { defaultTuiSessionId, forkSessionId, formatSessions, newSessionId, parseNewForkCommand, parseSessionCommand } from './sessions';
import { createSettingsPanel } from './components/settings-panel';
import { SPINNER_FRAMES } from './design/tokens';
import { installOmdKeybindings } from './keys';
import { buildSettings, parseSettingsCommand } from './settings';
import { STARTUP_HINT, formatHelp, parseHelpCommand, slashCommands } from './commands';
import { MANUAL_COORD, choiceLabel, listModelChoices, parseModelsCommand, sortChoices } from './model-picker';
import { createOmdAutocompleteProvider } from './skill-complete';
import { createContextHealth } from './health';
import { loadTuiUiConfig, setApprovalTokenTtl, setTuiUi } from './ui-config';
import { renderLogo } from './render/logo';
import { summarizeToolArg } from './render/tool-arg';
import { fmtUsd, formatStatusLine } from './render/statusbar';
import { humanTokens } from './render/pressure';
import { formatStatus } from './status';
import { defaultExportPath, exportTranscriptMarkdown } from './export';
// ⚠ 进屏的 provider 错误一律先压成一行 —— 原文照旧进各处的 logger.warn(压呈现不压证据)。
import { humanizeProviderError } from './render/error-text';
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

/** `/status` 账本行的窗口口径:ledger 只有滚动窗口,24h 是它给得出、最接近"今日"的现成读数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

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
/**
 * 侧栏 pathfinder 摘要画不画 —— **抽成纯函数是为了有一条能红的闸**。
 *
 * ⚠ 这里踩过一次:我先在 L3 PTY 里写了「有对话之后 `地图 ` 不再出现」那条断言,
 * 它**在注入下照样绿**(把条件删掉,闸没红)。根因是 pi-tui **差分重绘** ——
 * 还留在屏上、内容没变的行**不会再进字节流**,于是"它还在屏上"这件事
 * 在累积缓冲里根本看不见。⇒ 那条闸撤了(本仓不留看运气/空转的闸),
 * 换成这个纯函数的单测 + `docs/bars/refs/omd/08-streaming.txt` 那张重采帧当证据。
 */
export function pathHudVisible(s: { pathFullOn: boolean; hasDialogue: boolean }): boolean {
  return !s.pathFullOn && !s.hasDialogue;
}

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
          ['engine', o.engine],
          ['session', o.session],
        ],
        o.width,
      ),
      '',
      `  > ${STARTUP_HINT}`,
      '  > PgUp / PgDn scrolls back through history',
    ].join('\n'),
  /**
   * 空输入框里的提示符(`HintedEditor`)。
   *
   * ⚠ 它治的是一条**外部盲评量出来的**缺口:空态时输入框是「上框/空行/下框」,
   * 屏上读成"两条一样的线中间空无一物"(P3 件6 轮1,账本有原文与帧号)。
   * 文案只许 ASCII + 已量过的 CJK —— 这一行同样过字形闸。
   */
  editorHint: 'Ask something, or press / for commands · Ctrl+C twice to quit',
  /** 后端明确拒绝(**断链说明卡**):说出是谁拒的,不编一个回复。 */
  refused: (url: string) => `Backend refused this turn (${url}): engine not wired up, nothing was sent to any model`,
  /** 后端抛了:错误原文进屏,同时进日志文件。 */
  failed: (reason: string) => `This turn could not be sent: ${reason}`,
  /** 工具在跑 / 跑完。真事件真名字, 没有事件就不画这一行。 */
  toolStart: (name: string) => `${name} ...`,
  toolEnd: (name: string, ok: boolean) => `${name} ${ok ? 'ok' : 'failed'}`,
  /** 切座位成功 —— 说出改了哪个文件, 别让人猜它生效了没。 */
  seatChanged: (role: string, coord: string) => `Seat changed: ${role} -> ${coord} (written to .omd/config.json, effective next message)`,
  seatFailed: (reason: string) => `Seat unchanged: ${reason}`,
  /** 座位读不出来 (没配过 omd 的仓)。原因原样贴出来 —— 那一格的真值就是解析不到。 */
  seatUnresolved: (reason: string) => `Current seat does not resolve: ${reason}`,
  /** 切会话回执 —— 说清切到哪、回放了几条,别让人猜切没切成。 */
  sessionSwitched: (id: string, n: number) => `Switched to session ${id} (replayed ${n} messages)`,
  sessionNew: (id: string) => `New session ${id} (the file is only created when you say something)`,
  sessionFailed: (reason: string) => `Cannot switch: ${reason}`,
  /** skill 已挂在**下一句**上 —— 说清它什么时候生效, 别让人以为已经跑了。 */
  skillArmed: (name: string) => `Skill "${name}" armed: it is injected as extra discipline on the **next** message only (this turn, not stored in the session)`,
  skillMissing: (name: string) => `No such skill: ${name} (use /skill to see what is available)`,
  /** 这个后端没有 run 能力(fixture / 远程未实现)。**说出缺的是什么**,不画一个点了没反应的入口。 */
  noRunCapability: (what: string) => `This backend has no ${what} capability (probed: the method does not exist)`,
  resumeStarted: (runId: string, text: string) => `Resuming ${runId}: ${text}`,
  resumeRefused: (runId: string, text: string) => `Cannot resume ${runId}: ${text}`,
  /**
   * 行③帮助条。`omd tui` 字样留在这 —— 顶栏没了(v5: 信息下沉), 这一串同时是 PTY 的启动信标。
   *
   * ★ **2026-08-08 去掉了尾巴上的 `[后端坐标]`**(P1 密度)。实测:同一屏上后端坐标出现
   * **3 次** —— 首屏 `引擎 <坐标>`(一次性) + 行① `… │ <坐标> │ …`(常驻) + 这里(常驻)。
   * **两份常驻的同一个串是纯浪费**,而行① 那份带着仓名/分支/窗口用量, 信息量严格更大。
   * ⇒ 砍这一份。首屏那份是一次性的介绍, 不算重复, 留着。
   */
  /** 等待态那一行。措辞要说清**在等什么** —— 只画一个转圈等于没说。 */
  waiting: 'Waiting for the model...(Esc interrupts)',
  footer: () => 'omd tui · /help for commands · Ctrl+C twice to quit',
  footerArmed: () => 'omd tui · press Ctrl+C again to quit',
  // ── 审批层(切片①)。裁决回执要进对话记录 —— 卡片关掉之后, "刚才批没批过"得能回看。 ──
  approvalDenied: (summary: string) => `Approval: denied ${summary}`,
  approvalOnce: (summary: string) => `Approval: allowed once - ${summary}`,
  approvalGranted: (summary: string, min: number) => `Approval: allowed ${summary} (same tier is auto-allowed for ${min} min)`,
  /** 对话框被占时新到的审批单按拒绝处理(fail-closed)—— 说出为什么, 别静默拒。 */
  approvalBusy: (summary: string) => `Approval: another dialog is open, treated as denied - ${summary}`,
  // ── 切片⑥: /login 与设置写盘回执。key 本身一个字符都不进屏。 ──
  loginDone: (provider: string, target: string, warnings: string[]) =>
    `Key written to ${target === 'env' ? '.env' : 'auth.json'} (${provider}, effective immediately)${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  uiWritten: (what: string, path: string) => `${what} written to ${path}`,
  // ── 切片⑦: 会话树。fork 的回执要说清"现在在分支上, 原会话没动"。 ──
  sessionForked: (text: string) => `${text} - switched to the branch; the source session is untouched, /session switches back`,
  sessionForkFailed: (reason: string) => `Cannot fork: ${reason}`,
  approvalTtlWritten: (sec: number, path: string) => `Approval token TTL -> ${sec}s written to ${path} (effective after restart)`,
  /** 切片⑧: 一张图都没有时说真话 (画一个空雾场会读成"有图但没散")。 */
  noPathMaps: () => 'No pathfinder map yet (docs/plan/pathfinder/ is empty) - open one with /omd-path',
  // ── 2026-08-11 命令面六项(/compact /logout /status /export /new /fork /quit)的回执。 ──
  compactDone: (id: string, before: number, after: number, n: number) =>
    `Compacted ${id}: ~${before} -> ~${after} tokens (${n} messages -> summary + tail)`,
  /** 静态串一律走函数形(与 footer/footerArmed 同款):字形闸只采样字符串常量,ASCII 串不占样本表。 */
  compactNone: () => 'Nothing to compact: session is empty or already at the tail',
  logoutCancelled: () => 'logout cancelled, nothing removed',
  logoutClaude: () => 'claude-code uses the Claude CLI subscription - run `claude logout` in a terminal; omd does not touch its credentials.',
  logoutDone: (provider: string, removed: { file: string; key: string }[], warnings: string[]) =>
    `Removed ${provider} credential: ${removed.map((r) => `${r.key} in ${r.file}`).join(', ')}${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  logoutNone: (provider: string, warnings: string[]) =>
    `No stored credential for ${provider} - nothing removed${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  exportDone: (n: number, abs: string) => `Exported ${n} messages -> ${abs}`,
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
  /**
   * ★ UI 建好之后回调一次,把**对话框宿主 / 主题 / 记录口**交出去(2026-08-08)。
   *
   * 存在的理由是装配环:工具面必须在 backend 之前装好, 而 backend 又要先于 TUI ——
   * 于是 `ask_user` 这类**要用 UI 的工具**在装配时拿不到 UI。装配层给一个延迟指针,
   * 这里在 UI 就绪的那一刻把它填上(与 `sink` 那根指针同一个形状)。
   * 省略 = 装配层不需要(`omd serve` / `mcp` 那两条路没有对话框)。
   */
  onUi?: (ui: { host: DialogHost; theme: OmdTuiTheme; appendNotice: (text: string) => void }) => void;
  /** 唯一接缝(SDD §3.1)。S2 只用它的 `connection` / `start` / `stop`。 */
  backend: OmdBackend;
  cwd: string;
  /** 测试注入(L3 用真 `ProcessTerminal`,L1/L2 可给替身)。 */
  terminal?: Terminal;
  /** 时钟注入 —— 双击窗口的判定要可测。 */
  now?: () => number;
  /** 硬退注入:第二次 `requestCleanExit` 的兜底路径,测试里不许真杀进程。 */
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
 * 定时器,是隐式的。这里只由 `requestCleanExit()` 兑现一个 Promise,结束条件是显式的一处。
 */
/**
 * ★ 左槽宽度(P1)。取 1 不取 2:窄屏(80 列)下每一列都算数,而"不贴边"这件事 1 列就成立
 * —— 参照物里 pi 的正文起始列就是 `1`。
 */
export const GUTTER_COLS = 1;

/**
 * ★ **左槽**(P1,2026-08-08)。正文不许贴着终端左边缘。
 *
 * ## 这是量出来的,不是审美
 *
 * 三家同一条提示词、同一个 110x32(`docs/bars/refs/<家>/08-streaming.txt`):
 * **正文起始列 opencode `5` / pi `1` / omd `0`** —— omd 是唯一贴边的。
 * 逐帧数过之后更难看:七张 omd 帧里,**每张都有 11–26 行起始列是 0**
 * (`01-empty` 11 行 / `07-settings` 26 行)。"又挤又平"的成因里,这一条是可定位的那个。
 *
 * ## 用 `Spacer` 而不是手拼空格
 *
 * ⚠ **实测过才敢这么用**:pi-tui 的 `Spacer.render()` 返回的是 **`lines` 个空串**
 * (`spacer.js:14-20`)—— 它本身是**纵向**留白,不是横向 padding。
 * 但把它当 `HStack` 的**首个子项** + 给一个固定 `basis`,`HStack` 会给它分配宽度并把
 * 后面的子项排在 `childWidth + gap` 之后(`h-stack.js:38`)⇒ 这就是左槽。
 * 实测(`basis: 1` + 既有 `gap: 1`)正文落在**第 2 列**,且**不引入行位移**
 * (对照组"无 spacer"在同一个探针里也有那一行首空行 —— 那是探针的,不是槽的)。
 *
 * ⇒ 顺带还掉台账里 `Spacer` 那笔欠账(omd 全仓曾是 **0** 引用)。
 */
export function withLeftGutter(root: Component, cols: number = GUTTER_COLS): Component {
  const shell = new HStack([], { gap: 0 });
  shell.addChild(new Spacer(1), { basis: cols, shrink: 0 });
  shell.addChild(root, { grow: 1, shrink: 1, minSize: 10 });
  return shell;
}

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

  // 键位表:补上 pi-tui 默认表认不出的双 ESC(`keys.ts` 记了实测的三行对照表)。
  // ⚠ 必须在建组件**之前** —— 组件是在 `handleInput` 里现查 `getKeybindings()` 的,
  //   所以顺序上其实没那么脆;放这儿是为了"键位是启动期的事"读起来一眼清楚。
  installOmdKeybindings();

  const contextFiles = opts.contextFiles ?? loadConductorContext(opts.cwd);
  const theme = opts.theme ?? createTheme();

  // 状态行走 StatusLine (截断, 不折行) —— 状态行一折, 下面所有东西的行号整体下移,
  // 而 HUD 是按行差分画的, 结果是布局错位。对话正文走 ChatLog (折行是对的)。
  // ⚠ 顶栏(`omd tui - cwd`)已去掉 —— v5 裁决: 信息下沉到底部三行, 仓名/分支在行①。
  const harness = new StatusLine(formatContextLine(contextFiles, { cwd: opts.cwd }));
  const chatLog = new ChatLog(theme);
  // HUD 在没有 run 的时候 `render()` 返回空数组 (无源恒缺席), 所以恒挂着不用条件添加。
  const dagHud = new DagHud(theme, () => opts.backend.connection.url.replace(/^embedded:\/\//, '') || null);
  // 切片③: 左栏树 + 三画法共用的数据模型。与 dagHud 吃同一批事件 (两个消费者都得喂, 坑 #7 同族)。
  const dagTree = new DagTree(theme, opts.now);
  // A4: pathfinder 前沿票。一张图都没有时 `render()` 返回空数组, 所以恒挂着。
  // 切片⑧: Ctrl+P 选了图之后侧栏跟着换 (pathSlugSel); 没选时保持"前沿最多"的默认。
  let pathSlugSel: string | null = null;
  const basePathReader = opts.pathReader ?? createPathReader(opts.cwd);
  const pathHud = new PathHud(theme, () => (pathSlugSel ? createPathReader(opts.cwd, pathSlugSel)() : basePathReader()));
  pathHud.refresh();
  // 空态在框里画一句提示符 —— 见 `components/hinted-editor.ts` 文件头(gauntlet critic 的判词)。
  const editor = new HintedEditor(tui, theme.editor, { hint: CHROME.editorHint, paint: theme.chrome.dim });
  // 补全:**行首 `/` 出命令,其余出文件** —— 底座是 pi-tui 的 `CombinedAutocompleteProvider`。
  // ⚠ 此前只挂了自写的文件补全, 于是打 `/settings` 弹出来的是一堆文件名(owner 截图抓到的)。
  //   斜杠开头本该出命令, 而这件事 pi-tui 本来就做好了。
  // 切片④ (G-4): 三段式 —— `/` 只出组, `/omd-` 出全名成员带描述, `/omd ` 出不带前缀的成员。
  // 成员清单 5s TTL 现扫 (装新 skill 不用重启), 组清单仍启动时算一次 (见 commands.ts 的说明)。
  const startupGroups = groupSkills(listSkills()).groups.map((g) => ({ name: g.name, count: g.members.length }));
  editor.setAutocompleteProvider(
    createOmdAutocompleteProvider({
      commands: slashCommands(startupGroups),
      cwd: opts.cwd,
      grouping: () => groupSkills(listSkills()),
    }),
  );
  const footer = new StatusLine(CHROME.footer());
  // 切片⑤: 上下文健康度一行。平时**不占位**(visible 靠 health.line() 判) —— 画一行空白
  // 会让底栏三行变成看起来的四行。
  const health = createContextHealth();
  const healthLine = new StatusLine('');
  // 底栏行①② (切片②, v5 第一节样张)。segment 模型: 没数据的段不画,
  // 所以启动时行②多半是空串 (窗口里没记录) —— 那不是 bug, 是「还没烧过」的真值。
  const statusLine = new StatusLine('');

  /**
   * 欢迎屏(S-3)。字标走 brand(整屏最亮的一处),正文走 dim —— **分层是判据不是口味**:
   * 一屏里两处同等亮度就没有"第一眼落在哪"这回事了。
   *
   * ⚠ 宽度取的是**启动那一刻**的列数。终端后来被拉窄不会重画这一块(它已经是历史消息了),
   * 但字标本身不折行、窄了会被 ChatLog 截断,不会顶花布局。
   */
  /**
   * ★ 本进程的会话 id。**只算一次** —— 横幅上写的那个与后面真发消息用的那个必须是同一个,
   * 各算一次的话跨秒起跑就会显示 A、写进 B(屏上与盘上是两条会话, 而两边都"有内容")。
   */
  let sessionId = opts.sessionId ?? defaultTuiSessionId();
  const bannerWidth = terminal.columns || 100;
  chatLog.appendBanner(
    [
      // 顶栏与字标之间留一行 —— 贴着画时字标第一行读起来像是顶栏的一部分。
      '',
      ...renderLogo(bannerWidth).map(theme.chrome.brand),
      '',
      ...CHROME.welcomeBody({
        engine: opts.backend.connection.url,
        session: sessionId,
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

  /**
   * ★ **左侧栏 + 全屏图**(切片③,G-3)。
   *
   * - 侧栏(画法 A 树):`/hud` 开关(默认开),**且**要 ① 有 run ② 屏够宽 才画 ——
   *   80 列的终端里再切 34 列给侧栏,剩下的对话区就没法读了(窄终端自动收起)。
   * - 全屏:`Ctrl+G` 开关,`Tab` 在 树 / 泳道甘特 / 分层依赖 三画法间循环。
   * - 侧栏或全屏画着时**不再画底部那张表** —— 同一份 DAG 画两遍,人会以为是两个 run。
   */
  const uiCfg = loadTuiUiConfig(opts.cwd);
  let sidebarOn = uiCfg.sidebar;
  let fullOn = false;
  let painterIdx = uiCfg.painterIdx; // 0=树 1=甘特 2=分层 (默认从 tui.ui.painter 读)
  const SIDEBAR_WIDTH = 34;
  /** 低于这个总宽不给侧栏。= 侧栏 34 + 对话区至少 56。 */
  const SIDEBAR_MIN_TOTAL = 90;
  const sidebarPainting = (vpWidth: number): boolean => sidebarOn && dagTree.active && vpWidth >= SIDEBAR_MIN_TOTAL;

  /** 全屏视图:一个薄 Component,按当前画法把快照交给对应的纯渲染函数。 */
  const PAINTERS = ['tree', 'gantt', 'layers'] as const;
  const fullView: Component = {
    render: (width: number): string[] => {
      if (!dagTree.active) return [fitLine('(no run yet - send one, then press Ctrl+G)', width)];
      const height = Math.max(6, (terminal.rows || 30) - 10);
      const hint = theme.chrome.dim(fitLine(`Tab switches view (now: ${PAINTERS[painterIdx]}) · Ctrl+G exits`, width));
      if (painterIdx === 0) return [...dagTree.render(width).slice(0, height), hint];
      const snap = dagTree.snapshot();
      const lines = painterIdx === 1 ? renderGantt(snap, { width, height, now: now() }) : renderLayers(snap, { width, height });
      return [...lines, hint];
    },
    handleInput: () => {},
    invalidate: () => dagTree.invalidate(),
  };

  /**
   * ★ **pathfinder 全屏散雾图**(切片⑧,owner 裁决主 C 副 B):`Ctrl+P` 选图进全屏,
   * C(雾退线)默认,`Tab` 切 B(三角洲),A 不做。数据在开图与每轮结束时重读。
   */
  let pathFullOn = false;
  let pathPainter = 0; // 0=C 雾退线 1=B 三角洲
  let pathSelected = 0;
  let pathData: PathViewData | null = null;
  function reloadPathData(): void {
    if (!pathSlugSel) return;
    try {
      const { loadMap } = require('../harness/pathfinder/maps') as typeof import('../harness/pathfinder/maps');
      const map = loadMap(opts.cwd, pathSlugSel);
      pathData = map ? buildPathViewData(map) : null;
      if (pathData && pathSelected >= pathData.frontier.length) pathSelected = Math.max(0, pathData.frontier.length - 1);
    } catch (err) {
      pathData = null;
      logger.warn({ err: (err as Error).message, slug: pathSlugSel }, '[omd/tui] pathfinder 图读不出来');
    }
  }
  const pathView: Component = {
    render: (width: number): string[] => {
      if (!pathData) return [fitLine('(map could not be read - the reason is in the log)', width)];
      const height = Math.max(6, (terminal.rows || 30) - 10);
      // 颜色分层照 HTML 稿: 前沿/读数 accent · 地层/雾 dim · 阻塞 warn · 选中 user 档。
      const paint = { accent: theme.chrome.accent, dim: theme.chrome.dim, warn: theme.chrome.warn, sel: theme.chrome.user };
      const o = { width, height, selected: pathSelected, paint };
      return pathPainter === 0 ? renderFogLine(pathData, o) : renderDelta(pathData, o);
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  const body = new HStack([], { gap: 1 });
  body.addChild(dagTree, { basis: SIDEBAR_WIDTH, shrink: 0, visible: (vp: { width: number }) => sidebarPainting(vp.width) });
  body.addChild(transcript, { grow: 1, shrink: 1, minSize: 3 });

  /**
   * ★ **等待指示器**(2026-08-08,还 `Loader` 那笔欠账)。
   *
   * 发出一句到第一片回来之间,屏上此前**没有任何会动的东西** —— 而参照物三家都有等待态
   * (`docs/bars/pi-tui-模块台账.md` 那条欠账的原话)。"看起来没反应"与"真没反应"
   * 在屏幕上长得一样,这正是本仓最怕的那一族。
   *
   * ⚠ **帧在 `design/tokens.ts` 的 `SPINNER_FRAMES`,不在这里** ——
   * 「框线字形不散在组件里」那条闸把方块字形写进本文件判为违规,而它判得对。
   * 不用 pi-tui 的默认帧(盲文点阵,不在白名单里)的理由也写在那边。
   */
  let waitingOn = false;
  const waiting = new Loader(tui, theme.chrome.accent, theme.chrome.dim, CHROME.waiting, {
    frames: [...SPINNER_FRAMES],
    intervalMs: 120,
  });
  waiting.stop(); // 构造里会 start;没在等的时候不许有定时器在跑

  /**
   * Ctrl+C 预备时刻(`null` = 没在预备)。
   *
   * ⚠ **声明必须在 `root` 装配之前**:底栏第三行的 `visible` 闭包读它,而 `let` 有 TDZ ——
   * 装配到声明之间只要发生一次同步渲染就是 `ReferenceError`。tsc 看不出这一类。
   */
  let armedAt: number | null = null;

  const root = new VStack();
  root.addChild(harness, chrome);
  root.addChild(body, { grow: 1, shrink: 1, minSize: 3, visible: () => !fullOn && !pathFullOn });
  root.addChild(fullView, { grow: 1, shrink: 1, minSize: 3, visible: () => fullOn && !pathFullOn });
  root.addChild(pathView, { grow: 1, shrink: 1, minSize: 3, visible: () => pathFullOn });
  root.addChild(dagHud, { shrink: 0, visible: (vp: { width: number }) => !fullOn && !pathFullOn && !sidebarPainting(vp.width) });
  /**
   * 侧栏 pathfinder 摘要:**只在还没开口说话的时候画**(2026-08-08,P3 件3 轮1)。
   *
   * 盲比 `08-streaming` 三跑**全部**判我方输(opencode×3),三条判词指的是同一件事:
   * 「流式回答下方混入与本题无关的仪表盘内容(进度条 8/23、前沿票工单表、阻塞集)」。
   * 核过帧(`08-streaming` 行 22-26):那 5 行确实**夹在回答与输入框之间**。
   *
   * ⇒ 它属于欢迎屏,不属于对话主屏。有对话之后收起,想看按 **Ctrl+P** 开全屏散雾图
   * (那条路一个字没动,PF-1…PF-5 全在)。
   * ⚠ 判据是 `chatLog.hasDialogue`(有 `user` 条目)**不是** `length > 0` —— 后者被欢迎屏字标满足。
   * ⚠ 全屏散雾图开着时同样不画(同一张图画两遍会读成两张)。
   */
  root.addChild(pathHud, { shrink: 0, visible: () => pathHudVisible({ pathFullOn, hasDialogue: chatLog.hasDialogue }) });
  root.addChild(waiting, { shrink: 0, visible: () => waitingOn });
  root.addChild(dialogSlot, chrome);
  root.addChild(editorContainer, chrome);
  root.addChild(healthLine, { shrink: 0, visible: () => health.line() !== null });
  root.addChild(statusLine, chrome);
  /**
   * ★ 底栏第三行**只在它真有话说的时候出现**(2026-08-08,P3 件6 轮3)。
   *
   * 盲比 6 跑里 **5 跑**把我方缺口指成同一件事:「底部状态/提示信息叠了 3 行
   * (两行状态加一行快捷键提示),拥挤且没有主次之分」。而那第三行是**静态**的
   * `omd tui · /help 看命令 · Ctrl+C 两次退出` —— 它说的两件事现在都在空输入框的提示符里,
   * 于是同一屏把 `/help` 说了三遍(欢迎屏、提示符、底栏)。
   * ⇒ 常态收掉,只留**预备退出**那一句(`再按一次 Ctrl+C 退出`)—— 那句是状态不是装饰。
   * PTY 的 `S2-4 / S2-7` 断言的正是 `再按一次`,所以这条路径一个字没动。
   */
  root.addChild(footer, { shrink: 0, visible: () => armedAt !== null });
  // 全屏走 `setLayoutRoot` 而不是 `addChild` —— 后者进的是隐式 ScrollView, 于是
  // `grow` 无处可分(可用高度是"内容高度"而不是"一屏"), 布局会退化回 inline 的样子。
  tui.setLayoutRoot(withLeftGutter(root));
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
      /**
       * ★ **对话框一开就把等待指示器停掉**(2026-08-08 实测撞出来的)。
       *
       * 它的文案是「在等模型回话」—— 而对话框(审批单 / 选择器)占住输入区时,
       * **在等的是人不是模型**。一边弹审批单一边说"在等模型回话", 是**说了一句错话**,
       * 而且是那种读起来完全合理、没人会去核的错话。
       *
       * ⚠ 顺带修掉一个测试面的问题:它每 120ms 重绘一次, 而 PTY 的 oracle 是**累积缓冲**
       * ⇒ 审批场景里整块缓冲被这一行刷满, `slice(-400)` 那种诊断输出全成了它。
       */
      waiting.stop();
      dialogSlot.addChild(component);
      tui.setFocus(focus);
      return true;
    },
    close() {
      if (!dialogOpen) return; // 幂等
      dialogOpen = false;
      // 框关了, 如果这一轮还在等模型, 指示器接着转。
      if (waitingOn) waiting.start();
      dialogSlot.clear();
      tui.setFocus(editor);
      tui.requestRender();
    },
    requestRender: () => tui.requestRender(),
  };
  // UI 就绪 —— 把三件交给装配层的延迟指针(`ask_user` 靠它才问得出来)。
  opts.onUi?.({
    host: dialogs,
    theme,
    appendNotice: (text: string) => {
      chatLog.appendNotice(text);
      tui.requestRender();
    },
  });

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
    // 底栏一行:ssh/tmux 与计价口径一起交给它(原来那是第二行的活)。
    statusLine.setText(
      formatStatusLine({
        ws,
        seat: opts.backend.connection.url.replace(/^embedded:\/\//, ''),
        pressure: lastPressure,
        session: session && session.calls > 0 ? session : null,
        win,
      }, { ssh: sshHost, tmux }),
    );
  }
  /** 已唤起、等着挂到下一句上的 skill 正文。**用完即清** —— 一条 skill 只管一轮。 */
  let pendingSkill: string | null = null;
  /** 最近一轮的上下文压力 —— 设置面板要显示它。`null` = 还没跑过一轮(**不是 0**)。 */
  let lastPressure: import('../harness/chat/usage').ContextPressure | null = null;
  let exiting = false;
  let resolveExit: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  /**
   * 干净退出的**唯一路径** —— `/quit` 与双击 Ctrl+C 的 `'exit'` 分支共走这一条,
   * 两份退出逻辑必漂, 只许有一份。
   * 幂等。第二次调用**直接硬退** —— 那是"第一次退出卡住了"的唯一出路
   * (openclaw 同款:`requestCleanExit` 二次进入即 `process.exit(130)`)。
   */
  function requestCleanExit(): void {
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
  /** 关等待态。**幂等** —— delta 与 submit 收尾都会调它, 而定时器只该停一次。 */
  function stopWaiting(): void {
    if (!waitingOn) return;
    waitingOn = false;
    waiting.stop();
  }

  async function submit(prompt: string): Promise<void> {
    chatLog.appendUser(prompt);
    // A7: skill 正文前置到这一句上。**用完即清** —— 不清的话它会在往后每一轮里重复出现。
    const withSkill = pendingSkill ? `${pendingSkill}\n\n${prompt}` : prompt;
    pendingSkill = null;
    editor.setText('');
    editor.addToHistory(prompt);
    // 等待态开:到第一片回来为止(见 `onEvent` 的 delta 分支)。
    waitingOn = true;
    waiting.start();
    tui.requestRender();
    try {
      const res = await opts.backend.sendChat({ sessionId, prompt: withSkill });
      // `ok:false` 是**响亮的否**, 不是空回复。
      if (!res.ok) chatLog.appendNotice(CHROME.refused(opts.backend.connection.url));
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 错误原文进屏, 同时进日志文件 (已改道)。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, sessionId }, '[omd/tui] sendChat 抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    // 无论成败都收尾: 抛错那条路上 `session` 事件不会来, 不收尾的话下一轮会续进这条气泡。
    // ⚠ 等待态也在这里关 —— **`finally` 语义**:抛错那条路上 delta 永远不会来,
    //   只在 delta 分支关的话, 一次失败就会留下一个**永远在转**的指示器。
    stopWaiting();
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
        stopWaiting(); // 第一片回来了 —— 从这一刻起"在动"的是正文本身
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
      if (p?.phase === 'start') {
        chatLog.toolStart(name, { id: p?.id, detail: summarizeToolArg(p?.args) });
        // 切片⑤: 健康度计数吃 start 事件 (end 不带 args)。
        health.onTool(name, p?.args);
        healthLine.setText(health.line() ?? '');
      } else chatLog.toolEnd(name, p?.ok !== false, { id: p?.id });
      tui.requestRender();
      return;
    }
    if (e.event === 'dag') {
      const p = e.payload as { runId?: string; node?: { type?: string } };
      // 换了 run → 清空上一个 run 的节点, 否则两个 run 的节点混成一张表。
      if (p?.node?.type === 'planned' && p.runId) {
        dagHud.beginRun(p.runId);
        dagTree.beginRun(p.runId);
      }
      if (p?.node) {
        dagHud.apply(p.node as never);
        // 切片③: 同一批事件两个消费者。**不能只喂一个** —— 交接 37 坑 #7 同族:
        // 只接一处的话左栏是一张永远空的图, 而它看起来只是"还没开始跑"。
        dagTree.apply(p.node as never);
      }
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
      if (pathSlugSel) reloadPathData(); // 切片⑧: 全屏图的数据同一时机重读
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
      footer.setText(CHROME.footer());
      updateStatusBar();
    } catch (err) {
      // 拒绝的原因原样进屏 (非法 role / 坐标格式不对), 不吞成一句"失败了"。
      chatLog.appendNotice(CHROME.seatFailed(err instanceof Error ? err.message : String(err)));
    }
    tui.requestRender();
  }

  /**
   * ★ **座位模型选单的唯一定义**(P2 IA 收敛,2026-08-08)。
   *
   * 三个入口(`/settings` 的座位子层 · `/seat` · `/models`)此前各拼一份标题与选项,
   * 于是"手动输入坐标…"那一行的措辞、`(N 个)` 的计数、搜索开不开,**三处各写各的**。
   * 照 hermes `ModelPicker` 的形收成一份:**一份实现,三个入口**
   * (`docs/bars/hermes.md` —— 那正是 P0 单独拿出来记的一条)。
   *
   * 返回 `null` = 目录空(没配 models.json / provider 没注册)⇒ 调用方**退回手输**,
   * 不开空框(开空框等于把人锁在一个只能按 Esc 的界面里)。
   */
  function seatModelOpts(role: string, now: string): SelectOpts | null {
    const current = now.startsWith('(') || !now ? null : now;
    // 全目录(2026-08-10): registry + configured 的 pi 目录家 + claude-code 派生 —— 照 pi 的
    // "Only showing models from configured providers"。没配的家不出场, /login 配了自然出现。
    const { fullModelCatalogDeps } = require('./provider-directory') as typeof import('./provider-directory');
    const choices = sortChoices(listModelChoices(fullModelCatalogDeps()), current);
    if (choices.length === 0) return null;
    // advisor 行复用同一子层 (key `seat:advisor.<seat>`), 只多一条"清掉" —— advisor 与座位模型
    // 不同: 它有合法的"不配"态 (不自动选, transcript 会外发), 座位模型没有。
    const isAdvisor = role.startsWith('advisor.');
    return {
      title: `${role} 换成哪个模型? (${choices.length} 个)`,
      options: [
        ...(isAdvisor ? [{ value: ADVISOR_NONE, label: '(none) 清掉 advisor', description: 'delete advisors key - back to unset' }] : []),
        ...choices.map((c) => ({ value: c.coord, label: choiceLabel(c, current) })),
        { value: MANUAL_COORD, label: '手动输入坐标…', description: '目录里没有登记的 provider:model' },
      ],
      search: true,
      maxVisible: 12,
    };
  }

  /** 手输坐标那条退路 —— 同样只此一份。 */
  function seatManualOpts(role: string, now: string): InputOpts {
    return { title: `${role} 换成哪个坐标? (provider:model)`, initial: now.startsWith('(') ? '' : now };
  }

  /**
   * `/models` 的一次性形态(它要 Promise:`handleModels` 是一趟直线,没有父层要留在栈里)。
   * **选项与标题全部来自 `seatModelOpts`** —— 这里只负责"把它开成一个一次性对话框"。
   */
  async function modelPicker(role: string, now: string): Promise<string | null> {
    const manual = (): Promise<string | null> => dialogInput(dialogs, theme, seatManualOpts(role, now));
    const optsSel = seatModelOpts(role, now);
    if (optsSel === null) return manual();
    const picked = await dialogSelect(dialogs, theme, optsSel);
    if (picked === null) return null;
    return picked === MANUAL_COORD ? manual() : picked;
  }

  /**
   * ★ **`/seat` 与 `/settings` 收成同一个组件**(P2 IA 收敛,2026-08-08)。
   *
   * ## 收的是什么
   *
   * 迁 `SettingsList` 那一程只收了一半:`/settings` 里每个座位**自己就是一行**,
   * Enter 直接开模型子层(**两层**);而 `/seat` 还是老的三层
   * (选座位列表 → 选模型 → 返回,靠 `for(;;)` 重开父层)。
   * **两套并存,而且差异是那一程自己造成的** —— 越留越贵:改一处子层行为要记得改两处,
   * 而"记得"正是本仓一再吃亏的东西。
   *
   * ## 现在
   *
   * `/seat` = **同一个面板,只是把项过滤成座位行**。于是:
   * 退一级的行为、选中行不丢、写盘失败回显真值 —— 三件全都自动一致,不需要各自实现一遍。
   * 少掉的那一层(`改哪个座位?`)不是功能,是老做法的产物:面板里每行**就是**一个座位。
   */
  async function openSeatPanel(): Promise<void> {
    const { current, err } = readSeats();
    const items = buildSettings({
      seats: current,
      seatsError: err,
      sessionId,
      sessionCount: null,
      pressure: null,
      color: colorEnabled(),
      truecolor: truecolorEnabled(),
      extensions: [],
      advisors: readAdvisors(), // advisor 行 action 也是 seat → /seat 面板自动带上
    }).filter((it) => it.action === 'seat');
    await new Promise<void>((resolve) => {
      const panel = createSettingsPanel({
        theme,
        items,
        painters: PAINTERS,
        // ★ 可见窗 12 → 4 (2026-08-10 座位真源切片): 全量 16 座时 12 行可见窗 + 描述区
        //   把面板顶到 ~26 行, 30 行终端里对话区只剩 2 行 —— `/seat` 回执 (3 核心座 +
        //   用法) 被挤到视口外, S12-1/S12-2 当场红 (PTY 实跑钉的)。4 行可见窗 +
        //   buildSettings 面板形态不带描述区 ⇒ 面板 ~10 行, 回执与面板同屏。
        //   全量座位仍可达: 列表可滚 ((1/N) 计数), 面板列全量不变。
        maxVisible: 4,
        title: 'Which seat?  (↑↓ select · Enter model · Esc cancel)',
        seatChoices: seatModelOpts,
        seatManual: seatManualOpts,
        textPrompt: (_id, cur) => ({ title: '?', initial: cur }), // 座位面板里没有文本项
        apply: (id, value) => applySetting(id, value),
        activate: () => {}, // 同上:过滤后只剩座位行, 没有"跳走"的项
        onCancel: () => {
          dialogs.close();
          resolve();
        },
        requestRender: () => tui.requestRender(),
      });
      if (!dialogs.open(panel, panel)) resolve();
      else tui.requestRender();
    });
    tui.requestRender();
  }

  /**
   * `/hud` —— 开关左侧栏的 DAG 树(切片③)。
   *
   * ⚠ 关掉时**不清空图** —— 图是 run 的状态不是 UI 的状态,关掉再开该看到同一张图。
   * 清空会让人以为"关一下把 run 弄没了"。
   */
  function handleHud(text: string): boolean {
    const t = text.trim();
    if (t !== '/hud') return false;
    chatLog.appendUser(t);
    editor.setText('');
    sidebarOn = !sidebarOn;
    chatLog.appendNotice(
      sidebarOn
        ? `DAG sidebar: on (drawn when there is a run and the terminal is at least ${SIDEBAR_MIN_TOTAL} columns; auto-hidden when narrower)`
        : 'DAG sidebar: off (the table at the bottom is back)',
    );
    tui.requestRender();
    return true;
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
      chatLog.appendNotice(formatSeatRows(seatRows(current, readAdvisors())));
      if (err) chatLog.appendNotice(CHROME.seatUnresolved(err));
      tui.requestRender();
      void openSeatPanel();
      return true;
    }
    if (cmd.kind === 'usage') chatLog.appendNotice(cmd.reason);
    else if (cmd.kind === 'advise') applyAdvisor(cmd.seat, cmd.coord);
    else applySeat(cmd.role, cmd.coord);
    tui.requestRender();
    return true;
  }

  /** advisor 消费座 (resolveSeatAdvisor 的两个消费点): conductor chat · leaf 装配。 */
  const ADVISOR_SEATS = ['conductor', 'leaf'] as const;

  /** advisor 子层"清掉"项的哨兵。NUL 开头与 MANUAL_COORD 同理 —— 真坐标里不会有 NUL。 */
  const ADVISOR_NONE = ' none';

  /** 读两个消费座的 advisor 现值。缺席 = 没配 (undefined), 不编 none。 */
  function readAdvisors(): Record<string, string | undefined> {
    const { resolveSeatAdvisor } = require('../model/role-models') as typeof import('../model/role-models');
    return Object.fromEntries(ADVISOR_SEATS.map((s) => [s, resolveSeatAdvisor(s)]));
  }

  /** advisor 写点 (owner 点名可配, 2026-08-10)。`null` = 清掉(删键)。回执带写到哪。 */
  function applyAdvisor(seat: string, coord: string | null): void {
    try {
      const { persistSeatAdvisor, resolveSeatAdvisor } = require('../model/role-models') as typeof import('../model/role-models');
      if (coord !== null && !coord.includes(':')) {
        chatLog.appendNotice(CHROME.seatFailed(`advisor coordinate must be provider:model (got '${coord}')`));
        return;
      }
      persistSeatAdvisor(seat, coord);
      const now = resolveSeatAdvisor(seat);
      chatLog.appendNotice(`advisor ${seat} -> ${now ?? '(none)'} (advisors.${seat} in .omd/config.json)`);
      // 一期纪律 (claude-sdk-loop.officialAdvisorModelId): claude-code 座只认 claude-code:* advisor,
      // 异族坐标运行时不挂。这里在**写的那一刻**就把话说明, 不等一轮跑完才发现没生效。
      const seatCoord = readSeats().current[seat];
      if (now && seatCoord?.startsWith('claude-code:') && !now.startsWith('claude-code:')) {
        chatLog.appendNotice(`warning: seat ${seat} is on the claude-code channel - a non claude-code:* advisor will not be attached at runtime`);
      }
    } catch (err) {
      chatLog.appendNotice(CHROME.seatFailed(err instanceof Error ? err.message : String(err)));
    }
    tui.requestRender();
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
        if (!runId) chatLog.appendNotice('Usage: /resume <runId> (use /runs to see what is there)');
        else if (!opts.backend.resumeRun) chatLog.appendNotice(CHROME.noRunCapability('resumeRun'));
        else {
          const r = await opts.backend.resumeRun({ runId });
          chatLog.appendNotice(r.ok ? CHROME.resumeStarted(runId, r.text) : CHROME.resumeRefused(runId, r.text));
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, cmd: t }, '[omd/tui] run 命令抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
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
   *
   * `/new` 与 `/fork` 是它的直达别名 —— 解析走 `sessions.ts` 的 `parseNewForkCommand`
   * (与 parseSessionCommand 同族),分发落进下面同一个 new/fork 分支,不另写会话逻辑。
   */
  /** 切过去 + 回放。抽出来是因为**文本命令与选择器两条路都要走它** —— 两份必漂。 */
  async function switchTo(id: string): Promise<void> {
    const history = await opts.backend.loadHistory({ sessionId: id });
    sessionId = id;
    health.reset(); // 计数是一条会话的上下文状态 —— 跟着会话走, 不跟着进程走
    healthLine.setText('');
    chatLog.replay(history as never);
    chatLog.appendNotice(CHROME.sessionSwitched(id, history.length));
  }

  async function handleSession(text: string): Promise<boolean> {
    const cmd = parseSessionCommand(text) ?? parseNewForkCommand(text);
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
          title: 'Switch to which session?',
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
        health.reset();
        healthLine.setText('');
        chatLog.clear();
        chatLog.appendNotice(CHROME.sessionNew(sessionId));
      } else if (cmd.kind === 'fork') {
        // 切片⑦: fork 当前会话 → 切进分支。失败**不切**(半切会让下一句发进不存在的会话)。
        if (!opts.backend.forkSession) {
          chatLog.appendNotice(CHROME.noRunCapability('forkSession'));
        } else {
          const newId = cmd.id ?? forkSessionId(sessionId);
          const r = await opts.backend.forkSession({ fromId: sessionId, newId });
          if (!r.ok) chatLog.appendNotice(CHROME.sessionForkFailed(r.text));
          else {
            await switchTo(newId);
            chatLog.appendNotice(CHROME.sessionForked(r.text));
          }
        }
      } else {
        await switchTo(cmd.id);
      }
    } catch (err) {
      // 切失败时**不许改 sessionId** —— 半切过去会让下一句发进一条不存在的会话。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, cmd: text }, '[omd/tui] session 命令抛了');
      chatLog.appendNotice(CHROME.sessionFailed(reason));
    }
    footer.setText(CHROME.footer());
    tui.requestRender();
    return true;
  }

  /**
   * `Ctrl+P` 的选图 + 全屏(切片⑧)。多张图先挑, 一张直接进, 零张说真话。
   */
  async function openPathView(): Promise<void> {
    const { summarizeOpenMaps } = require('../harness/pathfinder/maps') as typeof import('../harness/pathfinder/maps');
    let maps: import('../harness/pathfinder/maps').OpenMapSummary[] = [];
    try {
      maps = summarizeOpenMaps(opts.cwd);
    } catch (err) {
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(err instanceof Error ? err.message : String(err))));
      tui.requestRender();
      return;
    }
    if (maps.length === 0) {
      chatLog.appendNotice(CHROME.noPathMaps());
      tui.requestRender();
      return;
    }
    let slug = maps[0]!.slug;
    if (maps.length > 1) {
      const picked = await dialogSelect(dialogs, theme, {
        title: 'Switch to which map?',
        options: maps.map((m) => ({
          value: m.slug,
          label: `${m.slug === pathSlugSel ? '* ' : '  '}${m.slug}`,
          description: `frontier ${m.frontierCount} · open ${m.openCount} - ${m.destination}`,
        })),
        search: true,
      });
      if (picked === null) return; // Esc: 不切不开
      slug = picked;
    }
    pathSlugSel = slug;
    pathSelected = 0;
    reloadPathData();
    pathHud.refresh(); // 侧栏跟着换图
    pathFullOn = true;
    tui.requestRender();
  }

  /**
   * 票的动作弹窗(切片⑧,三方案稿共用交互)。四动作 g/d/c/r。
   *
   * ⚠ **与稿的显式偏离**:稿里选完动作弹「现在执行? y/n」并直接派 run。这里选完把
   * 对应指令**预填进输入框**,回车才发 —— 二段确认由"预填不发送"承担,执行走
   * conductor 既有的 map/run 工具面, 不在 UI 里长第二条派活路径。
   */
  async function openTicketActions(t: { id: string; type: string; title: string }): Promise<void> {
    const slug = pathSlugSel ?? '';
    const act = await dialogSelect(dialogs, theme, {
      title: `ticket ${t.id} · ${t.title}`,
      options: [
        { value: 'g', label: 'g grill', description: 'split the fork open for the owner to rule on' },
        { value: 'd', label: 'd do it (dag_goal/dag_run)', description: 'hand this ticket to the engine' },
        { value: 'c', label: 'c comment', description: 'write an owner note back into the map' },
        { value: 'r', label: 'r research', description: 'run dag_research to collect evidence' },
      ],
    });
    if (act === null) return; // Esc: 返回
    const prompts: Record<string, string> = {
      g: `Grill ticket ${t.id} "${t.title}" of map ${slug}: walk the decision tree, give a recommended answer first, and list the questions that need my ruling`,
      d: `Hand ticket ${t.id} "${t.title}" of map ${slug} to the engine (omd_run or omd_solve), then report the result and a ruling recommendation for that ticket`,
      c: `Record an owner note on ticket ${t.id} of map ${slug}: `,
      r: `Run one round of research on ticket ${t.id} "${t.title}" of map ${slug}, then summarize it into a ruling recommendation`,
    };
    // 预填不发送 —— 回车那一下才是"现在执行"。
    pathFullOn = false;
    editor.setText(prompts[act] ?? '');
    tui.setFocus(editor);
    tui.requestRender();
  }

  /**
   * `/login` —— 给一个 provider 落 key(切片⑥)。
   *
   * 复用 `setKeyHeadless`(auth.json / .env 双路由 + 活注入,与 `omd_set_key` MCP 同一条),
   * **不新写写盘逻辑**。key 输入框回显打星 —— 屏幕会进截图与 scrollback,一个字符都不许上屏。
   */
  async function handleLogin(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/login' && !t.startsWith('/login ')) return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    try {
      // ★ 全目录选单(2026-08-10, owner 点名照 pi): pi 目录 38 家 ∪ 探到的 ∪ claude-code,
      //   配了的排前挂状态 —— 此前只列 discoverProviders() 探到的, 新机器上是空表。
      const { CLAUDE_CODE_ID, listProviderRows, providerRowLabel } =
        require('./provider-directory') as typeof import('./provider-directory');
      let provider = t.split(/\s+/)[1] ?? '';
      if (!provider) {
        const rows = listProviderRows();
        const MANUAL = ' manual';
        const configured = rows.filter((r) => r.status !== 'unconfigured').length;
        const picked = await dialogSelect(dialogs, theme, {
          title: `Configure which provider? (${configured}/${rows.length} configured)`,
          options: [
            ...rows.map((r) => ({ value: r.id, label: providerRowLabel(r) })),
            { value: MANUAL, label: 'type a provider id…', description: 'works for ones the catalog cannot see' },
          ],
          search: true,
          maxVisible: 12,
        });
        if (picked === null) return true; // Esc: 什么都不改
        provider = picked === MANUAL ? ((await dialogInput(dialogs, theme, { title: 'provider id' })) ?? '') : picked;
        if (!provider.trim()) return true;
      }
      if (provider.trim() === CLAUDE_CODE_ID) {
        // 订阅通道没有"落 key"这条路 —— 凭证归 claude CLI 管, 这里指路而不是开一个必失败的输入框。
        chatLog.appendNotice('claude-code uses the Claude CLI subscription - run `claude login` in a terminal; seats see it automatically.');
        tui.requestRender();
        return true;
      }
      const key = await dialogInput(dialogs, theme, { title: `API key for ${provider} (echo is masked)`, mask: true });
      if (key === null || !key.trim()) return true; // Esc / 空: 什么都不改
      const { setKeyHeadless } = require('../harness/init/headless-config') as typeof import('../harness/init/headless-config');
      const r = setKeyHeadless(provider.trim(), key.trim());
      chatLog.appendNotice(CHROME.loginDone(r.provider, r.target, r.warnings));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /login 抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }
  /**
   * `/logout` —— 删一个 provider 的凭证(切片⑥的反向)。
   *
   * 复用 `removeKeyHeadless`(与 `setKeyHeadless` 同一条反向路由,删的是盘上真存在的键),
   * **不新写删凭证逻辑**。裸 `/logout` 开选单 —— 只列已配的(listProviderRows 过滤
   * unconfigured);Esc 零副作用,回执写明什么都没动。claude-code 的凭证归 claude CLI
   * 自管,这里只指路不假装删。
   */
  async function handleLogout(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/logout' && !t.startsWith('/logout ')) return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    try {
      const { CLAUDE_CODE_ID, listProviderRows, providerRowLabel } =
        require('./provider-directory') as typeof import('./provider-directory');
      let provider = t.split(/\s+/)[1] ?? '';
      if (!provider) {
        // 只列已配的 —— 没配过的家没有凭证可删, 列出来是给人按 Esc 的假动作。
        const rows = listProviderRows().filter((r) => r.status !== 'unconfigured');
        if (rows.length === 0) {
          chatLog.appendNotice('No configured provider credentials to remove - nothing removed');
          tui.requestRender();
          return true;
        }
        const picked = await dialogSelect(dialogs, theme, {
          title: 'Log out which provider?  (Esc cancels, nothing removed)',
          options: rows.map((r) => ({ value: r.id, label: providerRowLabel(r) })),
          search: true,
          maxVisible: 12,
        });
        if (picked === null) {
          // Esc: 零副作用 —— 只是关选单, 什么都没删。
          chatLog.appendNotice(CHROME.logoutCancelled());
          tui.requestRender();
          return true;
        }
        provider = picked;
      }
      if (provider.trim() === CLAUDE_CODE_ID) {
        chatLog.appendNotice(CHROME.logoutClaude());
        tui.requestRender();
        return true;
      }
      const { removeKeyHeadless } = require('../harness/init/headless-config') as typeof import('../harness/init/headless-config');
      const r = removeKeyHeadless(provider.trim());
      chatLog.appendNotice(r.removed.length > 0 ? CHROME.logoutDone(r.provider, r.removed, r.warnings) : CHROME.logoutNone(r.provider, r.warnings));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /logout 抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/status` —— 一屏当前状态,**只读零副作用**。
   *
   * 四段读数全走既有读径(座位 / sessionId / lastPressure / 账本窗口),
   * 读不到的行由 formatStatus 写真话 —— 不编数。
   */
  function handleStatus(text: string): boolean {
    const t = text.trim();
    if (t !== '/status') return false;
    chatLog.appendUser(t);
    editor.setText('');
    const { current } = readSeats();
    // 账本行:ledger 只有滚动窗口, 24h 是"今日"最近似的现成读数, 标明窗口不冒充日账。
    const win = opts.usage?.window(DAY_MS) ?? null;
    chatLog.appendNotice(
      formatStatus({
        seat: current.conductor ?? null,
        sessionId,
        pressure: lastPressure,
        usageToday: win === null ? null : `${fmtUsd(win.costUsd, win.unpriced)} · ↑${humanTokens(win.in)} ↓${humanTokens(win.out)} · ${win.calls} calls (24h window)`,
      }),
    );
    tui.requestRender();
    return true;
  }

  /**
   * `/compact` —— 手动压缩当前会话上下文(真 model call + 落盘,副作用)。
   *
   * 复用 backend 的 `compact`(内部走 chat 既有 compaction 管线),回执带压缩前后
   * 两个 token 估读数。压缩后**清屏重放** —— 屏上必须是人/模型同一份历史
   * (sessions.ts 那条纪律:不回放的话旧消息冒充新上下文)。
   */
  async function handleCompact(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/compact') return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    try {
      const r = await opts.backend.compact({ sessionId });
      if (r === null) {
        chatLog.appendNotice(CHROME.compactNone());
      } else {
        chatLog.clear();
        const history = await opts.backend.loadHistory({ sessionId });
        chatLog.replay(history as never);
        chatLog.appendNotice(CHROME.compactDone(sessionId, r.tokensBefore, r.tokensAfter, r.messageCount));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /compact 抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/export` —— 把当前会话 transcript 写成 markdown 文件(写盘,副作用)。
   *
   * 数据从 `backend.loadHistory` 取,不新造存储;缺省路径 `.omd/exports/<sessionId>-<ts>.md`
   * 由 export.ts 给。回执带**绝对路径** —— 人要在别的终端里找得到那个文件。
   */
  async function handleExport(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/export' && !t.startsWith('/export ')) return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    try {
      const history = await opts.backend.loadHistory({ sessionId });
      const markdown = exportTranscriptMarkdown(history, { sessionId });
      const rel = t.split(/\s+/)[1] ?? defaultExportPath(sessionId, Date.now());
      const abs = resolvePath(opts.cwd, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${markdown}\n`, 'utf8');
      chatLog.appendNotice(CHROME.exportDone(history.length, abs));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /export 抛了');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /** `/quit` —— 干净退出。与双击 Ctrl+C 的 `'exit'` 分支共走 {@link requestCleanExit}。 */
  function handleQuit(text: string): boolean {
    const t = text.trim();
    if (t !== '/quit') return false;
    chatLog.appendUser(t);
    editor.setText('');
    requestCleanExit();
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
    /**
     * ★ **循环只剩"跳走再回来"这一种**(2026-08-08,P1-3)。
     *
     * `ac8d92d` 那版是"改一项就重开一次整页" —— 用户看到的是退回上一级,但它是**重开**,
     * 选中行位置会丢。现在设置页是**常驻组件**(pi-tui `SettingsList`),改值/开子层
     * 全在组件内部,循环碰不到它。
     *
     * 剩下这个循环只服务两项:`当前会话` 与 `provider 凭证` —— 它们不是"改一个值",
     * 是**跳去另一条流程**,而那条流程自己要开对话框,host 一次只开一个
     * (`dialog.ts` 文件头的裁决)。所以必须先让位,办完再把面板开回来。
     * 重开在这里是**对的**:刚落的 key 要显示成"已配",不重读就还是旧数。
     */
    for (;;) {
      const jump = await settingsOnce();
      if (jump === null) break; // Esc:收工
      if (jump === 'session') await handleSession('/session');
      else if (jump === 'providers') await handleLogin('/login');
    }
    tui.requestRender();
    return true;
  }

  /**
   * 开一次设置页(常驻组件)。返回 `null` = 用户按 Esc 收工;
   * 返回一个 id = 那一项要**跳去另一条流程**,面板已让位,由外层办完再开回来。
   */
  async function settingsOnce(): Promise<string | null> {
    const { current, err } = readSeats();
    let sessionCount: number | null = null;
    try {
      sessionCount = (await opts.backend.listSessions()).length;
    } catch {
      // 读不到就是 null —— 与"一条都没有"分得开(本仓 NULL ≠ 0)。
    }
    // 切片⑥: 可改组的现状。TTL 与 provider 现读 (只在 /settings 打开时, 不在渲染回路)。
    const approvalTtlSec = ((): number => {
      const { loadApprovalConfig } = require('./approval/policy') as typeof import('./approval/policy');
      return loadApprovalConfig(opts.cwd).tokenTtlSec;
    })();
    const providers = ((): { id: string; hasKey: boolean }[] => {
      try {
        const { discoverProviders } = require('../config/config-discovery') as typeof import('../config/config-discovery');
        return discoverProviders(process.env).map((p) => ({ id: p.id, hasKey: Boolean(p.hasKey) }));
      } catch {
        return []; // 发现不了 = 空表 (面板画「一个都没发现」, 不是崩)
      }
    })();
    const items = buildSettings({
      seats: current,
      seatsError: err,
      sessionId,
      sessionCount,
      pressure: lastPressure,
      color: colorEnabled(),
      truecolor: truecolorEnabled(),
      extensions: opts.extensions ?? [],
      ui: { sidebar: sidebarOn, painterName: PAINTERS[painterIdx] ?? 'tree' },
      approvalTtlSec,
      providers,
      advisors: readAdvisors(),
    });
    return new Promise<string | null>((resolve) => {
      const panel = createSettingsPanel({
        theme,
        items,
        painters: PAINTERS,
        // ★ 窗口装下**全部行**(2026-08-10): 面板把只读行排到末尾 (P3 件2 赢的那一手),
        //   窗口 < 行数时只读尾巴 (colors/glyphs) 首绘永远不可见 —— advisor 行加进来时
        //   SET-1 就是这么红的。写死 12 会在每次加行时复发, 所以跟着行数走。
        maxVisible: Math.max(12, items.length),
        // 座位子层 = 模型选单。**三个入口一份实现**(P2 IA 收敛)—— 定义在 `seatModelOpts`。
        seatChoices: seatModelOpts,
        seatManual: seatManualOpts,
        // `审批 token TTL` 的值带单位(`30s`), 而输入框里该是**可编辑的数**, 不是带单位的串。
        textPrompt: (_id, current) => ({ title: 'Approval token TTL (seconds)', initial: current.replace(/s$/, '') }),
        apply: (id, value) => applySetting(id, value),
        activate: (id) => {
          // 就地办完的:一条通知就够, 面板留着(通知画在对话区, 不遮设置页)。
          if (id === 'ext') {
            chatLog.appendNotice('The extension manifest lives in `.omd/extensions.json` (entry points are absolute paths). Restart omd tui after editing it.');
            tui.requestRender();
            return;
          }
          // 要开对话框的:让位。外层办完再把面板开回来。
          finish(id);
        },
        onCancel: () => finish(null),
        requestRender: () => tui.requestRender(),
      });
      /**
       * ⚠ **面板自己画框与标题**,这里不许再套一层 `DialogBox`。
       *
       * 第一版套了 —— 帧上当场看见**双层框、标题印两遍**
       * (`docs/bars/refs/omd/07-settings.txt`)。单测看不见这个:它量的是面板自己的
       * `render()`,套在外面那层不在它视野里。**渲染类改动必须拿帧核对**(交接 40 §7.6)。
       */
      const finish = (v: string | null): void => {
        dialogs.close();
        resolve(v);
      };
      if (!dialogs.open(panel, panel)) resolve(null);
      else tui.requestRender();
    });
  }

  /**
   * 真的改一项。**返回改完之后的真值** —— 面板照它回显。
   *
   * ⚠ 写盘失败时返回**旧值**:屏幕上不许留下一个"改好了"的假象。这是本仓
   * "oracle 绿 ≠ 语义对"的同一条 —— 回执说改了而盘上没改, 是最难发现的一种错。
   */
  function applySetting(id: string, value: string): string {
    if (id.startsWith('seat:advisor.')) {
      const seat = id.slice('seat:advisor.'.length);
      // 空串 = 手输框空提交 → 不动 (清掉走显式的 (none) 项, 不让"没输"当成"清掉")。
      if (value !== ADVISOR_NONE && !value.trim()) return readAdvisors()[seat] ?? '(none)';
      applyAdvisor(seat, value === ADVISOR_NONE ? null : value.trim());
      // 真值回盘上读 (applyAdvisor 吞异常发回执, 同 applySeat 的口径)。
      return readAdvisors()[seat] ?? '(none)';
    }
    if (id.startsWith('seat:')) {
      const role = id.slice('seat:'.length);
      const coord = value.trim();
      if (!coord) return readSeats().current[role] ?? value;
      applySeat(role, coord);
      // applySeat 自己吞了异常并发了回执 —— 真值只能回盘上读, 不能信入参。
      return readSeats().current[role] ?? coord;
    }
    if (id === 'ui-sidebar') {
      sidebarOn = value === 'on';
      const path = setTuiUi(opts.cwd, { sidebar: sidebarOn });
      chatLog.appendNotice(CHROME.uiWritten(`DAG sidebar default -> ${sidebarOn ? 'on' : 'off'}`, path));
      return sidebarOn ? 'on' : 'off';
    }
    if (id === 'ui-painter') {
      const idx = PAINTERS.indexOf(value as (typeof PAINTERS)[number]);
      if (idx < 0) return PAINTERS[painterIdx] ?? 'tree'; // 认不出就不动 —— 别把 painterIdx 写成 -1
      painterIdx = idx;
      const path = setTuiUi(opts.cwd, { painterIdx });
      chatLog.appendNotice(CHROME.uiWritten(`fullscreen default view -> ${PAINTERS[painterIdx]}`, path));
      return PAINTERS[painterIdx] as string;
    }
    if (id === 'approval-ttl') {
      const raw = value.trim();
      const { loadApprovalConfig } = require('./approval/policy') as typeof import('./approval/policy');
      const old = `${loadApprovalConfig(opts.cwd).tokenTtlSec}s`;
      if (!raw) return old;
      try {
        const sec = Number(raw);
        const path = setApprovalTokenTtl(opts.cwd, sec);
        chatLog.appendNotice(CHROME.approvalTtlWritten(sec, path));
        return `${sec}s`;
      } catch (err2) {
        chatLog.appendNotice(CHROME.failed(humanizeProviderError(err2 instanceof Error ? err2.message : String(err2))));
        return old; // ★ 拒了就回显旧值
      }
    }
    return value;
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
    if (handleHud(prompt)) return;
    if (handleSeat(prompt)) return;
    // 与 `/settings` 同一条形状:解析是同步的, 处理是异步的 —— 分发这一层不是 async。
    if (parseModelsCommand(prompt)) {
      void handleModels(prompt);
      return;
    }
    if (handleSkill(prompt)) return;
    // S-6: 组命令排在 handleSkill 之后 —— `/skill` 本身不是组名, 顺序上不会互吃。
    if (handleSkillGroup(prompt)) return;
    // 只读 / 退出命令就地消化; 其余走既有异步链 (解析同步、处理异步 —— 分发这一层不是 async)。
    if (handleStatus(prompt)) return;
    if (handleQuit(prompt)) return;
    if (parseSettingsCommand(prompt)) {
      void handleSettings(prompt);
      return;
    }
    void handleLogin(prompt).then((handledLogin) => {
      if (handledLogin) return;
      void handleLogout(prompt).then((handledLogout) => {
        if (handledLogout) return;
        void handleSession(prompt).then((handledSession) => {
          if (handledSession) return;
          void handleCompact(prompt).then((handledCompact) => {
            if (handledCompact) return;
            void handleExport(prompt).then((handledExport) => {
              if (handledExport) return;
              void handleRuns(prompt).then((handled) => {
                if (!handled) void submit(prompt);
              });
            });
          });
        });
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
        requestCleanExit();
      } else {
        armedAt = now();
        footer.setText(CHROME.footerArmed());
        tui.requestRender();
      }
      return { consume: true };
    }
    // 切片⑧: Ctrl+P (\x10) 开关 pathfinder 全屏; 全屏时 Tab 切画法, 上下键选票, Enter 动作。
    // ⚠ 弹窗开着时 (dialogs.busy) 这些键要让给弹窗 —— 抢了的话动作选单收不到 Enter。
    if (data === '\x10' && !dialogs.busy) {
      if (pathFullOn) pathFullOn = false;
      else void openPathView();
      tui.requestRender();
      return { consume: true };
    }
    if (pathFullOn && !dialogs.busy) {
      if (data === '\t') {
        pathPainter = (pathPainter + 1) % 2;
        tui.requestRender();
        return { consume: true };
      }
      if (data === '\x1b[A' || data === '\x1b[B') {
        const n = pathData?.frontier.length ?? 0;
        if (n > 0) pathSelected = (pathSelected + (data === '\x1b[A' ? -1 : 1) + n) % n;
        tui.requestRender();
        return { consume: true };
      }
      if (data === '\r' || data === '\n') {
        const t = pathData?.frontier[pathSelected];
        if (t) void openTicketActions(t);
        return { consume: true };
      }
    }
    // 切片③: Ctrl+G (\x07) 开关全屏 DAG; 全屏时 Tab 循环三画法。
    // ⚠ Tab 只在全屏时截 —— 平时它是 editor 的补全键, 抢了会让输入框残废。
    if (data === '\x07') {
      if (!dagTree.active && !fullOn) {
        chatLog.appendNotice('No run yet - send one, then press Ctrl+G');
      } else {
        fullOn = !fullOn;
      }
      tui.requestRender();
      return { consume: true };
    }
    if (fullOn && data === '\t') {
      painterIdx = (painterIdx + 1) % 3;
      tui.requestRender();
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
      footer.setText(CHROME.footer());
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
