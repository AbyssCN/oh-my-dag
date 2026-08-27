/**
 * src/harness/proc/live-children —— **组杀原语 + live-pids 台账 + 信号收尾**(SDD 2026-08-24 片 1)。
 *
 * 三件事一个模块 (写集未列 group-kill.ts, 合并于此):
 *
 *  · `killProcessGroup` (INV-1/2): `kill(-pid)` 杀整个进程组; 抛 ESRCH/EPERM/任何错 →
 *    回退单 PID kill; 回退再抛 → 吞。**任何情况下不向上抛**。
 *  · 台账 (INV-4, D-3): `.omd/live-pids/<ownerPid>.json`, **单写者 = ownerPid 本人**,
 *    spawn 登记 / 退出销账。分文件免锁: 引擎与 detached goal-worker 各写各的。
 *    读写 fail-open (INV-6): 失败 warn 带路径 + 错误原文, 不挡 leaf 执行。
 *  · 信号收尾 (INV-3, D-2): detached 子进程不再随终端进程组吃 SIGINT —— 引擎进程收
 *    SIGINT/SIGTERM 时先对全部在册子进程组杀再退出。幂等 (重复调用不再发信号)。
 *
 * 判据在 `group-kill.test.ts` (GWT-1/2) 与 `live-children.test.ts` (GWT-3/4);
 * 消费方: `command-leaf.ts` (spawn/杀/登记) · `orphan-reap.ts` (启动期回收读台账)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../logger';

/* ──────────────────────────────────────────────────────────────────────────────
 *  类型 —— 台账 schema (契约冻结面, orphan-reap 按它消费)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 台账里的一条子进程记录。cmdHead = spawn argv 前两段 join, 回收器用它防 PID 复用误杀 (D-4)。 */
export interface LiveChildEntry {
  pid: number;
  cmdHead: string;
  startedAt: number;
  runId?: string;
}

/** `.omd/live-pids/<ownerPid>.json` 的整体形状。 */
export interface LiveChildrenLedger {
  ownerPid: number;
  entries: LiveChildEntry[];
}

/** 组杀的结局: 组杀成功 / 回退单杀 / 两刀都落空 (全部吞掉, 不抛)。 */
export type GroupKillOutcome = 'group' | 'single' | 'none';

/* ──────────────────────────────────────────────────────────────────────────────
 *  组杀原语 (INV-1/2)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 默认组杀: POSIX `kill(-pid)` —— detached spawn 的子进程是组长, 孙进程同组一并收到。 */
const defaultKillGroup = (pid: number, signal?: number | NodeJS.Signals): void => {
  process.kill(-pid, signal);
};

/** 默认回退单杀: 组没了但头进程可能还在 (或注入替身走这支)。抛了吞 —— INV-2 兜底不抛。 */
const defaultKillPid = (pid: number, signal?: number | NodeJS.Signals): void => {
  process.kill(pid, signal);
};

/**
 * 组杀 + 回退 (INV-1/2)。**永不抛**:
 *   ① `killGroup(pid, signal)` (默认 `kill(-pid)`) → 成功返 `'group'`;
 *   ② 抛 ESRCH/EPERM/任何错 → `killPid(pid, signal)` 单杀 → 返 `'single'`;
 *   ③ 单杀也抛 → 吞 (debug 留痕), 返 `'none'`。
 *
 * 注: 注入的 `killGroup` 收到的是**正 pid** —— 取负是默认实现的事, 不是接口语义
 * (`group-kill.test.ts` 「默认信号为 SIGTERM」那条钉住了这一点)。
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  killGroup: (pid: number, signal?: number | NodeJS.Signals) => void = defaultKillGroup,
  killPid: (pid: number, signal?: number | NodeJS.Signals) => void = defaultKillPid,
): GroupKillOutcome {
  const sig = signal ?? 'SIGTERM';
  try {
    killGroup(pid, sig);
    return 'group';
  } catch (groupErr) {
    // ESRCH (组已不在) / EPERM (跨用户或替身注入) / 其它 —— 一律回退单杀, 不区分:
    // 组杀失败的每一张脸下一步都只有「试试单杀」一条路, 分支只会多一处漏。
    try {
      killPid(pid, sig);
      return 'single';
    } catch (pidErr) {
      logger.debug(
        { pid, sig, groupErr: String(groupErr), pidErr: String(pidErr) },
        '[omd/live-children] 组杀与单杀均落空 (多半已退出), 吞掉 (INV-2)',
      );
      return 'none';
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  cmdHead (D-4)
 * ──────────────────────────────────────────────────────────────────────────── */

