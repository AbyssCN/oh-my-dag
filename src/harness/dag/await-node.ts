/**
 * src/harness/dag/await-node —— 跨 run 等待节点 (S3, executor:'await')。
 *
 * 引擎 park 该节点, 等待 run-board 上出现匹配的 published 条目后 unpark:
 * 确定性 git 合入 published commit, 然后继续下游。
 *
 * ## 谓词 (D-6 满足条件)
 * - published.artifact === spec.artifact
 * - spec.fromRun 给定时 published.runId === spec.fromRun
 * - published.writeSet 与本 run 声明的 spec.writeSet **不相交** (相交 → 不满足, 一直等到超时)
 *
 * ## 中止条件 (D-6)
 * - fromRun terminal 而无 published → 立即 STALLED (不等 timeoutMs) + suggested 票
 * - 等满 timeoutMs 无满足条目 → STALLED + suggested 票
 *
 * ## 不变量
 * - INV-3: 等待期零模型调用 (llmCalls 恒 0)
 * - INV-4/D-7: 合入冲突 → STALLED + 票, 无静默继续路径
 * - INV-6: 零 LLM, 纯本地 IO + git
 *
 * ## 文件监视
 * - fs.watch 盯 .omd/run-board.jsonl (主触发, 事件即醒)
 * - 低频 poll (opts.pollMs) 兜底 (WSL2 触发可靠性未实测)
 *
 * ## 本模块**写**板 (#205, 2026-08-19) —— 为什么这不违反「渲染零写」
 *
 * 到 2026-08-19 为止本模块只 `readBoard` 从不写, 于是「有个节点正卡在等某份 artifact」
 * 这件事**根本没被记下来**: #96 的观察面画不出它, 而**从别的事实去推它是错的**
 * (「某 artifact 至今没 published」既可能是有人在等, 也可能压根没人等 —— NULL≠0)。
 *
 * 所以这里进等待时 `appendBoard` 一条 `awaiting`。这与「渲染零写铁律」不冲突, 因为那条约束
 * 的是**观察面**: 观察面一旦写盘就从旁观者变成了参与者。而 await-node **本来就是参与者** ——
 * 它写的是**自己的等待事实**(我在等哪份、从什么时候起、最多等多久), 不是别人的状态,
 * 也不改任何判定。板上其它写者 (goal / intervene / ignition-preflight) 记的同样是自己那半。
 *
 * 只记不改判: 这一条 `awaiting` **不参与** unpark 谓词与中止条件 —— 上面那两节一字未动。
 *
 * @module
 */
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { appendBoard, readBoard } from '../board/run-board';
import { logger } from '../logger';

// ─── 冻结接口 ──────────────────────────────────────────────────────────────────

export interface AwaitSpec {
  /** 等待的 artifact 名 (匹配 published.artifact)。 */
  artifact: string;
  /** 超时毫秒 (D-8 默认 3h = 10_800_000)。 */
  timeoutMs: number;
  /** 本 run 声明的写集 (与 published.writeSet 判不相交)。 */
  writeSet: string[];
  /** 限定前置 run id; 不给 = 任意 run 的 published 都匹配。 */
  fromRun?: string;
}

export interface AwaitOptions {
  /** poll 间隔毫秒 (fs.watch 触发不可靠时的兜底)。 */
  pollMs: number;
  /** 本节点 run id (进 ticket 的 suggestedBy)。 */
  runId: string;
}

export interface AwaitTicket {
  status: 'suggested';
  reason: string;
  suggestedBy: string;
  title: string;
}

export interface AwaitResult {
  verdict: 'unparked' | 'stalled';
  /** unparked 时合入的 commit hash。 */
  commit?: string;
  tickets: AwaitTicket[];
  /** INV-3: 恒 0 —— 等待期零模型调用。 */
  llmCalls: number;
}

// ─── 默认值 ────────────────────────────────────────────────────────────────────

/** D-8: 默认超时 3 小时。 */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** fs.watch 退化 poll 间隔 (30s), 仅当外部未注入 pollMs 时用。 */
const DEFAULT_POLL_MS = 30_000;

// ─── 内部工具 ──────────────────────────────────────────────────────────────────

function stalled( reason: string, suggestedBy: string, title: string,): AwaitResult {
  return {
    verdict: 'stalled',
    tickets: [{ status: 'suggested', reason, suggestedBy, title }],
    llmCalls: 0,
  };
}

function unparked(commit: string): AwaitResult {
  return { verdict: 'unparked', commit, tickets: [], llmCalls: 0 };
}

/** 两个写集是否有交集 (D-6 不相交判据)。 */
function intersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((w) => b.includes(w));
}

/**
 * 确定性 git 合入 commit 到当前 HEAD。
 * 冲突 → 抛 Error (调用方转 STALLED + 票, INV-4/D-7 无静默继续路径)。
 */
