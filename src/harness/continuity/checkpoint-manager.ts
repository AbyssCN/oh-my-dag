/**
 * src/harness/continuity/checkpoint-manager.ts — W2 session continuity checkpoint 持久化管理器 (SDD §2 C2).
 *
 * 职责:
 *   - DAG checkpoint 落盘到 `<repoRoot>/.omd/continuity/<runId>/`
 *   - 原子写 (tmp+rename) 避免损坏
 *   - `shouldSkip` 验证产物一致性 (sha256 前 16 hex 匹配)
 *   - `findLatestRun` 按 mtime 查最新 run
 *   - 所有失败 fail-open (WARN 日志, 不阻断 DAG)
 *
 * 消费方:
 *   - executor-dag.ts (C4 集成)
 *   - omd-build driver (C6 停机接线)
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { logger } from '../logger';
import type { NodeCheckpoint, DagMetadata } from './types';
import { dataPath } from '../project-scope';

/** `.omd/continuity` — 约定目录, per-worktree 局部 (legacy: repoRoot 相对)。 */
const CHECKPOINT_DIR = '.omd/continuity';

// ─── CheckpointManager ──────────────────────────────────────────────────────

export class CheckpointManager {
  /** @param repoRoot — 项目根目录 (与 `git ls-files` 的 cwd 一致)。 */
  constructor(private readonly repoRoot: string) {}

  // ── Private helpers ───────────────────────────────────────────────────────

  private runDir(runId: string): string {
    // OMD_DATA_HOME 设 (script 入口) → 出目标 repo 落 ~/.omd/projects/<slug>/continuity;
    // 未设 (TUI/legacy) → repoRoot/.omd/continuity (旧语义保真, 不孤儿化既有 checkpoint)。
    const base = process.env.OMD_DATA_HOME?.trim() ? dataPath('continuity') : join(this.repoRoot, CHECKPOINT_DIR);
    return join(base, runId);
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // ── DAG metadata ─────────────────────────────────────────────────────────

  /** 落 `_dag.json`。失败 → WARN (fail-open)。 */
  writeDagMetadata(runId: string, meta: DagMetadata): void {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const tmp = join(dir, '_dag.tmp');
      writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
      renameSync(tmp, join(dir, '_dag.json'));
    } catch (err) {
      logger.warn({ err, runId }, 'checkpoint: writeDagMetadata failed (fail-open)');
    }
  }

  /** 读 `_dag.json`。不存在/损坏/parse 失败 → null。 */
  loadDagMetadata(runId: string): DagMetadata | null {
    try {
      const path = join(this.runDir(runId), '_dag.json');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as DagMetadata;
    } catch {
      return null;
    }
  }

  // ── Per-node checkpoint ──────────────────────────────────────────────────

