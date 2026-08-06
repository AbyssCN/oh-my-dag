/**
 * src/serve/read-api —— web daemon 的**读侧:纯磁盘契约**(wayfinder-maps 范式)。
 *
 * 架构决策:读侧不碰任何进程内 registry —— run 可能由三种进程起(Claude Code 的 MCP 进程 /
 * detached goal-worker / daemon 自己),进程内存互不可见,而它们**全都写同一批磁盘契约**:
 *   · `.omd/continuity/<runId>/` — 结构与产物真相(_dag.json + 节点 checkpoint + out-*.txt)
 *   · `.omd/hud/{dag,fog}.json`  — 活体快照(HudMirror 原子写,带新鲜度语义)
 *   · `.omd/pathfinder` + docs/plan/pathfinder/*.md — 决策地图(md 是真相源)
 *   · `.omd/plan-ledger.db`      — plan 图库(family/版本链/战绩)
 * 于是「谁起的 run 都看得见」不是特性是必然。损坏条目跳过但按仓规留证据(WARN path+err)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import { readDagView, readFog, type DagView } from '../hud/load';
import type { HudFogSnapshot } from '../hud/types';
import { loadMap } from '../harness/pathfinder/map-store';
import { computeFog, type FogView } from '../harness/pathfinder/fog';
import { ledgerPath } from '../harness/dag-record';
import { readout, type ReadoutResult } from '../../scripts/omd-readout';
import { Database } from 'bun:sqlite';
import type { PathMap } from '../harness/pathfinder/types';

/** runId 是目录名、nodeId 是文件名成分 —— 皆来自 HTTP 边界,白名单闸(动态子节点含 `::` 与 `.`)。 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,160}$/;

export function safeRunId(id: string): string {
  if (!RUN_ID_RE.test(id)) throw new Error(`非法 runId: ${JSON.stringify(id)}`);
  return id;
}
export function safeNodeId(id: string): string {
  if (!NODE_ID_RE.test(id) || id.includes('..')) throw new Error(`非法 nodeId: ${JSON.stringify(id)}`);
  return id;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export interface RunListRow {
  runId: string;
  goal: string;
  createdAt: string;
  planName: string | null;
  nodeCount: number;
  /** settled = 有 checkpoint 的节点数 (done+failed+skipped 之和; 只算已知 nodeIds 内的)。 */
  settled: number;
  /** 活体覆盖: hud 快照恰好是这个 run 且新鲜 → live/stalled/finished; 否则 null (磁盘态不可知)。 */
  live: DagView['phase'] | null;
}

interface DagMeta {
  runId: string;
  goal: string;
  createdAt: string;
  nodeIds?: string[];
  deps?: Record<string, string[]>;
  plan?: { name?: string; description?: string; nodes?: Record<string, unknown> };
  runtimeNodes?: { id: string; parent?: string; kind?: string; deps?: string[] }[];
  taskText?: string;
}

function continuityDir(cwd: string): string {
  return join(cwd, '.omd', 'continuity');
}

function readMeta(cwd: string, runId: string): DagMeta | null {
  const f = join(continuityDir(cwd), runId, '_dag.json');
  try {
    const meta = JSON.parse(readFileSync(f, 'utf-8')) as DagMeta;
    if (typeof meta.runId !== 'string' || typeof meta.goal !== 'string') return null;
    return meta;
  } catch (err) {
    if (existsSync(f)) logger.warn({ file: f, err: String(err) }, '[serve/read] 坏 _dag.json 跳过 (证据在此)');
    return null;
  }
}

/** run 目录里的 checkpoint 文件名集合 (排除 _ 前缀元文件与 out-/fanin- 文本)。 */
function checkpointFiles(cwd: string, runId: string): string[] {
  try {
    return readdirSync(join(continuityDir(cwd), runId)).filter(
      (n) => n.endsWith('.json') && !n.startsWith('_') && n !== '_dag.json',
    );
  } catch {
    return [];
  }
}

