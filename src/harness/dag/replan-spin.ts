/**
 * src/harness/dag/replan-spin —— 平铺图确定性重规划的空转检测与修补节点合成 (SDD D2 切片 3)。
 *
 * **为什么这块存在 (背景)** —— run e7e360f6 (2026-08-25) 实证: accept 闸在仓规绊线 (禁词 / 沉默 catch
 * 净增) 上红了, 第 1 轮修复轮 deterministicReplan 重新铺了**同一张平铺图** (compileBreakdown 的确定
 * 产物, 见 types.ts:486), D-21 语义指纹 6/7 节点命中 → reuseHits=6; accept 那一条原本就是被点名
 * 节点 (frozen), 即使跑出来也不会改变判据结果。整轮**必空转**: 72 秒零修复产物。
 *
 * **本片的判据 (机械,零启发式)**:
 *   - accept 红 (verdict.pass === false) ∧ 确定性重规划产物里, 毒集前向闭包内
 *     **没有会写文件的执行节点** (即除 accept 类冻结命令节点外全部走 D-21 复用)
 *   ⇒ 命中空转, 不执行该计划, 改合成**一个**修补节点:
 *     - task  = accept 失败输出原文 + 「只修这些失败,不动其他」;
 *     - 写集  = 本轮各 leaf 写集 (write_set ∪ filesTouched) 的并集;
 *     - verify = 同一条 accept 命令 (来自 deterministicPlan 的 accept 节点, 节点定义逐字保留)。
 *
 * **零启发式**: 不分析 verifier reason 是不是「机械红 / 语义红」——闭包内是否还有会真跑的节点
 * 就是全部判据。语义红 (闭包内有实装节点被重跑) 不走此路, 照旧重规划。
 *
 * **INV**:
 *   - INV-D2-1 引擎侧一个仓库规则都不许硬编码 — 本片零规则, 纯结构判据。
 *   - INV-D2-3 三态语义 — 本片只判结构 (boolean), 不铸 FAIL/UNVERIFIED 票。
 *   - INV-D2-4 fail-open 不吞证据 — 修补节点构造失败 (try/catch) 日志留 runId + 错误原文 + fallback 路径。
 *
 * **可移植性**: `detectReplanSpin` 与 `buildRepairPlan` 都是**纯函数** —— 输入输出无副作用,
 * 单测可以脱离引擎跑 (O-6 实装前天然红的判别力来源)。引擎只在 deterministic 分支调用。
 */
import type { ConductorPlan } from '../conductor-plan';
import { merkleFingerprints } from '../plan-passes/semantic-key';
import type { LeafResult, PriorExec } from './types';

// ── 公共类型 ────────────────────────────────────────────────────────────────

/**
 * `detectReplanSpin` 与 `buildRepairPlan` 共用的输入包。
 * 取自 `engine.ts` 升级重规划分支 (≈:5477) 当时手上的事实, 不引新计算。
 */
export interface ReplanSpinArgs {
  /**
   * 毒集前向闭包 (blame ∪ downstream)。`null` = blame 解析失败 → fail-open 整轮,
   * 不是空转 (整轮是有可能真修出东西的), 不应触发本片。
   */
  closure: ReadonlySet<string> | null;
  /**
   * 确定性重规划产物 — 本轮要跑的那张图。Spin 检测看的是它「在闭包内还会不会真写文件」。
   */
  deterministicPlan: ConductorPlan;
  /** 上一轮的 plan (用于 D-21 指纹匹配: deterministicPlan 的指纹若不在 prior.poisoned 里就真跑)。 */
  priorPlan: ConductorPlan;
  /** 上一轮的指纹毒集 (D-4 跨轮传播)。闭包指纹全集, 命中者被 D-21 复用。 */
  priorPoisoned: ReadonlySet<string>;
  /** 调用方在 `config.frozenNodes` 里点名的冻结节点 (run-goal 平铺图 = `['accept']`)。 */
  frozenNodes: readonly string[];
}

/**
 * `buildRepairPlan` 的输入包 = `ReplanSpinArgs` + 这一轮的 verifier 失败原文 + 上一轮 results。
 */
export interface BuildRepairPlanArgs extends ReplanSpinArgs {
  /** 上一轮 results —— 写集 (write_set ∪ filesTouched) 从这里取, 不再重跑产物门。 */
  priorResults: Record<string, LeafResult>;
  /** 上一轮 verifier 的失败原文 (从输出里截掉轮次记号等机械前缀)。 */
  verdictReason: string;
}

// ── 空转检测 (纯函数) ────────────────────────────────────────────────────────

