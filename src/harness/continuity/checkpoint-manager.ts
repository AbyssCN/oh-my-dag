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
import type { NodeCheckpoint, DagMetadata, FixpointJournal, GoalStageJournal } from './types';
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

  // ── 外层 fixpoint journal (INV-P2-6) ─────────────────────────────────────

  /** 落 `_fixpoint.json` (原子写)。失败 → WARN (fail-open, 与 _dag.json 同纪律)。 */
  writeFixpointJournal(runId: string, journal: FixpointJournal): void {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const tmp = join(dir, '_fixpoint.tmp');
      writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf-8');
      renameSync(tmp, join(dir, '_fixpoint.json'));
    } catch (err) {
      logger.warn({ err, runId }, 'checkpoint: writeFixpointJournal failed (fail-open)');
    }
  }

  /** 读 `_fixpoint.json`。不存在/损坏 → null (调用方按"没有外层历史"处理, 即从第 1 轮起)。 */
  loadFixpointJournal(runId: string): FixpointJournal | null {
    try {
      const path = join(this.runDir(runId), '_fixpoint.json');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as FixpointJournal;
    } catch {
      return null;
    }
  }

  // ── goal 前置阶段 journal (2026-07-29) ───────────────────────────────────

  /** 落 `_goal.json` (原子写)。失败 → WARN (fail-open, 与 _dag/_fixpoint 同纪律)。 */
  writeGoalJournal(runId: string, journal: GoalStageJournal): void {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const tmp = join(dir, '_goal.tmp');
      writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf-8');
      renameSync(tmp, join(dir, '_goal.json'));
    } catch (err) {
      logger.warn({ err, runId }, 'checkpoint: writeGoalJournal failed (fail-open)');
    }
  }

  /** 读 `_goal.json`。不存在/损坏 → null (按"没有前置产出"处理, 即从 classify 重跑)。 */
  loadGoalJournal(runId: string): GoalStageJournal | null {
    try {
      const path = join(this.runDir(runId), '_goal.json');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as GoalStageJournal;
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
   * 文本制品原子写 `<runDir>/<prefix><安全化 nodeId>.txt`, 返绝对路径。失败 → null (fail-open)。
   * map 子节点 id 含 '::' 等 → 文件名安全化; 故**读取一律用返回的路径**, 不要在别处重算文件名。
   */
  private saveTextArtifact(runId: string, prefix: string, nodeId: string, text: string): string | null {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const safe = nodeId.replace(/[^\w.-]/g, '_');
      const path = join(dir, `${prefix}${safe}.txt`);
      const tmp = join(dir, `${prefix}${safe}.tmp`);
      writeFileSync(tmp, text, 'utf-8');
      renameSync(tmp, path);
      return path;
    } catch (err) {
      logger.warn({ err, runId, nodeId, prefix }, 'checkpoint: saveTextArtifact failed (fail-open)');
      return null;
    }
  }

  /**
   * fan-in **定向摘要**的"全文指针"落点: producer 全文原子写 `<runDir>/fanin-<nodeId>.txt`,
   * 返回绝对路径供摘要视图引用 (带工具的 agent consumer 需细节可自 Read)。
   * 写失败 → null (fail-open, 摘要视图退化为仅摘要无指针, 不阻断 DAG)。
   */
  saveFaninFull(runId: string, nodeId: string, text: string): string | null {
    return this.saveTextArtifact(runId, 'fanin-', nodeId, text);
  }

  /**
   * **D-O 产出面**: 节点输出**全文**落 `<runDir>/out-<nodeId>.txt`, 返绝对路径写进 checkpoint
   * (`NodeCheckpoint.outputText`)。summary 自此只给人看 —— 下游拿的是这份全文。
   * 写失败 → null (fail-open: checkpoint 无该字段, resume 退回 summary 并留痕)。
   */
  saveNodeOutput(runId: string, nodeId: string, text: string): string | null {
    return this.saveTextArtifact(runId, 'out-', nodeId, text);
  }

  /** 读回 {@link saveNodeOutput} 落的全文 (传 checkpoint 里存的绝对路径)。不存在/读失败 → null。 */
  loadNodeOutput(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
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
   *   checkpoint 存在 ∧ status=done ∧ 代数匹配 ∧ **输入面未变 (D-O)** ∧
   *   **所有 outputPaths 存在且 sha256 前 16 匹配**。
   *
   * 任意 output 文件缺失/被改 → 返回 false (需重执行)。
   * checkpoint 记录无 outputPaths → 返回 true (无产物需验证, 如 inproc/command 节点)。
   *
   * @param currentInputs D-O: 本次的 dep nodeId → **输出全文**。给了且 checkpoint 记过 inputHashes
   *   → 逐条比对, 任一依赖的产出内容变了就重跑。不给 / 老 checkpoint 无该字段 → 退回原语义
   *   (只看形态与产物), 向后兼容。
   */
  shouldSkip(
    runId: string,
    nodeId: string,
    currentGeneration?: string,
    currentInputs?: Record<string, string>,
  ): boolean {
    const cp = this.loadCheckpoint(runId, nodeId);
    if (!cp || cp.status !== 'done') return false;

    // D-O 输入面守卫: `generation` 只签图的**形态** (nodeIds + deps), 形态没变而上游重跑出**不同内容**
    // 时它一无所知 —— 于是下游被当绿跳过, 拿旧输入的产物冒充新输入的产物。这一段补的就是那个洞。
    if (cp.inputHashes && currentInputs) {
      for (const [dep, expected] of Object.entries(cp.inputHashes)) {
        const now = currentInputs[dep];
        // 依赖这次压根没产出 (缺席) 也算变了 —— 宁可重跑, 不拿来路不明的输入充数。
        if (now === undefined || hashText(now) !== expected) {
          logger.info({ runId, nodeId, dep }, 'checkpoint: 依赖输出已变 → 不跳过, 重执行 (D-O 输入面)');
          return false;
        }
      }
    }

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
 * 文本 hash (sha256 前 16 hex) —— D-O 输入面的指纹函数。与 {@link hashArtifact} 同截断长度,
 * 但吃的是内存里的字符串 (节点输出全文), 不是文件。
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
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
