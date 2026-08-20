/**
 * src/harness/waste/report —— **C-2 浪费尺子** (2026-08-20, P0 尺子与并发地基)。
 *
 * 零 LLM、零新依赖。读 `.omd/dag-runs.db` 的 `omd_dag_runs` 表,出四个数:
 *
 *   · `nodeWasteTokens`  被后一轮覆盖的节点的 token 和 / 总 token
 *   · `handoffTax`       注入的上游文本 token / 节点总 in
 *   · `cacheHitRate`     节点级缓存命中 / 节点 in (本期不分层,只出总数 — P2)
 *   · `waveWidth`        per-run 的 per-wave 并发直方图 (用 `levels` 列算)
 *
 * 每个数都是 `{value, n, unknownRuns}` 三件套;`WasteReport` 顶层还带 `missingColumns`。
 *
 * ## 缺列时的硬约束 (C-2 契约, 严禁退化成代理判据)
 *
 * 若某指标所依赖的列在库里**不存在**或**全为 NULL** → 该指标 `value = null`,
 * 把**所有相关跑**记进 `unknownRuns`,**不进分子也不进分母** (INV-5),
 * 并在顶层 `missingColumns` 里点名缺哪一列 —— **不许**用「多轮跑里非 reused 的
 * 节点 / 有 deps 的节点的 tokensIn」之类的代理顶替。
 *
 * 不变量:
 *   · INV-5 「没记」≠ 0;绝不把未知跑塞进 0 浪费的分子分母;
 *   · INV-4 `entry:'call'` 与 `entry:'node'` 不可相加。本期只读 `omd_dag_runs`,
 *     不读 `seat-usage.jsonl`,这条目前**不触发**;扩到多源时必须在两个桶之间
 *     用 `if (e.entry === ...)` 分流,严禁 `entries.filter().reduce(...)` 后相加;
 *   · 库为空 / 文件不存在 / 表缺列 → 不抛异常,全 `value=null` + `unknownRuns=0` +
 *     `missingColumns=[]`(GWT-2b)。
 *
 * ⚠ **覆盖面下界 (INV-6)**:本尺子只看 `dag-runs.db` 的节点 JSON,与
 * `seat-usage.jsonl` 的 `entry:'call' / 'node'` 不交叉校验;`dream/extract-*`
 * 仍未纳入采集,按座位求和是下界 —— CLI 一并印出 (INV-6)。
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { DagRunNode, DagRunRecord } from '../dag-record';

/**
 * 跨轮身份 + 覆盖标记列 —— `dag-record.ts` 的 `DagRunNode` 暂未声明
 * (A 片独占那片 schema),这里局部扩展。语义由 `engine.ts` 的 settle 写入:
 *   · `dagRound`     当前节点所在的引擎外层轮号 (跨轮身份)
 *   · `overriddenBy` 上一轮同 id 节点被本轮覆盖时被落上的轮号 (覆盖标记);
 *                    末轮同 id 节点不设 (与契约「最后一轮不算被覆盖」一致)
 */
type DagRunNodeX = DagRunNode & { dagRound?: number | null; overriddenBy?: number | null };

/** 单指标的形状 (C-2 契约)。`value` 缺列时是 `null`,`n` / `unknownRuns` 始终是 `number`。 */
export interface WasteMetric<T> {
  value: T | null;
  /** 为这个数出了真实数据的跑数 (分子+分母样本量)。 */
  n: number;
  /** 缺这个数要的数据的跑数 —— 「没记」,**不是** 0 (INV-5)。 */
  unknownRuns: number;
}

/** per-wave 并发直方图一桶:`width` = 该波节点数,`runs` = 全库有多少波取这个宽度。 */
export interface WaveWidthBucket { width: number; runs: number }
export type WaveWidthHistogram = WaveWidthBucket[];

/** `computeWaste` 的返回值 —— `missingColumns` 在顶层,跨指标汇总。 */
export interface WasteReport {
  nodeWasteTokens: WasteMetric<number>;
  handoffTax: WasteMetric<number>;
  cacheHitRate: WasteMetric<number>;
  waveWidth: WasteMetric<WaveWidthHistogram>;
  /** 当前 DB 里「不存在 / 全为 NULL」的列名清单 —— 解释 value=null 的原因。 */
  missingColumns: string[];
}

/** SELECT 只拿 `id` (锚定行数) + `levels` + `nodes` JSON 列;其它列都通过 JSON 拿。 */
interface RawRow {
  id: string;
  levels: string | null;
  nodes: string | null;
}

