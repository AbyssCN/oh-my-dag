/**
 * src/mcp/budget —— **周预算闸**(SDD 2026-08-09 远程指挥接缝 §2 ECON)。
 *
 * Claude→omd 全执行路由烧的是计费 API 真金。裁决:dogfooding 数据现在比省钱值钱,
 * 但设一道**周上限** —— 滚动 7 天窗口聚合账本支出,超限则 conductor 不接新活、不派新图,
 * 以 `lane="owner"` 上报(§2 原话:「超限 → conductor 拒新图并以 lane="owner" 上报」)。
 *
 * ## 读数从哪来 —— 复用 TUI 账本,不另起一本
 *
 * `.omd/tui-usage.jsonl` 是**一个仓一本账**(`harness/cli.ts` 的 mcp 分支已把 emitModelUsage
 * 订上去,engine 侧逐条落这里)。
 *
 * ## 增量读(S-E, 契约 C-7;此前每次检查整本重解析,压实阈值 50k 行 = 稳态 ~190× 今日量)
 *
 * 唯一合法形态 = **append 字节偏移续读,禁 TTL**(普查 §1.2:账本多写者——TUI、别的 omd
 * 进程、本进程 engine 钩子各自 append;这条闸的全部意义是「图 N 看得见图 1..N−1 烧掉的」,
 * 按偏移读新增字节保住了「轮中途越线下一次派图当场被拦」)。三条护栏:
 * ① 文件尺寸 < 已读偏移 → 压实/重写发生过 → memo 作废整本重读(账本压实在 ledger 构造时
 *    会把 50k 行截成 10k 行,偏移必失效);
 * ② 尾部半行(写者写到一半)留 carry 下轮拼——多写者 append 原子性只到行粒度;
 * ③ 出窗修剪只对**窗口前移**成立;更宽窗口的查询(since < prunedBefore)→ memo 作废重读,
 *    正确性优先于省一次全读。
 * 解析刀法与账本逐字同(JSON 坏行跳过;`ts` number ∧ `model` string 才算一条;
 * costUsd 缺失 → 求和 NaN 语义原样保留 —— 那是「尺子坏了」的信号,不许吞)。
 *
 * ## NULL ≠ 0 ≠ 不适用(本仓纪律,这里三种都出现)
 *
 * - **未计价行**(`unpriced`:价表里没这个坐标)→ 它的 `costUsd` 是 0,但那不是「没花钱」。
 *   于是聚合出来的 `costUsd` 是**下界**,超限判断**只基于已计价部分** —— 偏保守放行
 *   (宁可漏拦一次,不因为一个缺价表坐标就把 owner 的活拦死)。`unpriced` 原样带进判词。
 * - **账本里没这段记录**(`calls === 0`)→ 是「没记」不是「没花」(新仓 / 账本刚被压缩 /
 *   OMD_TUI_USAGE_DIR 指到别处)。一样放行,但这与「真的没花」在数据上分不开,别当成后者读。
 * - **读数不可用**(`costUsd === null`)→ 账本里有行缺 `costUsd` 字段,求和成 NaN。
 *   那不是 0,也不是「没超」—— 是尺子坏了。fail-open 放行,但**留一行证据**(warn 带路径)。
 *
 * ## 关闸
 *
 * `OMD_WEEKLY_BUDGET_USD=0` 显式关。非法值(负数/写错字)**不当 0** —— 回落默认并 warn,
 * 否则打错一个字符 = 闸悄悄没了(那正是本仓最贵的静默失效形态)。
 */
import { join } from 'node:path';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { logger } from '../harness/logger';
import { USAGE_LEDGER_FILE } from '../tui/usage/ledger';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ── C-7 增量读 memo(按账本路径;设计见文件头「增量读」节) ───────────────────
interface BudgetRow {
  ts: number;
  /** 可能缺失(老行)—— 求和成 NaN 是「尺子坏了」信号,原样保留。 */
  costUsd?: number;
  unpriced: boolean;
}
interface LedgerMemo {
  offset: number;
  carry: string;
  rows: BudgetRow[];
  prunedBefore: number;
}
const ledgerMemos = new Map<string, LedgerMemo>();

