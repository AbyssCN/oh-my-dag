#!/usr/bin/env bun
/**
 * scripts/speedup-readout —— 关键路径加速比读数板。
 *
 * `analyzeRun` 算每个 run 的 critical-path / total 与 `speedup`;`parseNodesColumn`
 * 把 SQLite 里 `omd_dag_runs.nodes` 的 JSON 文本解成 `RunNode[]`;`shapeBucket` 把
 * `shape_id` 划到 `absent / known / unknown` 三态;`renderMarkdown` 出表。
 *
 * 关键纪律(仓规 §静默坑 ①):
 *   · 缺 `durationMs` ≠ 0 —— 它是「跑了但没记上」,不是「跑了 0ms」;
 *     `totalMs` 不把它加进去,但关键路径**仍穿过**该节点(pass-through 降级)。
 *   · 缺 `deps` ≠ `[]` —— `[]` 是「确实没有入边」,null 是「入边字段缺席」。
 *     比例 `> 0.20` 整 run 退场(`excluded-missing`),否则 `invalid-shape`,
 *     不许把 null 改写成 `[]`。
 *   · shape 三态(`absent / known / unknown`)分别有数,不许压平。
 *
 * 出口面见 §1,数学定义见 §3.1,缺失比例定义见 §3.2,环检测见 §3.5。
 *
 * @module
 */
import { Database } from 'bun:sqlite';
import { isKnownShapeId } from '../src/harness/shapes/index.ts';

/** §1 导出面 —— 一字不改地采用契约文本。 */
export type RunNode = {
  id: string;
  deps: string[] | null;
  durationMs: number | null;
  /**
   * 节点终态 (C-1, 2026-09-01)。
   * - `'skipped'` = quorum 未达 / 级联跳过 — 不计入缺失占比、不触发整图剔除、
   *   critical-path 上视为 0ms。
   * - 其它合法值 (`'done'` / `'failed'`) 或字段缺席 = 正常计数, 按真值处理。
   * 字段缺席 (`status === undefined`) 与 `null` 严格分:
   * 缺席 = 老记录(早于本次改动); `null` 在解析阶段已被拒绝(非 string)。
   */
  status?: string;
};

export type RunVerdict =
  | {
      kind: 'ok';
      totalMs: number;
      criticalMs: number;
      speedup: number;
    }
  | {
      kind: 'excluded-missing';
      missingRatio: number;
    }
  | {
      kind: 'invalid-cycle';
    }
  | {
      kind: 'invalid-shape';
    };

export type MarkdownGroup = {
  label: string;
  speedups: number[];
};

/**
 * 剔除计数 — C-1 钉死两桶语义, **不许合并**:
 * - `excludedMissing` = 因缺失比例 > 20% 整图剔除 (skipped 节点不计入分子 / 不触发该剔除)
 * - `excludedInvalid` = 因环 / 形态异常剔除 (invalid-cycle + invalid-shape 合并对外)
 */
export type RunCounters = {
  excludedMissing: number;
  excludedInvalid: number;
};

/**
 * §2 `parseNodesColumn` —— 接受 JSON 字符串或已解析数组,其余输入返回 `null`。
 *
 * 字段缺席 / `undefined` / `null` → 该字段存 `null`(整行仍合法);类型错误 → 整行拒。
 * 负数 `durationMs` 也拒(整行无效,不是把负数当 null)。
 * `status` 缺席合法(老记录);非字符串则拒整行。
 */
