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
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
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
import { ALL_SEAT_IDS, SEAT_PREFERRED_COORD } from '../model/seats';
import { channelOf } from '../model/cost-ledger';
import { budgetStats } from '../model/provider-budget';
import type { ProfileSpec } from '../harness/profiles/profile';
import { loadPlaybooks, BUILTIN_PLAYBOOK_DIR, PROJECT_PLAYBOOK_DIR } from '../harness/playbook/load';
import type { Playbook } from '../harness/playbook/types';

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

// ── 座位 / 额度视图 (S4) ───────────────────────────────────────────────────────
//
// 首页那一问:「哪个座位在烧哪个桶 · 还剩多少 · 烧穿了落到哪」。
// 数据纪律与上面读数板同款:**只读真源,取不到就不给,不编 0**。
//   · 座位表 = model/seats.ts 编译期常量(SEAT_PREFERRED_COORD 只含显式配了的)
//   · 桶     = cost-ledger.channelOf(coord) —— api 与订阅分道,判据只此一处
//   · 预算   = provider-budget.budgetStats() —— ⚠ 名字叫 budget, 真实身份是 **MiMo provider
//              的限流状态**(并发/RPM),不是全 provider 通用预算;逐字段透传不改形状
//   · 花费/用量/溢出 → 本仓不存在座位粒度的映射函数(见 unavailable 各条),一律 undefined
//
// ⚠ 与文件头注不同: 本视图**不读磁盘** —— 座位表是编译期常量, budgetStats 是进程内内存态。
// cwd 保留仅为与 readRun(cwd, …) 等既有签名一致(未来若接入磁盘账本沿用同一入口)。

export interface SeatRow {
  /** 座位 id(ALL_SEAT_IDS 遍历序 = 展示序)。 */
  role: string;
  /** seats.ts 显式配的 per-node 首选坐标;没配 = undefined(该座位走 tier 类首选,运行期分派)。 */
  coord?: string;
  /** cost-ledger.channelOf(coord) 的透传结果: 烧哪个桶。无 coord → undefined(不许替它编)。 */
  channel?: 'api' | 'subscription';
  /** 座位粒度花费 —— 无已确认来源,恒 undefined(见 unavailable.spentUsd)。 */
  spentUsd?: number;
  /** 座位粒度输入 token —— 无已确认来源,恒 undefined(见 unavailable.tokensIn)。 */
  tokensIn?: number;
  /** 座位粒度输出 token —— 无已确认来源,恒 undefined(见 unavailable.tokensOut)。 */
  tokensOut?: number;
  /** 烧穿后的溢出落点 —— 调用方逐次传参,无静态登记,恒 undefined(见 unavailable.overflowTo)。 */
  overflowTo?: string;
}

export interface SeatsView {
  seats: SeatRow[];
  /** provider-budget.budgetStats() 逐字段透传(见上注释: MiMo 限流状态)。 */
  budget: { inFlight: number; waiting: number; cap: number; rpmTokens: number; rpmLimit: number };
  /** 取不到的字段/座位组合,逐项说明为什么 —— 空着不解释等于骗人。 */
  unavailable: Array<{ field: string; reason: string }>;
}

/**
 * 座位/额度只读视图。
 * 实现**零 fs 调用**(座位表是编译期常量, budgetStats 是内存态)——
 * T-4 的逐字节一致测试钉的就是这条, 未来若加磁盘缓存必须同步更新那条闸。
 */
