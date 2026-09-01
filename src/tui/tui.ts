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
import { dirname, join, resolve as resolvePath } from 'node:path';
import { type Component, Container, HStack, Loader, ProcessTerminal, Spacer, TuiMainScreen, VStack, type Terminal, visibleWidth } from '@earendil-works/pi-tui';
import { HintedEditor } from './components/hinted-editor';
import { logger } from '../logger';
import { spawnFinalCheckpoint } from '../harness/session/final-spawn';
import { cancelDetachedRun, recordIntervention } from '../harness/run-control';
import { FAILURE_KIND_ORDER } from '../harness/node-failure';
import { createRunStore } from '../mcp/run-store';
import type { OmdBackend } from './backend';
import { ChatLog } from './components/chat-log';
import { type DialogHost, type InputOpts, type SelectOpts, confirm as dialogConfirm, input as dialogInput, select as dialogSelect } from './components/dialog';
import { DagHud } from './components/dag-hud';
import { DagTree } from './components/dag-tree';
import { attachExternalRun, createExternalRunChannel, type ExternalRunChannel } from './dag-hud-attach';
import { type PathReader, PathHud, createPathReader } from './components/path-hud';
import { paintTicketRow, renderTicketBoard } from './components/ticket-board';
import { renderRunBoard } from './components/run-board';
import { readBoard, awaitingRuns } from '../harness/board/run-board';
import { renderGantt } from './render/dag-gantt';
import { renderDagScreen } from './render/dag-screen';
import { type PathViewData, buildPathViewData, renderDelta, renderFogLine } from './render/path-fog';
import { fitLine } from './render/line';
import { initHyperlinks } from './render/link';
import { renderLayers } from './render/dag-layers';
import { renderRunList } from './render/run-list';
import { renderNowBand, type NowBandInput, type NowPaint } from './render/now-band';
import { applyInboxAction, decideInboxKey, renderInbox, type InboxAction, type InboxItem } from './render/inbox';
import { readDagShards } from '../hud/load';
import { readTerminalRunIds, sweepHudSnapshots } from '../hud/gc';
import type { AttentionView } from '../serve/read-api';
import { createAttentionReader } from './attention-reader';
import { createOscTailGuard } from './osc-guard';
import { StatusLine } from './components/status-line';
import { formatSeatRows, parseSeatCommand, seatRows } from './seat-picker';
import { defaultTuiSessionId, forkSessionId, formatSessions, newSessionId, parseNewForkCommand, parseSessionCommand, sessionPickerOptions } from './sessions';
import { paletteOptions, parsePaletteValue } from './palette';
import { createSettingsPanel } from './components/settings-panel';
import { SPINNER_FRAMES } from './design/tokens';
import { findKeyClashes, formatKeyClashes, installOmdKeybindings, loadUserKeybindings } from './keys';
import { buildSettings, parseSettingsCommand } from './settings';
import { STARTUP_HINT, formatHelp, parseHelpCommand, parseSearchCommand, slashCommands } from './commands';
import { formatBangEntry, parseBang } from './bang';
import { PROMPTS_DIR, expandPrompt, loadUserPrompts } from './prompts';
import { detectTerminalScheme, schemeFromEnv } from './scheme-detect';
import { extractImageRefs, fmtAttachment } from './attachments';
import { MANUAL_COORD, choiceLabel, listModelChoices, parseModelsCommand, sortChoices } from './model-picker';
import { buildTreeRows, formatTree, parseTreeCommand, rewindTargets, treeLabel } from './tree-picker';
import { createOmdAutocompleteProvider } from './skill-complete';
import { createContextHealth } from './health';
import { THINKING_LEVELS, loadTuiUiConfig, setTuiUi, type ThinkingLevelName } from './ui-config';
import { renderLogo } from './render/logo';
import { summarizeToolArg } from './render/tool-arg';
import { summarizeToolResult } from './render/tool-result';
import { FOOTER_SEP, fmtUsd, formatStatusGauge, formatStatusLine } from './render/statusbar';
import { humanTokens } from './render/pressure';
import { formatStatus } from './status';
import type { ExtReloadResult } from './ext/session';
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

/** 双击 Esc 的窗口。比 Ctrl+C 宽:回退开的是选单(Esc 可反悔),误触代价低,漏触代价是"以为没这功能"。 */
export const DOUBLE_ESC_WINDOW_MS = 600;

/**
 * Esc 键的分派(纯函数,时钟外给 —— `decideCtrlC` 同款)。
 *
 * - 在飞 → `'interrupt'`:**单按就打断**,不要求双击 —— 等着的人最不想多按一下,
 *   且等待行早就承诺了 `(Esc interrupts)`(此前那是句没接线的空话)。
 * - 空闲、窗口内第二击 → `'rewind'`(开回退选单)。
 * - 空闲、第一击 → `'arm'`:只记时刻,**键不吃** —— editor 自己也用 Esc(清补全)。
 */
export function decideEsc(
  turnInFlight: boolean,
  armedAt: number | null,
  now: number,
  windowMs = DOUBLE_ESC_WINDOW_MS,
): 'interrupt' | 'rewind' | 'arm' {
  if (turnInFlight) return 'interrupt';
  if (armedAt !== null && now - armedAt <= windowMs) return 'rewind';
  return 'arm';
}

// ── 切片 S3 · 全屏状态机 (DAG 屏 ⇄ 活图列表, 2026-08-22) ──
//
// 纯函数 dispatcher 提在模块层 → 单测不必起 TUI,直接喂事件就行。
// `runOmdTui` 内部只持 `let dagFullState` 与 ticker,把 listener 的键事件
// 收成一次 `decideDagFull` 调用 + 应用结果,没分支膨胀。

/** 全屏状态。`fullOn = false` 时其它字段不读 — 但保留供关闭时记忆,
 *  重开仍是关闭前的"哪一屏 + 选到哪儿" — 同 `painterIdx` 的"上次用过的"。 */
export interface DagFullState {
  fullOn: boolean;
  kind: 'dag' | 'run-list';
  dagSelected: number;
  runListSelected: number;
}

export const initialDagFullState = (): DagFullState => ({
  fullOn: false,
  kind: 'dag',
  dagSelected: 0,
  runListSelected: 0,
});

export type DagFullEvent =
  | { type: 'toggle'; dagActive: boolean }
  | { type: 'tab' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'enter'; runListNotEmpty: boolean };

/**
 * 全屏状态机的**唯一决策点**(纯函数, 时钟外给 — `decideCtrlC` 同款)。
 *
 * - `toggle`  Ctrl+G 开关。开时归零选中(打开应是"刚开"的那一份, 不是上次闭的位置)。
 * - `tab`     DAG ⇄ run-list 循环(关着时 no-op)。
 * - `up/down` 当前屏里的选中位 ±1(mod 由 renderer 侧 `pickSelected` 处理,
 *            dispatcher 只递增递减, 不需 count)。
 * - `enter`   仅在 run-list 屏 + 列表非空时切回 DAG(空列表 = INV-DAG-8, 不假装进图)。
 */
