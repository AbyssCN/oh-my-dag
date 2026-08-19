/**
 * src/harness/session/omd-checkpoint —— omd **自己的**会话什么时候存一次交接档(#211)。
 *
 * Claude Code 那头我们只能等它发 `Stop` / `PreCompact`;omd 的循环是自己的代码,
 * 该存档的那两个时刻**本来就在跑**(轮尾落盘、压缩),缺的只是一个出口。本模块就是那个出口。
 *
 * 档距口径与 CC 那条共用 `bucket.ts` —— 同一个人在两个 harness 下不该拿到两种存档节奏。
 *
 * ## 为什么档位基准放在内存里
 *
 * CC 那条能无状态判定,是因为它每次都重读整个 transcript(ledger 里有全部历史读数)。
 * omd 这条是**长驻进程**,每轮只知道"这一刻多少 token",没有历史序列可比。所以记一个
 * per-session 的已触发档位。进程重启 → 基准回 0 → 最多**多存一次**档:方向是安全的那边
 * (宁可多一份交接,不可少一份),而且不会连环触发 —— 存完基准就更新了。
 *
 * @module
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { logger } from '../logger';
import { createOmdMemory } from '../memory';
import { resolveMemoryDbPath } from '../memory/db-path';
import { CONTINUITY_SAFEGUARD } from '../../memory/safeguards/continuity-namespace';
import { bucketIndex, bucketThreshold } from './bucket';
import { omdSessionSource, type OmdEntryLike } from './source';
import { runWriter, type WriterMode, type WriterResult } from './writer';
import type { OmdMemory } from '../memory';

export interface OmdCheckpointDecision {
  readonly fire: boolean;
  readonly mode: WriterMode;
  readonly bucket: number;
  readonly why: string;
}

/**
 * 该不该存(纯函数)。
 *
 * - **本轮压缩过** → 存,`precompact`。压缩是"上下文要被换掉"的那一刻,与档位无关。
 * - **跨档** → 存,`rolling`。
 * - `ctxTokens` 量不到(`null`)→ **不存**:没有读数就没有判据,伪造一个数比不存更糟。
 */
export function decideOmdCheckpoint(opts: {
  ctxTokens: number | null;
  /** 本 session 已经触发过的最高档(没触发过 = 0)。 */
  lastFiredBucket: number;
  /** 本轮是否发生过上下文压缩。 */
  compacted: boolean;
  env?: NodeJS.ProcessEnv;
}): OmdCheckpointDecision {
  if (opts.compacted) return { fire: true, mode: 'precompact', bucket: opts.lastFiredBucket, why: '本轮压缩过' };

  const threshold = bucketThreshold(opts.env ?? process.env);
  if (threshold === null) {
    return { fire: false, mode: 'rolling', bucket: 0, why: 'OMD_SESSION_BUCKET 配置坏 → 不造档位' };
  }
  if (opts.ctxTokens === null) {
    return { fire: false, mode: 'rolling', bucket: 0, why: 'ctx 量不到 → 不伪造读数' };
  }

  const idx = bucketIndex(opts.ctxTokens, threshold);
  if (idx < 1) return { fire: false, mode: 'rolling', bucket: idx, why: `未过首档 (${opts.ctxTokens} < ${threshold})` };
  if (idx <= opts.lastFiredBucket) return { fire: false, mode: 'rolling', bucket: idx, why: `同档延续 (${idx})` };
  return { fire: true, mode: 'rolling', bucket: idx, why: `跨到 ${idx} 档` };
}

/**
 * 交接镜像层实例。**窄闸**(只 continuity 一格)与 `scripts/session-writer.ts` 同款 ——
 * 写入面不该因为要写一条交接就放宽。开不出来返 `null`:markdown 仍会落盘,少的只是镜像。
 */
function openContinuityMemory(cwd: string, env: NodeJS.ProcessEnv): OmdMemory | null {
  try {
    const path = resolve(cwd, resolveMemoryDbPath(env));
    mkdirSync(resolve(path, '..'), { recursive: true });
    return createOmdMemory({ path, safeguard: CONTINUITY_SAFEGUARD });
  } catch (err) {
    logger.warn(
      { cwd, err: err instanceof Error ? err.message : String(err) },
      '[session-continuity] 镜像层开不出 → 只落 markdown (不阻断)',
    );
    return null;
  }
}

/** per-session 已触发档位。进程级,重启即忘(见模块头注:方向安全)。 */
const firedBuckets = new Map<string, number>();