function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * 读 `dag-runs.db`,返回**全部**记录(无 limit)。
 *
 * 三层失败容忍,GWT-2b 钉死:
 *   ① 文件不存在 → [];
 *   ② 库打开失败 / 表不存在 → [];
 *   ③ `nodes` 或 `levels` 解析失败的行 → 跳过(语义不是「缺列」,不入 unknownRuns)。
 *
 * 只 SELECT `id/levels/nodes`,新增列不会被搅到。
 */
export function readDagRuns(dbPath: string): DagRunRecord[] {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    db.run('PRAGMA query_only = ON');
    const tables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='omd_dag_runs'`,
    ).all();
    if (tables.length === 0) return [];
    const rows = db.query<RawRow, []>(
      `SELECT id, levels, nodes FROM omd_dag_runs`,
    ).all();
    const out: DagRunRecord[] = [];
    for (const r of rows) {
      const levels = safeJsonParse<string[][]>(r.levels);
      const nodes = safeJsonParse<DagRunNode[]>(r.nodes);
      if (!levels || !nodes) continue; // 解析失败 = 跳过(语义不是「缺列」)
      out.push({
        id: r.id,
        createdAt: 0,
        planName: '',
        nodeCount: nodes.length,
        question: null,
        runId: null,
        levels,
        nodes,
        // `usage` 不参与本期计算,塞个空对象满足 DagRunRecord 形状。
        usage: { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 扫一遍所有节点,看某个字段是否在**任何**节点里出现过非 null 的 number 值。 */
function hasAnyDataField(nodes: readonly DagRunNode[], field: 'dagRound' | 'overriddenBy' | 'injectedTokens' | 'cacheHitTokens'): boolean {
  for (const n of nodes as readonly DagRunNodeX[]) {
    const v = n[field];
    if (typeof v === 'number') return true;
  }
  return false;
}

/**
 * 算四个数。**纯函数** —— 不开库,不写盘,只吃 `DagRunRecord[]`。
 *
 * 严格按 C-2 契约:
 *   · 所需列在库里**不存在 / 全为 NULL** → `value = null`,相关跑全进 `unknownRuns`,
 *     列名进顶层 `missingColumns`。**绝不**用 `kind !== 'conductor'` / `deps 非空`
 *     之类的代理字段顶替(那是上一轮 verifier 打回的点);
 *   · 列存在且有真实数据 → `n` 记贡献的跑数,`unknownRuns` 记该跑没贡献的;
 *   · `INV-1` `null` ≠ `0` → typeof !== 'number' 的节点**不进**分子分母,不编 0;
 *   · `INV-5` 「没记」≠ 0 → 整跑缺指标所需列时,整跑进 `unknownRuns`,**不**算成 0 浪费。
 */
export function computeWaste(records: readonly DagRunRecord[]): WasteReport {
  // ─── 1. 拼出全库节点 + 每跑 (nodes, levels) ───
  const allNodes: DagRunNode[] = [];
  const perRun: { nodes: readonly DagRunNode[]; levels: readonly string[][] }[] = [];
  for (const r of records) {
    const nodes = Array.isArray(r.nodes) ? r.nodes : [];
    const levels = Array.isArray(r.levels) ? r.levels : [];
    allNodes.push(...nodes);
    perRun.push({ nodes, levels });
  }

  // ─── 2. 检测每个指标所依赖的列是否在库里**有任何数** ───
  const hasDagRound = hasAnyDataField(allNodes, 'dagRound');
  const hasOverriddenBy = hasAnyDataField(allNodes, 'overriddenBy');
  const hasInjected = hasAnyDataField(allNodes, 'injectedTokens');
  const hasCacheHit = hasAnyDataField(allNodes, 'cacheHitTokens');

  const missingColumns: string[] = [];
  if (!hasDagRound) missingColumns.push('dagRound');
  if (!hasOverriddenBy) missingColumns.push('overriddenBy');
  if (!hasInjected) missingColumns.push('injectedTokens');
  if (!hasCacheHit) missingColumns.push('cacheHitTokens');

  // ─── 3. nodeWasteTokens ───
  // 契约:分子 = 被后一轮覆盖的节点的 tokensIn 之和;
  //       分母 = 全图节点 tokensIn 之和;
  // 「被覆盖」=`overriddenBy` 字段被设上的节点 (上游引擎在 settle 时给早轮那条落
  // `overriddenBy = currentEngineRound`,末轮那条不设 —— 与「最后一轮的节点不是浪费」
  // 契约一致)。`dagRound` 单独留作跨轮身份列,但**判定覆盖只看 `overriddenBy`**,两者
  // 必须同时有数据才算可量。
  let tokensAll = 0;
  let wastedTokensAll = 0;
  let tokensRuns = 0;
  let tokensUnknown = 0;
  if (!hasDagRound || !hasOverriddenBy) {
    tokensUnknown = perRun.length;
  } else {
    for (const { nodes } of perRun) {
      let runTokens = 0;
      let runWasted = 0;
      let anyContributing = false;
      for (const n of nodes as DagRunNodeX[]) {
        const inTok = n.tokensIn;
        if (typeof inTok !== 'number') continue;
        anyContributing = true;
        runTokens += inTok;
        // 「被覆盖」= `overriddenBy` 是 number 且 > 0 (末轮 0 / undefined 不算)
        const ovr = n.overriddenBy;
        if (typeof ovr === 'number' && ovr > 0) runWasted += inTok;
      }
      if (anyContributing) {
        tokensRuns += 1;
        tokensAll += runTokens;
        wastedTokensAll += runWasted;
      } else {
        tokensUnknown += 1;
      }
    }
  }
  const nodeWasteTokens: WasteMetric<number> = {
    value: hasDagRound && hasOverriddenBy && tokensAll > 0 ? wastedTokensAll / tokensAll : null,
    n: tokensRuns,
    unknownRuns: tokensUnknown,
  };

  // ─── 4. handoffTax ───
  // 契约:分子 = `injectedTokens` 列 SUM (不为 NULL 的);
  //       分母 = 节点 `tokensIn` SUM (全图);
  // 严禁用「有 deps 的节点的 tokensIn」代理 (那是上一轮 verifier 打回的点)。
  let handoffInAll = 0;
  let handoffTokensAll = 0;
  let handoffRuns = 0;
  let handoffUnknown = 0;
  if (!hasInjected) {
    handoffUnknown = perRun.length;
  } else {
    for (const { nodes } of perRun) {
      let runIn = 0;
      let runHandoff = 0;
      let anyContributing = false;
      for (const n of nodes) {
        const inTok = n.tokensIn;
        const inj = n.injectedTokens;
        if (typeof inTok !== 'number' || typeof inj !== 'number') continue;
        anyContributing = true;
        runIn += inTok;
        runHandoff += inj;
      }
      if (anyContributing) {
        handoffRuns += 1;
        handoffInAll += runIn;
        handoffTokensAll += runHandoff;
      } else {
        handoffUnknown += 1;
      }
    }
  }
  const handoffTax: WasteMetric<number> = {
    value: hasInjected && handoffInAll > 0 ? handoffTokensAll / handoffInAll : null,
    n: handoffRuns,
    unknownRuns: handoffUnknown,
  };

  // ─── 5. cacheHitRate ───
  // 契约:节点级 cache 命中 / 节点 in;「分层 (per cache source) 留 P2, 本期只出总数」。
  let cacheInAll = 0;
  let cacheHitAll = 0;
  let cacheRuns = 0;
  let cacheUnknown = 0;
  if (!hasCacheHit) {
    cacheUnknown = perRun.length;
  } else {
    for (const { nodes } of perRun) {
      let runIn = 0;
      let runHit = 0;
      let anyContributing = false;
      for (const n of nodes) {
        const inTok = n.tokensIn;
        const hit = n.cacheHitTokens;
        if (typeof inTok !== 'number' || typeof hit !== 'number') continue;
        anyContributing = true;
        runIn += inTok;
        runHit += hit;
      }
      if (anyContributing) {
        cacheRuns += 1;
        cacheInAll += runIn;
        cacheHitAll += runHit;
      } else {
        cacheUnknown += 1;
      }
    }
  }
  const cacheHitRate: WasteMetric<number> = {
    value: hasCacheHit && cacheInAll > 0 ? cacheHitAll / cacheInAll : null,
    n: cacheRuns,
    unknownRuns: cacheUnknown,
  };

  // ─── 6. waveWidth ───
  // 契约:用现有 `levels` 列算 per-wave 并发直方图。`levels` 在 CREATE TABLE 里就有,
  // 老库也带 —— 本指标**永**不缺,`missingColumns` 不列。
  const widthCounts = new Map<number, number>();
  let levelsRuns = 0;
  let levelsUnknown = 0;
  for (const { levels } of perRun) {
    if (levels.length === 0) {
      levelsUnknown += 1;
      continue;
    }
    levelsRuns += 1;
    for (const wave of levels) {
      const w = Array.isArray(wave) ? wave.length : 0;
      if (w > 0) widthCounts.set(w, (widthCounts.get(w) ?? 0) + 1);
    }
  }
  const waveWidthHist: WaveWidthHistogram = Array.from(widthCounts.entries())
    .map(([width, runs]) => ({ width, runs }))
    .sort((a, b) => a.width - b.width);
  const waveWidth: WasteMetric<WaveWidthHistogram> = {
    value: waveWidthHist,
    n: levelsRuns,
    unknownRuns: levelsUnknown,
  };

  return { nodeWasteTokens, handoffTax, cacheHitRate, waveWidth, missingColumns };
}