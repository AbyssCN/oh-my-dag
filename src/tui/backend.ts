/**
 * src/tui/backend —— **UI 与引擎之间唯一的接缝**(SDD §3.1)。零运行时代码,只有 type。
 *
 * ## 为什么是一个 type 而不是一个 class
 *
 * 抄 openclaw 最值钱的那块(`tui-backend.ts:177`):UI 只认这一个形状,于是同一套 UI 能在
 * **三种装配**下跑 —— 注入 fixture(测试)、进程内嵌(生产默认)、远程 daemon(后续)。
 * 一旦这里出现运行时代码,三种装配就会开始各自长分支。
 *
 * ## ⚠ 这个文件曾经被切错过一次(2026-08-07,SDD §10 更正 ①)
 *
 * 初稿把它排在 S1、**先于任何消费者**进仓 —— `reachability.test.ts` 的「没有孤儿」当场红了。
 * 那条闸的正确读法是:一个没有消费者的纯 type 文件,就是「在一个从没打开过的开关上盖东西」
 * 的缩小版。**所以它现在和第一个消费者(`tui.ts`)同一片进仓。**
 * 加新字段时同理:**没有消费者的字段别先加**,那是本仓 S-1 静默失效的原型。
 *
 * ## 事件词表钉死 5 种
 *
 * `chat` / `tool` / `dag` / `run` / `session`。超出这 5 种的一律不加 ——
 * 加之前先回答「为什么它不能是这 5 种之一的 payload」。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * 事件信封。`seq` **单调递增**,免费换来掉包检测 + 自动对账
 * (openclaw `tui-backend.ts:63` 同款)—— 远程装配下这是唯一能发现"少收了一帧"的办法,
 * 而进程内嵌装配照样发它,好让两种装配的 UI 代码一个字都不用分叉。
 */
export interface OmdTuiEvent {
  event: 'chat' | 'tool' | 'dag' | 'run' | 'session';
  payload?: unknown;
  seq: number;
}

/** 会话列表项(侧栏/切换用的最小面)。 */
export interface TuiSessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** fork 来源会话 id(切片⑦ 会话树)。缺席 = 根会话。 */
  parent?: string;
}

/**
 * UI 能对引擎做的全部事情。
 *
 * ⚠ **可选字段 = 能力探测面**:用 `backend.listRuns ?` 判断,**不要**再加一个
 * `capabilities` 标志位 —— 两处声明同一件事必漂(本仓 D-2 刚为此付过账)。
 */
export interface OmdBackend {
  /** 连接标识(进程内嵌装配也要有,UI 的 header 一视同仁地显示它)。 */
  readonly connection: { url: string };

  // ── 推送 (后端 → UI):可选回调字段,不是 EventEmitter ──
  // 刻意不用 EventEmitter: 那会把"谁在监听"变成运行时状态, 而这里要的是一个**可静态检查
  // 的形状**。fixture 装配下这几个字段就是测试的观测口。
  onEvent?: (e: OmdTuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  /** `seq` 不连续时报告 —— 收到即说明丢帧,UI 该重拉而不是接着画。 */
  onGap?: (info: { expected: number; received: number }) => void;

  // ── 生命周期 ──
  start(): void;
  stop(): void | Promise<void>;

  // ── 请求 (UI → 后端) ──
  sendChat(o: { sessionId: string; prompt: string }): Promise<{ ok: boolean; runId?: string }>;
  abortChat(o: { sessionId: string }): Promise<{ ok: boolean; aborted: boolean }>;
  loadHistory(o: { sessionId: string }): Promise<AgentMessage[]>;
  listSessions(): Promise<TuiSessionMeta[]>;
  /** 压缩当前会话上下文(真 model call,副作用)。`null` = 无可压缩(空会话/已在尾部)。 */
  compact(o: { sessionId: string }): Promise<{
    tokensBefore: number;
    tokensAfter: number;
    messageCount: number;
  } | null>;

  // ── 可选能力 (S14):**用 `backend.listRuns ?` 探测,不加 capabilities 标志位** ──
  // 两处声明同一件事必漂 (本仓 D-2 刚为此付过账)。fixture 后端不实现这两个 →
  // UI 那边键**不出现**, 而不是出现一个点了没反应的入口。
  /** 列出 run(内存注册表 + 磁盘 checkpoint 合并)。 */
  listRuns?(): Promise<string>;
  /** 续跑一个断掉的 run —— 从磁盘 checkpoint 重载 plan,跳过已绿节点。 */
  resumeRun?(o: { runId: string }): Promise<{ ok: boolean; text: string }>;
  /** fork 一条会话分支(切片⑦)。`ok:false` 带原因(源不存在 / id 冲突)。 */
  forkSession?(o: { fromId: string; newId: string }): Promise<{ ok: boolean; text: string }>;
  /** 会话**树**(台账 §1.3 / C11)。整棵树,不只当前分支 —— 只给当前分支就画不出分叉。 */
  sessionTree?(o: { sessionId: string }): Promise<{ leafId: string | null; entries: TuiTreeEntry[] }>;
  /**
   * 导航到树上某个条目:被放弃的那条分支先摘要成一条 `[branch summary]` 节点,再切过去。
   *
   * `summarized:false` 与 `ok:false` **不是一回事**:前者 = 切成了但没有可摘要的东西
   * (纯往前导航),后者 = 没切(摘要失败 / 条目不存在)。压成一个布尔就再也分不开。
   */
  branchTo?(o: { sessionId: string; entryId: string }): Promise<{ ok: boolean; text: string; summarized: boolean }>;
  /** 跨会话全文搜索(只读)。命中带会话 id + 片段;无命中 = 空表,不是错误。 */
  searchSessions?(o: { text: string }): Promise<{ hits: { sessionId: string; entryId: string; snippet?: string }[] }>;
}

/**
 * 会话树里的一条(UI 要的最小面)。
 *
 * ⚠ 刻意**不透传 pi 的 `Entry`**:UI 只需要"挂在谁下面 + 是什么 + 长什么样",
 * 而 `Entry` 带着整条消息与 usage。透传等于让 UI 层认识 pi 的条目词表,
 * 那是 `OmdBackend` 这个接缝存在的理由的反面。
 */
export interface TuiTreeEntry {
  id: string;
  /** `null` = 根。树的边就是这一格。 */
  parentId: string | null;
  /** pi 的 append 序号 —— 同层排序靠它(时间戳同毫秒会打平)。 */
  seq: number;
  /** `message/user` · `message/assistant` · `compaction` · `branch_summary` … */
  kind: string;
  /** 一行预览(已截断)。空串 = 这条投影不出文字,不是"没读到"。 */
  preview: string;
  /** user 消息的逐字全文(回退预填用)。只有 `message/user` 且有文字时才带 —— 预览是给看的, 这份是给填回去的。 */
  text?: string;
}