function gitMerge(root: string, commit: string): void {
  const r = Bun.spawnSync(['git', 'merge', commit, '--no-edit'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) {
    const errText = new TextDecoder().decode(r.stderr).trim();
    throw new Error(`git merge ${commit.slice(0, 7)} 失败: ${errText.slice(0, 300)}`);
  }
}

// ─── 冻结接口实现 ──────────────────────────────────────────────────────────────

/**
 * 等待 run-board 上出现匹配 published 条目, 然后 git 合入其 commit。
 *
 * 全程零模型调用 (INV-3/INV-6): 纯本地 IO + 确定性 git。
 */
export async function awaitNode(
  root: string,
  spec: AwaitSpec,
  opts: AwaitOptions,
): Promise<AwaitResult> {
  const deadline = Date.now() + (spec.timeoutMs || DEFAULT_TIMEOUT_MS);
  const pollMs = opts.pollMs || DEFAULT_POLL_MS;

  // ── fs.watch 主触发 + poll 兜底 ──
  let watcher: FSWatcher | null = null;
  let wake: (() => void) | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  const omdDir = join(root, '.omd');
  try {
    mkdirSync(omdDir, { recursive: true });
    watcher = watch(omdDir, { persistent: false }, () => {
      // 板文件有动静 → 提前醒来检查谓词; 无人在睡 → 忽略 (poll 兜底)
      const w = wake;
      if (w && wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
        wake = null;
        w();
      }
    });
  } catch {
    // watch 不可用 (权限/平台) → 纯 poll, 不阻塞
  }

  /** 睡到 pollMs 或 watch 触发 (谁先到谁醒); watcher 为空 → 纯 poll。 */
  const waitForNextCheck = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
      wakeTimer = setTimeout(() => {
        wake = null;
        wakeTimer = null;
        resolve();
      }, ms);
    });

  try {
    // ── 首次检查: fromRun 是否已经 terminal ──
    if (spec.fromRun) {
      const initial = readBoard(root);
      if (isTerminalWithoutPublish(initial, spec.fromRun, spec.artifact)) {
        return stalled(
          'predecessor-terminal',
          opts.runId,
          `前置 run ${spec.fromRun} 已 terminal 且未发布 artifact "${spec.artifact}"`,
        );
      }
    }

    // ── 首次检查: published 是否已存在 ──
    {
      const r = tryUnpark(root, readBoard(root), spec, opts);
      if (r) return r;
    }

    // ── #205: 真要等了才记 ──
    // 落在两次首检**之后**是刻意的: 前面两条任一命中就直接返回, 那种"根本没等"的情况
    // 记一条 awaiting 会让观察面闪一下一个从不存在的等待 (而板是 append-only, 抹不掉)。
    // 只记不改判 —— 下面的谓词与中止条件一字未动。
    // fail-open: 写板失败不拦等待 (板是观测面, 等待才是本职), 但不吞证据。
    try {
      appendBoard(root, {
        v: 1,
        ts: new Date().toISOString(),
        runId: opts.runId,
        event: 'awaiting',
        artifact: spec.artifact,
        timeoutMs: spec.timeoutMs || DEFAULT_TIMEOUT_MS,
        ...(spec.fromRun ? { fromRun: spec.fromRun } : {}),
      });
    } catch (err) {
      logger.warn(
        { runId: opts.runId, artifact: spec.artifact, err: err instanceof Error ? err.message : String(err) },
        '[omd/await] 记 awaiting 失败 → 观察面看不见这次等待 (等待本身照跑)',
      );
    }

    // ── 等待循环: watch 主触发, poll 兜底 ──
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // watch 触发 → 立即醒来检查; 否则睡到 pollMs (或剩余超时) 再查
      const sleepMs = Math.min(pollMs, remaining);
      await waitForNextCheck(sleepMs);

      const entries = readBoard(root);

      // 中止条件: fromRun terminal 而无 published → 立即 STALLED (D-6)
      if (spec.fromRun && isTerminalWithoutPublish(entries, spec.fromRun, spec.artifact)) {
        return stalled(
          'predecessor-terminal',
          opts.runId,
          `前置 run ${spec.fromRun} 已 terminal 且未发布 artifact "${spec.artifact}"`,
        );
      }

      const r = tryUnpark(root, entries, spec, opts);
      if (r) return r;
    }

    // ── 超时 ──
    return stalled(
      'timeout',
      opts.runId,
      `等待 artifact "${spec.artifact}"${spec.fromRun ? ` (fromRun ${spec.fromRun})` : ''} 超时 (${spec.timeoutMs}ms)`,
    );
  } finally {
    if (wakeTimer) clearTimeout(wakeTimer);
    if (watcher) {
      try { watcher.close(); } catch { /* 关闭失败不抛 */ }
    }
  }
}

// ─── 内部谓词 ──────────────────────────────────────────────────────────────────

/**
 * 遍历板条目, 找第一个满足谓词的 published 条目并尝试 git 合入。
 * 找到但合入冲突 → 直接返回 STALLED (不继续等下一个, INV-4/D-7)。
 * 未找到满足条目 → null (继续等)。
 */
function tryUnpark(
  root: string,
  entries: ReturnType<typeof readBoard>,
  spec: AwaitSpec,
  opts: AwaitOptions,
): AwaitResult | null {
  for (const e of entries) {
    if (e.event !== 'published') continue;
    if (e.artifact !== spec.artifact) continue;
    if (spec.fromRun && e.runId !== spec.fromRun) continue;
    if (!e.commit) continue;

    // D-6 写集不相交判据
    if (intersects(e.writeSet ?? [], spec.writeSet)) continue;

    // 满足 → 确定性 git 合入
    try {
      gitMerge(root, e.commit);
    } catch (err) {
      return stalled(
        'merge-conflict',
        opts.runId,
        `合入 published commit ${e.commit.slice(0, 7)} (artifact "${spec.artifact}") 时失败: ${(err as Error).message.slice(0, 200)}`,
      );
    }
    return unparked(e.commit);
  }
  return null;
}

/** fromRun 是否已 terminal 且没有匹配的 published 条目。 */
function isTerminalWithoutPublish(
  entries: ReturnType<typeof readBoard>,
  runId: string,
  artifact: string,
): boolean {
  const hasTerminal = entries.some((e) => e.runId === runId && e.event === 'terminal');
  if (!hasTerminal) return false;
  const hasPublished = entries.some(
    (e) => e.runId === runId && e.event === 'published' && e.artifact === artifact,
  );
  return !hasPublished;
}