/** 测试钩子:跨用例不串味。 */
export function resetBudgetLedgerMemoForTest(): void {
  ledgerMemos.clear();
}

const freshMemo = (): LedgerMemo => ({ offset: 0, carry: '', rows: [], prunedBefore: 0 });

/** 增量读账本 → 窗内 {calls, costUsd, unpriced}。语义与 ledger.window() 的三个消费字段逐分等价。 */
function readWeeklyWindow(dir: string, windowMs: number, nowMs: number): { calls: number; costUsd: number; unpriced: boolean } {
  const path = join(dir, USAGE_LEDGER_FILE);
  const since = nowMs - windowMs;
  let memo = ledgerMemos.get(path);
  if (!memo || since < memo.prunedBefore) {
    // 护栏③:更宽窗口够不着已修剪的行 → 作废重读(正确性 > 省一次全读)。
    memo = freshMemo();
    ledgerMemos.set(path, memo);
  }
  if (!existsSync(path)) {
    ledgerMemos.set(path, freshMemo());
    return { calls: 0, costUsd: 0, unpriced: false };
  }
  const size = statSync(path).size;
  if (size < memo.offset) {
    // 护栏①:压实/重写发生过,偏移作废。
    memo = freshMemo();
    ledgerMemos.set(path, memo);
  }
  if (size > memo.offset) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - memo.offset);
      const n = readSync(fd, buf, 0, buf.length, memo.offset);
      memo.offset += n;
      const text = memo.carry + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      memo.carry = parts.pop() ?? ''; // 护栏②:尾部半行留下轮拼
      for (const line of parts) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as { ts?: unknown; model?: unknown; costUsd?: number; unpriced?: unknown };
          if (typeof r.ts === 'number' && typeof r.model === 'string') {
            memo.rows.push({ ts: r.ts, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), unpriced: r.unpriced === true });
          }
        } catch {
          // 坏行跳过 —— 与账本同刀法(账本是读数不是闸)
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  if (since > memo.prunedBefore) {
    memo.rows = memo.rows.filter((r) => r.ts >= since);
    memo.prunedBefore = since;
  }
  let calls = 0;
  let costUsd = 0;
  let unpriced = false;
  for (const r of memo.rows) {
    if (r.ts < since) continue;
    calls += 1;
    costUsd += r.costUsd as number; // undefined → NaN:语义与 ledger.sum 逐分一致
    unpriced ||= r.unpriced;
  }
  return { calls, costUsd, unpriced };
}
/** owner 定的量级(SDD §2 标 tentative:拍的是量级不是精确值)。 */
export const DEFAULT_WEEKLY_BUDGET_USD = 50;
export const WEEKLY_BUDGET_ENV = 'OMD_WEEKLY_BUDGET_USD';

export interface WeeklyBudgetStatus {
  /** 上限($/周);0 = 闸关(env 显式设 0)。 */
  limitUsd: number;
  /** 闸生效吗(`limitUsd > 0`)。 */
  enabled: boolean;
  /**
   * 7 天滚动窗口内**已计价**部分的支出。
   * `null` = 读数不可用(账本行缺 costUsd → 求和 NaN),**不是 0**。
   */
  costUsd: number | null;
  /** 窗内有未计价调用 → 真实支出 ≥ `costUsd`(costUsd 是下界)。 */
  unpriced: boolean;
  /** 窗内记录条数。0 = 账本没这段记录(「没记」≠「没花」)。 */
  calls: number;
  /** 拦不拦 —— 只有「闸开 ∧ 读数可用 ∧ 已计价部分 ≥ 上限」才 true;其余一律放行。 */
  over: boolean;
}

/** 账本目录:与 `harness/cli.ts` 的 mcp/tui 两条分支同一个解析(OMD_TUI_USAGE_DIR 是测试接缝)。 */
export function usageLedgerDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OMD_TUI_USAGE_DIR || join(cwd, '.omd');
}

