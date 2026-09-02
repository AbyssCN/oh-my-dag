#!/usr/bin/env bun
/**
 * scripts/hygiene-tickets —— scan.json + triage → `tickets.json` 票草稿 (契约 D-7 / INV-7)。
 *
 *   bun scripts/hygiene-tickets.ts --scan <hy>/scan.json --worklist <hy>/worklist.json \
 *     --slug <地图 slug> --out <hy>/tickets.json
 *
 * ## 聚类成票, 不是逐条成票
 *
 * 失败 run 一百多条逐条成票 = 一百多张票, 那不是治理是刷屏。`mineFailedRuns` 已经按
 * 「终止原因」把它们收成簇, 这里**一簇一票**: 计数 + ≤3 个样本 runId + 首个判词原文。
 * fork 与残余 (证伪没过 / 分诊回退) 各一张汇总票 —— 上限 2 张, 不随数量涨。
 *
 * ## 去重靠稳定前缀, 不靠全文相等
 *
 * 票 title 里带计数 (「共 68 条」), 而计数每周都会变。所以去重比的是 `dedupPrefix`
 * (不含计数的那一段): 图上已有同前缀的未终结票 → 不再造新票, 只把新计数记进
 * `skipped[].detail` 让人看见它涨了没有。
 *
 * 产物是**草稿**: 字段与 `map_add` 同名 (`title` / `type` / `executorKind` / `slug`),
 * 但本脚本**不写图** —— 进图要人 `map_confirm` (D-7)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutorKind, TicketType } from '../src/harness/pathfinder/types';
import type { RefuteVerdict } from '../src/harness/hygiene/refute';
import { MAX_CLUSTER_SAMPLES, type HygieneScan } from '../src/harness/hygiene/types';

/** 全部治理票共用的 title 前缀 —— 图上一眼能筛出这条链造的票。 */
export const TICKET_PREFIX = '[hygiene]';
/** 汇总票上限 (fork 一张 + 残余一张); 超过就是聚类没起作用。 */
export const MAX_SUMMARY_TICKETS = 2;

/** 票草稿: 前四个字段与 `map_add` 参数同名, 其余是给人读的正文与读数。 */
export interface TicketDraft {
  title: string;
  type: TicketType;
  executorKind: ExecutorKind;
  slug: string;
  /** 去重键 = title 里**不含计数**的那一段。 */
  dedupPrefix: string;
  /** `count` = 这张票代表多少条底层项 (簇大小)。 */
  metrics: { count: number };
  /** 人读正文 (样本 runId / 判词原文 / 下一步)。 */
  body: string;
}

export interface TicketsResult {
  generatedAt: string;
  slug: string;
  tickets: TicketDraft[];
  /** 因图上已有同前缀票而没造的 —— 回退可见, 不静默 (§静默坑 2)。 */
  skipped: { dedupPrefix: string; detail: string }[];
}

export interface BuildTicketsInput {
  scan: HygieneScan;
  /** 证伪判决 (refuted 的那些进残余汇总票)。 */
  verdicts: RefuteVerdict[];
  /** 分诊回退的 itemId (解析失败 / 编 id / reproCmd 不合白名单)。 */
  fallbackIds: string[];
  slug: string;
  /** 图上**未终结**票的 title 清单 (open / suggested / blocked; delivered 的不算占位)。 */
  existingOpenTitles: string[];
  generatedAt: string;
}

function draft(
  dedupPrefix: string,
  count: number,
  body: string,
  type: TicketType,
  executorKind: ExecutorKind,
  slug: string,
): TicketDraft {
  return { title: `${dedupPrefix} — 共 ${count} 条`, type, executorKind, slug, dedupPrefix, metrics: { count }, body };
}

/**
 * scan + 证伪结果 → 票草稿。**纯函数**: 图的读取与文件写在 CLI 里。
 *
 * 票的三种来历各自一条规则:
 *   · `failed-runs` 每个 item 本来就是一个簇 → 一簇一票;
 *   · `forks` 全部未裁 fork → **一张**汇总票;
 *   · 残余 (refuted 的 delete 提议 + 分诊回退的 id) → **一张**汇总票。
 */
