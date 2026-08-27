/**
 * src/harness/proc/orphan-reap —— **启动期孤儿回收器**(D-6, INV-5, INV-6, INV-7)。
 *
 * 用途: 引擎进程硬崩溃 (OOM/SIGKILL) 之后, 上个生命周期的子进程**还活着**, 但它们的
 * 台账 (`.omd/live-pids/<ownerPid>.json`) 被遗弃在盘上。本进程启动时扫这些台账: owner
 * 已死 → 文件里登记的 pid 视为孤儿, 对它们组杀并清理台账; owner 还活着 → 跳过 (那是别的
 * engine 实例在用的, 不是孤儿)。
 *
 * ## 三条护栏 (与 INV-5/6/7 对齐)
 *
 *  · **INV-5 防误杀**: 发信号前核对 `/proc/<pid>/cmdline` 含台账登记的 `cmdHead` 前缀。
 *    一致 → 整组杀; 不一致 → 只删账 + warn `pid-reused`, 不发信号。
 *  · **INV-6 fail-open 不吞证据**: 台账 JSON 坏 / 目录不存在 / 读不到 cmdline → 全部
 *    warn 带具体路径/原因, 不抛, 不挡点火不挡 leaf 执行。
 *  · **INV-7 非 Linux 跳过**: `/proc` 不存在 → 整体返 `{ reaped: 0 }`, warn `non-linux`。
 *
 * ## 为什么是启动期挂载, 不是常驻定时器 (D-6)
 *
 * 引擎 + detached goal-worker 各自起进程, 进程启动 = 一次回收机会。常驻定时器意味着
 * MCP server 长驻进程里挂着无人值守的轮询, 与「无值也取不到值则 fail-open」的口径不符
 * (账本坏了 → 定时器也失效, 等于不挂)。无人值守的回收由下一次点火顺带完成, 间隔 = 工程实践
 * 可以接受。
 *
 * ## 边界诚实
 *
 *  · **POSIX-only**: `/proc/<pid>/cmdline` 是 Linux 专属; macOS / Windows 走 `ps` 等
 *    路径语义不同 —— INV-7 兜住, 非 Linux 直接返。
 *  · **不杀 owner 还活着的 owner 文件**: 那不是孤儿, 是别的 engine 实例在用。多 engine
 *    写不同 `<ownerPid>.json` (D-3) 是分文件的基础。
 *  · **不查 epoch 边界**: 如果 cmdHead 前缀匹配, 我们相信台账 (cmdHead 由 spawn argv 前
 *    两段拼成, 同一 spawn 形态下稳定); 已被无关进程复用但恰好 cmdHead 前缀相同的极小概率
 *    由 PID 复用那条 fail-safe 之外的代价承担 (D-4 注释里那条判断)。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { logger } from '../../logger';
import {
  killProcessGroup,
  listLedgerFiles,
  readLedger,
  type GroupKillOutcome,
  type LiveChildEntry,
} from './live-children';

/* ──────────────────────────────────────────────────────────────────────────────
 *  注入面 —— 测试用, 默认走内核
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ReapOpts {
  /** 扫的台账根目录 (默认 `process.cwd()`, 与 `live-children` 同源)。 */
  baseDir?: string;
  /** ownerPid 还活不活 —— 默认 `kill(pid, 0)`。 */
  isAlive?: (pid: number) => boolean;
  /** 读 cmdline —— 默认 `/proc/<pid>/cmdline`。`null` = 进程已不在或读不到。 */
  readCmdline?: (pid: number) => string | null;
  /** 整组 kill —— 默认 `killProcessGroup`。 */
  killGroup?: (pgid: number, signal?: NodeJS.Signals) => GroupKillOutcome | void;
  /** 强制判非 Linux (测试用) —— 默认读 `/proc` 是否存在。 */
  isLinux?: boolean;
  /** 发给孤儿的信号 —— 默认 SIGTERM。 */
  signal?: NodeJS.Signals;
}

export interface ReapSkipped {
  pid: number;
  reason: 'pid-reused' | 'cmdline-unreadable';
}

