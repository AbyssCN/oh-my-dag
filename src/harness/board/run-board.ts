/**
 * src/harness/board/run-board —— DAG 运行公告板(<root>/.omd/run-board.jsonl 追加写者)。
 *
 * 为什么需要它: 执行段(claimed/published)与终态(terminal)的事实要**跨进程、跨会话**留痕,
 * 且只许追加、不许覆写 —— 谁先写完谁说了算, 后写者不得抹掉先写者的证据。
 *
 * ## 介质与原子性
 * - 介质 = `<root>/.omd/run-board.jsonl`, 一行一条 `BoardEntry` 的 JSON。
 * - 追加用 **O_APPEND + 单次 writeSync**: 内核保证整行落在文件尾, 多进程并发追加不互相撕行。
 * - 单行 ≤1KB(超出部分裁剪, 见 `serializeEntry`);`note` 超 500B 截断。
 *
 * ## compact(追加后顺手, >1MB 强制)
 * - 只删**已超保留期**的终态 run 的全部条目(含 terminal 行本身): 保留期默认 24h,
 *   自 terminal 条目 ts 起算; 保留期内(刚写 terminal/published)的条目是 await 谓词的
 *   满足/中止信号(G-2/G-3), 删了下一拍 poll 什么都看不见 → 保留期内不删(D-5 竞态教训)。
 * - 超 1MB 强制 compact; 删超期条目后仍超 → 保留期**对半**再扫, 直到 ≤1MB 或已无终态 run。
 * - 活条目 INV-2 禁删(丢弃活条目属违约); 丢弃终态条目必留证据 note; 超限不可解也留证据
 *   note(fail-open: 不吞证据, 也不假装压缩成功)。
 *
 * ## 容错
 * - `readBoard` 容忍坏行: 跳过 + 返回一条含坏行内容片段的 `note` 证据行。
 * - compact 全程 best-effort: 追加成功即返回, compact 失败不阻断调用方。
 * - 零 LLM、零 daemon(INV-6): 本模块纯文件 IO, 无后台进程、无模型调用。
 *
 * @module
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FAILURE_KIND_ORDER } from '../node-failure';


// ─── 冻结接口 ────────────────────────────────────────────────────────────────

/**
 * `awaiting` (#205, 2026-08-19): **谁在等哪份产物**。
 *
 * 此前板上没有这一格 —— `await-node` 只读板从不写, 于是「有个节点正卡在等」这件事根本没被记
 * 下来, #96 的观察面也就画不出它。**不许从别的事实推它**(比如"某 artifact 至今没 published
 * 就算有人在等"): 那是把「没人在等」与「等这件事没被记」压成一行, 本仓坑① (NULL≠0)。
 *
 * 收尾不另设事件: 等到了走 `published` (谓词匹配), 等不到走 `terminal` —— 与 `liveRuns`
 * (claimed 减 terminal) 同款判法, 见 {@link awaitingRuns}。
 */
export type BoardEvent = 'claimed' | 'published' | 'terminal' | 'note' | 'verified' | 'intervened' | 'awaiting';

export interface BoardEntry {
  v: 1;
  ts: string;
  runId: string;
  event: BoardEvent;
  writeSet?: string[];
  artifact?: string;
  commit?: string;
  outcome?: string;
  note?: string;
  /** verified 专用: verifier/冻结判据的结论。 */
  verdict?: 'pass' | 'fail';
  /** intervened 专用: 人为什么不得不伸手 —— 值域 = NodeFailureKind (node-failure 词表复用, #160 判据①)。 */
  cause?: string;
  /** awaiting 专用 (#205): 这一等最多等多久 (ms) —— 观察面据它算"逼近超时", 不硬编阈值。 */
  timeoutMs?: number;
  /** awaiting 专用 (#205): 限定的前置 run id; 缺席 = 任意 run 的 published 都算数 (同 AwaitSpec)。 */
  fromRun?: string;
}


// ─── constants ───────────────────────────────────────────────────────────────

