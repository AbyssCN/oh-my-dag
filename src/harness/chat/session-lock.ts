/**
 * src/harness/chat/session-lock —— 会话文件的**跨进程写锁**(SDD 片 B)。
 *
 * ## 为什么必须有它:代价是实测出来的,不是设想的
 *
 * `scripts/probes/pi-session-probe.ts` 量到:两个 `Session` 实例写同一份 JSONL 会写出
 * **重复 seq**,而下一次 `open()` 直接抛 `non-consecutive seq` —— **整份会话读不出来**。
 * 老的 `ChatStore` 同场景只是 last-write-wins 丢一条。
 * 而 omd **真有两个写者**:TUI(`src/tui/backend-embedded.ts`)与 daemon(`src/serve/daemon.ts`)。
 *
 * 进程内那一层在 `session-store.ts`(一份文件一个 `Session` 实例);
 * 这一层管**跨进程**:抢不到锁就**响亮拒绝**,不覆盖、不静默降级。
 *
 * ## 三条刻意的取舍
 *
 * 1. **只在第一次写的时候抢锁**,读(`list` / `messages`)永不上锁 ——
 *    看历史不该被另一个进程挡住。
 * 2. **同机看 pid 活不活**(`process.kill(pid, 0)`);**跨机看不到对方的进程表**,
 *    所以跨机只认"陈旧"(默认 6 小时)。⚠ 这两档不许压成一档:
 *    "pid 死了"是**事实**,"跨机而且很久没动"是**推断**(本仓 NULL ≠ 0 ≠ 不适用)。
 * 3. **接管要留证据**:抢死锁成功时 `logger.warn` 一条(谁的锁、多久没动)——
 *    fail-open 可以吞异常,不许吞证据。
 *
 * ⚠ **不做**乐观并发 / CRDT / 合并:单用户工具,拒绝 + 说清是谁在写就够了。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { logger } from '../../logger';

/** 跨机锁多久算陈旧 —— 只对**别的机器**持有的锁生效(同机直接看 pid)。 */
export const FOREIGN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export interface LockHolder {
  pid: number;
  host: string;
  /** 抢到锁的时刻(ms)。 */
  at: number;
}

export interface LockDeps {
  now: () => number;
  pid: number;
  host: string;
  /** pid 活不活。默认 `process.kill(pid, 0)`;测试注入。 */
  alive: (pid: number) => boolean;
  staleAfterMs: number;
}

export const defaultLockDeps = (): LockDeps => ({
  now: () => Date.now(),
  pid: process.pid,
  host: hostname(),
  alive: (pid: number) => {
    try {
      process.kill(pid, 0); // signal 0 = 只探测存在性, 不发信号
      return true;
    } catch (e) {
      // ⚠ 两种错要分开:`ESRCH` = 没这个进程(死了);**`EPERM` = 有这个进程但不属于我 ⇒ 活着**。
      //   把 EPERM 当死会去接管一把**活锁**, 那正好是这一层要防的事。
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  staleAfterMs: FOREIGN_LOCK_STALE_MS,
});

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder; why: string };

const lockPathFor = (sessionPath: string): string => `${sessionPath}.lock`;

/** 读锁文件。坏文件当"没有锁"处理(**并留一条 warn** —— 不许静默)。 */
function readHolder(path: string): LockHolder | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LockHolder>;
    if (typeof raw.pid !== 'number' || typeof raw.host !== 'string' || typeof raw.at !== 'number') {
      throw new Error('字段不全');
    }
    return { pid: raw.pid, host: raw.host, at: raw.at };
  } catch (e) {
    logger.warn({ path, reason: (e as Error).message }, '[session-lock] 锁文件读不出来, 当作没有锁');
    return null;
  }
}

/**
 * 抢会话的写锁。
 *
 * @returns `ok:true` 带 `release()`;`ok:false` 带**持有者是谁**(错误信息里要能说出 pid)。
 */
export function acquireWriteLock(sessionPath: string, deps: LockDeps = defaultLockDeps()): AcquireResult {
  const path = lockPathFor(sessionPath);
  const holder = readHolder(path);
  const mine: LockHolder = { pid: deps.pid, host: deps.host, at: deps.now() };

  if (holder) {
    // 自己的锁(同机同 pid)—— 重入放行, 不然一个进程里第二次写就把自己挡了。
    const isMine = holder.host === deps.host && holder.pid === deps.pid;
    if (!isMine) {
      const sameHost = holder.host === deps.host;
      if (sameHost && deps.alive(holder.pid)) {
        return { ok: false, holder, why: `另一个进程正在写这份会话(pid ${holder.pid} @ ${holder.host})` };
      }
      const idleMs = deps.now() - holder.at;
      if (!sameHost && idleMs < deps.staleAfterMs) {
        return {
          ok: false,
          holder,
          why: `另一台机器持有这份会话的写锁(pid ${holder.pid} @ ${holder.host}, ${Math.round(idleMs / 60000)} 分钟前)`,
        };
      }
      // 接管:**留证据**。同机 pid 已死 = 事实;跨机陈旧 = 推断, 两者的判词分开写。
      logger.warn(
        { path, holderPid: holder.pid, holderHost: holder.host, idleMs, 依据: sameHost ? 'pid 已不存在(事实)' : '跨机且超过陈旧阈值(推断)' },
        '[session-lock] 接管一把旧锁',
      );
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(mine), 'utf-8');
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      // 只删**自己那把**:别人接管过之后不许把人家的锁删掉。
      const cur = readHolder(path);
      if (cur && cur.pid === mine.pid && cur.host === mine.host && cur.at === mine.at) {
        rmSync(path, { force: true });
      }
    },
  };
}

/** 现在是谁持锁(给判词与测试用;没有锁返回 `null`)。 */
export function currentHolder(sessionPath: string): LockHolder | null {
  return readHolder(lockPathFor(sessionPath));
}
