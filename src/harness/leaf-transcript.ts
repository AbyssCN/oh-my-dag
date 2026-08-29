/**
 * harness/leaf-transcript —— **叶子逐事件留痕**(2026-08-29,opt-in,默认关)。
 *
 * ## 为什么加
 *
 * code80 锚点批里最强的一个相关量是 leaf 空转:按 spin 次数分桶,reward 从 0.453(0 次)
 * 单调掉到 0.238(6 次以上),并且在 easy/medium/hard **三层里方向一致**。
 * 但要判「空转到底是病因还是只是难题的伴随现象」,得看叶子**当时到底在调什么** ——
 * 而那份 transcript **一个字节都没留下**:`AgentLeafRunnerOpts.onEvent` 这个钩子
 * 从加进来那天起就没有任何生产调用方。
 *
 * 于是最大的那条线索是**不可诊断的**。这个文件补的就是这一格:把事件流按行落盘,
 * 下一批就能回答那个问题。
 *
 * ## 边界(每一条都是刻意的)
 *
 * · **默认关**:没有 `OMD_LEAF_TRANSCRIPT` 就不接线,热路径零开销(同 onEvent 原注释的承诺)。
 * · **双上限**:事件条数与字节数各一个,先到先停。停了写一行 `__truncated__` 再闭嘴 ——
 *   悄悄停下会让读的人把"截断"读成"叶子不动了",那正是本仓坑 ①(NULL ≠ 0 ≠ 不适用)。
 * · **永不抛**:写盘失败只记一次 warn 就转静默。留痕是排障件,不许它把 run 弄挂。
 * · **不做脱敏**:事件里有工具参数,而工具参数里可能有仓内任意内容。所以它是**排障开关**,
 *   不是可以长开的审计日志。谁开谁负责那份盘。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger';

export interface LeafTranscriptSinkOpts {
  /** 落盘路径 (JSONL, 追加)。父目录不存在则建。 */
  path: string;
  /** 事件条数上限。默认 20_000。 */
  maxEvents?: number;
  /** 累计字节上限。默认 32 MiB。 */
  maxBytes?: number;
}

/** 每条事件里被截短的字符串上限 —— 单条工具结果可能是整个文件, 不截会把盘吃穿。 */
const MAX_FIELD_CHARS = 4_000;

/** 深截断: 只截字符串叶子, 结构原样 (结构才是分析要看的东西)。 */
function truncateDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…[+${v.length - MAX_FIELD_CHARS}]` : v;
  if (depth >= 6) return '…[deep]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => truncateDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = truncateDeep(val, depth + 1);
    return out;
  }
  return v;
}

/**
 * 造一个 `onEvent` 汇。返回的函数吃 agent-leaf 的事件, 按行追加 JSONL。
 *
 * 反向自检: 把 `maxEvents` 设成 1 → 第二条事件之后只多出一行 `__truncated__`, 不再增长。
 */
export function createLeafTranscriptSink(opts: LeafTranscriptSinkOpts): (event: { type: string; [k: string]: unknown }) => void {
  const maxEvents = opts.maxEvents ?? 20_000;
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  let events = 0;
  let bytes = 0;
  let stopped = false;
  let warned = false;
  let dirReady = false;

  return (event) => {
    if (stopped) return;
    try {
      if (!dirReady) {
        mkdirSync(dirname(opts.path), { recursive: true });
        dirReady = true;
      }
      if (events >= maxEvents || bytes >= maxBytes) {
        stopped = true;
        appendFileSync(opts.path, `${JSON.stringify({ ts: Date.now(), type: '__truncated__', events, bytes, maxEvents, maxBytes })}\n`);
        return;
      }
      const line = `${JSON.stringify({ ts: Date.now(), ...(truncateDeep(event) as Record<string, unknown>) })}\n`;
      appendFileSync(opts.path, line);
      events += 1;
      bytes += line.length;
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据 (仓规坑 ②): 记一次原文, 之后转静默免刷屏。
      if (!warned) {
        warned = true;
        logger.warn({ path: opts.path, err: (err as Error).message }, '[leaf-transcript] 写入失败 → 本次 run 不再留痕 (不影响主流程)');
      }
      stopped = true;
    }
  };
}
