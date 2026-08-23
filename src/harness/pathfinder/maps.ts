/**
 * src/harness/pathfinder/maps —— 地图的**命名与总览** (slug / 开放地图摘要 / 开或建)。
 *
 * 2026-08-01 从 `pathfinder-extension.ts` 搬出来。搬的理由不是文件太长, 是**这三个函数没有一处
 * 属于交互 TUI**: MCP 的 `path_init`/`path_map` 与 CLI 的 omd-path 都在用它们, 而它们此前与
 * `createPathfinderExtension` 同住一个文件 —— 于是零 UI 的 stdio server 只为了一个 `slugifyDestination`
 * 就把整个 `pi-coding-agent` 拖进了自己的 import 图。
 *
 * 现在的约定: **`*-extension.ts` 只放 pi TUI 的门面**, 能力本体住在别处。这条约定由
 * `src/mcp/no-cli-dep.test.ts` 守着 (从 MCP 入口走 import 图, 命中 pi-coding-agent 即红)。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeFrontier } from './frontier';
import { loadMap, saveMap } from './map-store';
import type { PathMap } from './types';

// 地图 IO 的真身迁到 map-store (单写口 mutateMap 所在); re-export 兼容既有 import (omd-path CLI / 测试)。
export { loadMap, mutateMap, saveMap } from './map-store';

/** 目的地 → 稳定 slug (markdown 文件名 + db 主键)。与 plan crystallize 同风格, 小写化。 */
export function slugifyDestination(destination: string): string {
  return (
    destination
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'map'
  );
}

/** 一张开放地图的摘要 (CLI/status 用)。 */
export interface OpenMapSummary {
  slug: string;
  destination: string;
  /** 未裁决 (非 ruled/escalated) 的票数。 */
  openCount: number;
  /** 当前前沿 (可动) 票数 (computeFrontier)。 */
  frontierCount: number;
}

/** 扫 docs/plan/pathfinder/*.md, 每图算 open/frontier 计数。目录不存在 → []。按 slug 排序。 */
export function summarizeOpenMaps(cwd: string): OpenMapSummary[] {
  const dir = join(cwd, 'docs', 'plan', 'pathfinder');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: OpenMapSummary[] = [];
  for (const f of files.sort()) {
    const slug = f.slice(0, -3);
    const map = loadMap(cwd, slug);
    if (!map) continue;
    out.push({
      slug: map.slug || slug,
      destination: map.destination,
      openCount: map.tickets.filter((t) => t.status !== 'ruled' && t.status !== 'escalated').length,
      frontierCount: computeFrontier(map).length,
    });
  }
  return out;
}

/** 开/建一张地图: slug 已存在 → resume (created=false); 否则建空图并写盘 (created=true)。 */
export function createOrResumeMap(cwd: string, destination: string): { map: PathMap; created: boolean } {
  const slug = slugifyDestination(destination);
  const existing = loadMap(cwd, slug);
  if (existing) return { map: existing, created: false };
  const map: PathMap = { destination, slug, tickets: [], decisionsLog: [] };
  saveMap(map, cwd);
  return { map, created: true };
}