/**
 * 机械空转判据 (SDD D2 切片 3, INV-D2-1/-2/-3):
 *   accept 红 ∧ 闭包内**每个节点**都满足下列任一:
 *     (a) accept 类冻结命令节点 (id ∈ frozenNodes ∧ executor === 'command') — 这些是判据门,
 *         故意不被 D-21 复用 (它们就是被打回的那几位)。
 *     (b) D-21 语义指纹命中 priorPoisoned — 这些节点跑出来也不会真跑, 结果从上一轮原样复用。
 *   ⇒ 没有任何节点会真跑 + 写文件 ⇒ spin。
 *
 * `closure === null` (blame 解析失败) → 返回 false (fail-open, 走整轮重规划 — 那条路**有可能**修对,
 * 不能用「整轮没用」提前判死)。
 *
 * `closure.size === 0` → 返回 false (空闭包 = 没点名任何节点, 不是空转)。
 */
export function detectReplanSpin(args: ReplanSpinArgs): boolean {
  const { closure, deterministicPlan, priorPoisoned, frozenNodes } = args;
  if (!closure || closure.size === 0) return false;

  const frozenSet = new Set(frozenNodes);
  const currentFps = merkleFingerprints(deterministicPlan);

  for (const id of closure) {
    const node = deterministicPlan.nodes[id];
    if (!node) continue; // 幽灵 id (不在图里) — 调用方预滤过则不会到这里; 真到这里 fail-open 当作不 spin。

    // (a) accept 类冻结命令节点: 判据门, 故意跑出来也不会让 reuse 命中。
    // 鉴权靠 frozenNodes (调用方显式点名) — 命名启发式 (id === 'accept') 故意不用, INV-D2-1。
    if (frozenSet.has(id) && node.executor === 'command') continue;

    // (b) D-21 复用: 当前指纹 ∈ priorPoisoned → 节点结果从上一轮拿, 不真跑。
    const fp = currentFps.get(id);
    if (fp !== undefined && priorPoisoned.has(fp)) continue;

    // 既不是冻结门, 也不会被复用 → 真跑, 可能写文件 → 不是空转。
    return false;
  }
  return true;
}

// ── 修补计划合成 (纯函数) ────────────────────────────────────────────────────

/**
 * 从一轮各 leaf 的写集里抽并集 — 用 `node.write_set` (声明) ∪ `LeafResult.filesTouched` (观察) 的并。
 * 两者**有意不互替** (silent-failures §1):
 *   - write_set 缺席 = 节点没声明 (弱 conductor 常态) → 看 filesTouched;
 *   - filesTouched 缺席 = command 节点 / 没观测 → 看 write_set;
 *   - 都有 → 并集 (哪个真都不漏)。
 *
 * 路径以 leaf 的 cwd / artifactRoot 为锚, 不在合成时改 (合成无 cwd 信息)。
 */
function collectUnionWriteSet(args: {
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  closure: ReadonlySet<string>;
}): string[] {
  const out = new Set<string>();
  for (const id of args.closure) {
    const node = args.plan.nodes[id];
    const declared = node?.write_set;
    if (Array.isArray(declared)) {
      for (const p of declared) if (typeof p === 'string' && p.length > 0) out.add(p);
    }
    const touched = args.results[id]?.filesTouched;
    if (Array.isArray(touched)) {
      for (const p of touched) if (typeof p === 'string' && p.length > 0) out.add(p);
    }
  }
  return [...out];
}

/**
 * 在 deterministicPlan 里找一个**类型为 command 的节点**, 作为修补计划的 verify 节点 (即 accept 类
 * 冻结命令的语义延续: 同一道闸再跑一遍, 看修补节点有没有把真问题修掉)。
 *
 * 优先 frozenNodes 里的 command 节点 (那是调用方显式点名的「accept 闸」 — 与 SDD 语义对齐);
 * 其次退化到任意 command 节点 (平铺图里通常唯一 — 仅一个 accept-style 命令, 没专门点 frozen
 * 时也只有一个可选)。
 *
 * 找不到 (罕见的非 command verify, 或 plan 没 verify) → 返回 null, 调用方决定要不要
 * 退回原 plan (fail-open, 不强造一个无 verify 的修补计划)。
 */
function findVerifyNode(plan: ConductorPlan, frozenNodes: readonly string[]): { id: string; node: Record<string, unknown> } | null {
  const frozenSet = new Set(frozenNodes);
  // 优先级 1: frozenNodes 里的 command 节点 (accept 闸 — 这是 SDD 主语义)
  for (const [id, node] of Object.entries(plan.nodes)) {
    if (frozenSet.has(id) && (node as { executor?: string }).executor === 'command') {
      return { id, node: node as Record<string, unknown> };
    }
  }
  // 优先级 2: 任意 command 节点 (退化路径 — 平铺图通常唯一)
  for (const [id, node] of Object.entries(plan.nodes)) {
    if ((node as { executor?: string }).executor === 'command') {
      return { id, node: node as Record<string, unknown> };
    }
  }
  return null;
}

/**
 * 修补节点 id —— 命名锚: `__repair_spin` 前缀让图谱里一眼可识别 (其他切片也用 `__` 前缀
 * 做引擎合成节点的命名空间, 例如 iterate 的 `__iterate_*`)。escCount 后缀保并发互不冲突。
 */