export function decideDagFull(state: DagFullState, event: DagFullEvent): DagFullState {
  if (event.type === 'toggle') {
    if (state.fullOn) return { ...state, fullOn: false };
    // 开屏落点看 dagActive: 本进程没有 bus run → 直接落 run-list (盘上外部 run 的入口,
    // t-tui-attach 收尾) —— 否则先见一张空 DAG 屏还得 Tab 一下, 空屏即 INV-DAG-8 反例。
    return { fullOn: true, kind: event.dagActive ? 'dag' : 'run-list', dagSelected: 0, runListSelected: 0 };
  }
  if (!state.fullOn) return state;
  if (event.type === 'tab') {
    return { ...state, kind: state.kind === 'dag' ? 'run-list' : 'dag' };
  }
  if (event.type === 'up') {
    if (state.kind === 'dag') return { ...state, dagSelected: state.dagSelected - 1 };
    return { ...state, runListSelected: state.runListSelected - 1 };
  }
  if (event.type === 'down') {
    if (state.kind === 'dag') return { ...state, dagSelected: state.dagSelected + 1 };
    return { ...state, runListSelected: state.runListSelected + 1 };
  }
  // enter
  if (state.kind !== 'run-list') return state;
  if (!event.runListNotEmpty) return state; // 空列表 → 不切 (INV-DAG-8)
  return { ...state, kind: 'dag' };
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
      // ★ 启动时的 resume 入口(2026-08-22)。`defaultTuiSessionId` 让每个进程直接开新会话,
      // 从不问要不要接上次那个 —— 那条路一直存在(`/session`), 只是**屏上没有任何痕迹**。
      // 不做「启动时弹一个框问你」: 那会拦在第一句话前面, 而多数时候答案是「不接」。
      '  > Ctrl+K goes to a session / the live graph / a map - press it then Enter to pick up the last session',
      '  > Scroll back with your terminal (wheel / Shift+PgUp) - the transcript lives in scrollback',
      '  > Esc interrupts a turn · Esc Esc rewinds · Ctrl+O folds thinking · !cmd runs shell',
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
  /**
   * `Ctrl+K` 一行候选都没有。**说出探了什么、为什么空**,不静默 ——
   * 按了键什么都不发生比开一个空框更难查。
   */
  paletteEmpty: () =>
    'Nowhere to go yet: no stored sessions, no pathfinder map under docs/plan/pathfinder/, and no run in this process. Say something first, or press Ctrl+P once a map exists.',
  /** 会话表读不出来是**异常**(与「一条都没有」分得开)—— 原因原样上屏,选单照开但少一段。 */
  paletteSessionsFailed: (reason: string) => `Sessions could not be listed, this palette has no session rows: ${reason}`,
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
  /** 同一行的计时态(首个整秒起)。秒数是"活着"的证据 —— 静止的等待行与死机在屏上长得一样。 */
  waitingElapsed: (s: number) => `Working... ${s}s (Esc interrupts)`,
  /** Esc 打断的回执。要说清**部分回复留没留** —— "停了"与"停了且这段话作数"是两件事。 */
  interrupted: () => 'Interrupted - whatever was generated so far is kept in the session',
  /** 双 Esc 回退但没有可回的点 —— 说真话,不开空选单(开空框让人按 Esc 是耍人)。 */
  rewindNone: () => 'Nothing to rewind to yet - need an earlier user message (the very first one has no "before")',
  footer: () => 'omd tui · /help for commands · Ctrl+C twice to quit',
  footerArmed: () => 'omd tui · press Ctrl+C again to quit',
  /**
   * 沙箱降级告警(2026-08-13)。**顶栏一行,不是日志里一行** —— owner 裁的兜底是
   * 「降级裸跑 + 红字告警」,而"起没起来"在屏上没有别的痕迹:命令照跑、结果照回。
   */
  sandboxOff: (reason: string) => `sandbox off - shell commands run unconfined (${reason})`,
  // ── 切片⑥: /login 与设置写盘回执。key 本身一个字符都不进屏。 ──
  loginDone: (provider: string, target: string, warnings: string[]) =>
    `Key written to ${target === 'env' ? '.env' : 'auth.json'} (${provider}, effective immediately)${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  uiWritten: (what: string, path: string) => `${what} written to ${path}`,
  // ── 切片⑦: 会话树。fork 的回执要说清"现在在分支上, 原会话没动"。 ──
  sessionForked: (text: string) => `${text} - switched to the branch; the source session is untouched, /session switches back`,
  sessionForkFailed: (reason: string) => `Cannot fork: ${reason}`,
  // ── §1.3 (2026-08-11): `/tree` 的会话内分支。**回执要说清写没写摘要节点** ——
  //    "切成了" 与 "切成了并且留下了交代" 是两件事, 压成一句就再也分不开。 ──
  treeBranched: (id: string, text: string) => `Branched at ${id.slice(0, 8)}: ${text}`,
  treeBranchFailed: (reason: string) => `Cannot branch: ${reason} (the session was not moved)`,
  /** 选中的就是当前叶 —— 什么都不做, 但要说出来, 否则读成"点了没反应"。 */
  treeAtLeaf: () => 'That entry is already the current leaf - nothing to branch from, nothing was written',
  /** 切片⑧: 一张图都没有时说真话 (画一个空雾场会读成"有图但没散")。 */
  noPathMaps: () => 'No pathfinder map yet (docs/plan/pathfinder/ is empty) - open one with /omd-path',
  // ── 2026-08-11 命令面六项(/compact /logout /status /export /new /fork /quit)的回执。 ──
  compactDone: (id: string, before: number, after: number, n: number) =>
    `Compacted ${id}: ~${before} -> ~${after} tokens (${n} messages -> summary + tail)`,
  /** 静态串一律走函数形(与 footer/footerArmed 同款):字形闸只采样字符串常量,ASCII 串不占样本表。 */
  compactNone: () => 'Nothing to compact: session is empty or already at the tail',
  // ── `/search`(2026-08-17): 跨会话全文搜索的三句回执。 ──
  searchUsage: () => 'Usage: /search <text> - full-text search across all sessions',
  searchNone: (q: string) => `No hits for "${q}" in any session`,
  // ── `!` bash 直通(2026-08-17): 本地跑命令, 输出进上下文。 ──
  bangUsage: () => 'Usage: !<command> - runs locally in the repo; the output joins the session context',
  bangBusy: () => 'A turn is in flight - run local commands after it finishes (Esc interrupts)',
  // ── 在飞排队 (W1): 三句回执把"什么时候真的发出去"说清 —— 排队最怕的是黑盒。 ──
  queued: (n: number) => `Queued (#${n}) - joins the running turn at the next tool boundary, or right after it ends`,
  queuedFlush: (n: number) => `Sending ${n} queued message(s) as the next turn`,
  queuedHeld: (n: number) => `Interrupted - ${n} queued message(s) put back into the editor, Enter re-sends`,
  // ── /think (W1): 回执印**写盘后的真值**, 不印入参。 ──
  thinkShown: (level: string) => `thinking level: ${level} (set with /think <${'off|low|medium|high|xhigh'}>)`,
  thinkSet: (level: string, path: string) => `thinking level -> ${level} (persisted to ${path})`,
  thinkBad: (given: string) => `Unknown thinking level "${given}" - valid: off, low, medium, high, xhigh`,
  // ── W5 图片附件的两句回执 (I5: 附了什么、跳了什么, 都说真话)。 ──
  attached: (items: string[]) => `attached: ${items.join(', ')}`,
  attachSkipped: (ref: string, reason: string) => `not attached: ${ref} (${reason})`,
  logoutCancelled: () => 'logout cancelled, nothing removed',
  logoutClaude: () => 'claude-code uses the Claude CLI subscription - run `claude logout` in a terminal; omd does not touch its credentials.',
  logoutDone: (provider: string, removed: { file: string; key: string }[], warnings: string[]) =>
    `Removed ${provider} credential: ${removed.map((r) => `${r.key} in ${r.file}`).join(', ')}${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  logoutNone: (provider: string, warnings: string[]) =>
    `No stored credential for ${provider} - nothing removed${warnings.length > 0 ? `\n  ${warnings.join('\n  ')}` : ''}`,
  exportDone: (n: number, abs: string) => `Exported ${n} messages -> ${abs}`,
  // ── D3 `/reload`(2026-08-11): 扩展重载回执。**成败两侧都要有数**, 且工具面的那条
  //    限制(启动时冻结)只在真发生时才多说一行 —— 没有增减就不占屏。 ──
  extReloaded: (r: ExtReloadResult) => {
    const head =
      r.loaded.length === 0 && r.rejected.length === 0
        ? 'Extensions reloaded: the manifest lists none (.omd/extensions.json)'
        : `Extensions reloaded: ${r.loaded.length} loaded${r.loaded.length > 0 ? ` (${r.loaded.join(', ')})` : ''}, ${r.rejected.length} rejected${
            r.rejected.length > 0 ? ` (${r.rejected.map((x) => `${x.name}: ${x.reason}`).join('; ')})` : ''
          }`;
    const lines = [head];
    // 工具面在启动时冻结(chat-seat.ts:81 展开成新数组), 所以增减要说出来, 不静默。
    if (r.toolsAdded.length > 0) lines.push(`  new tools need a restart to reach the model: ${r.toolsAdded.join(', ')}`);
    if (r.toolsRemoved.length > 0) lines.push(`  tools that went away are still listed but now answer with an error: ${r.toolsRemoved.join(', ')}`);
    return lines.join('\n');
  },
  /** 一轮还在飞的时候拒绝重载 —— kill 掉正在被调用的子进程会让那一轮无声地断。 */
  extReloadBusy: () => 'Not reloading: this turn is still running (a tool call could be in flight). Try again once it finishes.',
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
   * `/reload` 的执行侧(D3,2026-08-11)。kill 掉扩展子进程 + 按 `.omd/extensions.json` 重来。
   *
   * **省略 = 这条装配路没有扩展宿主**(fixture lane)—— 那时 `/reload` 说清"这个 backend
   * 没有这个能力", 不装一个点了没反应的命令(同 `noRunCapability` 那条惯例)。
   */
  reloadExtensions?: () => Promise<ExtReloadResult>;
  /**
   * bwrap 围栏的**探测读数**(2026-08-13)。`ok:false` → 顶栏画一行红字
   * `sandbox off - <原因>`;省略 = 这条装配路不谈沙箱(fixture lane)。
   *
   * ⚠ 只是**读数**不是开关:开关在 `.omd/config.json` 的 `tui.sandbox`,
   * 装配层(`cli.ts`)读完探完才把结论给 UI。UI 画它,不决定它。
   */
  sandbox?: { ok: boolean; reason?: string };
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

/**
 * ★ 一轮的 t/s(切片②)。分子 = 本轮 completion tokens,分母 = 流式墙钟秒。
 *
 * 时钟**从外面给**(I6:`runOmdTui` 里注入的 `now()`)—— 自己摸 `Date.now` 的函数测不动。
 * 算不出来时给 `null` 不给 0(I2:没读数 ≠ 0 t/s):还没跑过一轮(`startedAt === 0`)、
 * 墙钟非正(时钟回拨 / 同毫秒收尾)、一个 token 都没出,都是"这一格没有数据"。
 */
export function computeTps(completionTokens: number, startedAt: number, endedAt: number): number | null {
  if (startedAt <= 0 || completionTokens <= 0) return null;
  const seconds = (endedAt - startedAt) / 1000;
  if (seconds <= 0) return null;
  return completionTokens / seconds;
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
  /**
   * ★ W6·M1(owner 裁 A,2026-08-17):主形态换 **TuiMainScreen** —— 对话进终端
   * scrollback、退出留痕、滚轮/选择/搜索全是终端**原生**的(claude code / pi interactive
   * 同形态)。alt-screen 只在 Ctrl+G/Ctrl+P 全屏视图时临时起一个(M2,preserveScreen 往返)。
   * ⚠ 主屏**不开**应用 mouse 捕获 —— 捕获会抢掉原生拖选,而原生正是换形态要的东西;
   *   mouse:true 只留在 alt 实例上(那里没有原生滚回可用)。
   */
  const tui = new TuiMainScreen(terminal);

  // 键位表:补上 pi-tui 默认表认不出的双 ESC(`keys.ts` 记了实测的三行对照表)。
  // ⚠ 必须在建组件**之前** —— 组件是在 `handleInput` 里现查 `getKeybindings()` 的,
  //   所以顺序上其实没那么脆;放这儿是为了"键位是启动期的事"读起来一眼清楚。
  // W4③: 键位表 = pi 全表 + omd 五键, 用户文件 (.omd/keybindings.json) 可覆盖任意一条。
  // 坏文件 fail-open 用默认, 但证据上屏 (启动后画 notice, 不是日志里一行)。
  const userKb = loadUserKeybindings(opts.cwd);
  const kb = installOmdKeybindings(userKb.config);

  // W4②: 亮暗自适应 —— OMD_THEME 显式覆盖 > OSC 11 探测 > 暗色默认 (探测失败留日志不拦启动)。
  const detected = opts.theme ? null : await detectTerminalScheme();
  if (!opts.theme && detected === null && schemeFromEnv() === null) {
    logger.info({}, '[omd/tui] terminal scheme probe failed -> dark default (OMD_THEME=light|dark to override)');
  }
  const theme = opts.theme ?? createTheme({ scheme: detected ?? 'dark' });

  // 2026-08-21: OSC-8 可点路径。**能力位问 pi**(screen 不转发 / tmux 要真探一次,
  // 见 `render/link.ts` 头注);`OMD_NO_HYPERLINKS` 是用户侧一票否决(照 NO_COLOR 的形)。
  // 默认关 → 渲染函数恒等, 所以不开这一行时全仓行为逐字节照旧。
  const linksOn = initHyperlinks(process.env);
  logger.info({ hyperlinks: linksOn }, '[omd/tui] OSC-8 clickable paths');

  // 状态行走 StatusLine (截断, 不折行) —— 状态行一折, 下面所有东西的行号整体下移,
  // 而 HUD 是按行差分画的, 结果是布局错位。对话正文走 ChatLog (折行是对的)。
  // ⚠ 顶栏(`omd tui - cwd`)已去掉 —— v5 裁决: 信息下沉到底部三行, 仓名/分支在行①。
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
  // ── 切片 S5: 决策地图票看板 ──
  // 盘上 PathMap 是唯一真源 (D-12 ①), TUI 只渲染不产独立状态; 渲染路径零写 (D-12 ③, 事故先例 1890115)。
  // 不在 render 里读盘 (D-12 ②): 复用 pathHud.refresh() 的时机 (启动 / 每轮收尾 / Ctrl+P 切图)。
  let ticketBoardMap: import('../harness/pathfinder/types').PathMap | null = null;
  let ticketBoardErr: string | null = null;
  function refreshTicketBoard(): void {
    ticketBoardMap = null;
    ticketBoardErr = null;
    try {
      // 选图与 pathHud 同一把尺 (createPathReader): 显式选了走选中, 没选走"前沿最多"的默认。
      const snap = (pathSlugSel ? createPathReader(opts.cwd, pathSlugSel) : basePathReader)();
      if (!snap) return; // 一张图都没有 → 无源恒缺席 (与 path-hud 同一语义, 不画空框)
      // 直接用 reader 已经读到的那张图: 此处**再读一遍**正是 2026-08-12 切 gh 时炸掉看板的形状
      // (reader 给 md slug、这里拿它去问 gh, readMap 返回 null 而 null 不是异常 → 静默空白)。
      ticketBoardMap = snap.map;
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 原因留着画在屏上。
      ticketBoardErr = err instanceof Error ? err.message : String(err);
    }
  }
  refreshTicketBoard();
  const ticketBoard: Component = {
    render: (width: number): string[] => {
      if (ticketBoardErr) return [theme.chrome.warn(fitLine(`ticket board could not be read: ${ticketBoardErr}`, width))];
      if (!ticketBoardMap) return [];
      // ⚠ 侧栏行数必须封顶 (实跑钉的): 19 票的图整张画会把 transcript 挤到 3 行,
      //   欢迎屏那张表 (engine/session) 被挤出可见窗, PTY 的 bootReady 一条接一条红。
      // 列宽治理走 renderTicketBoard 自己的 {width} (W2 片3; 此前这里没传, 靠外层 fitLine 硬裁);
      // 表头不画 —— 同屏上方 PathHud 的 map 标题就是它, 同一句话两遍是 dump 不是 UI。
      const rows = renderTicketBoard(ticketBoardMap, now(), { width }).slice(1);
      const cap = 6;
      const shown = rows.length <= cap ? rows : [...rows.slice(0, cap), `... ${rows.length - cap} more tickets`];
      return shown.map((l) => paintTicketRow(theme.chrome, l));
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  // ── #96: 活 run 观察面 (公告板) ──
  // 与 ticketBoard **同一套纪律**: 不在 render 里读盘 (D-12 ②, 复用同一次 refresh 时机),
  // 渲染路径零写 (D-12 ③), 无源恒缺席不画空框。
  // 为什么要有它: 板的写侧与判定侧 2026-08-11 就齐了 (appendBoard 五个生产调用方 + liveRuns
  // 的 D-9 语义), 而**没有任何消费者** —— 盘上有数据、没人看得见, 正是本仓在杀的空旋钮形态。
  let boardEntries: import('../harness/board/run-board').BoardEntry[] = [];
  function refreshRunBoard(): void {
    try {
      boardEntries = readBoard(opts.cwd);
    } catch (err) {
      // fail-open 吞异常不吞证据: 观察面读不到不该拦住 TUI, 但原因要留痕。
      boardEntries = [];
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] read run board threw -> observation pane empty this round');
    }
  }
  refreshRunBoard();
  const runBoard: Component = {
    render: (width: number): string[] => {
      // 同 ticketBoard: 侧栏行数封顶, 否则一屏活 run 会把 transcript 挤没。
      const rows = renderRunBoard(boardEntries, now(), { width });
      const cap = 5;
      return rows.length <= cap ? rows : [...rows.slice(0, cap), `... ${rows.length - cap} more`];
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  /**
   * ★ **声明必须排在 `refreshNowBandData` 之前**(2026-08-22 修一次启动即死)。
   *
   * `let` 是 TDZ 的:`refreshNowBandData()` 里读 `runList`,而它原来声明在**两百多行之后**——
   * 启动那一次调用当场抛 `Cannot access 'runList' before initialization`,**TUI 根本起不来**。
   * ⚠ 值得记的是它是怎么漏过去的:`tsc --noEmit` 干净、`bun test` **6390 pass / 0 fail** ——
   * 两道闸都碰不到「模块顶层的调用顺序」。抓到它的是 **L3 PTY lane**(S2-1 起七条一起红,
   * 判词就是那句 TDZ)。⇒ 「屏起不起得来」这件事只有真起一次才知道。
   *
   * 数据源 = **磁盘分片**(`readDagShards`),不是本进程内存。这是片 4 存在的理由(INV-DAG-7):
   * run / research 恒 detached,进程内订阅在生产上基本是空的,而这个列表画的是盘上有什么,
   * 与哪个进程无关。
   */
  let runList: import('../hud/load').DagView[] = [];
  let runListTicker: ReturnType<typeof setInterval> | null = null;
  // ── t-tui-attach 接线 (2026-09-01):外部 run 附身通道 ──
  // run-list Enter 选中**非 bus 的** run → attach + 开通道;1s ticker 顺拍 tick;
  // 全屏关 / 换 run / bus 起新图 → dispose。通道自身 fail-open,这里只管生命周期。
  let externalChannel: ExternalRunChannel | null = null;
  /** 引擎 bus 正在喂的本地 runId(planned 事件记账)—— 附身不与 bus 抢同一张图。 */
  let busRunId: string | null = null;
  function dropExternalChannel(): void {
    if (externalChannel) {
      externalChannel.dispose();
      externalChannel = null;
    }
  }

  // ── 片 5 切片 3 · 「当前」区数据 + 收件箱数据 ──
  // 与 ticketBoard / runBoard 同条纪律:不在 render 里读盘 (D-12 ②),复用既有刷新时机
  // (启动 / 每轮收尾 / Ctrl+P 切图)。data 是 already-fetched 结构,纯函数吃它就够。
  let nowBandData: NowBandInput = { awaiting: [], suggested: [], live: [], maps: [] };
  /** 收件箱四态由各数据源汇成。`InboxItem` 形状见 `render/inbox.ts` 类型定义。 */
  let inboxItems: InboxItem[] = [];
  /**
   * 注意力视图 (等裁票 / 建议票 / 雾档) **异步取** (2026-09-02): `readAttention` 走 PathBackend 端口,
   * gh 后端 = listMaps + 每图一次 GraphQL, 实测 5 图 5.4s —— 同步读会把启动与每轮收尾各冻 5s。
   * 于是取数进 Worker (`attention-reader.ts`), 这里先用**上一次**的票立即画, 数回来再重画。
   * 序号防乱序: 慢的旧请求不许盖掉新的。
   */
  const EMPTY_ATTENTION: AttentionView = { awaiting: [], frontier: [], suggested: [], maps: [] };
  let lastAttention: AttentionView = EMPTY_ATTENTION;
  let attentionSeq = 0;
  const readAttentionAsync = createAttentionReader();
  function refreshNowBandData(): void {
    buildNowBand(lastAttention);
    const seq = ++attentionSeq;
    void readAttentionAsync(opts.cwd)
      .then((view) => {
        if (seq !== attentionSeq) return; // 更新的一轮已经发出, 这份是旧的
        lastAttention = view;
        buildNowBand(view);
        tui.requestRender();
      })
      .catch((err) => {
        // fail-open 吞异常不吞证据:日志留痕,屏上留上一次的票 (不清空: 清空会把「读失败」画成「没票」)。
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] readAttention threw -> current zone keeps last view');
      });
  }
  function buildNowBand(attention: AttentionView): void {
    const liveViews = runList.filter((v) => v.phase === 'live');
    nowBandData = {
      awaiting: attention.awaiting,
      suggested: attention.suggested,
      live: liveViews,
      maps: attention.maps,
    };
    // 收件箱 = 等裁票 (rule) + 建议票 (confirm) + 活图 await 节点 (node) + 逼近超时等件 (take)。
    // node 一态本片非目标(SDD 非目标: 取数在另一处)。
    const items: InboxItem[] = [];
    for (const t of attention.awaiting) {
      items.push({ kind: 'rule', slug: t.slug, ticketId: t.ticketId, title: t.title });
    }
    for (const t of attention.suggested) {
      items.push({ kind: 'confirm', slug: t.slug, ticketId: t.ticketId, title: t.title });
    }
    // SDD 片 7 切片 3 (INV-RC-5/6): take 真接 `awaitingRuns(board)`,过「逼近超时」筛子
    //   (已等 ≥ timeoutMs × 0.75, timeoutMs 缺席不收)。caller 拼 InboxItem 时把 runId
    //   投影到 slug (runId.slice(0,8)),artifact 投影到 ticketId —— 见 `InboxItem`
    //   类型注释。
    const FRACTION = 0.75;
    const nowMs = now();
    const approaching = awaitingRuns(boardEntries).filter((a) => {
      if (typeof a.timeoutMs !== 'number') return false;
      const since = Date.parse(a.since);
      if (!Number.isFinite(since)) return false;
      return nowMs - since >= a.timeoutMs * FRACTION;
    });
    for (const a of approaching) {
      items.push({
        kind: 'take',
        slug: a.runId.slice(0, 8),
        ticketId: a.artifact,
        title: a.artifact,
      });
    }
    inboxItems = items;
  }
  refreshNowBandData();

  /** 「当前」区渲染器组件。
   *  常驻:由 `renderNowBand` 自己决定有几行 (INV-NOW-3 无源恒缺席 → []),
   *  与 pathHudVisible 那条三块**完全脱钩**(那一族照样被人开口后收起 —— 判词判的就是那条)。
   *  颜色走 `theme.chrome` 同形钩子,与 `run-list` / `dag-screen` 同款(关色 → 恒等)。 */
  const nowBand: Component = {
    render: (width: number): string[] => {
      const paint: NowPaint = {
        accent: theme.chrome.accent,
        dim: theme.chrome.dim,
        warn: theme.chrome.warn,
        // `chrome` 没单独的 `ok` 档;「真成功」色 = `toolOk`(亮绿,留给"真的成功")。
        // NowPaint 声明 `ok` 是为与 dim/accent/warn 同形,组件内未消费,这里只为类型满足。
        ok: theme.chrome.toolOk,
      };
      // 留一行顶气,与下方输入框分隔开 —— 空仓时 renderNowBand 自返 [],也不画那一行。
      const lines = renderNowBand(nowBandData, { width, now: now(), paint });
      return lines.length > 0 ? ['', ...lines] : lines;
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  /**
   * 收件箱全屏(片 5 切片 3)。与 fullView / pathView 同款树内模态 —— `renderInbox`
   * 本身已是纯函数(见 `render/inbox.ts`),底边常驻一句话(INV-INBOX-1/2)。
   * `selected` 越界 / 负数由 `renderInbox` 自己 mod(见 INV-INBOX-1 的 GWT 用例)。
   */
  const inboxView: Component = {
    render: (width: number): string[] => {
      const height = Math.max(6, (terminal.rows || 30) - 6);
      return renderInbox(inboxItems, {
        width,
        height,
        selected: inboxSelected,
        now: now(),
        paint: {
          accent: theme.chrome.accent,
          dim: theme.chrome.dim,
          warn: theme.chrome.warn,
          sel: theme.chrome.user,
        },
      });
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  /** 收件箱开关状态 + 选中索引。Ctrl+N 切换;开时本 listener 接管 ↑↓/Enter/Esc。 */
  let inboxOpen = false;
  let inboxSelected = 0;

  /**
   * 收件箱「Enter → 预填不发送」(INV-INBOX-4)。四态四句话 —— 不合并,合并就教人去撞
   * `pathfinder.ts:503` 的硬闸(SDD 表四态四组动作那条)。**只动 editor.setText,
   * 永远不调 submit**;用户在输入框里回车那一下才决定是不是真发。
   */
  function prefillInboxItem(item: InboxItem): void {
    let prompt: string;
    if (item.kind === 'rule') {
      prompt = `Map rule on ticket ${item.ticketId} of map ${item.slug} (ruling = goal): `;
    } else if (item.kind === 'confirm') {
      prompt = `Accept/reject ticket ${item.ticketId} of map ${item.slug}: `;
    } else if (item.kind === 'node') {
      prompt = `Look at node ${item.nodeId} in run ${item.runId.slice(0, 8)}: `;
    } else {
      prompt = `Take delivery for ticket ${item.ticketId} of map ${item.slug}: `;
    }
    inboxOpen = false; // 关掉全屏,把焦点还给输入框
    editor.setText(prompt);
    tui.setFocus(editor);
    tui.requestRender();
  }

  /**
   * 收件箱动作执行(片 6 切片 3 + 片 7 切片 3,SDD §2.3)。
   *
   * 路由 `InboxAction`:
   *   - `rule-input` → `applyInboxAction` 走 `backend.rule(...)`(写失败响亮, INV-BOX-4)
   *                    → 重读盘(INV-BOX-7)。
   *   - `confirm` → `applyInboxAction` 走 `backend.confirmSuggestion(...)` → 重读盘。
   *   - `intervene` → `applyInboxAction` 走 `recordIntervention(...)`(INV-RC-1/2) →
   *                   重读盘; cause 由 caller 的 `dialogSelect` + 可选 note 输入框。
   *   - `cancel` → `applyInboxAction` 走 `cancelDetachedRun(...)`(INV-RC-3/4) →
   *                重读盘; 二次确认由 caller 的 `dialogConfirm`。
   *   - `resume`  → `opts.backend.resumeRun?.(...)`(INV-BOX-6 真接线;后端没能力就 no-op)。
   *   - `prefill` → `prefillInboxItem(item)`(原有路径)。
   *   - `noop`    → 关掉收件箱, 不写盘。
   *
   * `applyInboxAction` 之后**无条件** `refreshNowBandData()` —— 与每轮收尾同一时机
   * (切片 S5/片 5 那条纪律, 见 `tui.ts:1520-1522` 的注释): 收件箱是当前区的子集,
   * 当前区是它的真源, 不在内存里把 `inboxItems` 改一改假装同步。
   */
  async function executeInboxAction(action: InboxAction): Promise<void> {
    if (action.kind === 'noop') {
      inboxOpen = false;
      tui.requestRender();
      return;
    }
    if (action.kind === 'prefill') {
      prefillInboxItem(action.item);
      return;
    }
    if (action.kind === 'resume') {
      // INV-BOX-6: 只有 `r` 真接线。`resumeRun` 是 OmdBackend 可选能力, 没能力就走
      // `noRunCapability` 同款 (CHROME.noRunCapability) —— 不画一个点了没反应的入口。
      const item = action.item;
      if (!opts.backend.resumeRun) {
        chatLog.appendNotice(CHROME.noRunCapability('resume'));
        tui.requestRender();
        return;
      }
      try {
        const r = await opts.backend.resumeRun({ runId: item.runId });
        chatLog.appendNotice(r.ok ? CHROME.resumeStarted(item.runId, r.text) : CHROME.resumeRefused(item.runId, r.text));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ err: reason, runId: item.runId }, '[omd/tui] resumeRun threw');
        chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
      }
      tui.requestRender();
      return;
    }
    // rule-input / confirm / intervene / cancel —— 四个都走 applyInboxAction
    // (纯函数层), 它替你:
    //   · 开对话框收 ruling / cause / note / 二次确认 (按 action 走不同 prompt)
    //   · 调 backend 写侧 (rule / confirm) 或 `harness/run-control` 写侧
    //     (intervene / cancel, 与 MCP 同源 —— INV-RC-1)
    //   · 写失败 → onError 把原文贴屏 (INV-BOX-4)
    //   · 写完调 refreshItems 重读盘 (INV-BOX-7)
    const { resolveBackend } = require('../harness/pathfinder/backend') as typeof import('../harness/pathfinder/backend');
    const pathBackend = resolveBackend(opts.cwd);
    const result = await applyInboxAction(action, {
      cwd: opts.cwd,
      backend: pathBackend,
      promptRuling: async (item, closedByRuling) => {
        // 复用 dialogs.input —— 它的语义就是 "null = Esc / 空串 = 取消", 跟 INV-BOX-3 一致。
        // 标题里把 closedByRuling 说出来: 用户看见前缀警告就不打了。
        const title = closedByRuling
          ? `Close-by-ruling on ${item.ticketId} (text becomes [closed-by-ruling] goal):`
          : `Rule on ${item.ticketId} (text becomes the goal):`;
        return dialogInput(dialogs, theme, { title });
      },
      // SDD 片 7 切片 3 (INV-RC-2/3): 复合对话框——先 cause picker(FAILURE_KIND_ORDER
      // 全集,与 MCP 同词表, INV-RC-1 共享写侧), 再可选 note 输入框。两个都 Esc/空 = null
      // = 一个字节都不写。
      promptIntervene: async (item) => {
        const causeOptions = FAILURE_KIND_ORDER.map((k) => ({ value: k, label: k }));
        const cause = await dialogSelect(dialogs, theme, {
          title: `Why intervene on ${item.runId.slice(0, 8)}?`,
          options: causeOptions,
        });
        if (cause === null) return null;
        const noteRaw = await dialogInput(dialogs, theme, {
          title: `Note (optional, empty to skip):`,
        });
        // dialogInput 的语义: null = Esc, 空串 = 合法空串。这里把两者都收成 null ——
        // recordIntervention 自己有「trim 后空串不留字段」那条,但我们这里直接传 null
        // 比传空串更省(写盘那条路径已经在 run-control 里钉死)。
        if (noteRaw === null) return { cause, note: null };
        const note = noteRaw.trim();
        return { cause, note: note === '' ? null : note };
      },
      // 二次确认 —— INV-RC-3 的代价不对称 (误按损失墙钟)。复用 `dialogConfirm`,不新造。
      confirmStop: async (item) => {
        const r = await dialogConfirm(dialogs, theme, `Stop detached run ${item.runId.slice(0, 8)}? (cooperative, resumable)`);
        return r;
      },
      // 真写侧经 `cancelDetachedRun`(harness/run-control, 与 MCP 共用一份, INV-RC-1)。
      // ownerPid 从 `runs.db` 现读 (TUI 自己不持有 runRegistry —— 用 `createRunStore` 直读,
      // 与 mcp/dream 那些 consumer 同款 idiom)。不存 connection, 每次新开新关。
      runCancel: async (item) => {
        const rs = createRunStore({ path: join(opts.cwd, '.omd', 'runs.db') });
        try {
          return cancelDetachedRun(opts.cwd, item.runId, `stopped from TUI by ${opts.cwd}`, {
            readOwnerPid: (runId) => rs.get(runId)?.ownerPid ?? null,
          });
        } finally {
          rs.close();
        }
      },
      recordIntervention: (runId, cause, note) => {
        // run-control 的 recordIntervention 签名 note 是 string | undefined, 这里 note
        // 是 string | null —— 透传 null=没 note, 透传字=有 note(空白会被 run-control
        // 自己 trim 后丢弃,见 run-control.test.ts)。
        recordIntervention(opts.cwd, runId, cause as never, note ?? undefined);
      },
      nowIso: () => new Date(now()).toISOString(),
      refreshItems: async () => {
        // INV-BOX-7: 写完重读盘——重读的是 readAttention(), 跟 inboxItems 的真源一致,
        // 而不是改内存里那份。这样 "票裁掉了 → 收件箱里那件没了" 是磁盘变化的结果, 不是 TUI 的把戏。
        refreshNowBandData();
        return inboxItems;
      },
      onError: (reason) => {
        // INV-BOX-4: 原文上屏, fail-open 不吞证据。
        chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
      },
      // SDD 片 7 切片 3 (INV-RC-1/2/4): 写成功的回执——`formatCancelNotice` 已把
      // CancelOutcome 四种判别联合各画各的, 这里只负责把它贴屏。
      onNotice: (msg) => {
        chatLog.appendNotice(msg);
      },
    });
    inboxItems = [...result.items];
    tui.requestRender();
  }
  // 空态在框里画一句提示符 —— 见 `components/hinted-editor.ts` 文件头(gauntlet critic 的判词)。
  const editor = new HintedEditor(tui, theme.editor, { hint: CHROME.editorHint, paint: theme.chrome.dim });
  // 补全:**行首 `/` 出命令,其余出文件** —— 底座是 pi-tui 的 `CombinedAutocompleteProvider`。
  // ⚠ 此前只挂了自写的文件补全, 于是打 `/settings` 弹出来的是一堆文件名(owner 截图抓到的)。
  //   斜杠开头本该出命令, 而这件事 pi-tui 本来就做好了。
  // 切片④ (G-4): 三段式 —— `/` 只出组, `/omd-` 出全名成员带描述, `/omd ` 出不带前缀的成员。
  // 成员清单 5s TTL 现扫 (装新 skill 不用重启), 组清单仍启动时算一次 (见 commands.ts 的说明)。
  const startupGroups = groupSkills(listSkills()).groups.map((g) => ({ name: g.name, count: g.members.length }));
  // custom prompts 进补全 (启动冻结; 分发每次现扫, 新文件立即可用只是补全要重启才见)。
  // fail-open: 扫挂了补全少一段, 不拦启动 —— 但不吞证据。
  const startupPrompts = await loadUserPrompts(opts.cwd).catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] startup scan of custom prompts threw -> completion omits templates');
    return { promptTemplates: [], diagnostics: [] };
  });
  editor.setAutocompleteProvider(
    createOmdAutocompleteProvider({
      commands: [
        ...slashCommands(startupGroups),
        ...startupPrompts.promptTemplates.map((t) => ({
          name: t.name,
          description: t.description ?? `custom prompt (${PROMPTS_DIR}/${t.name}.md)`,
          argumentHint: '[args]',
        })),
      ],
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
        // 分层上色 (facelift): 键值行的值亮、提示行的 `>` 亮, 其余 dim —— 一整块同灰
        // 是截图判丑的第三半。关色下画笔全 identity, 重拼逐字节 = 原行。
        .map((l) => {
          const kv = /^(\s*)(engine|session)(\s+)(\S.*)$/.exec(l);
          if (kv) return `${kv[1]}${theme.chrome.dim(kv[2]!)}${kv[3]}${theme.chrome.user(kv[4]!)}`;
          const hint = /^(\s*> )([^]*)$/.exec(l);
          if (hint) return `${theme.chrome.accent(hint[1]!)}${theme.chrome.dim(hint[2]!)}`;
          return theme.chrome.dim(l);
        }),
    ].join('\n'),
  );
  /**
   * 沙箱降级告警(2026-08-13)。**第一屏就说**,不等第一条命令跑完 ——
   * owner 裁的兜底是「降级裸跑 + 红字告警」,而围栏在不在,屏上没有别的痕迹。
   * `ok` 时一个字都不画:一条"一切正常"的常驻横幅只会训练人不看它。
   */
  // W4③: 键位文件的坏账上屏 —— fail-open 用了默认, 但"为什么我的绑定没生效"必须一眼可见。
  if (userKb.diagnostic) chatLog.appendNotice(userKb.diagnostic);
  // 2026-08-21: 键位冲突走**同一条** diagnostic 通道 —— 此前用户把某条绑到已占用的键上,
  // 一条无声死掉且零提示。⚠ 不用 pi 的 `getConflicts()`: 它只比用户绑定之间, 不比默认绑定
  // (实测对「绑到默认键上」返回 []), 判据见 `keys.ts` 的 findKeyClashes。
  {
    const clashes = formatKeyClashes(findKeyClashes(kb, userKb.config));
    if (clashes) chatLog.appendNotice(clashes);
  }
  // 冲突检测是换上 KeybindingsManager 白得的 —— 同一键绑了两个动作时说出来, 不静默让后到的赢。
  for (const c of kb.getConflicts()) {
    chatLog.appendNotice(`keybinding conflict: "${c.key}" is bound to ${c.keybindings.join(' and ')}`);
  }
  if (opts.sandbox && !opts.sandbox.ok) {
    chatLog.appendNotice(CHROME.sandboxOff(opts.sandbox.reason ?? 'unknown'));
  }

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
   * ★ W6·M1:转录区**不再有 ScrollView/BottomAnchor** —— 主屏形态下 chatLog 按内容高
   * 自然生长,长出终端的部分进 scrollback(滚回/贴底/虚拟化三件事全归终端原生,
   * W3a 的 BottomAnchor 是 alt-screen 空腔的中间态,SDD 预告过随本迁移删除)。
   */
  const transcript: Component = chatLog;

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
   * ★ **左侧栏 + 全屏图**(切片③,G-3 + 切片 S3, 2026-08-22)。
   *
   * - 侧栏(画法 A 树):`/hud` 开关(默认开),**且**要 ① 有 run ② 屏够宽 才画 ——
   *   80 列的终端里再切 34 列给侧栏,剩下的对话区就没法读了(窄终端自动收起)。
   * - 全屏:`Ctrl+G` 开关,`Tab` 在 **DAG 屏 ⇄ 活图列表** 之间切(D-1: 不再是三画法轮换 —
   *   信息整合在一起而不是分这么多的形态和信息分散)。
   * - 侧栏或全屏画着时**不再画底部那张表** —— 同一张 DAG 画两遍,人会以为是两个 run。
   */
  const uiCfg = loadTuiUiConfig(opts.cwd);
  let sidebarOn = uiCfg.sidebar;
  /** `painterIdx` 在本片**不再被读**(三画法已被 DAG 屏合并) —— 字段留着,
   *  因为 `applySetting('ui-painter', ...)` 的旧面板还得能写而不抛;
   *  `render/dag-gantt.ts` / `render/dag-layers.ts` 是否孤儿,留给单独裁决(SDD 非目标)。 */
  let painterIdx = uiCfg.painterIdx; // 0=树 1=甘特 2=分层 (默认从 tui.ui.painter 读) — 本片后 dead
  /** `/think` 的当前档 (W1)。持久在 tui.ui.thinking; 每轮 sendChat 带上。 */
  let thinkingLevel = uiCfg.thinking;
  /** 低于这个总宽不给侧栏。= 侧栏 34 + 对话区至少 56。 */
  const SIDEBAR_MIN_TOTAL = 90;
  const sidebarPainting = (vpWidth: number): boolean => sidebarOn && dagTree.active && vpWidth >= SIDEBAR_MIN_TOTAL;

  /** `PAINTERS` 仍导出(用在 `applySetting('ui-painter', ...)` 的合法值校验上),
   *  不再传给 fullView 的 `now:` hint — 那是死字符串。 */
  const PAINTERS = ['tree', 'gantt', 'layers'] as const;

  // ── 切片 S3 · 接线状态机 (DAG 屏 ⇄ 活图列表) ──
  // 纯函数 dispatcher 在模块层 (单测盖得到);这里只持状态 + 应用结果。
  // ⚠ 声明必须在 `root` 装配之前(`fullView.render` 闭包读它, TDZ 同 `armedAt` 那一条)。

  let dagFullState: DagFullState = initialDagFullState();

  // 活图列表数据源 = **磁盘分片** (`readDagShards`), 不是本进程内存。
  // 这是整片存在的理由 (INV-DAG-7): run / research 恒 detached, 进程内订阅在生产上
  // 基本是空的, 而这个列表画的是盘上有什么, 与哪个进程无关。
  /**
   * HUD 分片归档 (2026-09-02, 见 `src/hud/gc.ts`): 终态过期 / run 已终态却仍 `running` / 静默 24h 的分片
   * 挪进 `.omd/hud/archive/`。不归档时 96 份僵尸分片会在 run 列表里永远「waiting」。
   * 节流 60s: 列表 ticker 是 1s 一拍, 每拍扫 2000 个文件没必要。
   */
  let lastHudSweepAt = -Infinity;
  const HUD_SWEEP_EVERY_MS = 60_000;
  function sweepHudIfDue(): void {
    const t = now();
    if (t - lastHudSweepAt < HUD_SWEEP_EVERY_MS) return;
    lastHudSweepAt = t;
    try {
      const r = sweepHudSnapshots(opts.cwd, t, { terminalRunIds: readTerminalRunIds(opts.cwd) });
      if (r.archived.length > 0 || r.failed.length > 0) {
        logger.info({ archived: r.archived.length, failed: r.failed.map((f) => `${f.runId.slice(0, 8)}:${f.note}`) }, '[omd/tui] hud shards archived');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] hud sweep threw (fail-open)');
    }
  }
  function refreshRunList(): void {
    sweepHudIfDue();
    try {
      runList = readDagShards(opts.cwd, now());
    } catch (err) {
      // fail-open 吞异常不吞证据: 读不到不该拦住 TUI, 但原因进日志, 不在屏上糊一句。
      runList = [];
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[omd/tui] readDagShards threw -> live run list empty this round',
      );
    }
    // 外部附身通道顺拍 (t-tui-attach): 通道内部按内容键判 APPLY/NO-OP, 不新增 ticker。
    externalChannel?.tick();
    // 数据变了 → 触发重绘。其它 ticker (loader / dagTicker) 也走同一通道, 不发明新机制。
    tui.requestRender();
  }
  /** 轮询仅在 `fullOn` 时跑 (D-2): 全屏关掉就停, 0 CPU 静止。 */
  function syncRunListTicker(): void {
    if (dagFullState.fullOn && runListTicker === null) {
      refreshRunList(); // 立刻读一次 — 开屏第一次画就要有数, 不等 1s
      runListTicker = setInterval(refreshRunList, 1000);
    } else if (!dagFullState.fullOn && runListTicker !== null) {
      clearInterval(runListTicker);
      runListTicker = null;
      dropExternalChannel(); // 全屏关 → 不再跟外部 run (D-2 同款: 静止零成本)
    }
  }

  /** 全屏视图:按当前屏调对应的纯渲染函数。两屏都靠 `readDagShards` 间接吃到磁盘分片,
   *  `paint` 走 `theme.chrome` 的同名钩子(ok/fail 是 `renderDagScreen` / `renderRunList` 都有的)。 */
  const fullView: Component = {
    render: (width: number): string[] => {
      if (!dagFullState.fullOn) return [];
      const height = Math.max(6, (terminal.rows || 30) - 10);
      const paint = {
        accent: theme.chrome.accent,
        dim: theme.chrome.dim,
        warn: theme.chrome.warn,
        sel: theme.chrome.user,
        ok: theme.chrome.toolOk ?? theme.chrome.accent, // 主题若未定义 ok/fail → 退到 accent/warn
        fail: theme.chrome.toolFail ?? theme.chrome.warn,
      };
      // ⚠ 空屏占位必须**撑满模态高度** (t-tui-bounce 实测): 只画一行的话, 全屏区从 ~30 行
      // 塌成 1 行, 上方露出终端 scrollback 里的旧聊天 —— 用户读到的是「全屏自己弹回聊天了」,
      // 而状态其实还在全屏里。占位行 + 空行垫到 height, 全屏「在场感」不许消失。
      const padded = (hint: string): string[] => [
        fitLine(hint, width),
        ...Array.from({ length: Math.max(0, height - 1) }, () => ''),
      ];
      if (dagFullState.kind === 'dag') {
        const snap = dagTree.snapshot();
        if (snap.nodes.length === 0)
          return padded('(no run on this screen - Tab: run list, Enter there attaches an external run)');
        return renderDagScreen(snap, { width, height, selected: dagFullState.dagSelected, now: now(), paint });
      }
      // run-list 屏: INV-DAG-8 由 renderRunList 自己保证 (空 → [])。这里不再画"空框"。
      if (runList.length === 0) return padded('(no run shards on disk yet)');
      return renderRunList(runList, { width, height, selected: dagFullState.runListSelected, now: now(), paint });
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
      logger.warn({ err: (err as Error).message, slug: pathSlugSel }, '[omd/tui] pathfinder map failed to read');
    }
  }
  const pathView: Component = {
    render: (width: number): string[] => {
      if (!pathData) return [fitLine('(map could not be read - the reason is in the log)', width)];
      const height = Math.max(6, (terminal.rows || 30) - 10);
      // 颜色分层照 HTML 稿: 前沿/读数 accent · 地层/雾 dim · 阻塞 warn · 选中 user 档。
      const paint = { accent: theme.chrome.accent, dim: theme.chrome.dim, warn: theme.chrome.warn, sel: theme.chrome.user };
      const o = { width, height, selected: pathSelected, paint, now: now() };
      return pathPainter === 0 ? renderFogLine(pathData, o) : renderDelta(pathData, o);
    },
    handleInput: () => {},
    invalidate: () => {},
  };

  /**
   * ★ W6·M1:左列侧栏在滚回形态**不成立** —— 冻结进 scrollback 的行不能事后混两列
   * (dsh / claude code 同理都没有常驻左列)。DAG 树改画成**底部块**(活动区原地重画,
   * 行数封顶,全量在 Ctrl+G 全屏),`sidebarPainting` 的开关/宽度语义原样沿用。
   */
  const dagTreeBlock: Component = {
    render: (width: number): string[] => {
      const lines = dagTree.render(width);
      if (lines.length === 0) return lines;
      const cap = 12;
      const shown = lines.length <= cap ? lines : [...lines.slice(0, cap), theme.chrome.dim(`... ${lines.length - cap} more nodes (Ctrl+G fullscreen)`)];
      return ['', ...shown]; // 顶部留一口气 (PathHud 同款) —— 帧读出来与正文贴死
    },
    handleInput: () => {},
    invalidate: () => dagTree.invalidate(),
  };
  /** 帧实测: dagHud 也与正文贴死 —— 同样补一口气 (有内容才补, 空块不占行)。 */
  const dagHudBlock: Component = {
    render: (width: number): string[] => {
      const lines = dagHud.render(width);
      return lines.length > 0 ? ['', ...lines] : lines;
    },
    handleInput: () => {},
    invalidate: () => dagHud.invalidate(),
  };
  /**
   * ★ 列对齐(帧实测,owner「都修了」):正文条目在 gutter(1) + paddingX(1) = 第 2 列,
   * 而各块(pathHud / 看板 / DAG 树·HUD)只有 gutter = 第 1 列 —— 差一列,读起来毛边。
   * 统一法:**装配层**包一格(内宽 -1 + 行首 ' '),组件与其测试一字不动;
   * 空行不包(空行加空格是尾随空白)。
   */
  const alignToContent = (c: Component): Component => ({
    render: (width: number): string[] => c.render(Math.max(1, width - 1)).map((l) => (l === '' ? l : ` ${l}`)),
    handleInput: () => {},
    invalidate: () => c.invalidate(),
  });

  /**
   * ★ **等待指示器**(2026-08-08,还 `Loader` 那笔欠账)。
   *
   * 发出一句到第一片回来之间,屏上此前**没有任何会动的东西** —— 而参照物三家都有等待态
   * (`docs/bars/pi-tui-模块台账.md` 那条欠账的原话)。"看起来没反应"与"真没反应"
   * 在屏幕上长得一样,这正是本仓最怕的那一族。
   *
   * ★ **2026-08-11 起指示器活满整轮,不再在首片 delta 时收掉**(Claude Code 同款)。
   * 旧设计"首片之后在动的是正文本身"在 SDK 通道上塌了:正文按 message 整段到达,
   * 两段之间(长思考/工具串)屏上完全静止 —— owner 实测第一反应就是打一句"你卡住了吗"。
   * 秒计时由 1s ticker 更新(`waitingElapsed`);对话框开着时 ticker 跳过 setMessage
   * (dialogs.open 已把 loader 停了 —— 那时在等的是人不是模型,PTY 缓冲也经不起刷)。
   *
   * ⚠ **帧在 `design/tokens.ts` 的 `SPINNER_FRAMES`,不在这里** ——
   * 「框线字形不散在组件里」那条闸把方块字形写进本文件判为违规,而它判得对。
   * 不用 pi-tui 的默认帧(盲文点阵,不在白名单里)的理由也写在那边。
   */
  /**
   * 一轮是不是还在飞(等待指示器的可见性 + `/reload` 靠它拒绝打断 —— 扩展工具的 execute
   * 是一次跨进程调用,轮飞着的时候 kill 子进程会让那次调用停在那儿,症状是"模型忽然不动了")。
   * ⚠ 声明必须在 `root` 装配之前(`armedAt` 同款 TDZ 坑:`visible` 闭包读它)。
   */
  let turnInFlight = false;
  /** 本轮起点(ms)。秒计时的分子;每轮 submit 重置。 */
  let turnStartedAt = 0;
  /** 秒计时 ticker。**只在轮飞着时存在** —— 退出/收尾都要清,不清就是一个永远在跳的定时器。 */
  let waitTicker: ReturnType<typeof setInterval> | null = null;
  const waiting = new Loader(tui, theme.chrome.accent, theme.chrome.dim, CHROME.waiting, {
    frames: [...SPINNER_FRAMES],
    intervalMs: 120,
  });
  waiting.stop(); // 构造里会 start;没在等的时候不许有定时器在跑
  /**
   * DAG 活秒数 ticker (C-6 ①, SDD 2026-08-11):有节点在跑 → 每秒刷一次渲染,
   * 树行的活秒数才随 render tick 递增。轮飞着时 Loader 自己就在刷(120ms),这里兜底的是
   * **轮已收尾而节点仍在跑**的那段 —— fixture 的 shard-3 就是这种, 摘掉这条秒数会停。
   * 幂等:只在 无→有 时起、有→无 时停。
   */
  let dagTicker: ReturnType<typeof setInterval> | null = null;
  function syncDagTicker(): void {
    const running = dagTree.hasRunning();
    if (running && dagTicker === null) {
      dagTicker = setInterval(() => tui.requestRender(), 1000);
    } else if (!running && dagTicker !== null) {
      clearInterval(dagTicker);
      dagTicker = null;
    }
  }


  /**
   * Ctrl+C 预备时刻(`null` = 没在预备)。
   *
   * ⚠ **声明必须在 `root` 装配之前**:底栏第三行的 `visible` 闭包读它,而 `let` 有 TDZ ——
   * 装配到声明之间只要发生一次同步渲染就是 `ReferenceError`。tsc 看不出这一类。
   */
  let armedAt: number | null = null;
  /** 上一次(空闲态)Esc 的时刻;`null` = 没有预备中的双击。`armedAt` 的 Esc 版。 */
  let escArmedAt: number | null = null;
  /** 本轮是否被 Esc 打断过。`submit` 开轮清零 —— 回执与错误抑制都看它。 */
  let abortRequested = false;

  const root = new VStack();
  // W6·M1: 转录直接进树 (自然高, 顶部进 scrollback)。全屏 = 树内模态块 (B 案,
  // enterAltView 处记录了对 SDD A 案的偏离与理由): 开着时转录/HUD 让位, 关掉回来。
  root.addChild(transcript, { visible: () => !dagFullState.fullOn && !pathFullOn && !inboxOpen });
  root.addChild(fullView, { shrink: 0, visible: () => dagFullState.fullOn && !pathFullOn });
  root.addChild(pathView, { shrink: 0, visible: () => pathFullOn });
  /**
   * ★ **收件箱全屏**(片 5 切片 3,2026-08-22):与 fullView / pathView 同款树内模态。
   * `Ctrl+N` 切(`omd.inbox`,见 `keys.ts`);开时 transcript 让位,Esc 关。
   * 与三块(pathHud/ticketBoard/runBoard)**无关** —— 收件箱开时那一族照常按
   * `pathHudVisible` 决定收不收,本片不动那一族(判词判的就是那一族)。
   */
  root.addChild(inboxView, { shrink: 0, visible: () => inboxOpen });
  root.addChild(alignToContent(dagTreeBlock), { shrink: 0, visible: (vp: { width: number }) => !dagFullState.fullOn && !pathFullOn && !inboxOpen && sidebarPainting(vp.width) });
  root.addChild(alignToContent(dagHudBlock), { shrink: 0, visible: (vp: { width: number }) => !dagFullState.fullOn && !pathFullOn && !inboxOpen && !sidebarPainting(vp.width) });
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
  root.addChild(alignToContent(pathHud), { shrink: 0, visible: () => pathHudVisible({ pathFullOn, hasDialogue: chatLog.hasDialogue }) && !inboxOpen });
  // 切片 S5: 票看板与 pathHud 同一可见性 —— 它属于欢迎屏, 不属于对话主屏 (要常看按 Ctrl+P)。
  root.addChild(alignToContent(ticketBoard), { shrink: 0, visible: () => pathHudVisible({ pathFullOn, hasDialogue: chatLog.hasDialogue }) && !inboxOpen });
  // #96: 活 run 观察面挂在票看板下面, **同一可见性** —— 它和票看板回答的是同一屏上的两个问题
  // ("图上还剩什么" / "现在谁在跑"), 分开挂会让其中一个在欢迎屏之外孤零零地出现。
  root.addChild(alignToContent(runBoard), { shrink: 0, visible: () => pathHudVisible({ pathFullOn, hasDialogue: chatLog.hasDialogue }) && !inboxOpen });
  root.addChild(waiting, { shrink: 0, visible: () => turnInFlight });
  root.addChild(dialogSlot, chrome);
  /**
   * ★ **「当前」区**(片 5 切片 3,2026-08-22):画在输入框**正上方**,**对话中常驻**。
   *
   * 判词(`tui.ts:861-863`)判的是「与本题无关的 3 块」,不是「不许有常驻区」。
   * ⇒ 这一条带子**与 pathHudVisible 那条三块脱钩**(INV-NOW-1 阶梯只选一档,
   *   INV-NOW-3 无源恒缺席)。`renderNowBand` 自己返空仓时 `[]`,这里转出来还是 `[]`,
   *   VStack 自然不画 —— 一条常驻的「一切正常」只会训练人不看它。
   * 全屏态(DAG / 散雾图 / 收件箱)让位:同一区域画三遍是 dump 不是 UI。
   * ⚠ `nowBand` 是声明在 `root` 之上的 Component,这里**只引用** —— 真实定义在上面
   *   「当前」区数据那一段(行号随 commit 漂移,看上面 `nowBand:` 那条声明)。
   */
  root.addChild(nowBand, { shrink: 0, visible: () => !dagFullState.fullOn && !pathFullOn && !inboxOpen });
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
  // W6·M1: 主屏形态没有 layoutRoot 概念 (那是 viewport TUI 的口) —— 树按内容高
  // 自然生长, 活动区 (末屏) 原地重画, 长出的顶部进 scrollback。
  tui.addChild(withLeftGutter(root));
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
      // 框关了, 如果这一轮还在飞, 指示器接着转。
      if (turnInFlight) waiting.start();
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
    // 活仪表(切片② + 2026-08-17 帧实测去重)。还没跑过一轮 ⇒ 没有 usage ⇒ 整块缺席,
    // 那时行①与仪表落地前**逐字相同**(I1)。
    const gauge = formatStatusGauge({
      usage: lastUsage === null ? null : { completionTokens: lastUsage.out },
      pressure: lastPressure !== null && lastPressure.ratio !== null ? { ratio: lastPressure.ratio } : null,
      tps: lastTps,
    });
    // 仪表的 ctx 条在场时, 行①的平文 `ctx N%` 段撤下 —— 同屏两个 ctx 是重复读数 (帧抓的)。
    const gaugeHasCtx = gauge.startsWith('ctx ');
    const line = formatStatusLine(
      {
        ws,
        seat: opts.backend.connection.url.replace(/^embedded:\/\//, ''),
        pressure: gaugeHasCtx ? null : lastPressure,
        session: session && session.calls > 0 ? session : null,
        win,
      },
      {
        ssh: sshHost,
        tmux,
        // 宽度预算 = 终端宽 - 活仪表要占的位(含分隔符)。超了就**缩分支段**, 不让读数掉出屏。
        // ⚠ `terminal.columns` 在这里取的是**本次重画那一刻**的值, 而本函数只在启动与每轮收尾跑;
        //   窗口中途改大小 → 下一轮才重算, 那一段时间里退回今天的行为(fitLine 截), 不是回归。
        maxWidth: Math.max(40, (terminal.columns || 100) - (gauge === '' ? 0 : visibleWidth(FOOTER_SEP) + visibleWidth(gauge))),
      },
    );
    statusLine.setText(gauge === '' ? line : `${line}${FOOTER_SEP}${gauge}`);
  }
  /** 已唤起、等着挂到下一句上的 skill 正文。**用完即清** —— 一条 skill 只管一轮。 */
  let pendingSkill: string | null = null;
  /** 最近一轮的上下文压力 —— 设置面板要显示它。`null` = 还没跑过一轮(**不是 0**)。 */
  let lastPressure: import('../harness/chat/usage').ContextPressure | null = null;
  /** 最近一轮的 token 读数 —— 活仪表的 cache% 分子分母。`null` = 还没跑过一轮(整块缺席)。 */
  let lastUsage: import('../model/types').ModelUsage | null = null;
  /** 最近一轮的 t/s。轮间屏上显示的就是这个上一轮值;`null` = 还没算出过(那一格缺席)。 */
  let lastTps: number | null = null;
  // `turnInFlight` 的声明在等待指示器那一段(root 装配之前,TDZ)—— 2026-08-11 与
  // `waitingOn` 合并:指示器活满整轮之后,两者就是同一件事。
  /**
   * 扩展加载结果。**可变** —— `/reload` 之后设置面板要显示新的那份,
   * 显示旧的话"重载了没有"就再也读不出来了(而屏上那条通知会读成已经生效)。
   */
  let extStatus = opts.extensions ?? [];
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
    // 交接收尾(#212): 退出是这条会话**最后一次**存档机会, 错过就只剩上一次跨档那份。
    // detached 派子进程, 不在这里等 —— 蒸馏要打一次模型(秒级), 而"退出要等几秒"
    // 是不能接受的; 进程内 fire-and-forget 又活不过 exit。全程 fail-open。
    spawnFinalCheckpoint(sessionId, opts.cwd ?? process.cwd());
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

  /** §4.1 第 5 条:先停动画再拆传输。等待指示器(loader 帧 + 秒计时 ticker)、
   *  DAG 活秒数 ticker 与活图列表 1s 轮询 ticker 是目前的动画。 */
  function stopAnimations(): void {
    stopWaiting();
    if (dagTicker) {
      clearInterval(dagTicker);
      dagTicker = null;
    }
    if (runListTicker) {
      clearInterval(runListTicker);
      runListTicker = null;
    }
  }

  /**
   * 提交一轮。**这里是 S10 唯一要换的地方** —— 换掉的是 `opts.backend` 的实现,
   * 不是这段代码:UI 只认 `OmdBackend` 那一个形状(SDD §3.1)。
   *
   * ⚠ 拒绝要**画成 notice 不是 assistant**:一句"引擎没接通"若被画成助手发言,
   * 读起来就像模型在回答 —— 那正是本仓 S-1 那一族(看起来在动,其实一次都没生效)。
   */
  /** 关等待态(轮收尾/退出共用)。**幂等** —— 定时器只该停一次。 */
  function stopWaiting(): void {
    if (waitTicker) {
      clearInterval(waitTicker);
      waitTicker = null;
    }
    waiting.stop();
  }

  /** @param alreadyPainted 排队续发路:文本入队时已画过 user 气泡, 这里不再画第二遍。 */
  async function submit(prompt: string, alreadyPainted = false): Promise<void> {
    if (!alreadyPainted) chatLog.appendUser(prompt);
    // A7: skill 正文前置到这一句上。**用完即清** —— 不清的话它会在往后每一轮里重复出现。
    const withSkill = pendingSkill ? `${pendingSkill}\n\n${prompt}` : prompt;
    pendingSkill = null;
    editor.setText('');
    if (!alreadyPainted) editor.addToHistory(prompt);
    // 等待态开满整轮(2026-08-11,见 `waiting` 声明处)。文案先回到基态 ——
    // 不回的话第二轮的头一秒还挂着上一轮的秒数。
    turnInFlight = true;
    abortRequested = false;
    turnStartedAt = now();
    waiting.setMessage(CHROME.waiting);
    waiting.start();
    waitTicker = setInterval(() => {
      // 对话框开着时在等的是人不是模型 —— 不改文案不触发重绘(loader 那侧 dialogs.open 已停)。
      if (!dialogs.busy) waiting.setMessage(CHROME.waitingElapsed(Math.floor((now() - turnStartedAt) / 1000)));
    }, 1000);
    tui.requestRender();
    // W5 片2: `@图.png` 引用抽附件 (判定保守, 见 attachments.ts I1); 文本逐字不动 (I2)。
    // 回执两侧都说真话 (I5): 附上的报名字+体积, 读不出/超限的逐张明说。
    const att = extractImageRefs(withSkill, opts.cwd);
    if (att.images.length > 0) chatLog.appendNotice(CHROME.attached(att.images.map(fmtAttachment)));
    for (const s of att.skipped) chatLog.appendNotice(CHROME.attachSkipped(s.ref, s.reason));
    try {
      const res = await opts.backend.sendChat({
        sessionId,
        prompt: withSkill,
        thinking: thinkingLevel,
        ...(att.images.length > 0 ? { images: att.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) } : {}),
      });
      // `ok:false` 是**响亮的否**, 不是空回复。打断的轮不算拒 —— 那是人叫停的。
      if (!res.ok && !abortRequested) chatLog.appendNotice(CHROME.refused(opts.backend.connection.url));
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 错误原文进屏, 同时进日志文件 (已改道)。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, sessionId, abortRequested }, '[omd/tui] sendChat threw');
      // Esc 打断的轮抛出的 AbortError 不画成失败 —— 人叫停的不是事故 (回执在下面统一画)。
      if (!abortRequested) chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    // 打断回执画在收尾处 (唯一出口): 正常返回 (pi 把 stopReason:'aborted' 的部分消息照常
    // 返回并写入磁盘) 与抛错 (压缩中被掐) 两条路都汇到这里, 只画一次。
    if (abortRequested) chatLog.appendNotice(CHROME.interrupted());
    // 无论成败都收尾: 抛错那条路上 `session` 事件不会来, 不收尾的话下一轮会续进这条气泡。
    // ⚠ 等待态只在这里关(**`finally` 语义**)—— 指示器活满整轮, 不在 delta 分支收。
    turnInFlight = false;
    stopWaiting();
    chatLog.closeStreaming();
    tui.requestRender();
    // 排队残留兜底: 轮内没被钩子消费的 (claude-sdk 座不吃钩子 / 入队晚于最后一个间隙)。
    // 正常收尾 → 拼成下一轮续发 (painted=true: 入队时已画过气泡);
    // 打断收尾 → **不续发**(人叫停时静默续发最吓人), 也不许残留在后端 (下轮会意外注入) ——
    // 取回放进输入框, 人按回车才走。
    if (opts.backend.drainQueued) {
      try {
        const { prompts } = await opts.backend.drainQueued({ sessionId });
        if (prompts.length > 0) {
          if (abortRequested) {
            chatLog.appendNotice(CHROME.queuedHeld(prompts.length));
            editor.setText(prompts.join('\n'));
          } else {
            chatLog.appendNotice(CHROME.queuedFlush(prompts.length));
            void submit(prompts.join('\n\n'), true);
          }
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, '[omd/tui] drainQueued threw');
      }
    }
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
        // 指示器不在这收(2026-08-11):正文按整段到达的通道上,两段之间屏会完全静止。
        chatLog.appendAssistantChunk(p.text);
        tui.requestRender();
      }
      // 思维链(2026-08-13):dim 一段, 与正文分条。`thinking_end` 收条目 ——
      // 不收的话下一段正文会续进思考区, 读起来就是"模型把草稿当答案发了"。
      if (p?.type === 'thinking' && p.text) {
        chatLog.appendThinkingChunk(p.text);
        tui.requestRender();
      }
      if (p?.type === 'thinking_end') {
        chatLog.closeStreaming();
        tui.requestRender();
      }
      return;
    }
    if (e.event === 'tool') {
      const p = e.payload as { phase?: string; name?: string; ok?: boolean; id?: string; args?: unknown; details?: unknown; lines?: number; tail?: string };
      const name = p?.name ?? '?';
      // 一个工具**一行**, end 原地更新 —— 不再 start/end 各追加一条 notice。
      // S-5: 带上参数那半句 —— 只画 `✓ read` 的话, 改对文件和改错文件在屏上长得一模一样。
      if (p?.phase === 'start') {
        // ⚠ 工具名必须传 —— 搜索一族靠它才画得出「词 in 范围」(2026-08-13)。
        //   不传的话 `grep(pattern, path)` 会退回通用挑格, 屏上只剩范围, 搜索词消失。
        chatLog.toolStart(name, { id: p?.id, detail: summarizeToolArg(p?.args, undefined, name) });
        // 切片⑤: 健康度计数吃 start 事件 (end 不带 args)。
        health.onTool(name, p?.args);
        healthLine.setText(health.line() ?? '');
        // 2026-08-14: 跑着的中途读数 —— 原地更新同一行, 让「在跑」与「卡死」分得开。
      } else if (p?.phase === 'update') {
        chatLog.toolUpdate(name, { id: p?.id, lines: Number(p?.lines ?? 0), tail: p?.tail });
        // 2026-08-13: 结果那半句在 end 事件里(start 时还不知道搜到了什么)。
      } else chatLog.toolEnd(name, p?.ok !== false, { id: p?.id, result: summarizeToolResult(name, p?.details) });
      tui.requestRender();
      return;
    }
    if (e.event === 'dag') {
      const p = e.payload as { runId?: string; node?: { type?: string } };
      // 换了 run → 清空上一个 run 的节点, 否则两个 run 的节点混成一张表。
      if (p?.node?.type === 'planned' && p.runId) {
        busRunId = p.runId; // bus 接管屏 → 外部附身让位 (两路喂同一 hud 会互踩)
        dropExternalChannel();
        dagHud.beginRun(p.runId);
        dagTree.beginRun(p.runId);
      }
      if (p?.node) {
        dagHud.apply(p.node as never);
        // 切片③: 同一批事件两个消费者。**不能只喂一个** —— 交接 37 坑 #7 同族:
        // 只接一处的话左栏是一张永远空的图, 而它看起来只是"还没开始跑"。
        dagTree.apply(p.node as never);
        syncDagTicker(); // 节点态变了 → 重算活秒数 ticker 的启停 (C-6 ①)
      }
      tui.requestRender();
      return;
    }
    if (e.event === 'session') {
      chatLog.closeStreaming();
      const p = e.payload as { pressure?: import('../harness/chat/usage').ContextPressure; usage?: import('../model/types').ModelUsage };
      lastPressure = p?.pressure ?? lastPressure;
      // 切片②: 本轮 t/s —— 墙钟用既有 turnStartedAt 与注入的 now()(I6)。
      // 算不出来就留上一轮的值,不退回 0(I2)。
      if (p?.usage) {
        lastUsage = p.usage;
        lastTps = computeTps(p.usage.out, turnStartedAt, now()) ?? lastTps;
      }
      // 切片②: 一轮跑完 → 底栏行①②重取数 (账本刚被 backend 记过, git 可能被这一轮改过)。
      updateStatusBar({ refreshGit: true });
      // 一轮跑完可能动过地图 (conductor 有 map_* 工具) → 重读一次。
      // 不在 render 里读盘: render 每帧都调, 那会变成每帧一次目录扫描。
      pathHud.refresh();
      refreshTicketBoard(); // 切片 S5: 同一时机重读看板 (一轮跑完可能动过地图)
      refreshRunBoard(); // #96: 板与看板同一时机重读 —— 一轮跑完 claimed/published 都可能变
      refreshNowBandData(); // 片 5: 当前区 + 收件箱同一时机重读 (一轮跑完 map/run 都可能变)
      if (pathSlugSel) reloadPathData(); // 切片⑧: 全屏图的数据同一时机重读
      tui.requestRender();
    }
  };
  // 启动即画一次: git 段立刻可见, 5h 窗口读的是账本写入磁盘的历史 (跨重启存活正是它的意义)。
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
      title: `${role} -> which model? (${choices.length})`,
      options: [
        ...(isAdvisor ? [{ value: ADVISOR_NONE, label: '(none) clear advisor', description: 'delete advisors key - back to unset' }] : []),
        ...choices.map((c) => ({ value: c.coord, label: choiceLabel(c, current) })),
        { value: MANUAL_COORD, label: 'manual input coord…', description: 'provider:model not in catalog' },
      ],
      search: true,
      maxVisible: 12,
    };
  }

  /** 手输坐标那条退路 —— 同样只此一份。 */
  function seatManualOpts(role: string, now: string): InputOpts {
    return { title: `${role} -> which coordinate? (provider:model)`, initial: now.startsWith('(') ? '' : now };
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
  const ADVISOR_NONE = '\x00none';

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
      logger.warn({ err: reason, cmd: t }, '[omd/tui] run command threw');
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
        // 2026-08-21: title 提成主标签 + 开搜索 + 放宽行数, 三处与 `/models`(:1287) 对齐。
        // 选项构造是纯函数 (`sessionPickerOptions`), 逻辑不留在这里。
        const pick = await dialogSelect(dialogs, theme, {
          title: `Switch to which session? (${list.length})`,
          options: sessionPickerOptions(list, sessionId, Date.now()),
          search: true,
          maxVisible: 12,
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
      logger.warn({ err: reason, cmd: text }, '[omd/tui] session command threw');
      chatLog.appendNotice(CHROME.sessionFailed(reason));
    }
    footer.setText(CHROME.footer());
    tui.requestRender();
    return true;
  }

  /**
   * `/tree` —— 会话**树**导航(台账 §1.3 / C11,真 model call + 写入会话文件,副作用)。
   *
   * ## 与 `/fork` 的分野(2026-08-11 裁决,别把两条读成重复)
   *
   * - `/fork` = **另存一条会话**(`repo.fork` 复制成第二份文件)。产物是两条并列的会话,
   *   都能在 `/session` 里来回切、能各自继续 —— 代价是同一段历史存在两份。
   * - `/tree` = **同一份文件里换分支**(pi 的做法)。回到旧节点重走,被放弃的那条分支
   *   摘要成一条 `[branch summary]` 节点接在新分支起点上,原消息一条不动 ⇒ **一份真值**。
   *   代价是同一条会话同时只有一个活分支(lane 指针只有一个)。
   *
   * ⇒ "想重走一段对话"走 `/tree`(默认);"想要两条同时活着的会话"走 `/fork`。
   *
   * ## 切完必须重放
   *
   * 换分支之后模型看到的是新分支的投影,屏上还是旧的 —— 不重放就是 `sessions.ts` 那条
   * 老纪律的同一形状(两边都有内容,只是不是同一份)。所以走 `switchTo(sessionId)`。
   */
  async function handleTree(text: string): Promise<boolean> {
    if (!parseTreeCommand(text)) return false;
    chatLog.appendUser(text.trim());
    editor.setText('');
    tui.requestRender();
    const { sessionTree, branchTo } = opts.backend;
    if (!sessionTree || !branchTo) {
      // 能力探测面靠字段在不在 —— 缺了就说**缺的是什么**, 不画一个点了没反应的入口。
      chatLog.appendNotice(CHROME.noRunCapability('session tree'));
      tui.requestRender();
      return true;
    }
    try {
      const { leafId, entries } = await sessionTree({ sessionId });
      const rows = buildTreeRows(entries, leafId);
      chatLog.appendNotice(formatTree(rows));
      tui.requestRender();
      // 一条都没有时 `select` 自己不开框(开个空框让人按 Esc 是耍人)。
      const pick = await dialogSelect(dialogs, theme, {
        title: 'Branch from which entry?',
        options: rows.map((r) => ({ value: r.id, label: treeLabel(r), description: r.kind })),
        search: true,
      });
      if (pick === null) return true; // Esc: 不切不写
      if (pick === leafId) {
        chatLog.appendNotice(CHROME.treeAtLeaf());
      } else {
        const r = await branchTo({ sessionId, entryId: pick });
        if (!r.ok) chatLog.appendNotice(CHROME.treeBranchFailed(r.text));
        else {
          await switchTo(sessionId); // 换分支 = 换了一份历史, 屏上必须跟着换
          chatLog.appendNotice(CHROME.treeBranched(pick, r.text));
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /tree threw');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/think [档]` —— chat 轮思考档的控制面(W1)。裸 `/think` 只看不改;
   * 档进本仓词表(role-models 的 ThinkingLevel, 不是 pi 的);写盘后回执印真值。
   * 屏上常驻显示排在 W2 仪表合入之后 —— 那片正在 status-line 上动, 现在碰它必撞。
   */
  function handleThink(text: string): boolean {
    const t = text.trim();
    if (t !== '/think' && !t.startsWith('/think ')) return false;
    chatLog.appendUser(t);
    editor.setText('');
    const arg = t.slice('/think'.length).trim();
    if (!arg) {
      chatLog.appendNotice(CHROME.thinkShown(thinkingLevel));
    } else if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
      chatLog.appendNotice(CHROME.thinkBad(arg));
    } else {
      const path = setTuiUi(opts.cwd, { thinking: arg as ThinkingLevelName });
      // 真值回盘上读 (applySetting 同口径): 写盘失败不许在屏上留"改好了"的假象。
      thinkingLevel = loadTuiUiConfig(opts.cwd).thinking;
      chatLog.appendNotice(CHROME.thinkSet(thinkingLevel, path));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `!cmd` —— 本地跑命令,输出进上下文(pi / claude code / dsh 同款)。
   *
   * - 跑在 `opts.cwd`,bash -c,120s 超时;信任模型同用户自己的终端(命令是人打的)。
   * - **在飞时拒绝**:命令输出与流式回复抢会话写序,谁先落说不清。
   * - 屏与账**同一份文本**(`formatBangEntry`):屏上截显示、账上截 `BANG_OUTPUT_CAP` ——
   *   两边各拼一份就是 S-1 那一族。
   */
  async function handleBang(cmd: string): Promise<void> {
    chatLog.appendUser(`! ${cmd}`);
    editor.setText('');
    editor.addToHistory(`!${cmd}`);
    tui.requestRender();
    if (!cmd) {
      chatLog.appendNotice(CHROME.bangUsage());
      tui.requestRender();
      return;
    }
    if (turnInFlight) {
      chatLog.appendNotice(CHROME.bangBusy());
      tui.requestRender();
      return;
    }
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile('bash', ['-c', cmd], { cwd: opts.cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        // err.code: number = 退出码; 其余 (超时/信号) → null, formatBangEntry 印 'signal'。
        const c = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
        resolve({ code: c, out: `${stdout ?? ''}${stderr ?? ''}` });
      });
    });
    const entry = formatBangEntry(cmd, code, out);
    // 屏上最多 1200 字符 —— 全文在会话里, 屏是给人扫的不是给人存档的。
    chatLog.appendNotice(entry.length > 1200 ? `${entry.slice(0, 1200)}\n[... display truncated; the session keeps the capped text]` : entry);
    if (opts.backend.appendContext) {
      try {
        await opts.backend.appendContext({ sessionId, text: entry });
      } catch (err) {
        // 落账失败要响亮: 屏上有、账上没有正是"看起来在动其实没生效"那一族。
        chatLog.appendNotice(CHROME.failed(err instanceof Error ? err.message : String(err)));
      }
    } else chatLog.appendNotice(CHROME.noRunCapability('appendContext'));
    tui.requestRender();
  }

  /**
   * `/search <词>` —— 跨会话全文搜索(pi 的扫描式现成件,只读)。
   * 命中选单选中 → 切进那条会话;同一会话的多条命中各占一行(片段不同,读起来不是重复)。
   */
  async function handleSearch(text: string): Promise<boolean> {
    const cmd = parseSearchCommand(text);
    if (!cmd) return false;
    chatLog.appendUser(text.trim());
    editor.setText('');
    tui.requestRender();
    if (!opts.backend.searchSessions) {
      chatLog.appendNotice(CHROME.noRunCapability('session search'));
      tui.requestRender();
      return true;
    }
    if (!cmd.text) {
      chatLog.appendNotice(CHROME.searchUsage());
      tui.requestRender();
      return true;
    }
    try {
      const { hits } = await opts.backend.searchSessions({ text: cmd.text });
      if (hits.length === 0) {
        chatLog.appendNotice(CHROME.searchNone(cmd.text));
        tui.requestRender();
        return true;
      }
      // 一条都没有时上面已经拦了 —— 这里恒有内容, 不会开空框。
      const pick = await dialogSelect(dialogs, theme, {
        title: `${hits.length} hit(s) for "${cmd.text}"  (Enter switches session - Esc cancels)`,
        options: hits.map((h) => ({
          value: h.sessionId,
          label: `${h.sessionId === sessionId ? '* ' : '  '}${h.sessionId}`,
          ...(h.snippet ? { description: h.snippet } : {}),
        })),
        search: true,
      });
      if (pick !== null && pick !== sessionId) await switchTo(pick);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] /search threw');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /**
   * 双 Esc 的回退选单 —— `/tree` 的近路(dsh-TUI / claude-code 的惯用键)。
   *
   * 与 `/tree` 是同一套机件(`sessionTree` + `branchTo` + `switchTo`),分野在取材:
   * `/tree` 给整棵树(含旁支,带搜索),这里只给**当前分支上的 user 消息**,
   * 选中 = 回到那句话**之前**(`branchTo` 它的 parent;被放弃的那段照旧摘要成
   * `[branch summary]` 节点,一条消息都不丢)。
   */
  async function openRewind(): Promise<void> {
    const { sessionTree, branchTo } = opts.backend;
    if (!sessionTree || !branchTo) {
      chatLog.appendNotice(CHROME.noRunCapability('session tree'));
      tui.requestRender();
      return;
    }
    try {
      const { leafId, entries } = await sessionTree({ sessionId });
      const targets = rewindTargets(entries, leafId);
      if (targets.length === 0) {
        chatLog.appendNotice(CHROME.rewindNone());
        tui.requestRender();
        return;
      }
      const pick = await dialogSelect(dialogs, theme, {
        title: 'Rewind to before which message?  (↑↓ select · Enter rewind · Esc cancel)',
        options: targets.map((t) => ({ value: t.id, label: t.preview || t.id.slice(0, 8) })),
      });
      if (pick === null) return; // Esc: 不切不写
      const target = targets.find((t) => t.id === pick);
      if (!target) return;
      const r = await branchTo({ sessionId, entryId: target.parentId });
      if (!r.ok) chatLog.appendNotice(CHROME.treeBranchFailed(r.text));
      else {
        await switchTo(sessionId); // 换分支 = 换了一份历史, 屏上必须跟着换 (handleTree 同款)
        chatLog.appendNotice(CHROME.treeBranched(target.parentId, r.text));
        // 原句逐字预填回输入框 (claude-code 同款): 回退是为了改一改重发, 不是重打一遍。
        // 没有全文就不填 —— 预览是截断的, 填截断文本进输入框是丢半句的静默坑。
        if (target.text) editor.setText(target.text);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] double-Esc rewind threw');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
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
    enterMap(slug);
  }

  /**
   * 换到某张图并进全屏。**抽出来是因为 `Ctrl+P` 与 `Ctrl+K` 两条路都要走它** ——
   * 两份必漂(`switchTo` 同一条理由)。
   */
  function enterMap(slug: string): void {
    pathSlugSel = slug;
    pathSelected = 0;
    reloadPathData();
    pathHud.refresh(); // 侧栏跟着换图
    refreshTicketBoard(); // 切片 S5: 看板跟着换图
    refreshRunBoard(); // #96: 板不随图走 (它是全仓的), 但借同一次时机刷新
    refreshNowBandData(); // 片 5: 当前区 + 收件箱同一时机重读 (切图可能改 awaiting 列表)
    enterAltView('path'); // W6·M2 (B 案): 树内模态块开灯
  }

  /**
   * ★ **`Ctrl+K` 去哪**(2026-08-22,视觉系统稿第 6 屏)。会话 / 活图 / 地图 一个选单。
   *
   * 选项构造是纯函数(`palette.ts`),这里只做三件事:取数 → 开框 → 按 target 跳。
   *
   * ⚠ **一行都取不到时说话,不静默** —— 按了键什么都不发生,比开一个空框更难查。
   * 会话读不出来是**异常**(与「一条都没有」分得开),所以那一路不吞证据。
   */
  async function openPalette(): Promise<void> {
    let sessions: import('./backend').TuiSessionMeta[] = [];
    try {
      sessions = [...(await opts.backend.listSessions())];
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 少一段候选, 但原因要留痕 + 上屏。
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason }, '[omd/tui] palette read session table threw -> no session row this time');
      chatLog.appendNotice(CHROME.paletteSessionsFailed(reason));
    }
    let maps: import('../harness/pathfinder/maps').OpenMapSummary[] = [];
    try {
      const { summarizeOpenMaps } = require('../harness/pathfinder/maps') as typeof import('../harness/pathfinder/maps');
      maps = summarizeOpenMaps(opts.cwd);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[omd/tui] palette scan maps threw -> no map row this time');
    }
    // 活图只有本进程这一张 —— 别的进程的 run 要等 #215/#216 (每 run 一份磁盘镜像 + 快照加载)。
    const snap = dagTree.snapshot();
    const options = paletteOptions({
      sessions,
      currentSession: sessionId,
      maps,
      liveRun:
        dagTree.active && snap.runLabel
          ? { label: snap.runLabel, nodes: snap.nodes.length, running: snap.nodes.filter((n) => n.status === 'running').length }
          : null,
      now: now(),
    });
    if (options.length === 0) {
      chatLog.appendNotice(CHROME.paletteEmpty());
      tui.requestRender();
      return;
    }
    const picked = await dialogSelect(dialogs, theme, {
      title: `Go to (${options.length})`,
      options,
      search: true,
      maxVisible: 12,
    });
    if (picked === null) return; // Esc: 不去哪
    const target = parsePaletteValue(picked);
    if (target === null) return; // 认不出就什么都不做, 不猜一个去处
    if (target.kind === 'session') {
      if (target.id === sessionId) return; // 已经在这条会话上 —— 重放一遍纯属浪费
      try {
        await switchTo(target.id);
      } catch (err) {
        // 与 handleSession 同一条: 切失败**不许改 sessionId** (半切会让下一句发进不存在的会话)。
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ err: reason, id: target.id }, '[omd/tui] palette switch session threw');
        chatLog.appendNotice(CHROME.sessionFailed(reason));
      }
    } else if (target.kind === 'map') {
      enterMap(target.slug);
    } else {
      enterAltView('dag');
    }
    tui.requestRender();
  }

  /**
   * ★ W6·M2(B 案,**与 SDD A 案的记录偏离**):全屏视图 = **树内模态块**
   * (fullView/pathView 高度自带封顶 rows-10),主 TUI 不停不换。
   *
   * 曾按 SDD 实装双 TUI(preserveScreen + capture/restore 往返)—— PTY 实测
   * pi `ProcessTerminal` 在同进程 stop/start 循环下输入侧挂死(PF-5 复现:视图
   * 画得出、按键进不来,alt 与主 listener 双双失聪;渲染半正常)。那是库的
   * 生命周期假设,不值得为一个视图切换去背。代价:每次切换往 scrollback 留
   * 一帧残影 —— 已知、可忍;pi 侧修了(或我们上游补丁)再回 A 案。
   */
  function enterAltView(kind: 'dag' | 'path'): void {
    if (kind === 'dag') {
      if (!dagTree.active) chatLog.appendNotice('No run yet - send one, then press Ctrl+G');
      else {
        // palette 走的是这条 — palette 的 liveRun 已隐含 dagTree.active, 直接 toggle。
        dagFullState = decideDagFull(dagFullState, { type: 'toggle', dagActive: true });
        syncRunListTicker();
      }
    } else {
      pathFullOn = true;
    }
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
        const MANUAL = '\x00manual';
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
      logger.warn({ err: reason }, '[omd/tui] /login threw');
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
      logger.warn({ err: reason }, '[omd/tui] /logout threw');
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
   * `/compact` —— 手动压缩当前会话上下文(真 model call + 写入磁盘,副作用)。
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
      logger.warn({ err: reason }, '[omd/tui] /compact threw');
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
      logger.warn({ err: reason }, '[omd/tui] /export threw');
      chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
    }
    tui.requestRender();
    return true;
  }

  /**
   * `/reload` —— 重载扩展(kill 子进程 + 按 `.omd/extensions.json` 重来,副作用)。
   *
   * ## 范围只有 extensions 一样(owner 裁决,D3)
   *
   * pi 的 `/reload` 是五样(keybindings / extensions / skills / prompts / themes),
   * 这里**只做扩展**:扩展是唯一"改了清单就得重启整个 TUI"的一样 —— skill 正文每次现读,
   * 座位每轮现解,主题/键位改完重开面板就行。别的四样先不铺。
   *
   * ## 正在跑的东西为什么不受影响
   *
   * - **对话轮**:轮在飞时**直接拒**(见 `turnInFlight`)—— 不去 kill 可能正被调用的子进程。
   * - **DAG 叶子**:叶侧的扩展宿主是 `harness/ext-tools.ts` 按 cwd 缓存的**另一批**子进程,
   *   这条路一个字都不碰它们。跑着的图照跑,它们手里的工具仍指向自己的进程。
   */
  async function handleReload(text: string): Promise<boolean> {
    const t = text.trim();
    if (t !== '/reload') return false;
    chatLog.appendUser(t);
    editor.setText('');
    tui.requestRender();
    if (!opts.reloadExtensions) {
      chatLog.appendNotice(CHROME.noRunCapability('extension reload'));
    } else if (turnInFlight) {
      chatLog.appendNotice(CHROME.extReloadBusy());
    } else {
      try {
        const r = await opts.reloadExtensions();
        extStatus = r.status;
        chatLog.appendNotice(CHROME.extReloaded(r));
      } catch (err) {
        // fail-open 可以吞异常, 不许吞证据:原文进屏也进日志。
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ err: reason }, '[omd/tui] /reload threw');
        chatLog.appendNotice(CHROME.failed(humanizeProviderError(reason)));
      }
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
      extensions: extStatus,
      ui: { sidebar: sidebarOn, painterName: PAINTERS[painterIdx] ?? 'tree' },
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
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
        apply: (id, value) => applySetting(id, value),
        activate: (id) => {
          // 就地办完的:一条通知就够, 面板留着(通知画在对话区, 不遮设置页)。
          if (id === 'ext') {
            chatLog.appendNotice('The extension manifest lives in `.omd/extensions.json` (entry points are absolute paths). Run `/reload` after editing it.');
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
    return value;
  }

  editor.onSubmit = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return; // 空回车不算一轮 —— 否则会往会话里塞空消息
    const bang = parseBang(prompt);
    if (bang) {
      void handleBang(bang.cmd);
      return;
    }
    // 在飞排队 (W1): 轮跑着时的**普通聊天文本**入队 (钩子在工具间隙注入 / 轮尾续跑)。
    // 斜杠命令不入队 —— 命令是对 TUI 说的, 不是对模型说的, 各命令自己决定在飞时接不接。
    if (turnInFlight && !prompt.startsWith('/') && opts.backend.queueChat) {
      chatLog.appendUser(prompt);
      editor.setText('');
      editor.addToHistory(prompt);
      void opts.backend.queueChat({ sessionId, prompt }).then(({ queued }) => {
        chatLog.appendNotice(CHROME.queued(queued));
        tui.requestRender();
      });
      tui.requestRender();
      return;
    }
    if (handleThink(prompt)) return;
    if (parseHelpCommand(prompt)) {
      chatLog.appendUser(prompt);
      editor.setText('');
      chatLog.appendNotice(formatHelp(Math.max(60, (terminal.columns || 100) - 4)));
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
          void handleTree(prompt).then((handledTree) => {
            if (handledTree) return;
            void handleSearch(prompt).then((handledSearch) => {
              if (handledSearch) return;
              void handleCompact(prompt).then((handledCompact) => {
                if (handledCompact) return;
                void handleExport(prompt).then((handledExport) => {
                  if (handledExport) return;
                  void handleReload(prompt).then((handledReload) => {
                    if (handledReload) return;
                    void handleRuns(prompt).then(async (handled) => {
                      if (handled) return;
                      // custom prompts (W4): 内建全未命中的 `/名` 试模板展开 —— 现扫目录,
                      // 新建文件立即可用 (补全启动时冻结, commands.ts:130 同款取舍)。
                      // 展开失败/无此模板 → 照旧当聊天文本发 (斜杠打错不该被吞)。
                      if (prompt.startsWith('/')) {
                        try {
                          const { promptTemplates } = await loadUserPrompts(opts.cwd);
                          const expanded = expandPrompt(promptTemplates, prompt);
                          if (expanded !== null) {
                            chatLog.appendUser(prompt); // 屏上留调用原文, 模型吃展开文 (pi I7: core 不感知)
                            editor.addToHistory(prompt);
                            void submit(expanded, true);
                            return;
                          }
                        } catch (err) {
                          logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] custom prompt expansion threw -> sent as chat text');
                        }
                      }
                      void submit(prompt);
                    });
                  });
                });
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
  // OSC 应答尾字节守卫 (2026-09-02, `osc-guard.ts`): 断开的 `OSC 11` 应答其结尾 BEL 与 Ctrl+G 同字节,
  // 不拦的话全屏视图会「自己弹出来」。放在最前: 它只吞「前缀之后紧跟的尾巴」, 真按键一律放行。
  const oscGuard = createOscTailGuard();
  tui.addInputListener((data: string) => {
    if (oscGuard.feed(data, now()) === 'swallow') return { consume: true };
    if (kb.matches(data, 'omd.quit')) {
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
    // W6·M2 (B 案): 全屏是树内模态块, 键都在本 listener 收 —— 开关键再按 = 关。
    if (kb.matches(data, 'omd.pathFull') && !dialogs.busy) {
      if (pathFullOn) pathFullOn = false;
      else void openPathView();
      tui.requestRender();
      return { consume: true };
    }
    if (kb.matches(data, 'omd.dagFull') && !dialogs.busy) {
      // 关 → 开: 两屏 (DAG / run-list) 任一有源才开, 两者都空则一句话告知。
      // INV-DAG-8: 无源恒缺席 — 按了键什么都没发生比开空屏更难查。
      // ⚠ t-tui-attach 收尾 (2026-09-01): 判门前先读一次盘 —— runList 只被全屏 ticker 刷新,
      // 开屏前恒空, 于是「盘上有外部 run 却开不了门」是死锁 (门等列表, 列表等门开)。
      if (!dagFullState.fullOn && !dagTree.active && runList.length === 0) refreshRunList();
      if (!dagFullState.fullOn && !dagTree.active && runList.length === 0) {
        chatLog.appendNotice('No run yet - send one, then press Ctrl+G');
        tui.requestRender();
        return { consume: true };
      }
      dagFullState = decideDagFull(dagFullState, { type: 'toggle', dagActive: dagTree.active });
      syncRunListTicker();
      tui.requestRender();
      return { consume: true };
    }
    // Ctrl+K 去哪(会话 / 活图 / 地图)。⚠ 这个键是从 pi 的 `tui.editor.deleteToLineEnd`
    // 手里抢来的 —— 取舍与还回去的办法记在 `keys.ts` 的 `omd.palette` 上。
    // 弹窗开着时不抢(与 pathFull / dagFull 同款守则):抢了的话框收不到键。
    if (kb.matches(data, 'omd.palette') && !dialogs.busy) {
      void openPalette();
      return { consume: true };
    }
    // 切片⑥ 收件箱(片 6 切片 3, 2026-08-22)。Ctrl+N 切(omd.inbox);开时本 listener 接管
    // ↑↓/Enter/Esc/x/c/r/i/s —— 与 pathFull / dagFull 同款"全屏是树内模态"约定。
    // 弹窗开着时不抢(同款守则): 框(审批单 / 选择器)收不到 Enter 就关不上。
    if (kb.matches(data, 'omd.inbox') && !dialogs.busy) {
      inboxOpen = !inboxOpen;
      inboxSelected = 0; // 每次开都从第一件开始 —— 不要把上次闭在哪带回来, "刚开" 就是第一件。
      tui.requestRender();
      return { consume: true };
    }
    // 收件箱开时的键盘分派: ↑↓ 移动, Enter / x / c / r / i / s 走 decideInboxKey,
    // Esc 关掉。空仓时只认 Esc (开空屏按上下键就读成"按了没反应", 那更难查)。
    if (inboxOpen && !dialogs.busy) {
      const len = inboxItems.length;
      if (kb.matches(data, 'omd.interrupt') || data === '\x1b') {
        inboxOpen = false;
        tui.requestRender();
        return { consume: true };
      }
      if (len === 0) {
        // 空仓: 仅 Esc 有效, 其余键吃掉不冒到 editor(editor 看不见, 冒上去会让人以为按了没接收)。
        return { consume: true };
      }
      if (data === '\x1b[A' || data === '\x1b[B') {
        inboxSelected = (inboxSelected + (data === '\x1b[A' ? -1 : 1) + len) % len;
        tui.requestRender();
        return { consume: true };
      }
      const action = decideInboxKey({ items: inboxItems, selected: inboxSelected, key: data });
      if (action.kind === 'noop') {
        // 路由说 noop 也要吃掉(吞掉否则会落到 editor, editor 看键盘时被吞键很迷)。
        // 但不重画 —— 没东西变。
        return { consume: true };
      }
      void executeInboxAction(action);
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
    if (dagFullState.fullOn) {
      // Tab 在两屏之间循环 (D-1: 信息整合, 不再是三画法轮换)。
      if (data === '\t') {
        dagFullState = decideDagFull(dagFullState, { type: 'tab' });
        tui.requestRender();
        return { consume: true };
      }
      // ↑↓ 在当前屏里移动选中。fullOn 时 editor 不可见, 裸方向键不会到达它, 这里接管。
      if (data === '\x1b[A' || data === '\x1b[B') {
        dagFullState = decideDagFull(dagFullState, { type: data === '\x1b[A' ? 'up' : 'down' });
        tui.requestRender();
        return { consume: true };
      }
      // Enter: run-list 屏上 = 加载那张图并切回 DAG (caller 拿 `runList[idx]` 调 `loadSnapshot`);
      //        DAG 屏上 = no-op — 选中即展开是 renderer 内部的事, dispatcher 不管。
      if (data === '\r' || data === '\n') {
        const before = dagFullState.kind;
        dagFullState = decideDagFull(dagFullState, { type: 'enter', runListNotEmpty: runList.length > 0 });
        if (before === 'run-list' && dagFullState.kind === 'dag') {
          // mod 口径与 renderer 一致 (`pickSelected` / `renderRunList`)。
          const len = runList.length;
          const idx = ((dagFullState.runListSelected % len) + len) % len;
          const view = runList[idx];
          if (view) {
            dropExternalChannel(); // 换 run 先清旧通道 (幂等)
            try {
              if (view.snap.runId !== busRunId) {
                // 外部 run (t-tui-attach): 快照翻译进 hud+tree, 再开 1s 尾随通道 —— 画面随盘动。
                attachExternalRun(dagHud, dagTree, view);
                externalChannel = createExternalRunChannel({
                  cwd: opts.cwd,
                  runId: view.snap.runId,
                  hud: dagHud,
                  tree: dagTree,
                  now,
                  requestRender: () => tui.requestRender(),
                });
              } else {
                // bus 正在喂的本地 run: 只重载树 (hud 由 bus 持续推, 不重复喂)。
                dagTree.loadSnapshot(view.snap);
              }
            } catch (err) {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err), runId: view.snap.runId },
                '[omd/tui] run-list Enter -> attach/loadSnapshot threw',
              );
            }
          }
        }
        tui.requestRender();
        return { consume: true };
      }
    }
    // 思维链折叠/展开 (默认 Ctrl+O)。弹窗开着时不抢 (pathFull 同款守则); 效果直接体现在重绘里, 不发回执。
    if (kb.matches(data, 'omd.thinkingToggle') && !dialogs.busy) {
      chatLog.toggleThinking();
      tui.requestRender();
      return { consume: true };
    }
    // Esc:在飞单按 = 打断本轮;空闲双按(600ms 窗)= 回退选单。判定在 decideEsc(纯函数)。
    // ⚠ dialogs.busy 时不碰 —— Esc 是对话框自己的关闭键(pi-tui `tui.select.cancel`),抢了框关不上。
    // ⚠ 全屏(DAG / pathfinder)时不开回退 —— 选单会开在全屏底下,谁在收键说不清。
    // ⚠ 只认裸 `\x1b`:方向键等序列(`\x1b[A`)整块到达,不会误入;快速双击并包成
    //   `\x1b\x1b` 到达的情形单独认。
    // ⚠ `\x1b\x1b` 保留字节比较: 那是快速双击被终端并包的**编码产物**不是键
    //   (parseKey 读成 ctrl+alt+[), 跟着 omd.interrupt 重绑走反而错。
    if ((kb.matches(data, 'omd.interrupt') || data === '\x1b\x1b') && !dialogs.busy) {
      const twice = data === '\x1b\x1b';
      const act = twice && !turnInFlight ? 'rewind' : decideEsc(turnInFlight, escArmedAt, now());
      if (act === 'interrupt') {
        escArmedAt = null;
        // 即时反馈 (owner 实报「Esc 有延迟」2026-09-01): abort 发出后模型要几秒才真停,
        // 期间屏上原来**一个字都不变** —— 键被吃了但看不见, 读起来就是"Esc 没反应/延迟"。
        // 终局回执仍归 submit 收尾 (CHROME.interrupted, :1595); 这里只画"已收到, 在停了"。
        // abortRequested 已置位时不重复画 (连按 Esc 不刷屏)。
        if (!abortRequested) {
          chatLog.appendNotice('Esc — interrupting… (the model may take a moment to stop)');
          tui.requestRender();
        }
        abortRequested = true;
        void opts.backend.abortChat({ sessionId }).catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, '[omd/tui] abortChat threw');
        });
        return { consume: true };
      }
      if (act === 'rewind' && !dagFullState.fullOn && !pathFullOn) {
        escArmedAt = null;
        void openRewind();
        return { consume: true };
      }
      escArmedAt = now();
      return undefined; // 第一下不吃 —— editor 自己也用 Esc (清补全)
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
    // 任何非 Esc 的键都解除双击预备 —— 否则"Esc、打半句话、再 Esc"会被当成双击。
    escArmedAt = null;
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
