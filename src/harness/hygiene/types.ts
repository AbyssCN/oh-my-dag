/**
 * src/harness/hygiene/types —— 仓库治理链的冻结接口 + 棘轮判决 (零 LLM, 零 IO)。
 *
 * 契约: `docs/plan/2026-09-02-仓库治理链-执行契约.md` §契约「冻结接口」/ D-1 / D-2。
 *
 * ## 为什么类型单独一个文件
 *
 * 九个矿源 (miners.ts) 与三个消费者 (scan CLI / 分诊 / 票聚类) 都要引用同一组形状。
 * 类型放在被两侧共同 import 的叶子文件里, 矿源与消费者之间就没有 import 边 —— 这是
 * 「扫描零 LLM」能被机械核实的前提 (见 hygiene-scan.test.ts 的 import 白名单闸)。
 *
 * ## NULL ≠ 0 ≠ 不适用 (仓规 §静默坑 1)
 *
 * 某一类矿源读不到时, `counts[source]` **仍然是 0**, 但 `errors[]` 里会多一条同名记录。
 * 判「这类真的是零」还是「这类没读到」靠 `errors`, 不靠 counts —— 两者是不同的列。
 */

/** 九个矿源展开成 12 个类 (knip 一个进程产四类, 分开计数才能分开做棘轮)。 */
export type HygieneSource =
  | 'knip-files'
  | 'knip-exports'
  | 'knip-types'
  | 'knip-deps'
  | 'debt'
  | 'todo'
  | 'big-file'
  | 'stale-plan'
  | 'seam-drift'
  | 'test-health'
  | 'failed-runs'
  | 'forks';

/** 全部类的枚举序 (counts 的键集合 = 这个数组, 缺一个都算 bug)。 */
export const HYGIENE_SOURCES: readonly HygieneSource[] = [
  'knip-files',
  'knip-exports',
  'knip-types',
  'knip-deps',
  'debt',
  'todo',
  'big-file',
  'stale-plan',
  'seam-drift',
  'test-health',
  'failed-runs',
  'forks',
] as const;

export interface HygieneItem {
  /** `<source>:<stable-key>` —— 同一处腐败跨两次扫描必须得到同一个 id (棘轮做差集靠它)。 */
  id: string;
  source: HygieneSource;
  path?: string;
  line?: number;
  symbol?: string;
  /** 一行人读摘要 (进票 title / 分诊输入面)。 */
  summary: string;
  /** 原文证据行 (给人贴进票里; 不做二次加工)。 */
  evidence: string[];
  /** 数值面 (行数 / 簇大小 / 天数)。读不到写 `null`, 不写 0。 */
  metrics?: Record<string, number | null>;
}

export interface HygieneScan {
  version: 1;
  generatedAt: string;
  /** 扫描时的 HEAD sha (基线可追溯到具体一次提交)。取不到 → 空串。 */
  sha: string;
  counts: Record<HygieneSource, number>;
  items: HygieneItem[];
  /** fail-open 的证据行: 哪一类没读到 + 错误原文 (仓规 §静默坑 2)。 */
  errors: { source: HygieneSource; error: string }[];
}

export interface RatchetVerdict {
  ok: boolean;
  rose: { source: HygieneSource; base: number; now: number; added: string[] }[];
}

// ── 阈值常量 (测试引用常量, 不写字面; 改阈值只改这里) ──────────────────────

/** 超长文件判据: 严格大于这个行数才算 (D-1 ④)。 */
export const BIG_FILE_LINE_THRESHOLD = 1500;

/** 陈旧 plan 文档判据: mtime 早于 N 天前 ∧ 无人引用 (D-1 ⑤)。 */
export const STALE_PLAN_DAYS = 30;

/** M3 输出 32K 截断 → 每个分诊叶最多这么多项 (§0 量级约束)。 */
export const MAX_ITEMS_PER_LEAF = 30;

/** 每条聚类票里最多贴几个样本 runId (D-7)。 */
export const MAX_CLUSTER_SAMPLES = 3;

// ── 棘轮 (D-2) ────────────────────────────────────────────────────────────

/** 空计数表 (全部 12 类置 0) —— 调用方拼 counts 的起点。 */
export function emptyCounts(): Record<HygieneSource, number> {
  return Object.fromEntries(HYGIENE_SOURCES.map((s) => [s, 0])) as Record<HygieneSource, number>;
}

/**
 * 棘轮判决: 任一类计数**高于**基线 → `ok:false`。持平与下降都算过。
 *
 * `added` 的三种来历要分清 (NULL ≠ 0 ≠ 不适用):
 *   · `baseIds` 给了这一类 → `added` = 真差集 (now 有而 base 没有的 id);
 *   · `baseIds` 没给这一类 → **基线里没有 id 清单, 做不了差集**, 退化为列出该类当前全部 id,
 *     并不假装那些都是新增的 (调用方看到的是"这一类现在有哪些", 不是编出来的差)。
 *
 * ⚠ 接口偏离: 契约冻结签名只有 `(base, now)`。仅凭计数无法算出「新增项 id」,
 *   而 GWT-2 要求 `rose[0].added` 含新增项 id —— 故加**可选**第三参 `baseIds`
 *   (不传时行为与冻结签名一致)。基线文件同时记 counts 与 ids, `--check` 走真差集。
 */
export function ratchet(
  base: Record<HygieneSource, number>,
  now: HygieneScan,
  baseIds?: Partial<Record<HygieneSource, string[]>>,
): RatchetVerdict {
  const rose: RatchetVerdict['rose'] = [];
  for (const source of HYGIENE_SOURCES) {
    const b = base[source] ?? 0;
    const n = now.counts[source] ?? 0;
    if (n <= b) continue;
    const nowIds = now.items.filter((i) => i.source === source).map((i) => i.id);
    const known = baseIds?.[source];
    const added = known ? nowIds.filter((id) => !known.includes(id)) : nowIds;
    rose.push({ source, base: b, now: n, added });
  }
  return { ok: rose.length === 0, rose };
}

/** 人读的棘轮判词 (CLI `--check` 打印这个)。 */
export function renderRatchet(v: RatchetVerdict): string {
  if (v.ok) return 'hygiene ratchet: OK — 无任一类高于基线';
  const lines = ['hygiene ratchet: 红 — 以下类高于基线:'];
  for (const r of v.rose) {
    lines.push(`  ${r.source}: ${r.base} → ${r.now}`);
    for (const id of r.added.slice(0, 20)) lines.push(`    + ${id}`);
    if (r.added.length > 20) lines.push(`    … 另 ${r.added.length - 20} 项`);
  }
  return lines.join('\n');
}