const EVENTS: ReadonlySet<string> = new Set(['claimed', 'published', 'terminal', 'note', 'verified', 'intervened', 'awaiting']);

/** intervened 专用 cause 合法值域 = node-failure 词表全集(fail-loud 校验复用)。 */
const FAILURE_KINDS: ReadonlySet<string> = new Set(FAILURE_KIND_ORDER);

/** 证据 note 专用 runId(不指向任何真实 run, 不进 liveRuns 判定)。 */
export const BOARD_RUN_ID = '__board__';

/** 板文件上限: 超此强制 compact。 */
const MAX_BOARD_BYTES = 1024 * 1024;
/** 终态保留期: 默认 24h, 自 terminal 条目 ts 起算; 保留期内不删(await 谓词的满足/中止信号)。 */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 保留期对半下限: 低于此不再对半 —— 对半到亚秒会误删"刚写入"的终态条目(违约)。 */
const MIN_RETENTION_MS = 1000;

/** 单行上限: O_APPEND 单次写, 行必须 ≤1KB。 */
const MAX_LINE_BYTES = 1024;
/** `note` 字段截断上限(字节)。 */
const MAX_NOTE_BYTES = 500;

const OVERFLOW_NOTE_PREFIX = 'run-board > 1MB after compact: ';
const DISCARD_NOTE_PREFIX = 'run-board compact dropped: ';

const BAD_LINE_NOTE_PREFIX = 'run-board bad line skipped: ';
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1000;

// ─── 内部工具 ────────────────────────────────────────────────────────────────

function boardPath(root: string): string {
  return resolve(root, join('.omd', 'run-board.jsonl'));
}

/** 按**字节**截断, 不劈开多字节 UTF-8 字符。 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/**
 * entry → 单行 JSON(≤1KB)。
 * 裁剪顺序: ① note 截到 500B(契约条款) ② writeSet 从尾部裁(唯一无界字段)
 * ③ artifact/commit/outcome 各截到 100B(最后防线)。**不修改调用方传入的对象**。
 */
function serializeEntry(e: BoardEntry): string {
  const line: BoardEntry = { ...e, v: 1 };
  if (typeof line.note === 'string') line.note = truncateUtf8(line.note, MAX_NOTE_BYTES);
  let s = JSON.stringify(line);
  if (Array.isArray(line.writeSet)) {
    while (Buffer.byteLength(s, 'utf8') > MAX_LINE_BYTES && line.writeSet.length > 0) {
      line.writeSet = line.writeSet.slice(0, -1);
      s = JSON.stringify(line);
    }
  }
  for (const k of ['artifact', 'commit', 'outcome'] as const) {
    if (Buffer.byteLength(s, 'utf8') <= MAX_LINE_BYTES) break;
    if (typeof line[k] === 'string' && Buffer.byteLength(line[k], 'utf8') > 100) {
      line[k] = truncateUtf8(line[k], 100);
      s = JSON.stringify(line);
    }
  }
  return s;
}