/** 测试用:清掉档位记忆(生产没有调用方 —— 长驻进程不该有人手动重置它)。 */
export function resetOmdCheckpointStateForTest(): void {
  firedBuckets.clear();
}

export interface OmdCheckpointDeps {
  sessionId: string;
  cwd: string;
  /** 会话条目读取(append-only)。 */
  entries: () => Promise<readonly OmdEntryLike[]>;
  /** 这一刻的 ctx token 真值;量不到传 `null`。 */
  ctxTokens: number | null;
  /** 本轮是否压缩过。 */
  compacted?: boolean;
  /**
   * 镜像层**注入口(测试用)**。省略 = 自己开一个(见 `openContinuityMemory`)。
   *
   * ⚠ 刻意**不复用** `ChatTurnOpts.memory` —— 那一个是「每轮请求前自动召回」用的
   * (S16/A8),而 owner 2026-08-18 把自动注入关了(`MEMORY_REQUERY=0`,观察窗到 09-01)。
   * 借它来写交接会把两件事绑死:哪天谁为了关召回把它摘掉,交接的 facts 就跟着静默消失。
   */
  memory?: OmdMemory;
  env?: NodeJS.ProcessEnv;
  /** 测试接缝:替换真 writer(真 writer 要真模型)。生产不传。 */
  runWriterFn?: typeof runWriter;
}

/**
 * 判 + 存。**全程 fail-open**:判不该存 → `null`;存挂了 → `null` + 一行 warn。
 * 交接是附加价值,它永远不该把正在跑的那一轮弄失败。
 *
 * ⚠ 调用方**不要 await**(蒸馏要打一次模型,秒级):`void maybeCheckpointOmdSession(...)`。
 * 这里仍返回 Promise 是为了可测 —— 测试要等得到结果。
 */
export async function maybeCheckpointOmdSession(deps: OmdCheckpointDeps): Promise<WriterResult | null> {
  try {
    const lastFiredBucket = firedBuckets.get(deps.sessionId) ?? 0;
    const decision = decideOmdCheckpoint({
      ctxTokens: deps.ctxTokens,
      lastFiredBucket,
      compacted: deps.compacted === true,
      ...(deps.env ? { env: deps.env } : {}),
    });
    if (!decision.fire) return null;

    // 先更新基准再跑:蒸馏是秒级的,同一 session 的下一轮不该因为"上一次还没写完"再触发一次。
    firedBuckets.set(deps.sessionId, Math.max(lastFiredBucket, decision.bucket));

    // 镜像层:调用方没给就自己开一个窄闸实例(只 continuity 一格),用完就关。
    // 库位置与该 repo 的 MCP 读面同一条解析(`resolveMemoryDbPath`),对 `deps.cwd` 取绝对 ——
    // 相对路径按 `process.cwd()` 解会在长驻进程里指到别处去。
    const owned = deps.memory ? null : openContinuityMemory(deps.cwd, deps.env ?? process.env);
    const memory = deps.memory ?? owned;

    const run = deps.runWriterFn ?? runWriter;
    // `OMD_CONTINUITY_MECHANICAL=1` → 跳过模型调用(与 CC hook 同一个旋钮)。
    // 有了它,「轮尾真的会派存档」这条接线闸才跑得成确定性 —— 否则它要打一次真模型。
    const mechanical = (deps.env ?? process.env).OMD_CONTINUITY_MECHANICAL === '1';
    let res: WriterResult;
    try {
      res = await run({
        sessionId: deps.sessionId,
        cwd: deps.cwd,
        mode: decision.mode,
        ...(mechanical ? { mechanical: true } : {}),
        source: omdSessionSource({
          entries: deps.entries,
          ctxTokens: () => deps.ctxTokens,
        }),
        ...(memory ? { memory } : {}),
      });
    } finally {
      // 自己开的自己关 —— 抛出去也要关(长驻进程里漏一个 sqlite 句柄就是漏一路)。
      owned?.close();
    }
    logger.info(
      { sessionId: deps.sessionId, mode: decision.mode, why: decision.why, chars: res.chars, degraded: res.degraded },
      '[session-continuity] omd 会话已存档',
    );
    return res;
  } catch (err) {
    // fail-open 吞异常,但**不吞证据**(仓规坑②)。
    logger.warn(
      { sessionId: deps.sessionId, err: err instanceof Error ? err.message : String(err) },
      '[session-continuity] omd 会话存档失败 (已吞, 不影响这一轮)',
    );
    return null;
  }
}
