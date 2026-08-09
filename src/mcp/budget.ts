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
 * 订上去,engine 侧逐条落这里)。本闸只调 `createTuiUsageLedger(...).window(7d)` ——
 * 读回/坏行跳过/求和全是账本自己的既有逻辑,这里一行解析都不重写。
 *
 * **每次检查现开一个实例** = 现读盘,不是复用某个长活实例。两个理由:
 * ① MCP server 是长驻进程,而账本是**多写者**(TUI、别的 omd 进程、本进程的 engine 钩子)
 *    各自 append —— 进程内那份 `records` 只含该实例亲眼见过的;
 * ② 因此**一轮跑到半截跨线也看得见**(轮前没超、图烧超了 → 下一次派图当场被拦)。
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
import { logger } from '../harness/logger';
import { createTuiUsageLedger } from '../tui/usage/ledger';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
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
    const w = createTuiUsageLedger({ dir: opts.dir, ...(opts.now ? { now: opts.now } : {}) }).window(SEVEN_DAYS_MS);
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
