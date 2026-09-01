/**
 * src/harness/goal/ignition-preflight —— 点火预检硬闸 (S2 / INV-5)。
 *
 * 已结晶 SDD 点火 (sddPath 直通) 前查一次板上活 run: 写集相交 + 对方活 → 拒点火。
 * 判据与介质全部来自 S1 的 run-board (readBoard/liveRuns), 本模块只做集合运算, 零 LLM (INV-6)。
 *
 * ## 多路判据
 * ① **闸 A · 目标向量冻结** (t-gate-inmigrate, 2026-09-01): 调用方声明「必须已冻结的文件 + 草案标记串」
 *    (draftMarker),命中 `String.includes(draftMarker)` 即拒点火。错误信息逐字抄 night.sh L42。
 * ② **闸 B · 座位签名** (t-gate-inmigrate, 2026-09-01): 调用方声明 `seatExpectations`,实配逐字匹配 +
 *    `verifySeats` 家族校验(异族终审)。同族 → blocked + message 抄 verify-seats.ts:126 抛出样式。
 * ③ **闸 C · resultOut·sddPath 互斥** (t-gate-inmigrate, 2026-09-01): 同 resultOut / 同 sddPath 并发
 *    点火互斥。复用 `dream/trigger.ts:118` `acquireDreamLock` + `STALE_LOCK_MS = 30*60*1000`
 *    (同仓唯一含陈锁过期判据的范本)。`force=true` 越闸走同一留账范式。
 * ④ **活 run 相交 → blocked** (INV-5 前半): '运行中' = board 的 claimed 且无对应 terminal
 *    条目 (D-9), **不做进程探测** —— 进程探活会误杀刚崩的 run 的写面 (它可能正在被 owner 续跑)。
 * ⑤ **force → 'ok' 但必留账** (INV-5 后半): 越闸不是偷偷的, 板上留一行 note 证据
 *    (runId 用 BOARD_RUN_ID —— 与 S1 的坏行/超限 note 同一个惯用法: note 是板级证据, 不挂 run)。
 *    无冲突时 force 不产生记录 —— 没有闸可越, 就没有越闸这回事。
 * ⑥ **已结晶未点火 SDD 相交 → 只进 advisories** (D-1/D-10): docs/plan/*.md 里已结晶
 *    (契约+分解两段齐、表可解析) 且**未被任何活 run 占用**的 SDD, 其写集与本 run 相交时
 *    只建议合图/协商, 不拒 —— 未点火的 SDD 是投机性存在, 不配占住别人的写面。
 *
 * 闸 A → B → C → ② 写集相交 → ③ 已结晶 advisory 的顺序与 night.sh L28-58 物理行序一致。
 *
 * ## 接口冻结 (S2 契约)
 * - 调用方在点火路径拿到自己的写集 (SDD 分解表各切片写集的并集) 后调本函数;
 * - `opts.force` 是 owner 的显式越闸声明, 不是默认逃生门。
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../logger';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard } from '../board/run-board';
import { loadSddContract, parseBreakdown } from './sdd-direct';
import { renderConfigDump } from '../config-dump';
import { verifySeats } from '../verify-seats';
import { acquireDreamLock, releaseDreamLock, STALE_LOCK_MS } from '../dream/trigger';

// ─── 冻结接口 ────────────────────────────────────────────────────────────────

export interface PreflightReport {
  verdict: 'ok' | 'blocked';
  conflicts: { runId: string; overlap: string[] }[];
  advisories: string[];
  /**
   * 闸 C 本次**真取到**的锁文件路径 (调用方终态后负责 releaseDreamLock 逐一释放 ——
   * 不释放 = 同进程/同 key 的下一次点火撞自己的残锁, 只能等 STALE_LOCK_MS 过期)。
   * 缺 key = 本次没取任何锁 (闸 C 未声明或全被拒)。
   */
  acquiredLocks?: string[];
}

// ─── 内部工具 ────────────────────────────────────────────────────────────────

const FORCE_NOTE_PREFIX = 'ignition-preflight 越闸 (INV-5): force=true — 写集与板上活 run 相交仍点火: ';
/** 闸 C 越闸(force=true 撞活锁) 留账前缀:与 FORCE_NOTE_PREFIX 平行命名空间,便于 grep 区分。 */
const FORCE_LOCK_NOTE_PREFIX = 'ignition-preflight 闸 C 越闸 (INV-5): force=true — 同 key 互斥锁仍点火: ';