export function parseNodesColumn(raw: unknown): RunNode[] | null {
  let arr: unknown;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else {
    return null;
  }
  if (!Array.isArray(arr)) return null;

  const out: RunNode[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;

    // id: 非空字符串,否则整行拒。
    const id = obj.id;
    if (typeof id !== 'string' || id === '') return null;

    // deps: 缺席/undefined/null → null;string[] → 保留;其他 → 整行拒。
    let deps: string[] | null;
    if (!('deps' in obj) || obj.deps === undefined || obj.deps === null) {
      deps = null;
    } else if (Array.isArray(obj.deps)) {
      let allStrings = true;
      for (const d of obj.deps) {
        if (typeof d !== 'string') {
          allStrings = false;
          break;
        }
      }
      if (!allStrings) return null;
      deps = obj.deps as string[];
    } else {
      return null;
    }

    // durationMs: 缺席/null/NaN/±Infinity → null;有限 ≥0 → 保留;负数或其他类型 → 整行拒。
    let durationMs: number | null;
    if (
      !('durationMs' in obj) ||
      obj.durationMs === undefined ||
      obj.durationMs === null ||
      (typeof obj.durationMs === 'number' && !Number.isFinite(obj.durationMs))
    ) {
      durationMs = null;
    } else {
      const d = obj.durationMs;
      if (typeof d === 'number') {
        if (d < 0) return null;
        durationMs = d;
      } else {
        return null;
      }
    }

    // status (C-1): 缺席合法(老记录, 视为非 skipped); 非字符串则拒整行。
    // 词表不校验 —— 留痕层存原值, 派生判定 (`status === 'skipped'`) 由消费面做。
    let status: string | undefined;
    if ('status' in obj && obj.status !== undefined) {
      if (obj.status === null || typeof obj.status !== 'string') return null;
      status = obj.status;
    }

    out.push({ id, deps, durationMs, status });
  }
  return out;
}

/**
 * §3 `analyzeRun` —— 带 `visiting` 标记的记忆化 DFS 算 critical path;
 * 遇环 / 缺字段比例超阈值 / 节点形态异常各自分流。
 *
 * `missingRatio` 计数规则(§3.2):`durationMs === null` 或 `deps === null` 各算一次,
 * 同节点即使两字段都缺也只计一次。**C-1 例外**:`status === 'skipped'` 的节点
 * 不计入分子(quorum 级联跳过本就预期没跑,null durationMs 是预期),亦不参与
 * 第 ⑶ 步 `deps === null` 的残余检查 (skipped 节点的 deps null 同样合理 —
 * 该路不适用)。
 *
 * 判错顺序严格按 §3.6:基本形态 → 缺字段比例 → 残留 deps null → 环 → critical 非正/非有限 → ok。
 */
export function analyzeRun(nodes: RunNode[]): RunVerdict {
  // ⑴ 基本形态 —— 重复 id、负数 duration、悬空 dependency 都属此层。
  if (nodes.length === 0) {
    return { kind: 'invalid-shape' };
  }
  const idSet = new Set<string>();
  const nodeById = new Map<string, RunNode>();
  for (const n of nodes) {
    if (idSet.has(n.id)) {
      return { kind: 'invalid-shape' };
    }
    if (n.durationMs !== null && n.durationMs < 0) {
      return { kind: 'invalid-shape' };
    }
    idSet.add(n.id);
    nodeById.set(n.id, n);
  }
  for (const n of nodes) {
    if (n.deps !== null) {
      for (const d of n.deps) {
        if (!idSet.has(d)) {
          return { kind: 'invalid-shape' };
        }
      }
    }
  }

  // ⑵ 缺字段比例 —— 任一字段 null 算一次;**C-1**: skipped 节点不计入。
  let missingCount = 0;
  for (const n of nodes) {
    if (n.status === 'skipped') continue;
    if (n.durationMs === null || n.deps === null) {
      missingCount += 1;
    }
  }
  const missingRatio = missingCount / nodes.length;
  if (missingRatio > 0.20) {
    return { kind: 'excluded-missing', missingRatio };
  }

  // ⑶ 残留 deps null —— 比例 ≤ 0.20 但仍缺入边字段,无法恢复,拒。**C-1**: skipped 不查。
  for (const n of nodes) {
    if (n.status === 'skipped') continue;
    if (n.deps === null) {
      return { kind: 'invalid-shape' };
    }
  }

  // ⑷ 环检测 + 关键路径(DFS + visiting)。`visiting` 重入即抛,外层捕为 invalid-cycle。
  type State = 'unvisited' | 'visiting' | 'done';
  const state = new Map<string, State>();
  for (const id of idSet) state.set(id, 'unvisited');
  const memo = new Map<string, number>();
  const visit = (id: string): number => {
    const s = state.get(id);
    if (s === 'visiting') throw new Error('__cycle');
    if (s === 'done') return memo.get(id) as number;
    state.set(id, 'visiting');
    const node = nodeById.get(id) as RunNode;
    // deps 已被第 ⑶ 步筛掉 null(非 skipped 节点); skipped 节点此处可能仍 null —— 当作无边。
    const deps = node.status === 'skipped' ? (node.deps ?? []) : (node.deps as string[]);
    let best = 0;
    for (const d of deps) {
      const sub = visit(d);
      if (sub > best) best = sub;
    }
    // NULL pass-through: 自身 duration 缺失不增加路径长度,但仍占用节点,依赖路径穿过它。
    // **C-1**: skipped 节点永远 own = 0(quorum 未达,本就没跑,不该给关键路径贡献)。
    const own =
      node.status === 'skipped' ? 0 : node.durationMs === null ? 0 : node.durationMs;
    const pathVal = own + best;
    memo.set(id, pathVal);
    state.set(id, 'done');
    return pathVal;
  };

  let criticalMs = 0;
  try {
    for (const id of idSet) {
      const v = visit(id);
      if (v > criticalMs) criticalMs = v;
    }
  } catch {
    return { kind: 'invalid-cycle' };
  }

  // ⑸ criticalMs 必须正且有限(全 null 时 = 0 → invalid-shape;非有限数同理)。
  if (!(criticalMs > 0) || !Number.isFinite(criticalMs)) {
    return { kind: 'invalid-shape' };
  }

  // totalMs: NULL pass-through, 只把已知的 durationMs 求和。skipped 节点 durationMs 缺席
  // 不参与求和,与"自节点贡献为 0"语义一致。
  let totalMs = 0;
  for (const n of nodes) {
    if (n.durationMs !== null) totalMs += n.durationMs;
  }
  if (!Number.isFinite(totalMs)) {
    return { kind: 'invalid-shape' };
  }
  const speedup = totalMs / criticalMs;
  if (!Number.isFinite(speedup)) {
    return { kind: 'invalid-shape' };
  }
  return { kind: 'ok', totalMs, criticalMs, speedup };
}

