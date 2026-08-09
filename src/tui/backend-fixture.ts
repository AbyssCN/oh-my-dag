/**
 * src/tui/backend-fixture —— **L3 专用的假后端**(TUI SDD §9 第三层,切片 S10)。
 *
 * ## 它取代了 `backend-stub.ts`,但**不是同一件事**
 *
 * `backend-stub` 是断链说明卡:引擎还没接通时的**生产**默认值,零假数据。
 * S10 接通之后它该死 —— 留着当 fallback 会让"引擎挂了"静默退化成"看起来在用"。
 *
 * 这个文件相反:它**只在 `OMD_TUI_BACKEND=fixture` 时被装**,存在的唯一理由是
 * SDD §9 那条「L3 = fixture backend + 真 PTY」—— PTY lane 要证明 UI 循环、渲染、
 * 按键、流式装配是通的,而**不能**因此去打真模型(要钱、要网、读数还不稳定)。
 *
 * ## 它凭什么不算"假数据"
 *
 * 因为它**自报家门**:`connection.url === 'fixture://l3-test'`,而那串字符会画在 footer 上。
 * 判据不是"有没有编内容",是"读的人会不会误以为这是真的"。生产路径上它装不进来
 * (env 没设就走 embedded),PTY 上它写在屏幕正中间。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AnyOmdTool } from '../harness/agent-tools';
import type { ApprovalGate } from './approval/gate';
import type { OmdBackend, OmdTuiEvent, TuiSessionMeta } from './backend';

/** footer 上会显示这一串。PTY 断言它 —— 生产里出现即说明装错了后端。 */
export const FIXTURE_URL = 'fixture://l3-test';

/** 固定回复分两片发 —— 流式装配的判据要的就是"分批到达仍恰好出现一次"。 */
export const FIXTURE_CHUNKS = ['Got it.', 'This is the fixture backend, nothing was sent to any model.'] as const;

/** fixture 的 run id —— PTY 断言它出现在 HUD 顶行。 */
export const FIXTURE_RUN_ID = 'fixture-run';

/** 触发审批演示的暗号(切片① L3)。PTY 打这一句 → 真 gate 弹真卡片 → 真写/真拒。 */
export const FIXTURE_WRITE_PROMPT = 'fixture:write';
/** 触发 fan-out 图演示的暗号(切片③ L3)。发一个带 map 分裂的 run —— 左栏树要画得出 ├─ └─。 */
export const FIXTURE_DAG_PROMPT = 'fixture:dag';
/** 触发重复读演示的暗号(切片⑤ L3)。同一文件 read 三次 → 健康度一行要亮。 */
export const FIXTURE_READS_PROMPT = 'fixture:reads';
/** fan-out 演示 run 的 id。 */
export const FIXTURE_DAG_RUN_ID = 'fixture-fanout';
/** 审批演示写的文件名(目录由 `OMD_TUI_FIXTURE_DIR` 给;没给就不真写,只报没处写)。 */
export const FIXTURE_WRITE_FILE = 'approved.txt';

export interface FixtureBackendDeps {
  /**
   * 审批闸(切片①)。给了 → `fixture:write` 那条暗号会经它调一个真会写盘的假 write 工具:
   * 卡片、键位、拒绝则不改、批准则改,整条链与生产同一个 gate。
   * 不给 → 暗号退化成普通回显(能力探测面:没有闸就没有这条演示)。
   */
  approvals?: ApprovalGate;
  /**
   * 调用账本(切片②)。给了 → 每轮 sendChat 记一笔**固定读数**的假用量
   * (model=`fixture:model`),好让 PTY 能对底栏行①②断言真数字。
   * 它走与生产同一条 `record → 写盘 → window()` 链,假的只有数字本身。
   */
  usage?: import('./usage/ledger').TuiUsageLedger;
}

/** fixture 每轮记的固定用量 —— PTY 的行②断言就对着这三个数。 */
export const FIXTURE_USAGE = { in: 3120, out: 184, cacheHit: 2760 } as const;

/**
 * 写死的上下文压力 —— 让底栏 `ctx N%` 可断言(PTY 的 `SB-5`)。
 * 12,000 / 200,000 = **6%**;窗口非 0 ⇒ `ratio` 非 null(窗口未知那一档另有单测)。
 */
export const FIXTURE_PRESSURE = {
  systemTokens: 8000,
  harnessTokens: 2000,
  historyTokens: 4000,
  usedTokens: 12_000,
  windowTokens: 200_000,
  ratio: 12_000 / 200_000,
} as const;