/** 已结晶可执行 SDD: docs/plan/*.md 里契约+分解两段齐且表可解析的那批 (解析失败 = 不是已结晶 SDD, 跳过)。 */
function crystallizedSdds(root: string): { file: string; union: string[] }[] {
  let files: string[];
  try {
    files = readdirSync(join(root, 'docs', 'plan')).filter((f) => f.endsWith('.md'));
  } catch (err) {
    // docs/plan 不存在/读不到 → 无已结晶 SDD 可建议 (fail-open); 证据一行 (§静默坑 2)
    logger.debug({ err: String(err), root }, '[preflight] docs/plan 读不到 → 合图建议缺席');
    return [];
  }
  const out: { file: string; union: string[] }[] = [];
  for (const f of files) {
    try {
      const path = resolve(root, join('docs', 'plan', f));
      const bd = parseBreakdown(loadSddContract(path).text);
      out.push({ file: f, union: [...new Set(bd.slices.flatMap((s) => s.writeSet))] });
    } catch (err) {
      // 缺段/表坏 = 不是已结晶可执行 SDD —— 对散文提合图建议是噪声, 跳过;
      // 证据走 debug 档 (每份散文 md 都会进这里, warn 会刷屏, 但「为何被跳过」必须可查)。
      logger.debug({ err: String(err), file: f }, '[preflight] 非已结晶 SDD, 合图建议跳过');
    }
  }
  return out;
}

// ─── 冻结接口实现 ────────────────────────────────────────────────────────────

export interface FreezeCheckItem {
  /** 相对 root 的路径。 */
  path: string;
  /** 命中即拒的草案字符串(逐字包含即判草案)。 */
  draftMarker: string;
}
export interface FreezeCheckOpts {
  files: FreezeCheckItem[];
}
export interface ExclusiveLocksOpts {
  /** 路径(经 resolve(root, key) 规范化);给 resultOut 互斥锁。 */
  resultOut?: string;
  /** 路径(经 resolve(root, key) 规范化);给 sddPath 互斥锁。 */
  sddPath?: string;
}