/** O_APPEND + 单次 write: 整行原子落到文件尾。 */
function appendRaw(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, Buffer.from(`${line}\n`, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

/** 坏行(不可解析 / 形状不对)→ null。 */
function parseLine(line: string): BoardEntry | null {
  try {
    const j: unknown = JSON.parse(line);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    if (o.v !== 1 || typeof o.ts !== 'string' || typeof o.runId !== 'string') return null;
    if (typeof o.event !== 'string' || !EVENTS.has(o.event)) return null;
    if (o.writeSet !== undefined && (!Array.isArray(o.writeSet) || o.writeSet.some((w) => typeof w !== 'string'))) {
      return null;
    }
    return o as unknown as BoardEntry;
  } catch {
    return null;
  }
}

/** 独占锁(O_EXCL), 护住 compact 的重写与并发追加不互撕; 拿不到锁 → null(跳过 compact)。 */
function withLock<T>(lockPath: string, fn: () => T): T | null {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, Buffer.from(`${process.pid}\n`));
      closeSync(fd);
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 锁已不在 → 忽略 */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (Date.now() >= deadline) return null;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * compact 本体(best-effort, 不抛):
 * ① 只删**已超保留期**(默认 24h, 自 terminal 条目 ts 起算)的终态 run 的全部条目;
 *    保留期内的终态 run 条目(刚写 terminal/published)是 await 谓词的满足/中止信号(G-2/G-3),
 *    删了下一拍 poll 什么都看不见 → 保留期内不删。
 * ② 删后仍 >1MB → 保留期**对半**再扫, 直到 ≤1MB 或已无终态 run; 活条目 INV-2 禁删。
 * ③ 丢弃终态条目必留证据行('run-board compact dropped'); 对半到下限仍超 →
 *    留超限证据 note(fail-open: 不吞证据, 也不假装压缩成功)。
 */
function compactBoard(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // 读不到 → 不动
  }
  const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return;

  const parsed = rawLines.map(parseLine);

  // 每个终态 run 的 terminal 时刻(同一 run 多条 terminal → 取最新): 保留期自它起算。
  const terminalAt = new Map<string, number>();
  for (const p of parsed) {
    if (p && p.event === 'terminal') {
      const t = Date.parse(p.ts);
      if (Number.isFinite(t)) {
        const prev = terminalAt.get(p.runId);
        if (prev === undefined || t > prev) terminalAt.set(p.runId, t);
      }
    }
  }

  const now = Date.now();
  let retention = DEFAULT_RETENTION_MS;
  // 行与解析结果配对, 过滤时保持对齐(坏行 → null, 原样保留)。
  let rows: Array<{ line: string; p: BoardEntry | null }> = rawLines.map((line, i) => ({ line, p: parsed[i]! }));
  let droppedRuns = 0;

  for (;;) {
    const stale = new Set<string>();
    for (const [runId, ts] of terminalAt) {
      if (now - ts > retention) stale.add(runId); // age > retention 才算超期(等号不算, G-5 证伪锚点)
    }
    if (stale.size > 0) {
      const next: typeof rows = [];
      for (const r of rows) {
        if (r.p && stale.has(r.p.runId)) continue; // 超保留期终态 run 的全部条目删(含 terminal 行本身)
        next.push(r);
      }
      droppedRuns += stale.size;
      rows = next;
      for (const id of stale) terminalAt.delete(id);
    }
    const bytes = rows.reduce((n, r) => n + Buffer.byteLength(r.line, 'utf8') + 1, 0);
    if (bytes <= MAX_BOARD_BYTES) break;
    if (terminalAt.size === 0) break; // 已无终态 run 可删 → 活条目 INV-2 禁删, 走下面超限 note
    if (retention <= MIN_RETENTION_MS) break; // 对半到下限仍超 → fail-open, 不删"刚写入"的终态条目
    retention = Math.floor(retention / 2); // 仍超 1MB → 保留期对半, 再扫
  }

  if (droppedRuns > 0) {
    writeFileSync(path, rows.map((r) => r.line).join('\n') + '\n', 'utf8');
    // 丢弃必留证据行(fail-open 不吞证据); 已有同前缀 note 不再补(防刷屏)。
    const alreadyNoted = rows.some(
      (r) => r.p !== null && r.p.runId === BOARD_RUN_ID && (r.p.note ?? '').startsWith(DISCARD_NOTE_PREFIX),
    );
    if (!alreadyNoted) {
      appendRaw(
        path,
        JSON.stringify({
          v: 1,
          ts: new Date().toISOString(),
          runId: BOARD_RUN_ID,
          event: 'note',
          note: `${DISCARD_NOTE_PREFIX}${droppedRuns} terminal runs past ${retention}ms retention`,
        }),
      );
    }
  }

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size > MAX_BOARD_BYTES) {
    const liveCount = rows.filter((r) => r.p !== null && !terminalAt.has(r.p.runId)).length;
    // 判重扫**全板**(不能只看末行: 每次 append 后末行是刚追加的新条目, 只查末行会让
    // 每次追加都补一条超限 note → 刷屏)。已有超限 note 就不再补。
    const alreadyNoted = rows.some(
      (r) => r.p !== null && r.p.runId === BOARD_RUN_ID && (r.p.note ?? '').startsWith(OVERFLOW_NOTE_PREFIX),
    );
    if (!alreadyNoted) {
      appendRaw(
        path,
        JSON.stringify({
          v: 1,
          ts: new Date().toISOString(),
          runId: BOARD_RUN_ID,
          event: 'note',
          note: `${OVERFLOW_NOTE_PREFIX}kept ${liveCount} live entries; INV-2 forbids dropping live entries`,
        }),
      );
    }
  }
}