/** spawn argv 前两段 join(' '), 截断到 64 字符 —— 台账登记与回收器核对共用同一口径。 */
export function makeCmdHead(argv: readonly string[]): string {
  return argv.slice(0, 2).join(' ').slice(0, 64);
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  台账读写 (INV-4/6)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 台账目录: `<root ?? cwd>/.omd/live-pids`。与 orphan-reap 的扫描根同源 (默认 cwd)。 */
export function getLivePidsDir(root?: string): string {
  return join(root ?? process.cwd(), '.omd', 'live-pids');
}

/** `<root ?? cwd>/.omd/live-pids/<ownerPid>.json` —— ownerPid 是**写者进程**自己的 pid (D-3)。 */
export function getLivePidsFilePath(ownerPid: number, root?: string): string {
  return join(getLivePidsDir(root), `${ownerPid}.json`);
}

/** 写台账 (mkdir -p + 整文件写)。失败 warn 不抛 (INV-6: fail-open 吞异常不吞证据)。 */
export function writeLedger(filePath: string, ledger: LiveChildrenLedger): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(ledger, null, 1)}\n`, 'utf8');
  } catch (e) {
    logger.warn({ filePath, err: String(e) }, '[omd/live-children] 台账写入失败, 不挡 leaf 执行 (INV-6)');
  }
}

/** 读台账。JSON 坏 / 读不到 → 返 null 不抛, warn 带路径; **不删原文件** (留给人查, INV-6)。 */
export function readLedger(filePath: string): LiveChildrenLedger | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as LiveChildrenLedger;
    if (typeof raw?.ownerPid !== 'number' || !Array.isArray(raw?.entries)) {
      logger.warn({ filePath }, '[omd/live-children] 台账形状不对 (缺 ownerPid/entries), 按坏文件处理');
      return null;
    }
    return raw;
  } catch (e) {
    logger.warn({ filePath, err: String(e) }, '[omd/live-children] 台账读取/解析失败, 返 null (INV-6)');
    return null;
  }
}

/** 列出台账目录下全部 `<纯数字>.json` (完整路径)。目录不存在 → []。非 pid 命名的文件忽略。 */
export function listLedgerFiles(root?: string): string[] {
  const dir = getLivePidsDir(root);
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => join(dir, name));
  } catch (e) {
    logger.warn({ dir, err: String(e) }, '[omd/live-children] 台账目录列举失败, 按空处理 (INV-6)');
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  在册登记 (INV-4) —— 内存 registry 是真身, 文件是它的投影
 * ──────────────────────────────────────────────────────────────────────────── */

/** 本进程在飞的子进程。信号收尾按它组杀; 每次增删把投影整文件写回。 */
const registry = new Map<number, LiveChildEntry>();

/** 把 registry 投影写到本进程自己的台账文件 (单写者 = process.pid, D-3, 免锁)。 */
function persistRegistry(): void {
  writeLedger(getLivePidsFilePath(process.pid), {
    ownerPid: process.pid,
    entries: [...registry.values()],
  });
}

/** spawn 成功后立刻登记 (command-leaf 调)。fail-open: 写失败 warn 后照常返回。 */
export function registerChild(entry: LiveChildEntry): void {
  registry.set(entry.pid, entry);
  persistRegistry();
}

/** 子进程退出后销账。pid 不在册 → no-op (不重写文件, 不误清别的条目)。 */
export function unregisterChild(pid: number): void {
  if (!registry.delete(pid)) return;
  persistRegistry();
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  信号收尾 (INV-3, D-2)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 幂等闸: 第一次收尾走完之后置真, 之后的调用不再发信号 (GWT-3 第二刀)。 */
let cleanupDone = false;

/**
 * 对全部在册子进程组杀 + 删本进程台账文件。**幂等且不抛** (INV-3):
 * 单个 killFn 抛错不挡其余条目 (注入替身可能抛)。
 */
export function runSignalCleanup(
  signal: NodeJS.Signals = 'SIGTERM',
  killFn: (pgid: number, signal: NodeJS.Signals) => GroupKillOutcome | void = (pgid, sig) =>
    killProcessGroup(pgid, sig),
): void {
  if (cleanupDone) return;
  for (const entry of registry.values()) {
    try {
      killFn(entry.pid, signal);
    } catch (e) {
      logger.warn(
        { pid: entry.pid, err: String(e) },
        '[omd/live-children] 收尾 killFn 抛了, 不挡其余在册子进程 (INV-3)',
      );
    }
  }
  registry.clear();
  // 正常收尾把自己的台账删掉 (INV-4): 留着空文件只会让下次启动的回收器多扫一个死 owner。
  try {
    const own = getLivePidsFilePath(process.pid);
    if (existsSync(own)) unlinkSync(own);
  } catch (e) {
    logger.debug({ err: String(e) }, '[omd/live-children] 收尾删台账失败 (best-effort)');
  }
  cleanupDone = true;
}

/** 装载闸: SIGINT/SIGTERM handler 只挂一次 (command-leaf 模块加载时调, 多次 import 不重复挂)。 */
let handlersInstalled = false;

/**
 * 挂 SIGINT/SIGTERM 收尾 (D-2): detached 子进程收不到终端的 Ctrl+C —— 这里补回
 * 「引擎死, 子进程也死」的语义: 先组杀在册子进程, 再摘掉自己这个 handler 重发同信号
 * (保住默认退出码/核心语义)。幂等。
 */
export function installSignalCleanup(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      runSignalCleanup(sig);
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
  // 正常退出 (exit 事件里不能再 async): 只做同步的删台账 —— 子进程已各自销账, 文件应当是空壳。
  process.on('exit', () => {
    try {
      const own = getLivePidsFilePath(process.pid);
      if (existsSync(own)) unlinkSync(own);
    } catch (e) {
      // exit 阶段 logger 可能已收摊 —— 同步 stderr 留一行证据 (INV-6), 台账留给 orphan-reap 下次清。
      process.stderr.write(`[omd/live-children] exit 删台账失败 (orphan-reap 兜底): ${String(e)}\n`);
    }
  });
}

/** 测试专用: 清 registry + 幂等闸 (cwd 会被测试 chdir, 模块缓存必须可重置)。生产不许调。 */
export function __resetForTest(): void {
  registry.clear();
  cleanupDone = false;
}
