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
  /** 'cancelled' (D-P): 被叫停 —— 与 failed 分开 (没失败, 只是没跑完; 可 dag_resume 续)。 */
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  /** 最后更新时刻 (ISO) — 读侧新鲜度闸的锚: 超 TTL 仍 running = server 疑似崩 → ⚠ stalled。 */
  updatedAt: string;
  /** topo 层级 (dag_run_plan 有 plan 可算; dag_run conductor 路径出图晚 → null → 平铺一行)。 */
  levels: string[][] | null;
  /**
   * 全部节点 id+kind (每轮重规划整体覆盖)。
   *
   * `deps` (2026-08-22 补, slice 1 加宽账): 只有 `expanded` 事件**真带**的那份才记下来;
   * `planned` 事件本来就不带 deps —— 根层节点这里**就是缺席** (= undefined),
   * 不许编一个 `[]` 顶上 (INV-HUD-5; 与 `DagTree.apply` 从事件建树的行为逐字一致)。
   */
  planned: Array<{ id: string; kind: string; deps?: string[] }>;
  /** 正在跑的节点 id (renderProgressAscii 的 started: string[])。 */
  started: string[];
  /** start 时刻 (ISO) — 只留**还在跑的**节点的起点; settle 时把起点搬进 `settled[i].startedAt`。 */
  startedAt: Record<string, string>;
  /**
   * 已定局节点 (done/failed/skipped + 实际模型; skipped = D-7v2 quorum 级联跳过)。
   *
   * 四个可选字段都是 2026-08-22 slice 1 加宽账接进来的, 事件上**本来就有**, 只是账本没接:
   *   - `startedAt`   = 该节点当时的 start 时刻; settle 时从 `progress.startedAt` 搬过来, 不是抄 createdAt
   *   - `durationMs`  = settle 带的引擎侧墙钟 (D-5); 老发射点没报 → 缺席 (不是 0)
   *   - `usage`       = settle 带的词元用量; 老发射点没报 → 缺席 (不是 0)
   *   - `failureKind` = 闸的分类信息 (2026-08-21 起事件才有); 缺席 = 早于本次改动的发射点,
   *                     **与 `'unclassified'` 是两件事** (`types.ts:499` 的注逐字如此)。
   * INV-HUD-4: 缺席 ≠ 0 ≠ 不适用; 读侧画「—」, 不画 `0s`、不画 `0 tok`、不编 `unclassified`。
   */
  settled: Array<{
    id: string;
    status: 'done' | 'failed' | 'skipped';
    kind: string;
    model?: string;
    startedAt?: string;
    durationMs?: number;
    usage?: { in: number; out: number };
    failureKind?: string;
  }>;
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
