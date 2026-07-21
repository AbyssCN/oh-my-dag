/**
 * src/hud/mirror — HudMirror: DAG 活体进度的磁盘镜像写侧 (omd-hud 数据源)。
 *
 * RunRegistry 纯内存 (单测零磁盘, 契约不动); statusline 每 1~2s 独立 fork 读不到 server 内存 →
 * 本 mirror 在 onNodeEvent 接缝旁把 registry 记录序列化成 HudDagSnapshot 原子写 .omd/hud/dag.json。
 *
 * 铁律 (观察者不许扰动被观察者):
 *   - **fail-open** — 任何写失败吞掉 (WARN), 永不冒泡进引擎执行。
 *   - **原子写** (tmp+rename) — statusline 读到的永远是完整 JSON, 不会撞见半截。
 *   - home 解析与 checkpoint-manager 一致: OMD_DATA_HOME 设 → dataPath('hud'); 未设 → repoRoot/.omd/hud。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
 */
export interface HudRunRecordLike {
  goal: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  updatedAt: string;
  progress?: {
    planned: Array<{ id: string; kind: string }>;
    started: string[];
    startedAt: Record<string, string>;
    settled: Array<{ id: string; status: 'done' | 'failed'; kind: string; model?: string }>;
  };
}

export class HudMirror {
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

  /** 原子写一个 hud 文件 (tmp+rename, fail-open)。 */
  private atomicWrite(file: string, obj: unknown, tag: string): void {
    try {
      const dir = this.hudDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `${file}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
      renameSync(tmp, join(dir, file));
    } catch (err) {
      logger.warn({ err }, `hud-mirror: write ${tag} failed (fail-open)`);
    }
  }

  /**
   * 把当前 run 记录写成 dag.json 活体快照 (原子, fail-open)。
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
      this.atomicWrite('dag.json', snap, 'dag.json');
    } catch (err) {
      logger.warn({ err, runId }, 'hud-mirror: build dag snapshot failed (fail-open)');
    }
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
