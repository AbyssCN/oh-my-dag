/**
 * src/tui/usage/ledger —— **TUI 的调用账本**(切片②,v5 第四节的算法,逐字照做)。
 *
 * ## 每次调用记一条,5h 窗口 = 扫记录求和
 *
 * 记录形状照 v5 定死:`(ts, model, source, in, out, cacheHit, costUsd)`。
 * 窗口是**滚动**的(`now - 5h` 之后求和),不是自然小时。
 *
 * ## 两个来源,同一个入口(2026-08-09 起)
 *
 * - `engine`:omd gateway 的每次 `callModel` —— DAG 扇出烧的 conductor/leaf/verifier;
 * - `chat`:对话轮(`runChatTurn` 在轮内**逐条** emit,一条 assistant = 一次 provider 调用)。
 *
 * 两者都经 `emitModelUsage` 这一个钩子进账,`source` 由 **emit 侧的第三参**带过来 ——
 * 订阅侧分不出是谁烧的,所以不许在订阅处编一个恒定标签。
 * ⚠ backend **不再**在轮末补记合计:那一笔与轮内的逐条是同一份钱,记两遍
 * (生产账本上留下过 10 对 in/out 相同、相差 1-5ms 的孪生行)。
 *
 * ## 边界诚实(v5 原话)
 *
 * 这份账本只见**经 omd 烧的**。同一个订阅若还被别的客户端(Claude Code)同时用,
 * 那部分看不见 —— 所以订阅那格画的是「omd 视角下界」,措辞用「本地 ≥N」不用「已用 N」。
 *
 * ## 持久化
 *
 * `.omd/tui-usage.jsonl` 追加式 —— 5h 窗口要跨 TUI 重启存活。启动时读回,
 * 超过 50k 行时压缩成最近 10k 行(无界增长是已知的脏场景,5 行保险)。
 * 坏行静默跳过(fail-open),但**写失败要留日志**(fail-open 不吞证据)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../logger';
import { computeCost } from '../../model/cost-ledger';
import type { ModelUsage } from '../../model/types';

export interface UsageRecord {
  ts: number;
  /** `provider:model` 坐标。 */
  model: string;
  source: 'chat' | 'engine';
  in: number;
  out: number;
  cacheHit: number;
  /** `null` = 订阅通道(花的是额度不是美元,NULL ≠ 0);判别靠 `channel` 列。 */
  costUsd: number | null;
  /** 价表里没有这个坐标(ECON-3)。合计时分开报 —— 0 元与没计价不是一回事。 */
  unpriced: boolean;
  /** 计价通道。缺席 = api(老行向后兼容)。 */
  channel?: 'subscription';
}

export interface ProviderWindow {
  provider: string;
  calls: number;
  in: number;
  out: number;
  cacheHit: number;
  costUsd: number;
  /** 窗口内有没有没计价的调用 —— 有的话 cost 是下界不是真值。 */
  unpriced: boolean;
}

export interface WindowSummary {
  /** 窗口起点(`now - windowMs`)。 */
  since: number;
  calls: number;
  in: number;
  out: number;
  cacheHit: number;
  costUsd: number;
  unpriced: boolean;
  byProvider: ProviderWindow[];
}

export interface TuiUsageLedger {
  /** 记一笔并持久化。 */
  record(usage: ModelUsage, model: string, source: 'chat' | 'engine'): UsageRecord;
  /** 滚动窗口汇总(默认 5h)。 */
  window(windowMs?: number): WindowSummary;
  /** 本进程起动以来的合计(底栏「会话」那格)。 */
  sessionTotal(): { calls: number; in: number; out: number; cacheHit: number; costUsd: number; unpriced: boolean };
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/** 账本文件(相对 `.omd/`)。 */
export const USAGE_LEDGER_FILE = 'tui-usage.jsonl';

const providerOf = (model: string): string => model.split(':')[0] || model;

export function createTuiUsageLedger(opts: { dir: string; now?: () => number }): TuiUsageLedger {
  const now = opts.now ?? Date.now;
  const path = join(opts.dir, USAGE_LEDGER_FILE);
  /** 内存里保留全部已知记录(读窗口不回盘)。 */
  let records: UsageRecord[] = [];
  /** 本进程写的那部分(「会话」合计)。 */
  const mine: UsageRecord[] = [];

  // ── 启动读回(跨重启的 5h 窗口)。坏行跳过, 超长压缩。 ──
  if (existsSync(path)) {
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (typeof r.ts === 'number' && typeof r.model === 'string') records.push(r);
        } catch {
          // 坏行跳过 —— 账本是读数不是闸
        }
      }
      if (lines.length > 50_000) {
        records = records.slice(-10_000);
        writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, path }, '[omd/tui-usage] 账本读回失败 (从空开始, 5h 窗口丢失)');
    }
  }

  const persist = (r: UsageRecord): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(r)}\n`);
    } catch (err) {
      // fail-open: 记账失败不打断调用 —— 但证据要留。
      logger.warn({ err: (err as Error).message, path }, '[omd/tui-usage] 账本写入失败 (该笔只在内存)');
    }
  };

  const sum = (rs: readonly UsageRecord[]) => {
    const t = { calls: 0, in: 0, out: 0, cacheHit: 0, costUsd: 0, unpriced: false };
    for (const r of rs) {
      t.calls += 1;
      t.in += r.in;
      t.out += r.out;
      t.cacheHit += r.cacheHit;
      // null = 订阅通道 (channel 列判别), USD 合计合法跳过 —— 不是 0 也不是 NaN。
      // undefined (老行缺字段) 仍走 += → NaN: 「尺子坏了」的信号不许吞 (budget.ts 同口径)。
      if (r.costUsd !== null) t.costUsd += r.costUsd;
      t.unpriced ||= r.unpriced;
    }
    return t;
  };

  return {
    record(usage, model, source) {
      const breakdown = computeCost(usage, model);
      const r: UsageRecord = {
        ts: now(),
        model,
        source,
        in: usage.in,
        out: usage.out,
        cacheHit: usage.cacheHit ?? 0,
        costUsd: breakdown.costUsd,
        unpriced: breakdown.unpriced,
        ...(breakdown.channel ? { channel: breakdown.channel } : {}),
      };
      records.push(r);
      mine.push(r);
      persist(r);
      return r;
    },
    window(windowMs = FIVE_HOURS_MS) {
      const since = now() - windowMs;
      const inWin = records.filter((r) => r.ts >= since);
      const byProviderMap = new Map<string, UsageRecord[]>();
      for (const r of inWin) {
        const p = providerOf(r.model);
        const arr = byProviderMap.get(p) ?? [];
        arr.push(r);
        byProviderMap.set(p, arr);
      }
      const byProvider: ProviderWindow[] = [...byProviderMap.entries()]
        .map(([provider, rs]) => ({ provider, ...sum(rs) }))
        .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
      return { since, ...sum(inWin), byProvider };
    },
    sessionTotal() {
      return sum(mine);
    },
  };
}