export interface ReapResult {
  /** 真正被组杀的孤儿数。 */
  reaped: number;
  /** 因防误杀跳过的 pid 列表 —— 不杀, 也不计入 reaped。 */
  skipped: ReapSkipped[];
  /** 扫到的 owner 文件数 (含被跳过未删的)。 */
  filesScanned: number;
  /** 删掉的台账文件数 (owner-dead 且非 pid-reused 全部跳过的那种也删)。 */
  filesRemoved: number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  默认实现 (POSIX + Linux)
 * ──────────────────────────────────────────────────────────────────────────── */

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // 进程已不在 / 无权限问 —— 视为「不在」, debug 不刷屏 (被 reap 大量调用)。
    logger.debug({ pid }, '[omd/orphan-reap] isAlive 探针返 ESRCH/EPERM');
    return false;
  }
};

const defaultReadCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    // 进程已不在 → 视为「无可读 cmdline」, reap 那边按"已自然消亡"处理 (不杀, 不计 skipped)。
    logger.debug({ pid }, '[omd/orphan-reap] 读 /proc cmdline 失败, 视为已消亡');
    return null;
  }
};

/* ──────────────────────────────────────────────────────────────────────────────
 *  回收主函数
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 扫 `.omd/live-pids/` 目录下的全部台账文件:
 *   - owner 还活着 → 跳过 (是别的 engine, 不是孤儿)
 *   - owner 已死 → 遍历 entries, 对每条 cmdHead 匹配的 pid 组杀; 不匹配 → 删账 + warn
 *   - 台账 JSON 坏 (readLedger 返 null) → 不删, 不抛, warn 已由 readLedger 自己打
 *
 * 整个调用**不抛** (INV-6/7) —— 调用方可以无脑调。
 */
export function reapOrphans(opts: ReapOpts = {}): ReapResult {
  const isLinux = opts.isLinux ?? existsSync('/proc');
  if (!isLinux) {
    logger.warn({}, '[omd/orphan-reap] 跳过回收: non-linux 平台 (/proc 不存在)');
    return { reaped: 0, skipped: [], filesScanned: 0, filesRemoved: 0 };
  }

  const baseDir = opts.baseDir ?? process.cwd();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const readCmdline = opts.readCmdline ?? defaultReadCmdline;
  const killGroup = opts.killGroup ?? ((pgid, sig) => killProcessGroup(pgid, sig ?? opts.signal ?? 'SIGTERM'));
  const signal = opts.signal ?? 'SIGTERM';

  const result: ReapResult = { reaped: 0, skipped: [], filesScanned: 0, filesRemoved: 0 };
  const files = listLedgerFiles(baseDir);
  result.filesScanned = files.length;

  for (const filePath of files) {
    const ledger = readLedger(filePath);
    if (!ledger) {
      // JSON 坏 / 不存在 —— readLedger 已 warn, 这里不删 (留给人查, 见 INV-6)。
      continue;
    }

    // **owner 还活着**: 不是孤儿, 跳过整文件, 台账归当前 owner 自己管。
    if (isAlive(ledger.ownerPid)) continue;

    // **owner 已死**: 视为孤儿, 逐条处理。
    let anyProcessable = false;
    for (const entry of ledger.entries) {
      const cmdline = readCmdline(entry.pid);
      if (cmdline === null) {
        // 进程已不在 / 读不到 —— 视为已自然消亡, 删账不杀 (已无对象)。
        // 不计 skipped (防误杀口径专指 PID 复用)。
        continue;
      }
      // INV-5: cmdHead 必须以 cmdline 前缀出现才算同一进程。
      // 注: /proc/<pid>/cmdline 用 NUL 分隔 argv, 而 cmdHead = argv 前两段 join(' '),
      // 不是按 NUL 拼回 argv —— 但 `makeCmdHead` 的判据是「前两段 join」, 所以这里
      // 走「cmdline 含 cmdHead 字符串」即可, 哪怕 NUL 把空格也吃了也能命中。
      // 例: cmdline="bash\0-c\0..." , cmdHead="bash -c" → cmdline.includes('bash -c') = false,
      // 那需要的是 cmdline.replace(/\0/g, ' ').startsWith('bash -c')。
      const flat = cmdline.replace(/\0/g, ' ');
      if (!flat.startsWith(entry.cmdHead)) {
        logger.warn(
          { pid: entry.pid, cmdHead: entry.cmdHead, cmdlineHead: flat.slice(0, 64) },
          '[omd/orphan-reap] pid-reused: 台账 cmdHead 与 /proc cmdline 前缀不匹配, 跳过发信号',
        );
        result.skipped.push({ pid: entry.pid, reason: 'pid-reused' });
        anyProcessable = true;
        continue;
      }
      // cmdHead 匹配: 真孤儿, 整组杀。
      try {
        killGroup(entry.pid, signal);
      } catch (e) {
        // killProcessGroup 自己吞 ESRCH/EPERM; 这里只接住注入替身抛的奇葩错。
        logger.warn(
          { pid: entry.pid, err: String(e) },
          '[omd/orphan-reap] killGroup 抛了, 不挡后续条目 (warn)',
        );
        continue;
      }
      result.reaped++;
      anyProcessable = true;
    }

    // 删台账 —— owner 已死 + 我们已经走完 (即使全跳过也删: 文件无主, 留着占地方)。
    // 失败 warn 不抛 (INV-6)。
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
      result.filesRemoved++;
    } catch (e) {
      logger.warn(
        { filePath, err: String(e) },
        '[omd/orphan-reap] 删台账失败, 不挡主流程 (warn)',
      );
    }
    // anyProcessable 用来给未来的「全部 entries 都是空 / 全部 cmdline-unreadable」分支留口子;
    // 当前实现对任何 owner-dead 文件都删, 行为由文件内 entries 数决定是否真有动作。
    void anyProcessable;
  }

  if (result.reaped > 0 || result.skipped.length > 0) {
    logger.info(
      { reaped: result.reaped, skipped: result.skipped.length, filesScanned: result.filesScanned },
      '[omd/orphan-reap] 启动期回收完成',
    );
  }

  return result;
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  一次性触发器 —— 给引擎挂载 (D-6)
 * ──────────────────────────────────────────────────────────────────────────── */