/** `OMD_WEEKLY_BUDGET_USD` 解析:未设 → 默认;`0` → 关闸;非法 → 默认 + warn(不静默当 0)。 */
export function resolveWeeklyLimitUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WEEKLY_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_WEEKLY_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { [WEEKLY_BUDGET_ENV]: raw, fallbackUsd: DEFAULT_WEEKLY_BUDGET_USD },
      `[omd/budget] ${WEEKLY_BUDGET_ENV} 值非法 → 回落默认上限(**没有关闸**;要关闸请显式写 0)`,
    );
    return DEFAULT_WEEKLY_BUDGET_USD;
  }
  return n;
}

/** 滚动 7 天窗口读账本 → 判超限。任何异常都 fail-open(放行)但留证据。 */
export function checkWeeklyBudget(opts: {
  dir: string;
  env?: NodeJS.ProcessEnv;
  /** 测试接缝(账本自己的窗口用同一个时钟)。 */
  now?: () => number;
}): WeeklyBudgetStatus {
  const env = opts.env ?? process.env;
  const limitUsd = resolveWeeklyLimitUsd(env);
  const off: WeeklyBudgetStatus = { limitUsd, enabled: limitUsd > 0, costUsd: null, unpriced: false, calls: 0, over: false };
  if (limitUsd <= 0) return off; // 闸关:一行盘都不读
  try {
    const w = readWeeklyWindow(opts.dir, SEVEN_DAYS_MS, (opts.now ?? Date.now)());
    // 缺 costUsd 的行会让账本的求和成 NaN(它按坏行跳过的只有 JSON 解析失败那种)。
    // NaN ≥ limit 恒 false —— 不写这一条的话,闸会**看起来绿着**地失效。
    if (!Number.isFinite(w.costUsd)) {
      logger.warn(
        { dir: opts.dir, calls: w.calls },
        '[omd/budget] 账本求和不是有限数 (有行缺 costUsd) → 周支出**读数不可用**, 本次放行 (不可用 ≠ 0)',
      );
      return { ...off, unpriced: w.unpriced, calls: w.calls };
    }
    return {
      limitUsd,
      enabled: true,
      costUsd: w.costUsd,
      unpriced: w.unpriced,
      calls: w.calls,
      // 只拿**已计价**部分比 —— unpriced 那部分算不进钱,所以这是下界比较,偏放行。
      over: w.costUsd >= limitUsd,
    };
  } catch (err) {
    // fail-open 可以吞异常,不许吞证据。
    logger.warn(
      { err: (err as Error).message, dir: opts.dir },
      '[omd/budget] 账本读取失败 → 本次放行 (读不到 ≠ 没花钱)',
    );
    return off;
  }
}

/** 一行读数(下界措辞:窗内有未计价调用时说「≥」)。判词里出现的钱数一律经这里,免两处漂。 */
export function renderBudgetLine(s: WeeklyBudgetStatus): string {
  const spent =
    s.costUsd === null ? '读数不可用 (账本有行缺 costUsd)' : `${s.unpriced ? '≥ ' : ''}$${s.costUsd.toFixed(2)}`;
  const tail = s.unpriced ? ' · 窗内有未计价调用, 已计价部分是下界' : '';
  return `周支出 ${spent} / 上限 $${s.limitUsd.toFixed(2)} (滚动 7 天, 账本 .omd/tui-usage.jsonl, ${s.calls} 条${tail})`;
}

/**
 * 超限上报块 —— 形状逐字照 `mcp/tools/chat.ts` 的 `HEADLESS_PROMPT_BLOCK`(S2 阀块),
 * lane 恒 `owner`:提额还是本周收手是**花谁的钱**的问题,Claude 侧禁代答。
 */
export function renderBudgetEscalation(s: WeeklyBudgetStatus): string {
  return [
    '<omd-escalation lane="owner">',
    '倾向: 本周暂停经 omd 派新活 —— 已在飞的图不动, 等 owner 决定提额还是收手。',
    `理由: ${renderBudgetLine(s)} —— 已达周预算闸 (SDD 2026-08-09 §2 ECON)。`,
    `定不了的点: 提额 / 关闸 (${WEEKLY_BUDGET_ENV}=<新上限>, 0 = 关) 是 owner 的钱与方向, 代理不得自裁。`,
    '</omd-escalation>',
  ].join('\n');
}
