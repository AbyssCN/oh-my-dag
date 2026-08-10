/**
 * src/harness/dream/gather —— dream SDD §S1 语料采集(零 LLM)。
 *
 * 两路取料:
 * (a) chat 会话: `createOmdSessionStore(cwd).open(id).entries()` —— ⚠ 是 entries(),
 *     不是 messages()(后者是 buildSessionContext 的投影,压缩点前原文会被截掉)。
 * (b) 完结 run: `RunStore.all()` —— 「完结」= 终态(done/failed/cancelled)
 *     ∪ running 且 ownerPid 不存活(漏掉后者 = 5 条真语料永远进不来)。
 *
 * 水位存 dream_watermark 表(同 memory.db):会话按 `session:<id>` 记 lastSeq;
 * run 按 **per-run key** `run:<id>` 记 updatedAt —— 不用单游标(单游标会让
 * 「游标推进时还活着、之后死掉」的 run 永远沉在游标下面,静默丢语料;
 * S1 验收实审对 SDD §S1 原设计的改判,证伪见 gather.test.ts「中断 run 不沉游标」)。
 * 当前会话排除:由调用方传 `isSessionActive`(进程内 SESSIONS 判据),
 * **每次 gather 重判,skip 行不粘死**(否则昨天活跃的会话退役后永远进不了语料)。
 * 跨进程半边靠 session-lock,S1 只覆盖进程内半边。
 *
 * 阈值(全部 tentative,§1.9):
 *   M=20 / W_HOURS=6 / W_SESSIONS=2
 */
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { Entry } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore } from '../chat/session-store';
import { createRunStore, defaultIsAlive, type PersistedRun, type RunStore } from '../../mcp/run-store';
import { createWatermark, type Watermark } from './watermark';

// ---------------------------------------------------------------------------
// 阈值(tentative —— §1.9:拍的,量级不是精确值)
// ---------------------------------------------------------------------------

/** dirty 原始条目数水位(跨 source 合计)。tentative:初值 20(原拟 40,一天 131 条 → 下调)。 */
export const M = 20;
/** 距上次固化的最小间隔(小时)。tentative。 */
export const W_HOURS = 6;
/** 最少新会话数。tentative。 */
export const W_SESSIONS = 2;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface GatherSourceReport {
  type: 'session' | 'run';
  key: string;
  /** clean = 无新增; dirty = 有新增; skipped = 显式排除(当前会话等)。 */
  state: 'clean' | 'dirty' | 'skipped';
  /** 本次新增条目数(state=dirty 时有意义)。 */
  dirtyCount: number;
  /** skip 理由(state=skipped 时有意义)。 */
  reason?: string;
  /**
   * 候选游标(state=dirty 时有值):固化**成功后**由消费方(assembly)以它 setClean 推进。
   * gather 自己不推进游标 —— 采集时推进 = kill 于 extract 中途该批条目永沉
   * (2026-08-10 存量首跑前置缺陷①;正是本文件头「死在游标下面」要防的那族)。
   */
  cursor?: string;
}

export interface GatherReport {
  /** 跨 source 合计的 dirty 条目数。 */
  dirtyTotal: number;
  /** 逐 source 明细。 */
  sources: GatherSourceReport[];
  /** 全 clean(所有 source 都 clean 或 skipped,零 dirty) → true。 */
  skippedClean: boolean;
}

export interface GatherOpts {
  /** 工作目录(仓根)。 */
  cwd: string;
  /** 水位 db(同 memory.db)。省略 = 走 OMD_MEMORY_PATH ?? '.omd/memory.db'。 */
  watermarkDb?: Database;
  /** run 持久器。省略 = 默认 `.omd/runs.db`。 */
  runStore?: RunStore;
  /** pid 存活判据。默认 `process.kill(pid, 0)`。 */
  isAlive?: (pid: number) => boolean;
  /**
   * 进程内活跃会话判据(SESSIONS 表,session-store.ts:98)。
   * 返回 true 的 sessionId 不进语料,水位记 skipped。
   * S1 测试传 lambda;S6 生产接 SESSIONS。
   */
  isSessionActive?: (sessionId: string) => boolean;
}

