/**
 * src/hud/types — omd-hud statusline 的磁盘契约 (写侧 mirror ↔ 读侧 load 共享形状)。
 *
 * MCP server 每个 onNodeEvent 把 DAG 活体进度原子写 .omd/hud/dag.json (HudMirror);
 * pathfinder 保存地图时落 .omd/hud/fog.json。statusline (scripts/omd-hud.ts) 每 1~2s
 * fork 读这两个小 JSON, 用纯渲染器 (dag-ascii renderProgressAscii + fogBar 字符串) 拼多行 HUD。
 *
 * schema 字段 = 前向兼容闸: 读侧遇未知 schema 直接当"无数据"退化, 不崩。
 */

/** 当前契约版本; 破坏性改形状时 +1。 */
export const HUD_SCHEMA = 1;

/** DAG 活体快照 — HudMirror 写, statusline 读渲染层级图。 */
export interface HudDagSnapshot {
  schema: number;
  runId: string;
  /** 目标 (≤120 字, 状态行标题)。 */
  goal: string;
  /** run 生命周期 (pending 刚登记未出事件; done/failed 终态 → statusline grace 后收起)。 */
  status: 'pending' | 'running' | 'done' | 'failed';
  /** 最后更新时刻 (ISO) — 读侧新鲜度闸的锚: 超 TTL 仍 running = server 疑似崩 → ⚠ stalled。 */
  updatedAt: string;
  /** topo 层级 (dag_run_plan 有 plan 可算; dag_run conductor 路径出图晚 → null → 平铺一行)。 */
  levels: string[][] | null;
  /** 全部节点 id+kind (每轮重规划整体覆盖)。 */
  planned: Array<{ id: string; kind: string }>;
  /** 正在跑的节点 id (renderProgressAscii 的 started: string[])。 */
  started: string[];
  /** start 时刻 (ISO) — running 行耗时由 now - startedAt 算。 */
  startedAt: Record<string, string>;
  /** 已定局节点 (done/failed + 实际模型)。 */
  settled: Array<{ id: string; status: 'done' | 'failed'; kind: string; model?: string }>;
}

/** pathfinder 战争迷雾快照 — pathfinder 存图时写, statusline 直接印 bar (零 SQLite)。 */
export interface HudFogSnapshot {
  schema: number;
  updatedAt: string;
  /** 目的地 (地图 destination)。 */
  destination: string;
  /** 已 ruled/delivered 票数。 */
  ruled: number;
  /** 总票数。 */
  total: number;
  /** fogBar 渲染好的字符串 (█▒░ ruled/total 散雾) — 写侧算好, 读侧免拉 pathfinder 全树。 */
  bar: string;
}