// ─── 冻结接口实现 ────────────────────────────────────────────────────────────

/** D-2: verified / intervened 在写盘前 fail-loud 校验 —— 非法 verdict/cause 不写盘。 */
function validateEntry(e: BoardEntry): void {
  if (e.event === 'verified') {
    if (e.verdict !== 'pass' && e.verdict !== 'fail') {
      throw new Error(
        `run-board appendBoard: verified event requires verdict in {"pass","fail"}, got ${JSON.stringify(e.verdict)}`,
      );
    }
  } else if (e.event === 'intervened') {
    if (typeof e.cause !== 'string' || !FAILURE_KINDS.has(e.cause)) {
      throw new Error(
        `run-board appendBoard: intervened event requires cause in FAILURE_KIND_ORDER (${FAILURE_KIND_ORDER.join('|')}), got ${JSON.stringify(e.cause)}`,
      );
    }
  }
}

/** 追加一条 entry(O_APPEND 单次写, 原子); 追加后顺手 compact。追加失败抛(调用方决定怎么报)。 */
export function appendBoard(root: string, e: BoardEntry): void {
  validateEntry(e);
  const path = boardPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendRaw(path, serializeEntry(e));
  // compact 是 best-effort: 追加已成功, compact 失败不阻断调用方。
  withLock(`${path}.lock`, () => compactBoard(path));
}

/** 读全板: 坏行跳过 + 留一行含坏行内容片段的 note 证据(不吞证据)。文件不存在 → 空板。 */
export function readBoard(root: string): BoardEntry[] {
  let raw: string;
  try {
    raw = readFileSync(boardPath(root), 'utf8');
  } catch {
    return []; // 板不存在/读不到 → 空板(没有坏行可留证据)
  }
  const out: BoardEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = parseLine(t);
    if (p) {
      out.push(p);
      continue;
    }
    out.push({
      v: 1,
      ts: new Date().toISOString(),
      runId: BOARD_RUN_ID,
      event: 'note',
      note: `${BAD_LINE_NOTE_PREFIX}${truncateUtf8(t, 120)}`,
    });
  }
  return out;
}

/**
 * **板上还活着的 runId** —— 活判据的**唯一真源**(2026-08-26 从两处合并而来)。
 *
 * 判据 = 该 run 最后一次 `claimed` 排在最后一次 `terminal` **之后**。
 *
 * ## 为什么不是「有 terminal 就算死」(旧判法)
 *
 * 旧判法两处各写一份 `new Set(…filter(event==='terminal')…)`,**顺序盲**。
 * 于是 `claimed → terminal → claimed`(= 一次 resume 续跑)被判成"不活" ——
 * 一个**正在跑**的 run 在板上隐形,而板存在的全部理由就是让并发 run 看见彼此。
 *
 * 这个方向比反向更危险:反向(死 run 判成活)只是噪声,人看得见;
 * 正向(活 run 判成死)是**静默漏报**,撞车发生时板上什么都没有。
 * 2026-08-26 实测确认: 当时正在跑的 `6f97a21e`(第一轮 terminal 后 resume)恰好落在这个洞里。
 *
 * ## 为什么按下标不按时间戳
 *
 * 板是 append-only,文件顺序即事件顺序;而 `ts` 是 ISO 毫秒,同毫秒内两条事件排不出先后。
 * 下标没有这个问题,也不依赖写入方的时钟。
 *
 * ⚠ 顺序前提:调用方必须传**读回来的原始顺序**(`readBoard` 即是)。排过序的数组会读出错的答案。
 */
