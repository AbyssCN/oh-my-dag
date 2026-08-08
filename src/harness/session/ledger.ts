/**
 * src/harness/session/ledger —— W2→W1 ledger.jsonl 写者(S0/S1 施工 · D-4 接缝落点)。
 *
 * 接缝事实(契约锚点, 逐字):
 * - parser(W3 stop-ledger.ts)产 `tokenBucket`(stop-ledger.ts:33,170);
 * - 消费侧 W1 writer.ts `latestCtxTokens` 只认字面 `j.ctxTokens` 为 number(writer.ts:282-283),
 *   尾读 `readFileSync(join(contDir, 'ledger.jsonl'), …)`(writer.ts:367),
 *   `contDir = resolve(projectRoot, scope.dataPath(join('session', sessionId)))`(writer.ts:351)。
 * - 本模块 = 全仓唯一 serializer(tokenBucket→ctxTokens 映射, I-5: 该映射只许发生在这里)
 *   + ledger.jsonl append 写者;落盘路径与 writer.ts:351,367 逐字对齐 —— 对不齐 W1 尾读永远读不到。
 * - 五项契约:
 *   - append: 只增不覆写, 新行单批一次 appendFileSync;
 *   - offset: 追加前已有行数为去重基准, 跨调用(同 transcript 多次 Stop)不重复追加;
 *   - lock: 独占锁文件(ledger.jsonl.lock, O_EXCL), 防并发 hook 双写;
 *   - owner: 每行记录写者标识;
 *   - path: 与 W1 尾读对齐的落盘路径(见上)。
 * - 全程 fail-open: 任何异常/未知状态 → { ok:false, error }, 绝不抛(hook 链零阻断)、
 *   绝不在状态未知时追加(宁缺勿重, 不伪造、不半写)。
 *
 * @module
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveProject } from '../project-scope';
import type { StopLedger } from './stop-ledger';

// ─── constants ──────────────────────────────────────────────────────────────

/** 每行写者标识(W2 hook 是当前唯一生产调用方)。 */
export const LEDGER_OWNER_W2 = 'W2:session-continuity';

/** 锁重试间隔(ms)。 */
const LOCK_RETRY_MS = 20;

// ─── Public types ───────────────────────────────────────────────────────────

export interface LedgerSerializeOptions {
  /** 写者标识, 落进每行 `owner`;缺省 LEDGER_OWNER_W2。 */
  owner?: string;
  /** 注入时钟(测试确定性);缺省 Date.now。 */
  now?: () => number;
}

export interface AppendLedgerOptions extends LedgerSerializeOptions {
  /** W3 解析产物(entries 即本轮记账)。 */
  ledger: StopLedger;
  /** session id —— 与 writer.ts:351 同一分区键;空 → fail-open 不写。 */
  sessionId: string;
  /** 项目根解析用 cwd(与 writer CLI 同语义);缺省 process.cwd()。 */
  cwd?: string;
  /** 锁重试总时长上限 ms;缺省 1000。 */
  lockTimeoutMs?: number;
}

export interface AppendLedgerResult {
  ok: boolean;
  /** 落盘路径(与 W1 尾读对齐);失败时为 null。 */
  ledgerPath: string | null;
  /** 本次追加行数(0 = ledger 已是最新, 无新增)。 */
  appended: number;
  /** 追加前已有行数(= offset 去重基准)。 */
  offset: number;
  error?: string;
}

// ─── serializer(I-5)─────────────────────────────────────────────────────────

/**
 * StopLedger → ledger.jsonl 行(一行一条 entry)。
 * 映射只发生在这里: `tokenBucket` → 行字段 `ctxTokens`(null 原样透传 —— 不伪造数,
 * W1 侧 `typeof j.ctxTokens === 'number'` 判定行自会跳过)。
 */
export function serializeLedger(ledger: StopLedger, opts: LedgerSerializeOptions = {}): string[] {
  const owner = opts.owner ?? LEDGER_OWNER_W2;
  const ts = new Date((opts.now ?? Date.now)()).toISOString();
  return ledger.entries.map((e) =>
    JSON.stringify({ ordinal: e.ordinal, ctxTokens: e.tokenBucket, owner, ts }),
  );
}

// ─── ledger.jsonl append 写者 ───────────────────────────────────────────────

/** 锁文件路径(与 ledger 同目录)。 */
function lockPathOf(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

/** 独占锁:O_EXCL 创建锁文件;被占则短睡重试到 deadline。超时/非 EEXIST 错误 → false。 */
function acquireLock(lockPath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, Buffer.from(`${process.pid} ${new Date().toISOString()}`));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      if (Date.now() >= deadline) return false;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * 已有行数(= offset 去重基准)。任一行不可解析/非 record → 状态未知 → 不追加(fail-open):
 * 自己写的 ledger 不该出现坏行, 出现即不可信, 宁缺勿重。
 */
function readOffset(ledgerPath: string): { offset: number; error?: string } {
  if (!existsSync(ledgerPath)) return { offset: 0 };
  const lines = readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const j: unknown = JSON.parse(line);
      if (typeof j !== 'object' || j === null || Array.isArray(j)) {
        return { offset: 0, error: `ledger 含非 record 行: ${line.slice(0, 80)}` };
      }
    } catch {
      return { offset: 0, error: `ledger 含不可解析行: ${line.slice(0, 80)}` };
    }
  }
  return { offset: lines.length };
}

/** 追加本轮新 entry 行(全 fail-open, 不抛)。 */
export function appendLedger(opts: AppendLedgerOptions): AppendLedgerResult {
  const fail = (error: string, offset = 0): AppendLedgerResult => ({
    ok: false,
    ledgerPath: null,
    appended: 0,
    offset,
    error,
  });
  try {
    const sessionId = opts.sessionId.trim();
    if (!sessionId) return fail('sessionId 缺失 → 无法对齐 W1 分区路径, 不写');

    const scope = resolveProject(opts.cwd);
    // 与 writer.ts:351,367 逐字对齐: contDir = resolve(projectRoot, scope.dataPath(join('session', sessionId)))。
    const ledgerPath = resolve(scope.rootPath, scope.dataPath(join('session', sessionId, 'ledger.jsonl')));
    const lockPath = lockPathOf(ledgerPath);

    // 锁文件与 ledger 同目录: 父目录必须先存在(建 session 目录幂等, writer.ts:352 也会建)。
    mkdirSync(dirname(ledgerPath), { recursive: true });

    if (!acquireLock(lockPath, opts.lockTimeoutMs ?? 1000)) {
      return fail(`锁占用超时(${lockPath}) — 并发写者存在, 跳过`);
    }
    try {
      const { offset, error } = readOffset(ledgerPath);
      if (error) return fail(error, offset);

      if (opts.ledger.entries.length < offset) {
        return fail(
          `ledger 已有 ${offset} 行 > 本轮 entries ${opts.ledger.entries.length} — transcript 回退/替换, 状态未知, 不追加`,
          offset,
        );
      }
      const lines = serializeLedger(opts.ledger, opts);
      const fresh = lines.slice(offset);
      if (fresh.length === 0) return { ok: true, ledgerPath, appended: 0, offset };

      appendFileSync(ledgerPath, `${fresh.join('\n')}\n`, 'utf8');
      return { ok: true, ledgerPath, appended: fresh.length, offset };
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* 锁已不在 → 忽略 */
      }
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