export function readSeats(cwd: string): SeatsView {
  void cwd;

  const seats: SeatRow[] = ALL_SEAT_IDS.map((role): SeatRow => {
    const coord = SEAT_PREFERRED_COORD[role];
    return { role, ...(coord ? { coord, channel: channelOf(coord) } : {}) };
  });

  // 没配 preferredCoord 的座位 = 走 tier 类首选 + 渠道经济学, 运行期才定坐标。
  // 这里从真源派生(ALL_SEAT_IDS − 有 coord 的), 不手抄第二份 —— seats.ts 增减座位不会漂。
  const noCoordSeats = ALL_SEAT_IDS.filter((id) => !SEAT_PREFERRED_COORD[id]);

  const unavailable: SeatsView['unavailable'] = [
    ...noCoordSeats.map((role) => ({
      field: `${role}.coord`,
      reason:
        'seats.ts 未给 preferredCoord —— 该座位走 tier 类首选 + 渠道经济学运行期分派, 非静态登记' +
        '(role-models.ts 是派生视图, 不是真源)',
    })),
    {
      field: 'spentUsd',
      reason:
        'tui/usage/ledger.ts 的 byProvider 只按 provider(coord 冒号前段)聚合, 不记录发起调用的座位(role)' +
        '字段; 归到某座位属张冠李戴',
    },
    { field: 'tokensIn', reason: '同 spentUsd —— 用量与花费同源同一空缺, 拆不到座位粒度' },
    { field: 'tokensOut', reason: '同 spentUsd —— 用量与花费同源同一空缺, 拆不到座位粒度' },
    {
      field: 'overflowTo',
      reason: 'provider-budget.ts 的溢出坐标(overflowModel)由调用方逐次传参决定, 无按座位静态登记的查询函数',
    },
  ];

  return { seats, budget: budgetStats(), unavailable };
}

// ---------------------------------------------------------------------------
// S10 只读接口:Skills / MCP servers / run-board / Profiles
// ---------------------------------------------------------------------------
//
// 与上面 readSeats 一样是**纯磁盘契约**读侧:不读 daemon 内存、不读进程内 registry、
// 不提供任何写通道(启停/编辑留到后续片,若真有写通道会是第二真源)。
//
// 状态语义(DiskSource.status)统一四路复用:
//   missing = 路径不存在(正常空缺, 不记 warning) · empty = 存在但无条目 ·
//   ok = 至少一个有效条目且无失败 · partial = 有有效条目也有失败条目 ·
//   error = 路径存在但整体不可读/格式非法, 或候选条目全部失败。
// 这条把「目录不存在」与「目录空」分开返回 —— 压成同一个空数组会把「还没配置」
// 误读成「配置了但是空的」,两件事在运维判断上不是一回事(本仓 NULL ≠ 0 ≠ 不适用)。

export type DiskSourceStatus = 'missing' | 'empty' | 'ok' | 'partial' | 'error';

export interface DiskSource {
  path: string;
  kind: 'file' | 'directory';
  exists: boolean;
  status: DiskSourceStatus;
}

export interface ReadWarning {
  /** 出错文件/目录;JSONL 单行错误用 `${file}:${lineNumber}`。 */
  path: string;
  /** 必须是 String(err),保留原始错误文本。 */
  error: string;
}

/** 每个 catch 至少留一行证据(path + 原始错误文本),不许空 catch。 */
function pushReadWarning(warnings: ReadWarning[], path: string, err: unknown): void {
  const warning: ReadWarning = { path, error: String(err) };
  warnings.push(warning);
  logger.warn(warning, '[serve/read] 跳过损坏磁盘条目');
}

// ── Skills ───────────────────────────────────────────────────────────────

export interface SkillItem {
  /** 顶层技能目录名。 */
  name: string;
  scope: 'user' | 'project';
  /** 技能目录绝对路径。 */
  path: string;
  /** 目录内递归发现的 *.md 绝对路径, 字典序排列(主文档文件名未确认, 不猜 SKILL.md)。 */
  markdownFiles: string[];
}

export interface SkillsView {
  sources: { user: DiskSource; project: DiskSource };
  items: SkillItem[];
  warnings: ReadWarning[];
}

/** 符号链接跟随一次判目录:损坏链接(常见于 user skills 目录里的旧链接)当作非候选悄悄跳过, 不算失败。 */
function isSkillEntryDirectory(fullPath: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return statSync(fullPath).isDirectory();
    } catch {
      return false; // 断链, 不是候选, 不留 warning
    }
  }
  return false;
}