export function liveRunIds(entries: readonly BoardEntry[]): Set<string> {
  const lastClaim = new Map<string, number>();
  const lastTerminal = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.event === 'claimed') lastClaim.set(e.runId, i);
    else if (e.event === 'terminal') lastTerminal.set(e.runId, i);
  });
  const live = new Set<string>();
  for (const [id, claimAt] of lastClaim) {
    if (claimAt > (lastTerminal.get(id) ?? -1)) live.add(id);
  }
  return live;
}

/**
 * D-9: 还活着的 runId → writeSet 映射。活判据经 {@link liveRunIds}(单一真源)。
 * 同一 run 多次 claimed → 最后一次的 writeSet 胜出(后写者覆盖先写者)。
 *
 * ⚠ 这里的 `?? []` 把「未声明」压成「空集」——**上层若要三态, 别用这个函数**,
 * 读原始 entry(dag-run-board.ts 的 `otherLiveRuns` 就是为此存在的)。
 */
export function liveRuns(entries: BoardEntry[]): Map<string, string[]> {
  const live = liveRunIds(entries);
  const out = new Map<string, string[]>();
  for (const e of entries) {
    if (e.event !== 'claimed' || !live.has(e.runId)) continue;
    out.set(e.runId, e.writeSet ?? []);
  }
  return out;
}

/** 一条**未收尾**的等待 (#205)。 */
export interface AwaitingEntry {
  runId: string;
  artifact: string;
  /** 开始等的时刻 (ISO, 取该 run+artifact 最后一次 awaiting)。 */
  since: string;
  /** 这一等最多等多久; 缺席 = 没记 (观察面据此**不画**逼近超时的形变, 不假设一个默认值)。 */
  timeoutMs?: number;
  fromRun?: string;
}

/**
 * **谁还在等** (#205)。判法与 {@link liveRuns} 同款: 有 `awaiting` 且**无对应收尾事件**。
 *
 * 收尾有两条, 都不另设事件 —— 板上已有的事实够用:
 *   · **等到了** —— 出现满足谓词的 `published` (同 artifact; awaiting 若限定了 `fromRun`,
 *     则那条 published 的 runId 也要对上)。⚠ 这里**不复刻 await-node 的写集不相交判据**:
 *     那是"能不能合入"的问题, 而这里答的是"还在不在等"。两者混一起会让一次因写集相交而
 *     继续等的节点从观察面上消失 —— 那正是最该看见它的时候。
 *   · **不等了** —— 等待方自己 `terminal` (超时 STALLED 也走这条)。
 *
 * 同一 run+artifact 多次 awaiting → 取最后一次 (后写者胜, 同 liveRuns 的写集语义)。
 */
export function awaitingRuns(entries: BoardEntry[]): AwaitingEntry[] {
  const terminal = new Set(entries.filter((e) => e.event === 'terminal').map((e) => e.runId));
  const published = entries.filter((e) => e.event === 'published' && e.artifact);
  const open = new Map<string, AwaitingEntry>();
  for (const e of entries) {
    if (e.event !== 'awaiting' || !e.artifact) continue;
    if (terminal.has(e.runId)) continue; // 等待方已终态 = 不等了
    const got = published.some((p) => p.artifact === e.artifact && (!e.fromRun || p.runId === e.fromRun));
    if (got) continue; // 等到了
    open.set(`${e.runId}\x00${e.artifact}`, {
      runId: e.runId,
      artifact: e.artifact,
      since: e.ts,
      ...(typeof e.timeoutMs === 'number' ? { timeoutMs: e.timeoutMs } : {}),
      ...(e.fromRun ? { fromRun: e.fromRun } : {}),
    });
  }
  return [...open.values()];
}