/** §4 `shapeBucket` —— 三态分类器,`absent / known / unknown` 不许合并。 */
export function shapeBucket(
  shapeId: string | null | undefined,
): 'absent' | 'known' | 'unknown' {
  if (shapeId === null || shapeId === undefined || shapeId === '') {
    return 'absent';
  }
  return isKnownShapeId(shapeId) ? 'known' : 'unknown';
}

/** §5 `median` —— 升序排序后的副本算中位数;空数组返 `NaN`,非有限元素抛 `TypeError`。 */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  for (const x of xs) {
    if (!Number.isFinite(x)) {
      throw new TypeError(`median: non-finite value ${x}`);
    }
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) >> 1]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** §6 `renderMarkdown` —— 固定表头,空组显示 `—` / `0`,label 中的 `|` 转 `\|`,末尾恰好一个 `\n`。 */
export function renderMarkdown(
  title: string,
  groups: MarkdownGroup[],
  counters: RunCounters,
): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push('| 组别 | 中位数加速比 | 样本量 |');
  lines.push('|---|---:|---:|');
  for (const g of groups) {
    const label = g.label.replace(/\|/g, '\\|');
    let medianStr: string;
    let countStr: string;
    if (g.speedups.length === 0) {
      medianStr = '—';
      countStr = '0';
    } else {
      medianStr = median(g.speedups).toFixed(3);
      countStr = String(g.speedups.length);
    }
    lines.push(`| ${label} | ${medianStr} | ${countStr} |`);
  }
  lines.push('');
  lines.push(
    `excluded_missing: ${counters.excludedMissing} / excluded_invalid: ${counters.excludedInvalid}`,
  );
  return lines.join('\n') + '\n';
}

/**
 * §7 CLI —— 只读打开 `omd_dag_runs` 的 `nodes / shape_id / outcome`,
 * 渲染「全量」与 `outcome='success'` 两份独立报告。
 *
 * 表不存在 / 查询失败 → stderr + exit 1;缺 `--db` 值或未知参数 → stderr + exit 2。
 */