export function createFixtureBackend(deps: FixtureBackendDeps = {}): OmdBackend {
  let seq = 0;
  let onEvent: ((e: OmdTuiEvent) => void) | undefined;
  const sessions = new Map<string, AgentMessage[]>();
  /** 切片⑦: fork 的 lineage(内存版 parent 边)。 */
  const parents = new Map<string, string>();

  const emit = (event: OmdTuiEvent['event'], payload: unknown): void => {
    seq += 1;
    onEvent?.({ event, payload, seq });
  };

  /**
   * 审批演示用的假 write:名字叫 `write` 是刻意的 —— gate 的分类按名字走,
   * 名字不同的话 PTY 验的就不是生产那条 `write → 审批` 的分类路径。
   */
  const fixtureWrite: AnyOmdTool = {
    name: 'write',
    label: 'write',
    description: 'fixture write (approval demo)',
    parameters: undefined as never,
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const p = params as { path: string; content: string };
      const dir = process.env.OMD_TUI_FIXTURE_DIR;
      if (!dir) return { content: [{ type: 'text', text: '(OMD_TUI_FIXTURE_DIR is not set, nowhere to write)' }], details: undefined };
      writeFileSync(join(dir, p.path), p.content);
      return { content: [{ type: 'text', text: `✓ wrote ${p.path}` }], details: undefined };
    },
  } as AnyOmdTool;
  const wrappedWrite = deps.approvals ? deps.approvals.wrap([fixtureWrite])[0] : undefined;

  return {
    connection: { url: FIXTURE_URL },
    set onEvent(fn: ((e: OmdTuiEvent) => void) | undefined) {
      onEvent = fn;
    },
    get onEvent() {
      return onEvent;
    },
    start() {},
    stop() {},
    async sendChat({ sessionId, prompt }) {
      const msgs = sessions.get(sessionId) ?? [];
      msgs.push({ role: 'user', content: prompt, timestamp: Date.now() } as AgentMessage);
      // ── 切片① 审批演示: 真 gate → 真卡片 → 真写/真拒。放在流式回显之前, 先审后答。 ──
      if (prompt.trim() === FIXTURE_WRITE_PROMPT && wrappedWrite) {
        emit('tool', { phase: 'start', name: 'write', args: { path: FIXTURE_WRITE_FILE } });
        try {
          const r = await wrappedWrite.execute('fx-approval', { path: FIXTURE_WRITE_FILE, content: 'approved\n' }, undefined, undefined as never);
          emit('tool', { phase: 'end', name: 'write', ok: true });
          const text = (r.content ?? []).map((c) => ('text' in c ? c.text : '')).join('');
          emit('chat', { type: 'delta', text: `write executed: ${text}` });
        } catch (err) {
          emit('tool', { phase: 'end', name: 'write', ok: false });
          emit('chat', { type: 'delta', text: `write not executed: ${(err as Error).message}` });
        }
        /**
         * ★ **fixture 也发 `pressure`**(2026-08-09)。
         *
         * 之前只发 `messageCount` ⇒ 底栏那个 `ctx N%` 段**端到端一条闸都没有**:
         * L3 lane 永远看不到它, 真机上它只在"live 采帧且这一轮刚好在 grab 前定稿"时才出现
         * (本程就撞上过:两张 live 帧都在定稿前, 于是 ctx 缺席, 而我一时分不清是时序还是改坏了)。
         * ⇒ 给一组**写死的**读数, 让 `ctx` 变成可断言的东西。`ratio` 由 used/window 算,
         * 与生产同一条公式(`analyzeContextPressure`), 不在这里另编一个百分比。
         */
        emit('session', { sessionId, messageCount: msgs.length + 1, pressure: FIXTURE_PRESSURE });
        sessions.set(sessionId, msgs);
        return { ok: true };
      }
      // ── 切片③: fan-out 图演示。形状与引擎 DagNodeEvent 逐字一致 (planned 无 deps,
      //    expanded 带 parent+deps —— 不一致的话 PTY 绿而生产红)。
      if (prompt.trim() === FIXTURE_DAG_PROMPT) {
        const push = (node: unknown) => emit('dag', { runId: FIXTURE_DAG_RUN_ID, node });
        push({ type: 'planned', nodes: [{ id: 'plan', kind: 'conductor' }, { id: 'extract', kind: 'map' }, { id: 'merge', kind: 'map' }] });
        push({ type: 'start', id: 'plan', kind: 'conductor' });
        push({ type: 'settle', id: 'plan', status: 'done', kind: 'conductor', model: 'fixture-model' });
        push({ type: 'expanded', parent: 'extract', nodes: [
          { id: 'shard-1', kind: 'agent', deps: [] },
          { id: 'shard-2', kind: 'agent', deps: [] },
          { id: 'shard-3', kind: 'agent', deps: ['shard-1', 'shard-2'] },
        ] });
        push({ type: 'start', id: 'shard-1', kind: 'agent' });
        push({ type: 'settle', id: 'shard-1', status: 'done', kind: 'agent', model: 'fixture-model' });
        push({ type: 'start', id: 'shard-2', kind: 'agent' });
        push({ type: 'settle', id: 'shard-2', status: 'failed', kind: 'agent', model: 'fixture-model' });
        push({ type: 'start', id: 'shard-3', kind: 'agent' });
        emit('chat', { type: 'delta', text: 'fan-out demo graph sent.' });
        emit('session', { sessionId, messageCount: msgs.length + 1, pressure: FIXTURE_PRESSURE });
        sessions.set(sessionId, msgs);
        return { ok: true };
      }
      // ── 切片⑤: 重复读演示 —— 同一文件 read 三次, 健康度一行该亮。
      if (prompt.trim() === FIXTURE_READS_PROMPT) {
        for (let i = 0; i < 3; i++) {
          emit('tool', { phase: 'start', name: 'read', id: `fx-read-${i}`, args: { path: 'src/repeat.ts' } });
          emit('tool', { phase: 'end', name: 'read', id: `fx-read-${i}`, ok: true });
        }
        emit('chat', { type: 'delta', text: 'Read the same file three times.' });
        emit('session', { sessionId, messageCount: msgs.length + 1, pressure: FIXTURE_PRESSURE });
        sessions.set(sessionId, msgs);
        return { ok: true };
      }
      // 工具事件也发一对: PTY 要能验"工具在跑"这条线也接得上。
      emit('tool', { phase: 'start', name: 'fixture_tool' });
      emit('tool', { phase: 'end', name: 'fixture_tool', ok: true });
      // DAG 节点事件 (S11): 让 L3 能验 HUD 逐节点变。形状与引擎的 `DagNodeEvent` 逐字一致 ——
      // 不一致的话 PTY 绿而生产红, 那正是 fixture 最容易变成假闸的地方。
      const push = (node: unknown) => emit('dag', { runId: FIXTURE_RUN_ID, node });
      push({ type: 'planned', nodes: [{ id: 'fx-leaf', kind: 'agent' }, { id: 'fx-judge', kind: 'judge' }] });
      push({ type: 'start', id: 'fx-leaf', kind: 'agent' });
      push({ type: 'settle', id: 'fx-leaf', status: 'done', kind: 'agent', model: 'fixture-model' });
      for (const text of FIXTURE_CHUNKS) emit('chat', { type: 'delta', text });
      // 切片②: 上账本 (固定读数), 让 session 事件之后底栏行①②有真数可画。
      deps.usage?.record(FIXTURE_USAGE, 'fixture:model', 'chat');
      emit('session', { sessionId, messageCount: msgs.length + 1, pressure: FIXTURE_PRESSURE });
      sessions.set(sessionId, msgs);
      return { ok: true };
    },
    async abortChat() {
      return { ok: true, aborted: false };
    },
    async loadHistory({ sessionId }): Promise<AgentMessage[]> {
      return sessions.get(sessionId) ?? [];
    },
    async listSessions(): Promise<TuiSessionMeta[]> {
      return [...sessions.keys()].map((id) => ({ id, title: id, updatedAt: 0, ...(parents.has(id) ? { parent: parents.get(id) as string } : {}) }));
    },

    // 切片⑦: 内存版 fork —— 语义与 embedded 一致 (拷贝消息, 记 parent, 互不污染)。
    async forkSession({ fromId, newId }): Promise<{ ok: boolean; text: string }> {
      const src = sessions.get(fromId);
      if (!src) return { ok: false, text: `fork failed: session ${fromId} does not exist (a session never written has nothing to fork)` };
      if (sessions.has(newId)) return { ok: false, text: `fork failed: session ${newId} already exists` };
      sessions.set(newId, structuredClone(src));
      parents.set(newId, fromId);
      return { ok: true, text: `forked ${newId} from ${fromId} (${src.length} messages)` };
    },
  };
}