/** 递归收集一个技能目录下的 *.md 绝对路径。目录不可读会抛出, 由调用方记 warning。 */
function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function scanSkillsDir(dir: string, scope: 'user' | 'project', warnings: ReadWarning[]): { source: DiskSource; items: SkillItem[] } {
  if (!existsSync(dir)) return { source: { path: dir, kind: 'directory', exists: false, status: 'missing' }, items: [] };

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    pushReadWarning(warnings, dir, err);
    return { source: { path: dir, kind: 'directory', exists: true, status: 'error' }, items: [] };
  }

  const items: SkillItem[] = [];
  let hadFailure = false;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (!isSkillEntryDirectory(full, entry)) continue;
    try {
      items.push({ name: entry.name, scope, path: full, markdownFiles: collectMarkdownFiles(full).sort() });
    } catch (err) {
      pushReadWarning(warnings, full, err);
      hadFailure = true;
    }
  }

  const status: DiskSourceStatus =
    items.length === 0 ? (hadFailure ? 'error' : 'empty') : hadFailure ? 'partial' : 'ok';
  return { source: { path: dir, kind: 'directory', exists: true, status }, items };
}

/** Skills 清单:user (`~/.claude/skills`) + project (`.omd/skills`) 两层, 只读, 不猜文档文件名。 */
export function readSkills(cwd: string, homeDir: string = homedir()): SkillsView {
  const warnings: ReadWarning[] = [];
  const userScan = scanSkillsDir(join(homeDir, '.claude', 'skills'), 'user', warnings);
  const projectScan = scanSkillsDir(join(cwd, '.omd', 'skills'), 'project', warnings);
  const items = [...userScan.items, ...projectScan.items].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  );
  return { sources: { user: userScan.source, project: projectScan.source }, items, warnings };
}

// ── MCP servers ──────────────────────────────────────────────────────────

export interface McpServerItem {
  name: string;
  command: string;
  args: string[];
  /** 只公开 env 键名, 不公开值。 */
  envKeys: string[];
}

export interface McpServersView {
  source: DiskSource;
  items: McpServerItem[];
  warnings: ReadWarning[];
}

/** MCP 服务器清单, 真源 `.omd/mcp.json`(顶层键 `mcpServers`)。env 值绝不透传到响应。 */
export function readMcpServers(cwd: string): McpServersView {
  const file = join(cwd, '.omd', 'mcp.json');
  const warnings: ReadWarning[] = [];
  if (!existsSync(file)) return { source: { path: file, kind: 'file', exists: false, status: 'missing' }, items: [], warnings };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    pushReadWarning(warnings, file, err);
    return { source: { path: file, kind: 'file', exists: true, status: 'error' }, items: [], warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    pushReadWarning(warnings, file, err);
    return { source: { path: file, kind: 'file', exists: true, status: 'error' }, items: [], warnings };
  }

  const mcpServers = (parsed as Record<string, unknown> | null)?.mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers)) {
    pushReadWarning(warnings, file, new Error('顶层 mcpServers 字段缺失或类型非法'));
    return { source: { path: file, kind: 'file', exists: true, status: 'error' }, items: [], warnings };
  }

  const names = Object.keys(mcpServers);
  if (names.length === 0) return { source: { path: file, kind: 'file', exists: true, status: 'empty' }, items: [], warnings };

  const items: McpServerItem[] = [];
  let hadFailure = false;
  for (const name of names) {
    const entry = (mcpServers as Record<string, unknown>)[name] as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.command !== 'string') {
      pushReadWarning(warnings, `${file}#${name}`, new Error('server 条目缺失 command 字段或类型错'));
      hadFailure = true;
      continue;
    }
    items.push({
      name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      envKeys: entry.env && typeof entry.env === 'object' ? Object.keys(entry.env as Record<string, unknown>) : [],
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));

  const status: DiskSourceStatus = items.length === 0 ? 'error' : hadFailure ? 'partial' : 'ok';
  return { source: { path: file, kind: 'file', exists: true, status }, items, warnings };
}

// ── run-board ────────────────────────────────────────────────────────────

export interface RunBoardClaimedEvent {
  v: 1;
  ts: string;
  runId: string;
  event: 'claimed';
  writeSet: string[];
}

