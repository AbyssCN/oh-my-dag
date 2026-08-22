/**
 * src/harness/goal/ignition-forecast —— **点火那一刻的机械消耗预告**(owner 2026-08-14 排的片)。
 *
 * ## 为什么要机械打印, 而不是写进纪律让调用方自觉
 *
 * 本仓的实测结论是**「讲道理拦不住」**(§8.4 熔断键 · D-AL 验收探针):规则写在 prompt 里,
 * 执行体照样违反。`.claude/CLAUDE.md` 曾要求调用方点火前自报三样(为什么不是 run · 预计消耗 ·
 * 烧哪本账),而那三样**全靠 caller 自觉**。这一片把其中可机械化的两样(消耗 · 烧哪本账)
 * 挪到回执里;owner 2026-08-22 据此删掉了那条自报纪律,只留「为什么不是 run」的能力分野表。
 * **它不拦人,它只让"不知道要烧多少"这个借口消失。**
 *
 * ## 数字从账本来, 不写死
 *
 * 带宽读 `.omd/dag-runs.db` 的近期同名图(`goal-contract` / `goal-execute`)。
 * 写死会漂 —— 实测 2026-08-14:纪律里那句「契约段 ~9M / execute 5–33M」在近 20 跑上的
 * **中位数其实是 1.9M / 0.33M**,而 p75 是 4.8M / 13.2M。那句话不是错,是**取了尾巴当中心**。
 * 所以这里印**中位数 + p75 + max 三个数**:分布跨三个数量级,单一个数无论取哪个都是误导。
 *
 * ## NULL ≠ 0
 *
 * 账本里没有这一段的历史 → 返 `null`,回执上写「没记」而不是印一个 0。
 * 新仓 / 刚压缩过的账本 / 换了 `OMD_DAG_LEDGER` 都会落进这一格,而它与「这段不烧钱」是两回事。
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { channelOf } from '../../model/cost-ledger';
import { ledgerPath } from '../dag/dag-record';
import { logger } from '../logger';

/** 一个相位的历史带宽(输入 token = conductorIn + leavesIn)。 */
export interface PhaseBandwidth {
  /** 账本里的图名。 */
  plan: string;
  /** 样本数 —— 印出来, 免得 n=1 的中位数被读成"稳定值"。 */
  n: number;
  median: number;
  p75: number;
  max: number;
}

/** 两段图的带宽。任一段没有历史 → `null`(没记 ≠ 不烧)。 */
export interface IgnitionBandwidth {
  contract: PhaseBandwidth | null;
  execute: PhaseBandwidth | null;
}

/**
 * 契约段 / 执行段在账本里的图名 —— 这是**前缀**而不是精确名。
 * 写死成精确名= 把"下一次图改名"这件事藏进静默 bug:
 * 2026-08-22 实测: 执行段曾以 `goal-execute` 落账, 后改 `goal-execute-flat`,
 * phaseOf 用 `=` 一查一个准,函数照样返数,量的全是已停用的那条老 plan —— 这种漂移
 * 比「精确名不存在 → null」更坏, 因为它**返值有效但量错东西**。所以这里只写"族名前缀",
 * 下一档(`-flat` / `-batch` / 任何后继)不再需要同步改这一行,也不需要再被 contract 复提。
 */
const CONTRACT_PLAN_PREFIX = 'goal-contract';
const EXECUTE_PLAN_PREFIX = 'goal-execute';

/** 最近秩分位(不插值)—— 印出来的每个数都是**真跑过的一次**,不是算出来的中间值。 */
const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;

