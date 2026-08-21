/**
 * src/hud/mirror — HudMirror: DAG 活体进度的磁盘镜像写侧 (omd-hud 数据源)。
 *
 * RunRegistry 纯内存 (单测零磁盘, 契约不动); statusline 每 1~2s 独立 fork 读不到 server 内存 →
 * 本 mirror 在 onNodeEvent 接缝旁把 registry 记录序列化成 HudDagSnapshot 原子写 .omd/hud/dag.json
 * (2026-08-22 切片 1 加分片: 同时写 `dag-<runId8>.json`, 见下方 shard)。
 *
 * 铁律 (观察者不许扰动被观察者):
 *   - **fail-open** — 任何写失败吞掉 (WARN), 永不冒泡进引擎执行; 但不许吞证据
 *     (`[omd] .claude/CLAUDE.md` 三条坑之二: 每个 catch 至少留 runId + 路径 + 错误原文)。
 *   - **原子写** (tmp+rename) — statusline 读到的永远是完整 JSON, 不会撞见半截。
 *   - home 解析与 checkpoint-manager 一致: OMD_DATA_HOME 设 → dataPath('hud'); 未设 → repoRoot/.omd/hud。
 *
 * ## 分片 (2026-08-22, SDD 片 3 #215)
 *
 * 写两份, 都走既有的原子写:
 *   - `dag-<runId8>.json` — 每 run 一份, `runId8 = runId.slice(0, 8)`。**这是「活图地基」**:
 *     statusline 看不到 (它只认 `dag.json`), 但 `load.ts` 的 `readDagShards` 看; 屏 4 的
 *     DAG 屏从这里 hydrate。
 *   - `dag.json`           — 内容与今天**逐字相同**, = 本 run 的最新快照 (INV-HUD-1:
 *     statusline 的数据源, 它每 1~2s 独立 fork, 读不到 server 内存)。
 *
 * `runId8` 是 8 位十六进制, **会撞** (生日悖论); 而「两个 run 互相覆盖」正是这一片要修的缺陷 ——
 * 用一个会重演它的文件名是自相矛盾的。处理: **第一次写之前**读一下 `dag-<runId8>.json`
 * 里的 `runId`; 不是自己 ⇒ WARN 一行 (带两个完整 runId) 并改写 `dag-<完整 runId>.json`。
 * 判定**每个 HudMirror 实例只做一次**并缓存 (它每 run 一个进程, 不在热路径上重复付这次读)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../harness/logger';
import { dataPath } from '../harness/project-scope';
import type { FogSummary } from './fog';
import { HUD_SCHEMA, type HudDagSnapshot, type HudFogSnapshot } from './types';

/** `.omd/hud` — continuity 同级约定目录。 */
const HUD_DIR = '.omd/hud';

/**
 * HudMirror 消费的 registry 记录最小面 (RunRegistry.RunRecord 结构子集)。
 * 显式声明而非 import RunRegistry → mirror 不耦合注册表实现, 单测传假记录即可。
 *
 * 加宽: planned / settled 上的可选字段 (deps / startedAt / durationMs / usage / failureKind)
 * 全部 optional, 老记录缺这些字段时**仍是合法 HudRunRecordLike** (INV-HUD-4)。
 */
export interface HudRunRecordLike {
  goal: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  updatedAt: string;
  progress?: {
    planned: Array<{ id: string; kind: string; deps?: string[] }>;
    started: string[];
    startedAt: Record<string, string>;
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
  };
}

export class HudMirror {
  /**
   * 分片撞名检查的**单次缓存**(INV-HUD-2): 每次构造只付一次盘读;
   * `null` = 还没问过 (或 hud 目录还不存在), 问过一次就定, 之后**不再重读**。
   *
   * 三态:
   *   - `undefined` — 没查过
   *   - `null`     — 查过了, 目录不存在 / 文件不存在 / 文件不属于任何 run (runId 为空)
   *   - `string`   — 文件归属的 runId; 与自己一致 ⇒ 用短名; 不一致 ⇒ 用全名 + WARN
   *
   * 注意: 这个缓存是**这次进程**的, 进程重启后再建 HudMirror 就重新查。8 位短 id + 进程短命
   * (server 是 stdio, 客户端消失即自杀) ⇒ 撞名窗口**就这次进程里**才会发生, 缓存够用。
   */
  private shardOwnerChecked: string | null | undefined = undefined;

