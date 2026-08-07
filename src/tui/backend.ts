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

  // ── 可选能力 (S14):**用 `backend.listRuns ?` 探测,不加 capabilities 标志位** ──
  // 两处声明同一件事必漂 (本仓 D-2 刚为此付过账)。fixture 后端不实现这两个 →
  // UI 那边键**不出现**, 而不是出现一个点了没反应的入口。
  /** 列出 run(内存注册表 + 磁盘 checkpoint 合并)。 */
  listRuns?(): Promise<string>;
  /** 续跑一个断掉的 run —— 从磁盘 checkpoint 重载 plan,跳过已绿节点。 */
  resumeRun?(o: { runId: string }): Promise<{ ok: boolean; text: string }>;
}