function phaseOf(db: Database, planPrefix: string, limit: number): PhaseBandwidth | null {
  // planPrefix 是**前缀**: 见上方 CONTRACT/EXECUTE_PLAN_PREFIX 上的注释。
  // SQL `LIKE` 不接受 `?` 占位符当通配符的语法糖, 所以手拼前缀 + `%` —— planPrefix
  // 的内容是字面量(仓内常量, 不会来路不明的输入), 不是 SQL 注入面。
  const rows = db
    .query(`SELECT usage FROM omd_dag_runs WHERE plan_name LIKE ? ORDER BY created_at DESC LIMIT ?`)
    .all(`${planPrefix}%`, limit) as { usage: string }[];
  const vals: number[] = [];
  for (const r of rows) {
    try {
      const u = JSON.parse(r.usage) as { conductorIn?: number; leavesIn?: number };
      // 只算**输入**侧: 点火前要预告的是"这一发会驮多少语料进去", 那才是可被 SDD 直通省掉的量。
      const v = (u.conductorIn ?? 0) + (u.leavesIn ?? 0);
      if (Number.isFinite(v) && v > 0) vals.push(v);
    } catch {
      // 坏行跳过 —— 账本是读数不是闸
    }
  }
  if (vals.length === 0) return null;
  const s = vals.sort((a, b) => a - b);
  return { plan: planPrefix, n: s.length, median: quantile(s, 0.5), p75: quantile(s, 0.75), max: s[s.length - 1]! };
}

/**
 * 读近 `limit` 跑的两段带宽。**fail-open**:账本读不了不许把点火挡下来 ——
 * 预告是增益不是闸(留一行证据,§3 第 2 条)。
 */
export function readIgnitionBandwidth(opts: { path?: string; limit?: number } = {}): IgnitionBandwidth {
  const path = opts.path ?? ledgerPath();
  const limit = opts.limit ?? 20;
  if (!existsSync(path)) return { contract: null, execute: null };
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return {
      contract: phaseOf(db, CONTRACT_PLAN_PREFIX, limit),
      execute: phaseOf(db, EXECUTE_PLAN_PREFIX, limit),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/ignition] 带宽账本读不了 → 预告缺席 (点火不受影响)');
    return { contract: null, execute: null };
  } finally {
    db?.close();
  }
}

const m = (v: number): string => `${(v / 1_000_000).toFixed(2)}M`;

const band = (p: PhaseBandwidth | null, label: string): string =>
  p === null
    ? `${label} 无历史 (账本里没记 — 不是"不烧")`
    : `${label} 中位 ${m(p.median)} · p75 ${m(p.p75)} · max ${m(p.max)} (近 ${p.n} 跑)`;

export interface IgnitionForecastArgs {
  /** 这次点火有没有走 SDD 直通。 */
  sddPath?: string | undefined;
  /** 这趟真正会用的坐标(取自本次 dag config, 不另解析一遍座位表)。 */
  coords: { label: string; coord: string }[];
  bandwidth: IgnitionBandwidth;
}

/**
 * 渲染回执里的那几行。**只报不拦** —— 与 `describeRollback` 同一条纪律:
 * 知识本来就存在,只是拿不到它的人正是要用它的人。
 */
export function renderIgnitionForecast(args: IgnitionForecastArgs): string {
  const lines: string[] = [];
  // ① 带宽
  lines.push(`预计消耗 (输入 token, 本仓账本近期分布): ${band(args.bandwidth.contract, '契约段')} | ${band(args.bandwidth.execute, '执行段')}`);
  // ② SDD 直通
  lines.push(
    args.sddPath
      ? `SDD 直通: ${args.sddPath} — 契约段跳过 (上面那一格的量这趟不烧)。`
      : '无 sddPath: 这趟**会烧契约段** (research + spec 结晶)。已有结晶 SDD 的话 sddPath 直通可省掉它。',
  );
  // ③ 通道/账本 —— 订阅额度与美元账是两本账, 混在一起看会把"没花钱"读成"免费"。
  const byChannel = new Map<'api' | 'subscription', string[]>();
  for (const { label, coord } of args.coords) {
    const ch = channelOf(coord);
    const bucket = byChannel.get(ch) ?? [];
    bucket.push(`${label}=${coord}`);
    byChannel.set(ch, bucket);
  }
  const parts: string[] = [];
  for (const ch of ['subscription', 'api'] as const) {
    const bucket = byChannel.get(ch);
    if (bucket?.length) parts.push(`${ch === 'subscription' ? '订阅额度' : '美元账'}: ${bucket.join(', ')}`);
  }
  if (parts.length) lines.push(`烧哪本账: ${parts.join(' | ')}`);
  return lines.join('\n');
}