// ---------------------------------------------------------------------------
// 完结判定
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/** 一条 run 是否「完结」(可采集)。 */
function isRunCompleted(run: PersistedRun, isAlive: (pid: number) => boolean): boolean {
  if (TERMINAL_STATUSES.has(run.status)) return true;
  // running 且 ownerPid 不存活 = 跑到一半被打断
  // ownerPid===null 也判死:无属主=进程已消失
  if (run.status === 'running' && (run.ownerPid === null || !isAlive(run.ownerPid))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// gather
// ---------------------------------------------------------------------------

export async function gather(opts: GatherOpts): Promise<GatherReport> {
  const { cwd } = opts;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const isSessionActive = opts.isSessionActive ?? (() => false);
  const ownDb = !opts.watermarkDb;
  const ownRunStore = !opts.runStore;
  // ⚠ watermark 与 runStore 同一条纪律:锚定到 opts.cwd。默认路径 (OMD_MEMORY_PATH ??
  // '.omd/memory.db') 按**进程 cwd** 解析 —— 跨目录调用会读写错库(2026-08-10 存量首跑
  // 前置缺陷②,S6 验收期间 assembly.test.ts 被迫用 env 防污染真仓 memory.db 即此裂缝)。
  // 与 assembly 的 memory 同库同锚:join(cwd, '.omd', 'memory.db')。
  const wm: Watermark = createWatermark(
    opts.watermarkDb ? { db: opts.watermarkDb } : { path: join(cwd, '.omd', 'memory.db') },
  );
  // ⚠ 锚定到 opts.cwd(与 sessionStore 同基准)。裸相对路径按进程 cwd 解析 ——
  // 测试在临时 cwd 下会静默读到**主仓生产库**(验收实测:空仓测试读出 45 条真 run)。
  const runStore: RunStore = opts.runStore ?? createRunStore({ path: join(cwd, '.omd', 'runs.db') });

  const sources: GatherSourceReport[] = [];
  let dirtyTotal = 0;

  // ── (a) chat 会话 ──
  const sessionStore = createOmdSessionStore(cwd);
  const sessions = await sessionStore.list();

  for (const meta of sessions) {
    const key = `session:${meta.id}`;

    // 当前活跃会话排除(SESSIONS 表判据)—— **瞬态判断,每次 gather 重判**,
    // 不信存量 skip 行:skip 一旦粘死,昨天活跃的会话退役后语料永远进不来。
    if (isSessionActive(meta.id)) {
      wm.skip(key, 'active session (SESSIONS table)');
      sources.push({ type: 'session', key, state: 'skipped', dirtyCount: 0, reason: 'active session (SESSIONS table)' });
      continue;
    }

    const prev = wm.get(key);
    // 曾因活跃被 skip、现已退役 → 视同从未固化(游标从 0 起),走正常采集。
    const lastCursor = prev && !prev.skipped ? prev.lastCursor : '';
    const lastSeq = lastCursor ? Number(lastCursor) : 0;

    // 打开会话读条目
    const sess = await sessionStore.open(meta.id);
    if (!sess) {
      // 会话文件可能已被删 —— 跳过,不记水位
      continue;
    }

    const entries: Entry[] = await sess.entries();

    // 筛选 seq > lastSeq 的新条目
    const newEntries = entries.filter((e) => e.seq > lastSeq);
    const maxSeq = entries.length > 0 ? Math.max(...entries.map((e) => e.seq)) : lastSeq;

    if (newEntries.length > 0) {
      dirtyTotal += newEntries.length;
      // 游标**不推进**(仍写 lastCursor):推进权归固化成功后的消费方 (report.cursor →
      // assembly setClean)。采集即推进 = kill 于 extract 中途该批永沉(缺陷①,判据 3 的靶)。
      wm.setDirty(key, lastCursor, newEntries.length);
      sources.push({ type: 'session', key, state: 'dirty', dirtyCount: newEntries.length, cursor: String(maxSeq) });
    } else {
      // 无新增 → 记 clean(游标可能推进:会话被删条目再重建的边界;
      // prev.skipped = 曾活跃现退役且无条目可采,也要把 skip 行翻成 clean)
      if (maxSeq > lastSeq || !prev || prev.skipped) {
        wm.setClean(key, String(maxSeq));
      }
      sources.push({ type: 'session', key, state: 'clean', dirtyCount: 0 });
    }
  }

  // ── (b) 完结 run(per-run 水位,见文件头:单游标会静默丢「死在游标下面」的 run)──
  for (const run of runStore.all()) {
    const key = `run:${run.runId}`;
    const prev = wm.get(key);
    if (prev && prev.skipped) {
      sources.push({ type: 'run', key, state: 'skipped', dirtyCount: 0, reason: prev.skipReason });
      continue;
    }
    // 还在跑(终态外且属主活着):不记水位不报 source,下次重判 —— 死没死是瞬态,不能写死。
    if (!isRunCompleted(run, isAlive)) continue;
    const lastCursor = prev && !prev.skipped ? prev.lastCursor : '';
    if (run.updatedAt > lastCursor) {
      // 首见完结,或完结后又被更新过(resume 后再完结)→ dirty。游标不推进(同会话侧)。
      dirtyTotal += 1;
      wm.setDirty(key, lastCursor, 1);
      sources.push({ type: 'run', key, state: 'dirty', dirtyCount: 1, cursor: run.updatedAt });
    } else {
      sources.push({ type: 'run', key, state: 'clean', dirtyCount: 0 });
    }
  }

  if (ownDb) wm.close();
  if (ownRunStore) runStore.close();

  return {
    dirtyTotal,
    sources,
    skippedClean: dirtyTotal === 0,
  };
}