  /**
   * 保存节点 checkpoint (原子写: tmp + rename)。
   * 失败 → WARN (fail-open)。
   */
  saveCheckpoint(runId: string, cp: NodeCheckpoint): void {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const tmp = join(dir, `${cp.nodeId}.tmp`);
      writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf-8');
      renameSync(tmp, join(dir, `${cp.nodeId}.json`));
    } catch (err) {
      logger.warn({ err, runId, nodeId: cp.nodeId }, 'checkpoint: saveCheckpoint failed (fail-open)');
    }
  }

  /**
   * 加载单个节点 checkpoint。
   * 不存在/损坏/schemaVersion 无效 → null。
   */
  loadCheckpoint(runId: string, nodeId: string): NodeCheckpoint | null {
    try {
      const path = join(this.runDir(runId), `${nodeId}.json`);
      if (!existsSync(path)) return null;
      const cp = JSON.parse(readFileSync(path, 'utf-8')) as NodeCheckpoint;
      // schema version 检查: 未来迁移兼容
      if (typeof cp.schemaVersion !== 'number') return null;
      if (cp.nodeId !== nodeId) return null; // 防错位
      return cp;
    } catch {
      return null;
    }
  }

  /**
   * 加载 run 中全部 status=done 的 checkpoint。
   * .tmp 文件 / JSON parse 失败 → 安全丢弃 (不抛)。
   */
  loadAllGreen(runId: string): NodeCheckpoint[] {
    const dir = this.runDir(runId);
    if (!existsSync(dir)) return [];

    const results: NodeCheckpoint[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === '_dag.json') continue;
        if (entry.endsWith('.tmp')) continue; // 未完成 writes → 安全丢弃

        const nodeId = entry.slice(0, -5); // 去掉 `.json`
        const cp = this.loadCheckpoint(runId, nodeId);
        if (cp && cp.status === 'done') results.push(cp);
      }
    } catch (err) {
      logger.warn({ err, runId }, 'checkpoint: loadAllGreen partial failure (fail-open)');
    }
    return results;
  }

  // ── Resume 判定 ─────────────────────────────────────────────────────────

  /**
   * 判定节点是否可跳过 (resume 场景):
   *   checkpoint 存在 ∧ status=done ∧ **所有 outputPaths 存在且 sha256 前 16 匹配**。
   *
   * 任意 output 文件缺失/被改 → 返回 false (需重执行)。
   * checkpoint 记录无 outputPaths → 返回 true (无产物需验证, 如 inproc/command 节点)。
   */
  shouldSkip(runId: string, nodeId: string, currentGeneration?: string): boolean {
    const cp = this.loadCheckpoint(runId, nodeId);
    if (!cp || cp.status !== 'done') return false;

    // W4 SHADOW-3/4: 代数守卫。currentGeneration 与 cp.generation 均有且不等 → 过期 DAG 形态
    // 的 checkpoint, 丢弃重执行 (防"过期切点乱截")。相等 → 安全跳过 (幂等)。任一缺失 → 退回
    // 仅 artifact-hash 校验 (向后兼容旧 checkpoint / 未传 generation 的旧调用)。
    if (currentGeneration != null && cp.generation != null && cp.generation !== currentGeneration) {
      return false;
    }

    for (const [path, expectedHash] of Object.entries(cp.artifactHashes)) {
      try {
        // 绝对路径原样用 (path.join 会错误拼接绝对路径); 相对路径锚到 repoRoot。
        const fullPath = isAbsolute(path) ? path : join(this.repoRoot, path);
        if (!existsSync(fullPath)) return false;
        const actualHash = fileSha256Hex(fullPath).slice(0, 16);
        if (actualHash !== expectedHash) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  // ── Run 发现 ────────────────────────────────────────────────────────────

  /**
   * 按 specSlug 查找最新 (mtime) 的 run 的 DagMetadata。
   * .omd/continuity/ 不存在 / 无可匹配 → null。
   */
  findLatestRun(specSlug: string): DagMetadata | null {
    const baseDir = join(this.repoRoot, CHECKPOINT_DIR);
    if (!existsSync(baseDir)) return null;

    try {
      const entries = readdirSync(baseDir);
      let latest: DagMetadata | null = null;
      let latestMtime = 0;

      for (const entry of entries) {
        const runDir = join(baseDir, entry);
        let st;
        try {
          st = statSync(runDir);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;

        const meta = this.loadDagMetadata(entry);
        if (!meta || meta.specSlug !== specSlug) continue;

        if (st.mtimeMs > latestMtime) {
          latest = meta;
          latestMtime = st.mtimeMs;
        }
      }

      return latest;
    } catch (err) {
      logger.warn({ err, specSlug }, 'checkpoint: findLatestRun failed (fail-open)');
      return null;
    }
  }
}

// ─── DAG 代数签名 (W4 SHADOW-3) ───────────────────────────────────────────────

/**
 * DAG 形态的确定性代数签名 = sha256(goal + 规范化 nodeIds + 规范化 deps) 前 16 hex。
 * 同形态 → 同签名 (resume 安全跳过); 形态变 (goal/节点/依赖改) → 不同签名 (过期 checkpoint 丢弃)。
 * 规范化: nodeIds 排序; deps 按 key 排序 + 各依赖数组排序 (顺序无关)。
 */
export function computeDagGeneration(meta: {
  goal: string;
  nodeIds: string[];
  deps: Record<string, string[]>;
}): string {
  const nodeIds = [...meta.nodeIds].sort();
  const deps = Object.keys(meta.deps)
    .sort()
    .map((k) => `${k}:${[...(meta.deps[k] ?? [])].sort().join(',')}`)
    .join('|');
  return createHash('sha256').update(`${meta.goal}\n${nodeIds.join(',')}\n${deps}`).digest('hex').slice(0, 16);
}

// ─── Hash utility ───────────────────────────────────────────────────────────

/**
 * 计算文件 SHA-256 hex string。
 * 用于 artifactHashes 校验。只读整个文件 (产物通常不大)。
 */
function fileSha256Hex(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 产物 hash (sha256 前 16 hex), 写 checkpoint 时用。读不到 (不存在/权限) → null (fail-open)。
 * executor-dag C4 消费。
 */
export function hashArtifact(filePath: string): string | null {
  try {
    return fileSha256Hex(filePath).slice(0, 16);
  } catch {
    return null;
  }
}
