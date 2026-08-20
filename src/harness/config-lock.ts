/**
 * src/harness/config-lock —— `.omd/config.json` 写者独占锁 (C-4 · INV-10/11/12)。
 *
 * 复用 `src/harness/session/ledger.ts:89-103` 的 O_EXCL 锁形状(D-5: 不新造第二种锁)。
 * 锁文件 = `<configPath>.lock`,内容为 `${process.pid} ${new Date().toISOString()}` —
 * 与 ledger.ts:94 同一字节形状,便于后续 ops 用同一个工具读。
 *
 * 三项契约:
 *   - INV-10: 读-改-写 `.omd/config.json` 必须在锁内完成。
 *   - INV-11: 抢不到锁时**响亮抛错**(含持有者 pid),不静默返回/不静默跳过。
 *   - INV-12: 单写者路径行为不变(拿→改→放,产物逐字节相同,不残留锁文件)。
 *
 * 用法:
 *   - 短临界区: `withConfigLock(path, () => { ... })`;
 *   - 手动控制: `const release = acquireConfigLock(path); try { ... } finally { release(); }`。
 *
 * ⚠ **不区分进程死活** —— 锁文件存在 = 有人持有。本仓是单机单 owner,真撞上死进程时
 * 由 owner 手动 `rm` 锁文件即可(锁里写 pid+ts,人眼能判定)。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 20;
/** 锁默认持有上限 (ms);超此即视为争用,响亮抛错 (INV-11)。 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** 锁文件路径: 与 config 同目录,加 `.lock` 后缀 (与 ledger.ts:84 lockPathOf 同形状)。 */
export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/** 读取当前锁文件第一行持有者信息;锁不存在 → null。 */
function readHolder(lockPath: string): { pid: string; ts: string } | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').split('\n')[0]?.trim() ?? '';
    if (!raw) return null;
    const [pid, ts = ''] = raw.split(' ');
    return { pid: pid ?? '?', ts };
  } catch {
    return null;
  }
}

/**
 * 独占锁获取:O_EXCL 创建锁文件。被占则短睡重试到 deadline。
 *
 * @throws {Error} 超时(仍在争用)或非 EEXIST 错误 → 响亮抛错,判词含持有者 pid (INV-11)。
 */
export function acquireConfigLock(configPath: string, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): () => void {
  const lockPath = configLockPath(configPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, Buffer.from(`${process.pid} ${new Date().toISOString()}`));
      closeSync(fd);
      return () => releaseConfigLock(configPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new Error(
          `config-lock: 抢锁失败 (${lockPath}) — code=${code}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (Date.now() >= deadline) {
        const holder = readHolder(lockPath);
        const pidStr = holder?.pid ?? '?';
        const tsStr = holder?.ts ?? '?';
        throw new Error(
          `config-lock: ${lockPath} 持有者 pid=${pidStr} (acquired ${tsStr}); ` +
            `等 ${timeoutMs}ms 仍未释放,拒绝静默覆盖 (持有者在写) — ` +
            `如确认持有者已死,可手动 \`rm ${lockPath}\` 后重试。`,
        );
      }
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
}

/** 放锁:删锁文件;不在则忽略 (与 ledger.ts:168-172 同语义)。 */
export function releaseConfigLock(configPath: string): void {
  const lockPath = configLockPath(configPath);
  try {
    unlinkSync(lockPath);
  } catch {
    /* 锁已不在 → 忽略 */
  }
}

/**
 * 在独占锁内执行 mutator。锁释放始终进行 (finally),即使 mutator 抛错。
 * mutator 抛出的原错透传 —— 锁失败与业务失败分两层栈。
 */
export function withConfigLock<T>(configPath: string, mutator: () => T, timeoutMs?: number): T {
  acquireConfigLock(configPath, timeoutMs);
  try {
    return mutator();
  } finally {
    releaseConfigLock(configPath);
  }
}