  /**
   * @param repoRoot 项目根 (= assemble 的 cwd, 与 CheckpointManager 同源)。
   * @param now clock 注入 (单测可冻 fog.updatedAt); 默认实时。DAG 快照用 record.updatedAt 不需此钟。
   */
  constructor(
    private readonly repoRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private hudDir(): string {
    return process.env.OMD_DATA_HOME?.trim() ? dataPath('hud') : join(this.repoRoot, HUD_DIR);
  }

  /** 原子写一个 hud 文件 (tmp+rename, fail-open, 但 catch 留证据: runId + 文件名 + err)。 */
  private atomicWrite(file: string, obj: unknown, tag: string, runId?: string): void {
    try {
      const dir = this.hudDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `${file}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
      renameSync(tmp, join(dir, file));
    } catch (err) {
      // ⚠ 三件套: runId + 文件名 + 错误原文 — 〔omd〕.claude/CLAUDE.md 三条坑之二的契约。
      logger.warn(
        { err: (err as Error).message, runId, file: tag },
        'hud-mirror: write failed (fail-open)',
      );
    }
  }

  /**
   * 把当前 run 记录写成 dag.json 活体快照 (原子, fail-open)。
   *
   * 写两份 (2026-08-22, 片 3 #215):
   *   - `dag-<runId8>.json` (活图分片; 撞名按 INV-HUD-2 处理)
   *   - `dag.json`           (statusline 数据源; 与今天逐字同形, INV-HUD-1)
   *
   * @param record RunRegistry.getRecord(runId) — null (未知 run) → 静默跳过。
   * @param levels topo 层级 (dag_run_plan 传; dag_run 省略 → 快照 levels=null 平铺渲染)。
   */
  write(runId: string, record: HudRunRecordLike | null, levels?: string[][]): void {
    if (!record) return;
    try {
      const p = record.progress ?? { planned: [], started: [], startedAt: {}, settled: [] };
      const snap: HudDagSnapshot = {
        schema: HUD_SCHEMA,
        runId,
        goal: record.goal.slice(0, 120),
        status: record.status,
        updatedAt: record.updatedAt,
        levels: levels ?? null,
        planned: p.planned,
        started: p.started,
        startedAt: p.startedAt,
        settled: p.settled,
      };
      // statusline 的数据源: 与今天逐字同形, 不动 (INV-HUD-1)。
      this.atomicWrite('dag.json', snap, 'dag.json', runId);
      // 活图分片: 短 id 撞名按 INV-HUD-2 兜成全名 + WARN; 第一次写之前只付一次盘读。
      const shardFile = this.shardFileFor(runId);
      this.atomicWrite(shardFile, snap, shardFile, runId);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, runId },
        'hud-mirror: build dag snapshot failed (fail-open)',
      );
    }
  }

  /**
   * 分片文件名: 撞名 fail-loud (INV-HUD-2)。
   *   - 第一次写分片前读一下 `dag-<runId8>.json` 里的 `runId`;
   *   - 不是自己 ⇒ WARN + 改用 `dag-<完整 runId>.json`。
   *   - 撞名 / 目录不存在 / 文件不存在 → 都用短名 (短名足够, 详查只发生在「已有别人」时)。
   *
   * 注意: 用同步读是为了**简单**——这次调用在节点事件旁路的热路径上,
   * 但每个 HudMirror 实例只查一次 (缓存), 后续都是 cache hit 的零成本分支。
   */
  private shardFileFor(runId: string): string {
    const short = `dag-${runId.slice(0, 8)}.json`;
    if (this.shardOwnerChecked !== undefined) {
      // 已知归属, 之后直接定。
      return this.shardOwnerChecked === null || this.shardOwnerChecked === runId
        ? short
        : `dag-${runId}.json`;
    }
    const dir = this.hudDir();
    let owner: string | null = null;
    try {
      if (existsSync(dir)) {
        const obj = JSON.parse(readFileSync(join(dir, short), 'utf-8')) as { runId?: unknown };
        if (typeof obj?.runId === 'string' && obj.runId) owner = obj.runId;
      }
    } catch {
      /* 半截 / 坏 JSON / 没权限 — 用短名, 不打 WARN; 短名继续承担「第一次写」的语义。
         这是观察者铁律 (不许扰动被观察者): 出问题就退一步, 不丢事件。 */
    }
    this.shardOwnerChecked = owner;
    if (owner !== null && owner !== runId) {
      // 撞名! 响亮, 不许静默盖 — 这正是这一片要修的那个缺陷的形状 (P-1 第 13 次实例)。
      logger.warn(
        { hudShard: short, existingRunId: owner, newRunId: runId },
        'hud-mirror: shard filename 撞名 — 改写 dag-<完整 runId>.json (旧分片内容不变)',
      );
      return `dag-${runId}.json`;
    }
    return short;
  }

  /**
   * 写 pathfinder 战争迷雾快照到 fog.json (原子, fail-open)。pathfinder 工具每次 renderStatus 调,
   * 更新即当前用户在操作的那张地图 → statusline 直接印 bar (零 SQLite)。
   */
  writeFog(fog: FogSummary): void {
    const snap: HudFogSnapshot = {
      schema: HUD_SCHEMA,
      updatedAt: this.now().toISOString(),
      destination: fog.destination,
      ruled: fog.ruled,
      total: fog.total,
      bar: fog.bar,
    };
    this.atomicWrite('fog.json', snap, 'fog.json');
  }
}