export function listRuns(cwd: string, limit = 100): RunListRow[] {
  let dirs: string[];
  try {
    dirs = readdirSync(continuityDir(cwd), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // 目录不存在 = 还没跑过任何图, 空列表不是错误
  }
  const live = readDagView(cwd, Date.now());
  const rows: RunListRow[] = [];
  for (const dir of dirs) {
    const meta = readMeta(cwd, dir);
    if (!meta) continue;
    const ids = new Set(meta.nodeIds ?? Object.keys(meta.plan?.nodes ?? {}));
    const settled = checkpointFiles(cwd, dir).filter((n) => ids.size === 0 || ids.has(n.slice(0, -5))).length;
    rows.push({
      runId: meta.runId,
      goal: meta.goal,
      createdAt: meta.createdAt ?? '',
      planName: meta.plan?.name ?? null,
      nodeCount: ids.size,
      settled,
      live: live && live.snap.runId === meta.runId ? live.phase : null,
    });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// run detail (画布数据源)
// ---------------------------------------------------------------------------

export interface RunNodeView {
  id: string;
  deps: string[];
  /** plan 定义 (executor/goal/persona/template… 原样透传; runtime 动态子节点可能无定义)。 */
  def: unknown;
  /** runtimeNodes 里的 kind (动态子节点的执行形态)。 */
  kind: string | null;
  /** checkpoint 概要 (outputText 是大字段, 用 hasOutput 代替全文; 全文走 node output 端点)。 */
  checkpoint: {
    status: 'done' | 'failed' | 'skipped';
    leafKind?: string;
    model?: string;
    failureKind?: string;
    summary?: string;
    durationMs?: number;
    createdAt?: string;
  } | null;
  hasOutput: boolean;
}

export interface RunDetail {
  runId: string;
  goal: string;
  createdAt: string;
  taskText: string | null;
  plan: { name: string | null; description: string | null };
  nodes: RunNodeView[];
  /** 活体快照 (本 run 且新鲜才给; started/settled 驱动画布动画)。 */
  hud: DagView | null;
}

export function readRun(cwd: string, runId: string): RunDetail | null {
  safeRunId(runId);
  const meta = readMeta(cwd, runId);
  if (!meta) return null;
  const dir = join(continuityDir(cwd), runId);
  const runtimeById = new Map((meta.runtimeNodes ?? []).map((n) => [n.id, n]));
  const ids = new Set<string>([
    ...(meta.nodeIds ?? []),
    ...Object.keys(meta.plan?.nodes ?? {}),
    ...runtimeById.keys(),
  ]);
  const nodes: RunNodeView[] = [];
  for (const id of ids) {
    let checkpoint: RunNodeView['checkpoint'] = null;
    try {
      const cp = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8')) as Record<string, unknown>;
      checkpoint = {
        status: cp.status as 'done' | 'failed' | 'skipped',
        ...(cp.leafKind ? { leafKind: String(cp.leafKind) } : {}),
        ...(cp.model ? { model: String(cp.model) } : {}),
        ...(cp.failureKind ? { failureKind: String(cp.failureKind) } : {}),
        ...(cp.summary ? { summary: String(cp.summary).slice(0, 500) } : {}),
        ...(typeof cp.durationMs === 'number' ? { durationMs: cp.durationMs } : {}),
        ...(cp.createdAt ? { createdAt: String(cp.createdAt) } : {}),
      };
    } catch {
      /* 无 checkpoint = 未 settle (pending/in-flight), 不是错误 */
    }
    nodes.push({
      id,
      deps: meta.deps?.[id] ?? runtimeById.get(id)?.deps ?? [],
      def: meta.plan?.nodes?.[id] ?? null,
      kind: runtimeById.get(id)?.kind ?? null,
      checkpoint,
      hasOutput: existsSync(join(dir, `out-${id}.txt`)),
    });
  }
  const live = readDagView(cwd, Date.now());
  return {
    runId: meta.runId,
    goal: meta.goal,
    createdAt: meta.createdAt ?? '',
    taskText: meta.taskText ?? null,
    plan: { name: meta.plan?.name ?? null, description: meta.plan?.description ?? null },
    nodes,
    hud: live && live.snap.runId === runId ? live : null,
  };
}

/** 节点输出全文 (out-<id>.txt; kind=fanin → fanin-<id>.txt)。缺席 → null。 */
export function readNodeOutput(cwd: string, runId: string, nodeId: string, kind: 'out' | 'fanin' = 'out'): string | null {
  safeRunId(runId);
  safeNodeId(nodeId);
  const f = join(continuityDir(cwd), runId, `${kind}-${nodeId}.txt`);
  try {
    return readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// hud (活体 ticker) + pathfinder (地图)
// ---------------------------------------------------------------------------

export function readHudState(cwd: string): { dag: DagView | null; fog: HudFogSnapshot | null } {
  return { dag: readDagView(cwd, Date.now()), fog: readFog(cwd) };
}

export interface PathMapListRow {
  slug: string;
  destination: string;
  total: number;
  ruled: number;
  delivered: number;
  suggested: number;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export function listPathMaps(cwd: string): PathMapListRow[] {
  const dir = join(cwd, 'docs', 'plan', 'pathfinder');
  let files: string[];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const rows: PathMapListRow[] = [];
  for (const f of files) {
    const slug = f.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const map = loadMap(cwd, slug);
      if (!map) continue;
      rows.push({
        slug,
        destination: map.destination,
        total: map.tickets.length,
        ruled: map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').length,
        delivered: map.tickets.filter((t) => t.status === 'delivered').length,
        suggested: map.tickets.filter((t) => t.status === 'suggested').length,
      });
    } catch (err) {
      logger.warn({ slug, err: String(err) }, '[serve/read] 坏地图跳过 (证据在此)');
    }
  }
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** 地图 + 雾档读数 (前端要的两样东西一次给全, 免得它自己算第二份)。 */
export interface PathMapView extends PathMap {
  /**
   * 雾档 —— **服务端算**(SDD 2026-08-06 §4)。
   *
   * 判据留在 `pathfinder/fog.ts` 一处:前端只渲染不判断。放前端算等于让判据出现两份
   * (CLI/未来别的客户端各一份), 而两处各算一份必漂 —— 本仓已经为这条付过账。
   */
  fog: FogView;
}

/** 整张地图 + 雾档 (tickets 自带 blockedBy/status/suggestedBy/executorKind — 星图数据源)。 */
export function readPathMap(cwd: string, slug: string): PathMapView | null {
  if (!SLUG_RE.test(slug)) throw new Error(`非法 slug: ${JSON.stringify(slug)}`);
  const map = loadMap(cwd, slug);
  return map ? { ...map, fog: computeFog(map) } : null;
}


// ── 读数板 (⑫ 统一契约读数) ───────────────────────────────────────────────────
//
// 这块数此前**只有 CLI 看得到** —— 而它恰恰是「站在慢回路观测 agent」要看的东西
// (消耗口径 / 注意力轴 / 停止轴 / 诚实轴 / 判据四格 / 检出率)。这里只是把
// `readout()` 这个**唯一读数实现**接上 HTTP, 一个字的统计逻辑都不在这边重写。
//
// ⚠ 只读加固与 CLI 同款: readonly 连接 + `PRAGMA query_only`。

/** 读数板算一次要扫全表, 而首页会轮询 —— 缓存一小段, 免得每 5s 全表扫一遍。 */
let readoutCache: { at: number; value: ReadoutResult } | null = null;
const READOUT_TTL_MS = 8_000;

export function readReadout(cwd: string, nowMs: number = Date.now()): ReadoutResult | null {
  if (readoutCache && nowMs - readoutCache.at < READOUT_TTL_MS) return readoutCache.value;
  const dbPath = ledgerPath();
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.run('PRAGMA query_only = ON');
  } catch (err) {
    // 库还不存在 = 一次都没跑过, 不是错误。null 让前端说「还没有读数」而不是报错。
    logger.warn({ dbPath, err: String(err) }, '[serve/read] 留痕库打不开 (证据在此)');
    return null;
  }
  try {
    const value = readout({ db, limit: 200, dbPath, mapsCwd: cwd });
    readoutCache = { at: nowMs, value };
    return value;
  } finally {
    db.close();
  }
}

// ── 跨图注意力聚合 ───────────────────────────────────────────────────────────
//
// 首页要回答的第一问是「**哪一步需要人判断**」, 而票分散在多张图里。
// 这里把每张图的雾档汇总, 并**带出待决票的原话** —— LoopX 看板纪律④:
// 那一格装的是具体问题, 不是「等 owner」。

export interface AttentionTicket {
  slug: string;
  destination: string;
  ticketId: string;
  /** 原话, **不截断** —— 它就是要 owner 回答的那句。 */
  title: string;
  type: string;
}

export interface MapFogSummary {
  slug: string;
  destination: string;
  total: number;
  bands: Record<string, number>;
  phantoms: number;
}

export interface AttentionView {
  /** 等你落印的票 (跨全部图, 按图名稳定排序)。 */
  awaiting: AttentionTicket[];
  /** 现在就能派的前沿票。 */
  frontier: AttentionTicket[];
  /** 机器建议待确认。 */
  suggested: AttentionTicket[];
  /** 每张图一行的雾档汇总。 */
  maps: MapFogSummary[];
}

export function readAttention(cwd: string): AttentionView {
  const out: AttentionView = { awaiting: [], frontier: [], suggested: [], maps: [] };
  for (const row of listPathMaps(cwd)) {
    const view = readPathMap(cwd, row.slug);
    if (!view) continue;
    const bands: Record<string, number> = {};
    const byId = new Map(view.tickets.map((t) => [t.id, t]));
    for (const c of view.fog.cells) {
      bands[c.band] = (bands[c.band] ?? 0) + 1;
      const t = byId.get(c.ticketId);
      if (!t) continue;
      const entry: AttentionTicket = { slug: row.slug, destination: view.destination, ticketId: t.id, title: t.title, type: t.type };
      if (c.band === 'awaiting-owner') out.awaiting.push(entry);
      else if (c.band === 'frontier') out.frontier.push(entry);
      else if (c.band === 'suggested') out.suggested.push(entry);
    }
    out.maps.push({ slug: row.slug, destination: view.destination, total: view.tickets.length, bands, phantoms: view.fog.phantoms.length });
  }
  return out;
}