export function ignitionPreflight(
  root: string,
  myWriteSet: string[],
  opts?: {
    force?: boolean;
    /** 测试/外部注入: 替身 `crystallizedSdds(root)` —— 用于断言「不走磁盘扫描」或注入假数据。 */
    crystallizedProvider?: (root: string) => { file: string; union: string[] }[];
    /** 票源真值 (D-1): 当 ticket 自带写集 → crystallized advisory 按票读, **不**触发 docs/plan 目录扫描。 */
    ticketSource?: { writeSet: string[] };
    /** 闸 A · 目标向量冻结 (t-gate-inmigrate)。 */
    freezeCheck?: FreezeCheckOpts;
    /** 闸 B · 座位签名期望表 (t-gate-inmigrate)。实配从 renderConfigDump 取。 */
    seatExpectations?: Record<string, string>;
    /** 闸 C · resultOut·sddPath 互斥锁 (t-gate-inmigrate)。 */
    exclusiveLocks?: ExclusiveLocksOpts;
  },
): PreflightReport {
  const conflicts: { runId: string; overlap: string[] }[] = [];

  // ── 闸 A · 目标向量冻结 ─────────────────────────────────────────────────────────
  // 文件不存在 / 含 draftMarker → conflicts.push。闸段缺席(opts.freezeCheck 缺省)
    // 整段跳过,与 night.sh L38-43 行为一致。
  if (opts?.freezeCheck?.files) {
    for (const f of opts.freezeCheck.files) {
      const abs = resolve(root, f.path);
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch (err) {
        // 败因原文随 conflict 交出 (证据经返回值流出, §静默坑 2): ENOENT 与权限/IO 是两种修法。
        conflicts.push({
          runId: `freeze-check:${f.path}`,
          overlap: [`缺 ${f.path} —— owner 在该路径立目标向量并签字后再点火 (读失败: ${String(err)})`],
        });
        continue;
      }
      if (text.includes(f.draftMarker)) {
        conflicts.push({
          runId: `freeze-check:${f.path}`,
          overlap: [`${f.path}: 草案,待 owner 签字 — owner 改状态行签字冻结后再点火`],
        });
      }
    }
  }

  // ── 闸 B · 座位签名 ───────────────────────────────────────────────────────────
  // 实配从 renderConfigDump 解析;与 night.sh L46-58 用同一管线。任一不等 → blocked;
  // 全等 → verifySeats 跑家族校验,同族 → blocked。
  if (opts?.seatExpectations) {
    const realCoords = parseRealSeatCoords(root);
    for (const [seatId, expected] of Object.entries(opts.seatExpectations)) {
      const actual = realCoords[seatId];
      if (actual === undefined || actual !== expected) {
        conflicts.push({
          runId: `seat-check:${seatId}`,
          overlap: [`${seatId}: 实配 ${actual ?? '<未配>'} ≠ 期望 ${expected} —— TUI: omd_set_model`],
        });
      }
    }
    // 全配齐 ∧ 异族 → verifySeats;同族 → blocked
    const allMatched = Object.entries(opts.seatExpectations).every(
      ([seatId, expected]) => realCoords[seatId] === expected,
    );
    if (allMatched) {
      try {
        const vs = verifySeats(realCoords);
        if (!vs.ok) {
          const fails = vs.checks.filter((c) => !c.ok);
          for (const c of fails) {
            conflicts.push({
              runId: `seat-check:${c.verifier.seatId}-vs-${c.generator.seatId}`,
              overlap: [`座位家族校验失败:\n[${c.verifier.seatId} vs ${c.generator.seatId}] ${c.reason}`],
            });
          }
        }
      } catch (e) {
        // verifySeats 抛(极端:coords 缺字段等) → 落闸 B 拒语义
        conflicts.push({
          runId: 'seat-check:family',
          overlap: [`座位家族校验失败: ${(e as Error).message}`],
        });
      }
    }
  }

  // ── 闸 C · resultOut·sddPath 互斥 ─────────────────────────────────────────────
  // 复用 acquireDreamLock(同仓唯一含陈锁过期的范本 dream/trigger.ts:118)。
  // 闸段缺席(opts.exclusiveLocks 缺省)整段跳过。
  let lockBlockedKeys: string[] = [];
  const acquiredLocks: string[] = [];
  if (opts?.exclusiveLocks) {
    for (const [key, rawPath] of Object.entries(opts.exclusiveLocks)) {
      if (rawPath === undefined) continue;
      const lockPath = resolve(root, rawPath);
      try {
        mkdirSync(dirname(lockPath), { recursive: true });
        const got = acquireLockWithRecord(lockPath);
        if (got.acquired) acquiredLocks.push(lockPath);
        if (!got.acquired) {
          // 活锁:把对方 pid + 龄 拼进 message
          const age = got.existing ? Date.now() - got.existing.at : -1;
          const pidStr = got.existing ? String(got.existing.pid) : '<未知>';
          lockBlockedKeys.push(`${key}:${lockPath}`);
          conflicts.push({
            runId: `lock:${key}:${lockPath}`,
            overlap: [`${lockPath}: 已在用 (pid ${pidStr}, ${age}ms 前) —— 等对方终态, 或 force 越闸 (留账)`],
          });
        }
      } catch (err) {
        // 锁机制自身失败 → fail-closed(闸 C 拒),但**必须留证据**:不留的话
        // 「同 key 互斥失效」在盘上无痕迹 (§静默坑 2, dream/trigger.ts:139 同款)。
        logger.warn({ err: (err as Error).message }, '[preflight] 锁机制自身失败 → 闸 C 拒');
        conflicts.push({
          runId: `lock:${key}:${lockPath}`,
          overlap: [`${lockPath}: 锁机制自身失败 → 闸 C fail-closed —— 排查后重试 (留证据: ${(err as Error).message})`],
        });
      }
    }
  }

  // ── ② 活 run 写集相交 (D-9 判据: claimed 无 terminal, 不做进程探测) ─────────
  const mine = new Set(myWriteSet);
  const live = liveRuns(readBoard(root));
  for (const [runId, theirs] of live) {
    const overlap = theirs.filter((f) => mine.has(f)).sort();
    if (overlap.length > 0) conflicts.push({ runId, overlap });
  }

  // ── ③ 已结晶未点火 SDD 相交 → 只进 advisories (D-1/D-10) ───────────────────
  // 票上有 writeSet 真源 → 按票读 (注入 provider **不**被调, 零磁盘访问);
  // 票缺席 → 回落 provider ?? 今天的目录扫描 (crystallizedSdds 内部已 try/catch fail-open)。
  const advisories: string[] = [];
  if (mine.size > 0) {
    const crystallized =
      opts?.ticketSource?.writeSet !== undefined
        ? [{ file: '(ticket)', union: opts.ticketSource.writeSet }]
        : (opts?.crystallizedProvider?.(root) ?? crystallizedSdds(root));
    for (const sdd of crystallized) {
      const sddSet = new Set(sdd.union);
      const overlap = sdd.union.filter((f) => mine.has(f)).sort();
      if (overlap.length === 0) continue;
      // 写集与某活 run 相交 = 该 SDD 已被占用 → 那是 ② 的事, 不再重复建议。
      const ignited = [...live.values()].some((ws) => ws.some((f) => sddSet.has(f)));
      if (ignoredIgnited(ignited)) continue;
      // 并集逐字等于本 run 写集 = 正是正在点火的这份 (或同写集孪生) —— 建议自己合图是噪声。
      if (sddSet.size === mine.size && sdd.union.every((f) => mine.has(f))) continue;
      advisories.push(
        `docs/plan/${sdd.file}: 已结晶未点火 SDD 写集相交 (${overlap.join('、')}) — 若将点火, 先与它合图/协商写面 (D-1/D-10)`,
      );
    }
  }

  // 闸 C 锁撞活锁 → 即使 force=true 也**只越闸闸 ② 写集相交**,闸 C 仍拒。
  // 闸 C 越闸留账仅当 force=true ∧ lockBlockedKeys 非空:把锁文件覆写为本进程的 (force 语义)。
  if (lockBlockedKeys.length > 0) {
    if (opts?.force) {
      // 越闸闸 C → 覆写锁 + 板上留账
      for (const blocked of lockBlockedKeys) {
        // blocked 形如 `<key>:<lockPath>`。key 永不含 `:`(exclusiveLocks 仅 resultOut/sddPath)。
        // lockPath 绝对路径可能以 `/` 开头(UNIX)或 `C:\`(Windows),split 一次保留全路径。
        const idx = blocked.indexOf(':');
        const realPath = blocked.slice(idx + 1); // skip "<key>:"
        try {
          writeFileSync(realPath, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
          acquiredLocks.push(realPath); // force 覆写后锁归本进程, 终态时同样要释放
          appendBoard(root, {
            v: 1,
            ts: new Date().toISOString(),
            runId: BOARD_RUN_ID,
            event: 'note',
            note: `${FORCE_LOCK_NOTE_PREFIX}${blocked} (force=true 覆写锁)`,
          });
          // 既然 force 越闸了,把这条 conflict 从 conflicts 移除,verdict 不算它拒
          const idx2 = conflicts.findIndex((c) => c.runId === `lock:${blocked}`);
          if (idx2 >= 0) conflicts.splice(idx2, 1);
        } catch (e) {
          logger.warn({ err: (e as Error).message }, '[preflight] force 越闸覆写锁失败 → 闸 C 仍拒');
        }
      }
    }
    // 非 force 路径:lockBlockedKeys 已在 conflicts 里
  }

  // 重新计算 blocked:仅看 conflicts(force=true 已把闸 C 越闸的清掉了)。
  // INV-5: force=true 越闸 ② 写集相交(老语义);闸 C force 越闸已在上面 splice 掉。
  // 这里 `conflicts.length > 0 && !opts?.force` 是**唯一**判 blocked 的入口,必须保留
  // force=true 时让步的旧语义(2026-08-26 那次重构就因漏这条掉过 5 个回归用例)。
  const blocked = conflicts.length > 0 && !opts?.force;
  // 闸 ② 写集相交的越闸(同旧 INV-5 后半):板上 note 一行, 写明撞了谁、撞了哪些文件。
  // 关键:用 `conflicts.length > 0 && opts?.force`,不是 `blocked && opts?.force` ——
  // `blocked` 在 force=true 时是 false,但**冲突本身仍然存在**需要记账 (INV-5 后半)。
  // 旧实现就是这一对,2026-08-26 那次重构改成 `blocked` 间接触发了"verdict=ok 但 note 缺席"
  // 的失语(同根因,同修法)。
  if (conflicts.length > 0 && opts?.force) {
    const conflictStr = conflicts.map((c) => `${c.runId} (${c.overlap.join('、')})`).join('; ');
    appendBoard(root, {
      v: 1,
      ts: new Date().toISOString(),
      runId: BOARD_RUN_ID,
      event: 'note',
      note: `${FORCE_NOTE_PREFIX}${conflictStr}`,
    });
  }

  if (blocked) {
    // 拒 = 本次不会有 run 终态来释放 —— 立刻退还已取的锁, 否则残锁把后来者卡到
    // STALE_LOCK_MS 过期 (实测形态: 同进程测试第二次 runGoal 撞自己的残锁)。
    for (const p of acquiredLocks) {
      try {
        releaseDreamLock(p);
      } catch (e) {
        logger.warn({ err: String(e), lock: p }, '[preflight] blocked 退锁失败 (残锁将靠陈锁过期)');
      }
    }
    return { verdict: 'blocked', conflicts, advisories };
  }
  return { verdict: 'ok', conflicts, advisories, ...(acquiredLocks.length ? { acquiredLocks } : {}) };
}

// ─── 闸 C 内部工具 ─────────────────────────────────────────────────────────────

/** 调 acquireDreamLock 但同时**读**旧锁内容(供 message 拼「pid N, age ms」用)。
 *  复用 acquireDreamLock 的 O_EXCL + 陈锁过期语义,但需读出旧锁 pid/at → 包一层。
 *  若 acquireDreamLock 抛(自身失败),向上抛,让 ignitionPreflight 走 fail-closed 路径。 */
function acquireLockWithRecord(lockPath: string): {
  acquired: boolean;
  existing?: { pid: number; at: number };
} {
  // 先快照一份(若有):拿锁失败时拼 message 用
  let existing: { pid: number; at: number } | undefined;
  try {
    if (existsSync(lockPath)) {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; at?: unknown };
      const pid = typeof raw.pid === 'number' ? raw.pid : 0;
      const at = typeof raw.at === 'number' ? raw.at : 0;
      existing = { pid, at };
    }
  } catch (err) {
    // 旧锁读不出 → message 用 <未知> 兜底; 但留一行证据 (§静默坑 2: 读坏的锁文件值得被看见)
    logger.warn({ err: String(err), lockPath }, '[preflight] 旧锁内容读不出 → 按 <未知> 兜底');
  }
  // 走 acquireDreamLock(同仓唯一含陈锁过期的范本)
  const got = acquireDreamLock(lockPath);
  if (got) return { acquired: true };
  return { acquired: false, existing };
}

