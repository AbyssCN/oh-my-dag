/**
 * src/harness/run-control —— **run 控制面 (介入 / 停图) 的共享写侧** (INV-RC-1, SDD 片 7)。
 *
 * ## 为什么是它
 *
 * `i` (intervene) 与 `s` (cancel detached run) 在盘上本没有写侧 —— MCP 那一路在
 * `dag-tools.ts:566-590` 与 `intervene.ts:72-81` 各写一份, TUI 不久后要写**第三份**
 * (收件箱的 i / s 接线)。同一个动作三份实现 = 同一处漂 (`pathfinder.ts:112-116` 那条
 * 「同一个 id 在三处三种行为」的同类)。
 *
 * 抽到这一层之后: MCP 与 TUI **都**调这份, 任何一处漂都立刻见红
 * (`run-control-parity.test.ts` 是这条断言的闸)。
 *
 * ## INV-RC-1 的两个判别
 *
 *   1. `recordIntervention` 的写盘路径 = `appendBoard({ event:'intervened', cause, runId, ... })`,
 *      与原 `intervene.ts:74-81` **逐字同构** (除 `ts`)。两条路调用 → 板上两条记录除 ts
 *      逐字段相等, parity test 钉这条。
 *   2. `cancelDetachedRun` 是**协作式停** (写 `.omd/continuity/<runId>/cancel` + SIGTERM),
 *      子进程在调度接缝自己停, checkpoint 保底 `dag_resume`。**不**做进程内 AbortController
 *      (那是 `runRegistry.requestCancel` 的活, 属主不属主就返 false —— TUI 那路够不着)。
 *
 * ## INV-RC-4 —— 停图的四种结局要分得开
 *
 * `CancelOutcome` 是**判别联合**不是 boolean。`signalled` / `no-owner-pid` / `pid-dead` /
 * `signal-failed` 四种一字之差, 都吞成 "已取消" 就是画一个按了不发生的东西。
 *
 * ## deps 接缝
 *
 * 照 `dag-tools.ts:241-242` 已有的同款 idiom (真 kill 会杀测试进程) —— `killPid` / `isAlive`
 * 走默认实现, 测试注入 spy; `readOwnerPid` **必填** (server 用 `runRegistry.diskRecord`;
 * 默认值会跨层: harness 不依赖 mcp 的 RunStore, 不在 deps 里造一个)。
 *
 * @see INV-RC-1 .. INV-RC-8 (SDD 片 7)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendBoard } from './board/run-board';
import { logger } from '../logger';
import { FAILURE_KIND_ORDER, type NodeFailureKind } from './node-failure';

/**
 * 进程级 kill / 判活 / 读 pid 接缝 (照 `dag-tools.ts:241-242` 已有的 idiom)。
 *  默认走 `process.kill` —— **真 kill 会杀测试进程**; 测试必须注入 spy。
 */