export function buildTickets(input: BuildTicketsInput): TicketsResult {
  const { scan, verdicts, fallbackIds, slug, existingOpenTitles, generatedAt } = input;
  const drafts: TicketDraft[] = [];

  for (const item of scan.items.filter((i) => i.source === 'failed-runs')) {
    const count = (item.metrics?.count ?? 1) as number;
    drafts.push(
      draft(
        `${TICKET_PREFIX} 失败 run 簇「${item.symbol ?? item.id}」`,
        count,
        [
          `簇名: ${item.symbol ?? item.id}`,
          `首个判词原文: ${item.evidence[0] ?? '(无)'}`,
          `${item.evidence[1] ?? `样本 runId: (无, 至多列 ${MAX_CLUSTER_SAMPLES} 个)`}`,
          '下一步: 读判词定这是引擎缺陷还是任务难; 同因连续复现 = 引擎缺陷。',
        ].join('\n'),
        'grill',
        'agent',
        slug,
      ),
    );
  }

  const forks = scan.items.filter((i) => i.source === 'forks');
  if (forks.length > 0) {
    drafts.push(
      draft(
        `${TICKET_PREFIX} owner-inbox 未裁 fork 汇总`,
        forks.length,
        forks.map((f) => `· ${f.summary}\n  ${f.evidence[0] ?? ''}`).join('\n'),
        'grill',
        'agent',
        slug,
      ),
    );
  }

  const refuted = verdicts.filter((v) => v.verdict === 'refuted');
  const residueCount = refuted.length + fallbackIds.length;
  if (residueCount > 0) {
    drafts.push(
      draft(
        `${TICKET_PREFIX} 删除提议残余 (证伪未过 + 分诊回退)`,
        residueCount,
        [
          `证伪未过 ${refuted.length} 条:`,
          ...refuted
            .slice(0, 20)
            .map((v) => `· ${v.itemId}: ${v.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`),
          `分诊回退 ${fallbackIds.length} 条: ${fallbackIds.slice(0, 20).join(', ')}`,
          '下一步: 人逐条看; 回退率高说明分诊提示词或 schema 太紧, 先修尺。',
        ].join('\n'),
        'grill',
        'agent',
        slug,
      ),
    );
  }

  // 去重: 图上已有同前缀的未终结票 → 不重复造, 但把新计数记进 skipped 让人看见涨没涨。
  const tickets: TicketDraft[] = [];
  const skipped: TicketsResult['skipped'] = [];
  for (const d of drafts) {
    const hit = existingOpenTitles.find((t) => t.startsWith(d.dedupPrefix));
    if (hit) skipped.push({ dedupPrefix: d.dedupPrefix, detail: `图上已有「${hit}」; 本次计数 ${d.metrics.count}` });
    else tickets.push(d);
  }
  return { generatedAt, slug, tickets, skipped };
}

/** 汇总票 (非 failed-runs 簇票) 的张数 —— INV-7 的上限读数。 */
export function summaryTicketCount(r: TicketsResult): number {
  return r.tickets.filter((t) => !t.dedupPrefix.includes('失败 run 簇')).length;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (e) {
    console.error(`[hygiene-tickets] ${path} 解析失败 (按缺席处理): ${(e as Error).message}`);
    return fallback;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scanPath = val('scan');
  if (!scanPath) {
    console.error('usage: bun scripts/hygiene-tickets.ts --scan <scan.json> [--worklist <worklist.json>] --slug <slug> --out <tickets.json>');
    process.exit(1);
  }
  const scan = readJson<HygieneScan | null>(scanPath, null);
  if (!scan) {
    console.error(`[hygiene-tickets] 读不到 scan: ${scanPath}`);
    process.exit(1);
  }
  const worklist = readJson<{ verdicts?: RefuteVerdict[]; fallbackIds?: string[] }>(val('worklist') ?? '', {});
  const slug = val('slug') ?? 'hygiene';

  // 图上未终结的票 title —— 读不到图就是"没有已有票", 但要留证据 (fail-open)。
  let existingOpenTitles: string[] = [];
  try {
    const { loadMap } = await import('../src/harness/pathfinder/map-store');
    const map = loadMap(process.cwd(), slug);
    existingOpenTitles = (map?.tickets ?? [])
      .filter((t) => t.status === 'open' || t.status === 'suggested' || t.status === 'blocked')
      .map((t) => t.title);
  } catch (e) {
    console.error(`[hygiene-tickets] 读图失败 (去重按"图上无票"跑): slug=${slug} ${(e as Error).message}`);
  }

  const result = buildTickets({
    scan,
    verdicts: worklist.verdicts ?? [],
    fallbackIds: worklist.fallbackIds ?? [],
    slug,
    existingOpenTitles,
    generatedAt: new Date().toISOString(),
  });
  const outPath = val('out');
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`票草稿 ${result.tickets.length} 张 (汇总 ${summaryTicketCount(result)}), 去重跳过 ${result.skipped.length} 张`);
  for (const t of result.tickets) console.log(`  · ${t.title}`);
  for (const s of result.skipped) console.log(`  ~ 跳过: ${s.detail}`);
  process.exit(0);
}