if (import.meta.main) {
  const USAGE =
    'Usage: deno run --allow-read scripts/speedup-readout.ts [--db <path>]';

  // arg 解析 —— 仅支持 `--db <path>`;缺值或未知参数即用法错。
  let dbPath: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(USAGE);
        process.exit(2);
      }
      dbPath = v;
      i++;
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  const finalDbPath = dbPath ?? '.omd/dag-runs.db';

  // readonly 打开 —— 不创建、不迁移、不写 PRAGMA。
  let db: Database;
  try {
    db = new Database(finalDbPath, { readonly: true });
  } catch (e) {
    console.error(
      `[speedup-readout] 打不开数据库 ${finalDbPath} — ${(e as Error).message}`,
    );
    process.exit(1);
  }

  let rows: { nodes: string | null; shape_id: string | null; outcome: string | null }[];
  try {
    rows = db
      .query(`SELECT nodes, shape_id, outcome FROM omd_dag_runs`)
      .all() as {
      nodes: string | null;
      shape_id: string | null;
      outcome: string | null;
    }[];
  } catch (e) {
    console.error(
      `[speedup-readout] 查询 omd_dag_runs 失败 — ${(e as Error).message}`,
    );
    process.exit(1);
  }

  /**
   * 给定一个 row 子集,生成 §7.3 规定顺序的 markdown 表。
   * 具体 shape 行按本范围内出现过的已知 shape_id 建立(即便样本量为 0)。
   */
  function buildReport(
    scopeRows: typeof rows,
    title: string,
  ): string {
    const counters: RunCounters = {
      excludedMissing: 0,
      excludedInvalid: 0,
    };

    // 先扫一遍本范围内的已知 shape_id,定具体 shape 行的集合。
    const knownShapeIds = new Set<string>();
    for (const r of scopeRows) {
      const sid = r.shape_id;
      if (sid !== null && sid !== undefined && sid !== '' && isKnownShapeId(sid)) {
        knownShapeIds.add(sid);
      }
    }
    const sortedKnown = Array.from(knownShapeIds).sort();

    const buckets: Record<string, number[]> = {
      absent: [],
      known: [],
      unknown: [],
    };
    for (const sid of sortedKnown) {
      buckets[`known:${sid}`] = [];
    }

    for (const r of scopeRows) {
      const parsed = parseNodesColumn(r.nodes);
      if (parsed === null) {
        // 节点 JSON 不可解析 → 形态异常,与 invalid-shape 同语义 → 入 excludedInvalid
        counters.excludedInvalid += 1;
        continue;
      }
      const verdict = analyzeRun(parsed);
      if (verdict.kind === 'invalid-shape') {
        counters.excludedInvalid += 1;
        continue;
      }
      if (verdict.kind === 'invalid-cycle') {
        counters.excludedInvalid += 1;
        continue;
      }
      if (verdict.kind === 'excluded-missing') {
        counters.excludedMissing += 1;
        continue;
      }
      // verdict.kind === 'ok' —— 进入组。
      const sid = r.shape_id;
      const bucket = shapeBucket(sid);
      buckets[bucket]!.push(verdict.speedup);
      if (bucket === 'known' && sid !== null && sid !== undefined && sid !== '') {
        // shapeBucket('known') 已经过滤过 isKnownShapeId(true),此处可放心落到具体 shape 行。
        buckets[`known:${sid}`]!.push(verdict.speedup);
      }
    }

    const groupOrder: string[] = ['absent', 'known'];
    for (const sid of sortedKnown) groupOrder.push(`known:${sid}`);
    groupOrder.push('unknown');

    const groups: MarkdownGroup[] = groupOrder.map((label) => ({
      label,
      speedups: buckets[label]!,
    }));

    return renderMarkdown(title, groups, counters);
  }

  const fullMd = buildReport(rows, '全量');
  const successRows = rows.filter((r) => r.outcome === 'success');
  const successMd = buildReport(successRows, "outcome='success'");

  // 两张表之间放一个空行 —— renderMarkdown 末尾各带一个 `\n`,中间再加一个 `\n` 共两换行 = 一空行。
  process.stdout.write(fullMd + '\n' + successMd);
}