export interface RunControlDeps {
  /** SIGTERM 发送者; 默认 `process.kill(pid, 'SIGTERM')`。 */
  killPid?: (pid: number) => void;
  /** pid 是否仍存活; 默认 `process.kill(pid, 0)` 探 (同 `run-store.defaultIsAlive`)。 */
  isAlive?: (pid: number) => boolean;
  /**
   * 盘上 ownerPid 读取 —— server 侧给 `runRegistry.diskRecord(runId)?.ownerPid`。
   * **必填**: harness 不引 mcp 层 (反向: mcp 引 harness), 没有合理默认。
   */
  readOwnerPid: (runId: string) => number | null;
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const defaultKillPid = (pid: number): void => {
  process.kill(pid, 'SIGTERM');
};

/**
 * 协作式停的四种结局 (INV-RC-4)。
 *  **判别联合** 不是 boolean —— 屏上要分别画 "已发 SIGTERM" / "盘上没记 ownerPid" /
 *  "属主已死 (孤儿)" / "标记写了但 SIGTERM 失败", 一律回 "已请求取消" 就是画一个按了
 *  不发生的东西。
 */
export type CancelOutcome =
  | { kind: 'signalled'; pid: number; signal: 'SIGTERM' }
  | { kind: 'no-owner-pid' }
  | { kind: 'pid-dead'; pid: number }
  | { kind: 'signal-failed'; pid: number; error: string };

/**
 * 记一次人工介入 (INV-RC-1 / INV-RC-2)。
 *
 *  与 `intervene.ts:74-81` 那段 `appendBoard(...)` **逐字同构**:
 *   · `v: 1` · `event: 'intervened'` · `cause` 取自 `FAILURE_KIND_ORDER` (同词表)
 *   · `ts` 现取 ISO (parity test 通过对比时戳以外字段验证)
 *   · `note` 可选, trim 后空串**不**留字段 (与原 MCP 行为逐字一致)
 *
 *  cause 不在词表 → 抛 `Error` (调用方 — MCP 的 err 回执 / TUI 的对话框 — 各自翻译)。
 *  runId 空 → 抛。**不**做"双层闸"的写法 (MCP schema 拒 + 这里再拒): 与原 MCP
 *  `intervene.ts:63-70` 的二次闸同源 —— 任一处漂都立刻见红。
 *
 * @returns 写入时的 `ts` (ISO) —— 给 parity test 做"除 ts 外逐字段相等"对账。
 */
export function recordIntervention(
  cwd: string,
  runId: string,
  cause: NodeFailureKind,
  note?: string,
): string {
  if (!runId || !runId.trim()) {
    throw new Error('recordIntervention: runId 必填');
  }
  if (!(FAILURE_KIND_ORDER as string[]).includes(cause)) {
    throw new Error(
      `recordIntervention: cause 必须落 FAILURE_KIND_ORDER, got ${JSON.stringify(cause)}`,
    );
  }
  const ts = new Date().toISOString();
  const trimmed = note?.trim();
  appendBoard(cwd, {
    v: 1,
    ts,
    runId,
    event: 'intervened',
    cause,
    ...(trimmed ? { note: trimmed } : {}),
  });
  return ts;
}

/**
 * 协作式停 detached run (S2 子进程那一路, INV-RC-3)。
 *
 *  写 `.omd/continuity/<runId>/cancel` (子进程轮询这一格, 引擎接住后协作式停) +
 *  对属主 pid 发 SIGTERM (兜底 —— 子进程卡死时由信号带走)。
 *  checkpoint 保底 `dag_resume`。
 *
 *  INV-RC-3 的二次确认是**调用方**的事 (TUI 侧用既有 `dialogs.confirm`), 这一层只写
 *  盘 + 发信号, **不**弹 dialog。
 *  INV-RC-4: 没 pid / pid 已死 → 对应 outcome, 不假装停。
 *
 *  目录防御性建 (`dag-tools.ts:574-577` 同语义): spawn 时已建好, 但写标记不该因目录
 *  缺席而失败 —— SIGTERM 是兜底, 标记是协作通道, 两者都要尽力送达。
 *  标记写失败 → `logger.warn` 但继续发信号 (fail-open: 协作通道断, 兜底不能也断)。
 *
 * @returns `CancelOutcome` —— 判别联合, 调用方按 `kind` 各画各的回执。
 */
export function cancelDetachedRun(
  cwd: string,
  runId: string,
  why: string,
  deps: RunControlDeps,
): CancelOutcome {
  const pid = deps.readOwnerPid(runId);
  if (pid === null || pid === undefined) {
    return { kind: 'no-owner-pid' };
  }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  if (!isAlive(pid)) {
    return { kind: 'pid-dead', pid };
  }
  // 目录防御性建 + 写 cancel 标记 (子进程轮询这一格; SIGTERM 是兜底)。
  try {
    mkdirSync(join(cwd, '.omd', 'continuity', runId), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'continuity', runId, 'cancel'), why);
  } catch (e) {
    // 标记写失败不阻断 SIGTERM (与 dag-tools.ts:581 同语义)。
    logger.warn(
      { runId, err: (e as Error).message },
      '[omd/run-control] cancel 标记写失败 (SIGTERM 仍会发)',
    );
  }
  const killPid = deps.killPid ?? defaultKillPid;
  try {
    killPid(pid);
  } catch (e) {
    return { kind: 'signal-failed', pid, error: (e as Error).message };
  }
  return { kind: 'signalled', pid, signal: 'SIGTERM' };
}
