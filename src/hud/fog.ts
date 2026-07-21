/**
 * src/hud/fog — pathfinder 战争迷雾的紧凑摘要 (纯函数, 零重依赖)。
 *
 * pathfinder.ts 的 fogBar 出 4 行 (bar + ruled/open/blocked id 列表) 且长在整个 MCP 工具树上,
 * statusline 不能拉。这里复刻 fogBar 首行的 bar 数学 (█=ruled/delivered ▒=open ░=blocked, 宽 10),
 * 结构类型入参 (PathMap 满足) → 不 import pathfinder 任何模块。
 */

/** compactFog 的结构化入参 (PathMap 天然满足)。 */
export interface FogCountable {
  destination: string;
  tickets: Array<{ status: string }>;
}

export interface FogSummary {
  destination: string;
  ruled: number;
  total: number;
  /** 渲染好的 10 宽迷雾条 (█▒░) — 写侧算好, statusline 直接印。 */
  bar: string;
}

/** 票状态计数 → 紧凑迷雾摘要 (与 pathfinder.ts fogBar 首行同口径)。 */
export function compactFog(map: FogCountable): FogSummary {
  const total = map.tickets.length;
  let ruled = 0;
  let open = 0;
  for (const t of map.tickets) {
    if (t.status === 'delivered' || t.status === 'ruled') ruled++;
    else if (t.status === 'blocked') continue; // blocked 归 ░ (bb 兜底)
    else open++;
  }
  const W = 10;
  const rb = total ? Math.round((ruled / total) * W) : 0;
  const ob = total ? Math.round((open / total) * W) : 0;
  const bb = Math.max(0, W - rb - ob);
  const bar = '█'.repeat(Math.max(0, rb)) + '▒'.repeat(Math.max(0, ob)) + '░'.repeat(bb);
  return { destination: map.destination, ruled, total, bar };
}