let _reapRanForCurrentPid = false;

/**
 * 进程级一次性回收闸 —— 保证多次调用 `runExecutorDag*` 只触发一次启动期回收
 * (D-6: 一次挂载点覆盖 run + solve 两路)。
 *
 * **不抛**: reap 自己的失败模式已被吃掉 (INV-6/7), 这里再包一层只是为防御性。
 * 测试可用 `__resetReapForTest()` 重置。
 */
export function reapOrphansOnce(): ReapResult {
  if (_reapRanForCurrentPid) return { reaped: 0, skipped: [], filesScanned: 0, filesRemoved: 0 };
  _reapRanForCurrentPid = true;
  try {
    return reapOrphans();
  } catch (e) {
    logger.warn(
      { err: String(e) },
      '[omd/orphan-reap] reapOrphansOnce 抛了意外错, 吞掉不挡主流程 (warn)',
    );
    return { reaped: 0, skipped: [], filesScanned: 0, filesRemoved: 0 };
  }
}

/** 测试专用 —— 重置一次性闸。生产代码不许调。 */
export function __resetReapForTest(): void {
  _reapRanForCurrentPid = false;
}

/** 测试用 —— 拿到上一次 reap 的结果 (调试)。 */
let _lastReapResult: ReapResult | null = null;

/** 测试专用 —— 给 `expect(_lastReapResult).toEqual(...)` 用。 */
export function __lastReapResultForTest(): ReapResult | null {
  return _lastReapResult;
}

/** 给 `reapOrphansOnce` 留一个 hook 把最后一次结果缓存 (测试用)。 */
export function __captureLastReapForTest(r: ReapResult): void {
  _lastReapResult = r;
}

// 故意把 LiveChildEntry 暴露, 给 reaper 测试造 fixture 用 (类型安全)。
export type { LiveChildEntry };