// ─── 闸 B 内部工具 ─────────────────────────────────────────────────────────────

/** 解析 renderConfigDump 输出的座位坐标。座位行形如:
 *    `  conductor   minimax-cn:MiniMax-M3           [via]`
 *    `  verifier    openai-codex:gpt-5.6-sol        [via]`
 *  用 `[whitespace] <name> <model> [` 抓 id 与坐标。读不到 / 格式坏 → 空对象。 */
function parseRealSeatCoords(root: string): Record<string, string> {
  let dump: string;
  try {
    dump = renderConfigDump({ cwd: root });
  } catch (err) {
    // 空对象会让闸 B 判「实配读不到 ≠ 期望」→ 拒;拒因必须可溯源 (§静默坑 2)。
    logger.warn({ err: String(err), root }, '[preflight] config dump 失败 → 闸 B 按实配未知处理');
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of dump.split('\n')) {
    const m = line.match(/^\s*([a-z][\w-]*)\s+(\S+)\s+\[/);
    if (m && m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

/** 重命名回避 linter 「unused variable」警告;`ignited` 是 `Set.prototype.some` 返值。 */
function ignoredIgnited(_: boolean): boolean {
  return _;
}

// ─── 重导出(对外 seam:runGoalInner 默认从 .omd/preflight.json 加载时复用 STALE_LOCK_MS) ───
export { STALE_LOCK_MS };