export interface RunBoardTerminalEvent {
  v: 1;
  ts: string;
  runId: string;
  event: 'terminal';
  outcome: string;
  note?: string;
}

export type RunBoardEvent = RunBoardClaimedEvent | RunBoardTerminalEvent;

export interface RunBoardView {
  source: DiskSource;
  items: RunBoardEvent[];
  warnings: ReadWarning[];
}

/** 并发协调看板, 真源 `.omd/run-board.jsonl`。保持文件行序, 单行坏不炸全表(partial)。 */
export function readRunBoard(cwd: string): RunBoardView {
  const file = join(cwd, '.omd', 'run-board.jsonl');
  const warnings: ReadWarning[] = [];
  if (!existsSync(file)) return { source: { path: file, kind: 'file', exists: false, status: 'missing' }, items: [], warnings };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    pushReadWarning(warnings, file, err);
    return { source: { path: file, kind: 'file', exists: true, status: 'error' }, items: [], warnings };
  }

  const lines = raw.split('\n');
  const items: RunBoardEvent[] = [];
  let hadFailure = false;
  let sawNonBlankLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    sawNonBlankLine = true;
    const lineNo = i + 1;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event === 'claimed' && typeof parsed.runId === 'string' && Array.isArray(parsed.writeSet)) {
        items.push(parsed as unknown as RunBoardClaimedEvent);
      } else if (parsed.event === 'terminal' && typeof parsed.runId === 'string' && typeof parsed.outcome === 'string') {
        items.push(parsed as unknown as RunBoardTerminalEvent);
      } else {
        throw new Error(`未知 event 或字段缺失: ${line.slice(0, 200)}`);
      }
    } catch (err) {
      pushReadWarning(warnings, `${file}:${lineNo}`, err);
      hadFailure = true;
    }
  }

  const status: DiskSourceStatus = !sawNonBlankLine ? 'empty' : items.length === 0 ? 'error' : hadFailure ? 'partial' : 'ok';
  return { source: { path: file, kind: 'file', exists: true, status }, items, warnings };
}

// ── Profiles ─────────────────────────────────────────────────────────────
//
// 与 harness/profiles/profile.ts 的 loadProfiles() 同款字段级合并语义, 但**不复用它的返回值
// 反推来源状态**(它会把两层压成一个 Map, 看不出 project 层是缺目录还是空目录)。
// 这里独立扫两层磁盘, 换来 sources.project 能区分 missing/empty。

export interface ProfileItem extends ProfileSpec {
  /** 合并结果实际使用的来源;顺序恒 builtin → project。 */
  sourceLayers: Array<'builtin' | 'project'>;
}

export interface ProfilesView {
  sources: { builtin: DiskSource; project: DiskSource };
  items: ProfileItem[];
  warnings: ReadWarning[];
}

function scanProfileDir(dir: string, warnings: ReadWarning[]): { source: DiskSource; specs: Map<string, ProfileSpec> } {
  if (!existsSync(dir)) return { source: { path: dir, kind: 'directory', exists: false, status: 'missing' }, specs: new Map() };

  let files: string[];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    pushReadWarning(warnings, dir, err);
    return { source: { path: dir, kind: 'directory', exists: true, status: 'error' }, specs: new Map() };
  }
  if (files.length === 0) {
    return { source: { path: dir, kind: 'directory', exists: true, status: 'empty' }, specs: new Map() };
  }

  const specs = new Map<string, ProfileSpec>();
  let hadFailure = false;
  for (const file of files) {
    const abs = join(dir, file);
    try {
      const raw = JSON.parse(readFileSync(abs, 'utf-8')) as Partial<ProfileSpec>;
      // 判据与引擎侧 `profiles/profile.ts:readDirProfiles` 必须一致 —— 这里是同一条规则的**第二份**
      // 实装 (视图层自己扫盘, 不走 loadProfiles)。2026-08-12 D-3 把 persona 降级为可选后, 这里一度
      // 还留着 `typeof raw.persona !== 'string'` 就拒: 结果是**引擎认、控制台不认**同一份档案 ——
      // 一个没有报错、只是列表里少一行的静默分歧。改判据时两处一起改, 或哪天把这份合并回去。
      if (typeof raw !== 'object' || raw === null || typeof raw.name !== 'string') {
        throw new Error('name 缺失或类型错');
      }
      specs.set(raw.name, raw as ProfileSpec);
    } catch (err) {
      pushReadWarning(warnings, abs, err);
      hadFailure = true;
    }
  }

  const status: DiskSourceStatus = specs.size === 0 ? 'error' : hadFailure ? 'partial' : 'ok';
  return { source: { path: dir, kind: 'directory', exists: true, status }, specs };
}

