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
import type { NodeCheckpoint, DagMetadata, FixpointJournal, GoalStageJournal, NodeLoopJournal } from './types';
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

  /**
   * **运行时展开出来的子节点**追加进 `_dag.json` 的 `runtimeNodes` (2026-07-30 观察面补齐)。
   *
   * 只碰 `runtimeNodes` 一个字段 —— `nodeIds` / `deps` / `plan` / `generation` **一个字都不改**。
   * 理由写在 {@link DagMetadata.runtimeNodes} 上: 那四样是 resume 的一致性锚, 把运行期长出来的点
   * 并进去等于下次 resume 算出的代数与盘上每份 checkpoint 都对不上 → 整图作废重跑。
   *
   * 同 id 覆盖、新 id 追加 (重展开拿到同一个内容寻址 id = 同一个点)。`_dag.json` 还没落盘 (无 meta)
   * → 静默跳过: 这是纯观察记录, 不值得为它造一份半截元数据。全程 fail-open。
   */
  appendRuntimeNodes(runId: string, nodes: readonly NonNullable<DagMetadata['runtimeNodes']>[number][]): void {
    if (nodes.length === 0) return;
    try {
      const meta = this.loadDagMetadata(runId);
      if (!meta) return;
      const merged = new Map((meta.runtimeNodes ?? []).map((n) => [n.id, n]));
      for (const n of nodes) merged.set(n.id, n);
      this.writeDagMetadata(runId, { ...meta, runtimeNodes: [...merged.values()] });
    } catch (err) {
      logger.warn({ err, runId }, 'checkpoint: appendRuntimeNodes failed (fail-open)');
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

  // ── 节点级环 journal (P3 D-A, 2026-07-29) ────────────────────────────────

  /**
   * `_loop-<安全化 nodeId>.json` —— 每个带内环的节点一份。
   *
   * ⚠ **公开的原因不是"顺手"**(2026-08-06):轮数用尽时判词要**指名道姓**告诉人删哪个文件。
   * 此前那条判词只说「内环一轮都没跑成」,而唯一的出口就是删这份 journal —— 人得自己去猜
   * 文件名(还得猜对 `nodeId` 的安全化规则:`map` 子节点的 `::` 会被换成 `_`)。
   * **一个只有作者猜得到出口的错误,等于没有出口。**
   */
  loopPath(runId: string, nodeId: string): string {
    return join(this.runDir(runId), `_loop-${nodeId.replace(/[^\w.-]/g, '_')}.json`);
  }

  /**
   * 落节点级环 journal (原子写)。**写入时机 = 每轮 judge 判完之后**, 不是节点结束时 ——
   * 节点结束才写就等于崩在环中间毒集全丢, 那正是这个文件存在的理由。
   */
  writeNodeLoopJournal(runId: string, journal: NodeLoopJournal): void {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const path = this.loopPath(runId, journal.nodeId);
      const tmp = `${path.slice(0, -5)}.tmp`;
      writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf-8');
      renameSync(tmp, path);
    } catch (err) {
      logger.warn({ err, runId, nodeId: journal.nodeId }, 'checkpoint: writeNodeLoopJournal failed (fail-open)');
    }
  }

  /** 读节点级环 journal。不存在/损坏 → null (按"没有内环历史"处理, 即从第 1 轮起)。 */
  loadNodeLoopJournal(runId: string, nodeId: string): NodeLoopJournal | null {
    try {
      const path = this.loopPath(runId, nodeId);
      if (!existsSync(path)) return null;
      const j = JSON.parse(readFileSync(path, 'utf-8')) as NodeLoopJournal;
      if (j.nodeId !== nodeId) return null; // 防错位 (同 loadCheckpoint)
      return j;
    } catch {
      return null;
    }
  }

  /**
   * 一次 run 的**全部**节点级环 journal(N9, 2026-07-31)。
   *
   * 加它是因为读数板要的两条轴 —— 轮数、内环停止证据(`stop`)—— **只活在这些文件里**:
   * 留痕库存的是每张图跑完的结果, 环转了几轮、凭什么停的, 那张表一个字都没有。
   * 而读数板要按 runId 汇总, 手上只有 runId 没有 nodeId, {@link loadNodeLoopJournal} 用不上。
   *
   * **按文件内容认 nodeId, 不解析文件名**: {@link loopPath} 的安全化 (`[^\w.-]` → `_`) 是**有损**的,
   * 从文件名反推 nodeId 会把 `a/b` 与 `a_b` 读成同一个。名字只用来筛出这批文件。
   *
   * 目录不存在 / 某个文件坏了 → 跳过那一个, 不抛。读数板是**观察者**, 它读不出东西时的正确
   * 行为是"这一格没有数据", 不是把主路径拖下水。
   */
  listNodeLoopJournals(runId: string): NodeLoopJournal[] {
    try {
      const dir = this.runDir(runId);
      if (!existsSync(dir)) return [];
      const out: NodeLoopJournal[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('_loop-') || !name.endsWith('.json')) continue;
        try {
          const j = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as NodeLoopJournal;
          if (typeof j?.nodeId === 'string') out.push(j);
        } catch {
          // 坏一个跳一个 —— 一份半截 JSON 不该让整批读数消失。
        }
      }
      return out;
    } catch {
      return [];
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
      const target = join(dir, `${cp.nodeId}.json`);
      // t1 (图#11, 2026-08-04): 同名覆写前留存旧轮 —— f2-a-1 的教训: 两轮 run (verifier拒→repair)
      // 的 checkpoint 按 nodeId 逐轮覆写, 第一轮尾链从事后时间轴上整体消失 (「547s 空洞」伪影)。
      // 归档名 `<nodeId>.__r<K>.json` (`__r` 防与含点 nodeId 撞名); resume 语义不变:
      // loadAllGreen 明确跳过归档, loadCheckpoint 按 nodeId 只认最新。
      if (existsSync(target)) {
        let k = 1;
        while (existsSync(join(dir, `${cp.nodeId}.__r${k}.json`))) k++;
        renameSync(target, join(dir, `${cp.nodeId}.__r${k}.json`));
      }
      const tmp = join(dir, `${cp.nodeId}.tmp`);
      writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf-8');
      renameSync(tmp, target);
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
   * **内环轮间交接全文**落 `<runDir>/handoff-<nodeId>-r<round>.txt` (#226, 2026-08-23)。
   *
   * 与 {@link saveFaninFull} 同一条 No-silent-caps 纪律, 但**必须分开落**:
   * fan-in 的键是「哪个上游」(一个 dep 一份), 交接的键是「哪个节点的第几轮」——
   * 同一个 conductor 节点跨轮各有一份, 挤进 `fanin-<nodeId>` 会**逐轮互相覆盖**,
   * 而事后复盘要问的恰恰是"第 2 轮当时看见了什么"。
   *
   * 写失败 → null (fail-open: 注入退化为"有告示无指针", 不阻断 DAG)。
   */
  saveHandoffFull(runId: string, nodeId: string, round: number, text: string): string | null {
    return this.saveTextArtifact(runId, 'handoff-', `${nodeId}-r${round}`, text);
  }

  /**
   * **内环判词全文**落 `<runDir>/reason-<nodeId>-r<round>.txt` (#227, 2026-08-23)。
   *
   * 与 {@link saveHandoffFull} 同一条 No-silent-caps 纪律, 但**必须分开落**:
   * handoff 是「prompt 注入前那道交接」, reason 是「journal 里那一格」, 同节点同轮的两份全文
   * 是不同的事(交接给下一轮的输入 vs 留给自己回看的判词); 同前缀会让两者互相覆盖,
   * 而事后复盘要问的恰恰是「当时那一轮的判词原文是什么」(resume / verifier 旁路 / 读数板都靠它)。
   *
   * 写失败 → null (fail-open: 告示里说"全文未落盘", 退回今天的"只有告示无指针")。
   */
  saveReasonFull(runId: string, nodeId: string, round: number, text: string): string | null {
    return this.saveTextArtifact(runId, 'reason-', `${nodeId}-r${round}`, text);
  }

  /**
   * **D-O 产出面**: 节点输出**全文**落 `<runDir>/out-<nodeId>.txt`, 返绝对路径写进 checkpoint
   * (`NodeCheckpoint.outputText`)。summary 自此只给人看 —— 下游拿的是这份全文。
   * 写失败 → null (fail-open: checkpoint 无该字段, resume 退回 summary 并留痕)。
   */
  saveNodeOutput(runId: string, nodeId: string, text: string): string | null {
    return this.saveTextArtifact(runId, 'out-', nodeId, text);
  }

  /**
   * **失败节点输出全文**落 `<runDir>/fail-<nodeId>.txt` (2026-08-06)。改动前失败节点只有
   * 800 字 summary, 盘上 150 份非绿 checkpoint 带全文的 **0** 份。
   *
   * 两处刻意与 {@link saveNodeOutput} 不同:
   *   ① **前缀不同** (`fail-` 而非 `out-`): 多轮内环里同一个 nodeId 先失败后成功时, 同名会让
   *      成功全文覆盖失败全文, 而失败那份 checkpoint 已被归档成 `<nodeId>.__r<k>.json` 并仍
   *      指着那条路径 —— 指针活着、内容被换掉, 正是本仓在治的那种静默失效。
   *   ② **同名不覆写而是先归档** (`fail-<nodeId>.__r<k>.txt`): 同一节点连失败两轮时, 第一轮的
   *      失败全文是"这个环到底试过什么"的唯一记录 (与 `saveCheckpoint` 的 `__r` 归档同因)。
   *
   * 失败 → null (fail-open: checkpoint 无 outputText 字段, 退回 summary, 有 WARN 留痕)。
   */
  saveNodeFailureOutput(runId: string, nodeId: string, text: string): string | null {
    try {
      const dir = this.runDir(runId);
      this.ensureDir(dir);
      const safe = nodeId.replace(/[^\w.-]/g, '_');
      const target = join(dir, `fail-${safe}.txt`);
      if (existsSync(target)) {
        let k = 1;
        while (existsSync(join(dir, `fail-${safe}.__r${k}.txt`))) k++;
        renameSync(target, join(dir, `fail-${safe}.__r${k}.txt`));
      }
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 归档没做成 → 下面那次写会覆盖上一轮的失败全文,
      // 读的人得知道这一点 (仓规坑 #2)。
      logger.warn({ err, runId, nodeId }, 'checkpoint: 失败全文归档失败 → 本轮将覆盖上一轮 (fail-open)');
    }
    return this.saveTextArtifact(runId, 'fail-', nodeId, text);
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
        if (/\.__r\d+\.json$/.test(entry)) continue; // t1 覆写归档 (旧轮留证) — resume 只认最新

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
    /**
     * `baselineGate` = 这个节点是**基线测量型**(`expect_exit` 非 0)。调用方给, 因为
     * checkpoint 里没有 expect_exit 而 plan 里有 —— 与其为一个判据加一列账, 不如让知道的人说。
     */
    opts?: { baselineGate?: boolean },
  ): boolean {
    const cp = this.loadCheckpoint(runId, nodeId);
    if (!cp || cp.status !== 'done') return false;

    // ── S-43 第二张脸 (2026-08-18, run dbfe0c66): #167 那条「command 恒不跳」的**例外** ──
    // `expect_exit` 非 0 的闸验的是「**实装前**这条测试会不会红」, 而"实装前"在一个 run 里
    // 按定义只存在一次。resume 时重跑它, 量的是一个**已经不存在的时刻** —— 读到绿是必然的,
    // 而且毫无意义。实盘: s1-red/s3-red 双双 `[expect_exit 1, 实得 0]` → s1/s2 dep-skip,
    // 整张图塌掉, 而实装其实是好的。
    // #167 的理由 (command 便宜、往往就是验收 oracle, 重跑比跳过安全) 对**期望绿**的闸成立,
    // 对**期望红**的闸正好相反: 同一条规则两种语义, 不能共用一个出口。
    // ⚠ 已知的松处 (与 semantic-key.ts 那条同源): 若上游本轮重跑并改了被测文件, 继承的是
    // 旧文件的读数。仍然继承 —— 另一条路 (实装之后重测) 是**确定**错的, 这条只是**可能**旧。
    if (opts?.baselineGate) return true;

    // #167 (2026-08-17): command 节点恒不跳 —— 它的绿 checkpoint **只当账不当闸** (engine 的
    // command 出口自此也落绿, base 文件不再只可能 failed/skipped)。command 便宜且往往就是验收
    // oracle, resume 重跑一遍比"跳过一个闸"安全 —— 这条性质此前靠"不落绿"由构造成立, 现在
    // 账要诚实了, 执法点收进这里 (单点, 两个消费者 resumeGreens∧shouldSkip 都经过本函数)。
    if (cp.leafKind === 'command') return false;

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
