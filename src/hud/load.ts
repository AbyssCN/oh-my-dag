/**
 * src/hud/load — omd-hud 读侧: 从磁盘取 DAG/fog 快照 + 新鲜度分级 (纯读, 零重依赖)。
 *
 * 两个面:
 *   - statusline (老入口) 只看 `dag.json`, 走 `readDagView` —— INV-HUD-1 钉死, 一字不改。
 *   - TUI DAG 屏 (2026-08-22 片 3 #216 读侧, 新增) 看全部活图分片 `dag-*.json`, 走
 *     `readDagShards` / `readDagShard` —— INV-HUD-2 读侧对偶 + INV-HUD-3/4/8。
 *
 * 两处候选 home (取 mtime 最新):
 *   ① <cwd>/.omd/hud/           —— MCP server 经 .mcp.json 挂载 (OMD_DATA_HOME 未设, 落 repo 本地)。常态。
 *   ② ~/.omd/projects/<slug>/hud —— dag-*.ts 脚本入口 (script-bootstrap 设 OMD_DATA_HOME)。兜底。
 *
 * 新鲜度闸 (反 happy-path 核心, 见 types.HudDagSnapshot.updatedAt):
 *   running/pending: age ≤ TTL → live; 超 TTL → stalled (server 疑似崩, 别永远挂着假进度)。
 *   done/failed:     age ≤ grace → finished (短暂展示); 超 grace → null (收起, 不留昨天的残影)。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HUD_SCHEMA, type HudDagSnapshot, type HudFogSnapshot } from './types';

/** running/pending 超此龄仍无更新 → 判 stalled (server 崩/卡)。 */
export const RUNNING_TTL_MS = 30_000;
/** done/failed 终态展示宽限; 超此龄 → 收起 DAG 段。 */
export const DONE_GRACE_MS = 15_000;

