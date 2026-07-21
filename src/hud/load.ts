/**
 * src/hud/load — omd-hud statusline 读侧: 从磁盘取 DAG/fog 快照 + 新鲜度分级 (纯读, 零重依赖)。
 *
 * 两处候选 home (取 mtime 最新):
 *   ① <cwd>/.omd/hud/           —— MCP server 经 .mcp.json 挂载 (OMD_DATA_HOME 未设, 落 repo 本地)。常态。
 *   ② ~/.omd/projects/<slug>/hud —— dag-*.ts 脚本入口 (script-bootstrap 设 OMD_DATA_HOME)。兜底。
 *
 * 新鲜度闸 (反 happy-path 核心, 见 types.HudDagSnapshot.updatedAt):
 *   running/pending: age ≤ TTL → live; 超 TTL → stalled (server 疑似崩, 别永远挂着假进度)。
 *   done/failed:     age ≤ grace → finished (短暂展示); 超 grace → null (收起, 不留昨天的残影)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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

function candidateHudDirs(cwd: string): string[] {
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