export function repairNodeId(escCount: number): string {
  return `__repair_spin_${escCount}`;
}

/**
 * 合成一个**修补节点** — 单 agent 节点, 带着 verifier 失败原文 + 写集约束, 让模型只修这些,
 * 不动其他。
 *
 * **结构契约**:
 *   - 返回的 plan 形如 `{ name: '<原 plan 名>__repair_spin_<escCount>', nodes: { '__repair_spin_*', '<verifyId>' } }`
 *   - 修补节点 depends_on = `[]` (独立可跑; 不阻塞 verify 之外的东西)
 *   - verify 节点 (来自 deterministicPlan 的 command 类节点) depends_on = `[repairNodeId]`
 *   - verify 节点的**字段逐字保留** deterministicPlan 的原值 (command, expect_exit, goal 等) —
 *     它就是同一道闸再跑一遍, 任何改动都让本片验证不了「同一道 verify 在修补后还判一样的语义」。
 *
 * **找不到 verify 节点** → 返回 null, 调用方走 fail-open 退回原 plan。
 */
export function buildRepairPlan(args: BuildRepairPlanArgs & { escCount: number }): ConductorPlan | null {
  const verify = findVerifyNode(args.deterministicPlan, args.frozenNodes);
  if (!verify) return null;

  const repairId = repairNodeId(args.escCount);
  const writeSet = collectUnionWriteSet({
    plan: args.priorPlan,
    results: args.priorResults,
    closure: args.closure ?? new Set<string>(),
  });

  // 任务文本体 = verifier 失败原文 + 「只修这些失败」红线 (避免模型顺手改其它东西)。
  //  截断长度防 prompt 膨胀: 8KB 已远超 LLM 真用的注意力窗口 (实测 ~4KB 后就漂)。
  const reason = (args.verdictReason ?? '').slice(0, 8192);
  const taskBody = [
    '==== 上一轮 verifier 失败原文 (accept 闸红) ====',
    reason,
    '',
    '**只修上面点名的失败**;不动其他文件、不重构、不补无关测试。',
    '**写集约束** (写入路径必须落在下列集合内, 写了集合外的路径 = 越权 = 节点判红):',
    writeSet.length > 0 ? writeSet.map((p) => `  - ${p}`).join('\n') : '  (无 — 本轮没有任何 leaf 写过文件)',
    '',
    'verify 闸 = 同一道 accept 命令, 跑完再判一次。',
  ].join('\n');

  // 修补节点: agent leaf (吃 verifier 失败原文 + 写集约束 + 模型能力)。
  // executor 默认 'agent' —— 调用方可在 planFilters / post-process 改, 这里刻意不替 conductor 决定。
  const repairNode: Record<string, unknown> = {
    goal: taskBody,
    depends_on: [],
    ...(writeSet.length > 0 ? { write_set: writeSet } : {}),
  };

  // verify 节点: 字段逐字从 deterministicPlan 拷, 只改 depends_on (挂在修补节点之后)。
  const verifyNode: Record<string, unknown> = {
    ...verify.node,
    depends_on: [repairId],
  };

  const nodes: Record<string, Record<string, unknown>> = {
    [repairId]: repairNode,
    [verify.id]: verifyNode,
  };

  return {
    name: `${args.deterministicPlan.name}__repair_spin_${args.escCount}`,
    nodes: nodes as ConductorPlan['nodes'],
  };
}

// ── 工厂: 给引擎调用方一组干净的「detect + 合成」入口 ──────────────────────────────

/**
 * 引擎在确定性重规划分支 (engine.ts:5477) 的入口 — 把当时手头的事实打包, 一行调用:
 *
 *   const spin = detectReplanSpin({ closure, deterministicPlan, priorPlan, priorPoisoned, frozenNodes });
 *   if (spin) {
 *     const repair = buildRepairPlan({ ..., priorResults, verdictReason, escCount });
 *     if (repair) deterministicPlan = repair;  // fail-open: buildRepairPlan 返 null 保留原 plan
 *   }
 *
 * 单独抽这一层 (而不是把两个函数 inline 进 engine.ts) 是为了让单测可以脱离引擎跑:
 *   - 直接传手搓的 plan, 验证 detect 真判 / 真不判;
 *   - 直接传手搓的 priorResults, 验证 buildRepairPlan 真合成 / 真合并写集。
 */
export function trySpinRepair(args: BuildRepairPlanArgs & { escCount: number }):
  | { kind: 'spin'; plan: ConductorPlan }
  | { kind: 'no-spin' }
  | { kind: 'fallback' } {
  const spin = detectReplanSpin(args);
  if (!spin) return { kind: 'no-spin' };
  const plan = buildRepairPlan(args);
  if (!plan) return { kind: 'fallback' };
  return { kind: 'spin', plan };
}