/** cwd basename → 简化 slug (project-scope slugifyProject 的兜底近似; 仅二级 home 用)。 */
function slugOf(cwd: string): string {
  return basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export function candidateHudDirs(cwd: string): string[] {
  const dirs = [join(cwd, '.omd', 'hud')];
  const slug = slugOf(cwd);
  if (slug) dirs.push(join(homedir(), '.omd', 'projects', slug, 'hud'));
  return dirs;
}

/** 读两处候选中 mtime 最新且 schema 匹配的快照; 无/损坏/schema 不符 → null。 */
function readFreshest<T extends { schema: number }>(cwd: string, file: string): T | null {
  let best: T | null = null;
  let bestMtime = -1;
  for (const dir of candidateHudDirs(cwd)) {
    const p = join(dir, file);
    try {
      if (!existsSync(p)) continue;
      const mtime = statSync(p).mtimeMs;
      if (mtime <= bestMtime) continue;
      const obj = JSON.parse(readFileSync(p, 'utf-8')) as T;
      if (!obj || obj.schema !== HUD_SCHEMA) continue; // 前向兼容闸: 未知 schema 当无数据
      best = obj;
      bestMtime = mtime;
    } catch {
      /* 缺失/半截/坏 JSON → 跳过该候选 (读侧永不崩) */
    }
  }
  return best;
}

export type DagPhase = 'live' | 'stalled' | 'finished';
export interface DagView {
  snap: HudDagSnapshot;
  phase: DagPhase;
  ageMs: number;
}

/** 取当前 DAG 视图 + 新鲜度分级; 无快照 / 已过收起窗 → null (DAG 段消失)。 */
export function readDagView(cwd: string, nowMs: number): DagView | null {
  const snap = readFreshest<HudDagSnapshot>(cwd, 'dag.json');
  if (!snap) return null;
  const parsed = Date.parse(snap.updatedAt);
  const ageMs = Number.isFinite(parsed) ? nowMs - parsed : Infinity; // 坏时戳 → 当极旧
  if (snap.status === 'running' || snap.status === 'pending') {
    return { snap, phase: ageMs > RUNNING_TTL_MS ? 'stalled' : 'live', ageMs };
  }
  // done | failed
  if (ageMs > DONE_GRACE_MS) return null;
  return { snap, phase: 'finished', ageMs };
}

/** 取 pathfinder 迷雾快照; 无 / 空图 (total=0) → null (不显示 fog 段)。 */
export function readFog(cwd: string): HudFogSnapshot | null {
  const f = readFreshest<HudFogSnapshot>(cwd, 'fog.json');
  return f && f.total > 0 ? f : null;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 2026-08-22 片 3 读侧 (#216 的前一半) — 活图分片读取。
 *
 * 不动 `readDagView` (INV-HUD-1: statusline 的入口, 它每 1~2s fork 读不到 server 内存)。
 * 屏 4 的 DAG 屏从此处分流: `readDagShards` 给 "列全部活 run", `readDagShard` 给 "按 runId 取一份"。
 *
 * INV 表 (本函数面):
 *   - INV-HUD-2 读侧对偶: `readDagShard` 先读 `dag-<runId8>.json`, runId 对不上再试 `dag-<完整>.json`。
 *     两份都不匹配 → null (那个 run 还没被这个 server 写过 / 已被 GC)。
 *   - INV-HUD-3 老字段 `Schema=1` 的快照继续可读; 加宽字段 (deps / durationMs / usage / failureKind / startedAt)
 *     全 optional, 老快照没有是 undefined → 切片 3 (render) 画 "—", 不编 0 / 不编 unclassified。
 *   - INV-HUD-8 读侧永不崩: 半截 JSON / 未知 schema / 坏时戳 / 目录不存在 → 跳过那份 (或该 home),
 *     别的照常。读侧不冒泡进调用方。
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * 列出 hud 目录下**全部活图分片** (2026-08-22 片 3 #216 读侧)。
 *
 * 扫两处候选 home 里所有形如 `dag-<…>.json` 的文件 (pattern `^dag-.+\.json$` 自动排除
 * statusline 用的 `dag.json` —— 它没有 `-` 后缀, 不匹配)。逐份带分级的视图, 按 `updatedAt`
 * 倒序 — 屏 4 多 run 同时画时, 新的在前, 与 `#216` 的 "跑得最热那条" 一致。
 *
 * 0 分片 / 全坏 → **空数组**, 不是 null — 调用方通常是 for-of, 空数组比 null 更省一道判空。
 *
 * @param cwd   用户视角的工作目录 (与 `readDagView` 同口径, 走同样的 `candidateHudDirs`)。
 * @param nowMs 当前时刻 (ms) — 单测可冻, 真实 / TUI render tick 调用时按 `Date.now()` 即可。
 */
export function readDagShards(cwd: string, nowMs: number): DagView[] {
  // 去重: 同一份文件跨两处 home (理论 — 写侧只挑一处) 不会重读; 两 home 同名异 run 的边角交由 seen-by-path 处理。
  const seen = new Set<string>();
  const views: DagView[] = [];
  for (const dir of candidateHudDirs(cwd)) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // 目录不存在 / 没权限 → 跳过该 home, 别的照常 (INV-HUD-8)
    }
    for (const file of files) {
      if (!/^dag-.+\.json$/.test(file)) continue; // 只要分片: `dag.json` / `fog.json` 自动落选
      const full = join(dir, file);
      if (seen.has(full)) continue;
      seen.add(full);
      const view = readSingleShard(full, nowMs);
      if (view) views.push(view);
    }
  }
  // 按 updatedAt 倒序 — 坏时戳整体视作 0 排在末尾 (正常快照 updatedAt 合法, 不该撞见坏时戳)。
  views.sort((a, b) => {
    const ta = Date.parse(a.snap.updatedAt);
    const tb = Date.parse(b.snap.updatedAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return views;
}

/**
 * 按 runId 取**一份**分片视图 (INV-HUD-2 读侧对偶): 先短名 `dag-<runId8>.json`, 读到之后
 * 核对 `snap.runId === runId`, 不匹配 (撞名后被甩去全名那份) 再试 `dag-<完整 runId>.json`。
 * 两份都不匹配 → null (没写过 / 已被 GC)。
 *
 * 仍走 `readFreshest` 的两 home 取 mtime 最新一份 —— 与 `readDagView` 行为对称, 调用方不用关心 home。
 */
export function readDagShard(cwd: string, runId: string, nowMs: number): DagView | null {
  const shortFile = `dag-${runId.slice(0, 8)}.json`;
  const shortSnap = readFreshest<HudDagSnapshot>(cwd, shortFile);
  if (shortSnap && shortSnap.runId === runId) return gradeSnapshot(shortSnap, nowMs);
  // 短名里跑的不是自己 — 撞名后写侧改写到了 `dag-<完整 runId>.json` (INV-HUD-2 写侧对偶)。
  const fullSnap = readFreshest<HudDagSnapshot>(cwd, `dag-${runId}.json`);
  if (fullSnap && fullSnap.runId === runId) return gradeSnapshot(fullSnap, nowMs);
  return null;
}

/** 单份分片 → 视图 (含新鲜度闸); 缺/坏/schema 不符/已过收起窗 → null。给 `readDagShards` 用, 不给 statusline。 */
function readSingleShard(path: string, nowMs: number): DagView | null {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HudDagSnapshot>;
    if (!obj || obj.schema !== HUD_SCHEMA) return null; // 前向兼容闸: 未知 schema 当无数据 (INV-HUD-3)
    return gradeSnapshot(obj as HudDagSnapshot, nowMs);
  } catch {
    return null; // 半截 JSON / 没权限 / 解析抛 → 跳过那份, 不冒泡 (INV-HUD-8)
  }
}

/** 新鲜度闸: 与 `readDagView` 同公式, 只在这里抽出, 不动那个函数 (INV-HUD-1 守住 statusline)。 */
function gradeSnapshot(snap: HudDagSnapshot, nowMs: number): DagView | null {
  const parsed = Date.parse(snap.updatedAt);
  const ageMs = Number.isFinite(parsed) ? nowMs - parsed : Infinity; // 坏时戳 → 当极旧
  if (snap.status === 'running' || snap.status === 'pending') {
    return { snap, phase: ageMs > RUNNING_TTL_MS ? 'stalled' : 'live', ageMs };
  }
  // done | failed | cancelled —— cancelled 也归这里 (D-P, 与 failed 同展示窗)。
  if (ageMs > DONE_GRACE_MS) return null;
  return { snap, phase: 'finished', ageMs };
}