/**
 * Profiles 视图:内置 (`src/harness/profiles/builtin/*.json`) + 项目层 (`.omd/profiles/*.json`)
 * 字段级合并(project 字段胜, 未写字段保留 builtin), 但两层的 DiskSource 独立判定 —— 不从
 * 合并结果反推来源状态。
 */
export function readProfiles(cwd: string): ProfilesView {
  const warnings: ReadWarning[] = [];
  const builtinDir = join(import.meta.dir, '..', 'harness', 'profiles', 'builtin');
  const projectDir = join(cwd, '.omd', 'profiles');
  const builtinScan = scanProfileDir(builtinDir, warnings);
  const projectScan = scanProfileDir(projectDir, warnings);

  const merged = new Map<string, ProfileItem>();
  for (const [name, spec] of builtinScan.specs) merged.set(name, { ...spec, sourceLayers: ['builtin'] });
  for (const [name, spec] of projectScan.specs) {
    const base = merged.get(name);
    merged.set(name, base ? { ...base, ...spec, sourceLayers: ['builtin', 'project'] } : { ...spec, sourceLayers: ['project'] });
  }

  const items = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources: { builtin: builtinScan.source, project: projectScan.source }, items, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflows 外层: playbook 只读视图 (控制台 SDD D-5/D-7)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaybooksView {
  sources: { builtin: DiskSource; project: DiskSource };
  items: Playbook[];
  warnings: ReadWarning[];
}

/**
 * Playbooks 视图:内置 (`templates/playbooks/`) + 项目层 (`.omd/playbooks/`) 叠加, 项目层同名胜。
 *
 * **为什么这里要 catch, 而 `loadPlaybooks` 自己是 fail-closed 的**:那个函数刻意选了「一份坏
 * playbook → 整次加载抛错」—— 因为静默跳过会让调用方把"它被拒收"读成"没这个 playbook"。
 * 那条纪律对**引擎**成立;对**只读视图**不成立:一份坏 playbook 不该让控制台整页打不开。
 * 所以这里接住异常, 但**不吞证据** —— 原文进 warnings, 读的人看得见"这层没读成"而不是空列表。
 * 两种"空"因此可分:`status:'missing'`(目录不在)vs `status:'error'`(读了但拒收)。
 */
export function readPlaybooks(cwd: string): PlaybooksView {
  const warnings: ReadWarning[] = [];
  const builtinDir = BUILTIN_PLAYBOOK_DIR;
  const projectDir = join(cwd, PROJECT_PLAYBOOK_DIR);
  const dirSource = (dir: string): DiskSource =>
    existsSync(dir)
      ? { path: dir, kind: 'directory', exists: true, status: 'ok' }
      : { path: dir, kind: 'directory', exists: false, status: 'missing' };

  let items: Playbook[] = [];
  let failed = false;
  try {
    items = [...loadPlaybooks(cwd).values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    pushReadWarning(warnings, `${builtinDir} | ${projectDir}`, err);
    failed = true;
  }

  const stamp = (dir: string): DiskSource => {
    const s = dirSource(dir);
    // 加载整体失败时, 两层都标 error —— 抛错不指名是哪一层的锅, 不猜。
    return failed && s.exists ? { ...s, status: 'error' } : s;
  };
  return { sources: { builtin: stamp(builtinDir), project: stamp(projectDir) }, items, warnings };
}
