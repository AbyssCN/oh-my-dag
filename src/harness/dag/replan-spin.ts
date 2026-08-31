/**
 * src/harness/dag/replan-spin —— 平铺图确定性重规划的空转检测与修补节点合成 (SDD D2 切片 3 + 修补上下文补刀 2026-08-31)。
 *
 * **为什么这块存在 (背景)** —— run e7e360f6 (2026-08-25) 实证: accept 闸在仓规绊线 (禁词 / 沉默 catch
 * 净增) 上红了, 第 1 轮修复轮 deterministicReplan 重新铺了**同一张平铺图** (compileBreakdown 的确定
 * 产物, 见 types.ts:486), D-21 语义指纹 6/7 节点命中 → reuseHits=6; accept 那一条原本就是被点名
 * 节点 (frozen), 即使跑出来也不会改变判据结果。整轮**必空转**: 72 秒零修复产物。
 *
 * **本片的判据 (机械,零启发式;2026-08-25 修 #272/#273 后与 D-21 判据同源)**:
 *   - accept 红 (verdict.pass === false) ∧ 确定性重规划产物里**没有任何会真跑的非门节点**
 *     —— 「会不会真跑」不再用指纹近似, 直接吃引擎 `computeReuse` 的预览结果 (`reusedIds`):
 *     节点会真跑 = 非(冻结命令门 ∨ id ∈ reusedIds)。
 *   ⚠ 两个活体反例钉死了为什么不能自己近似:
 *     #272 (run b5b7a214): 仓规红判词 100% 无路径 → closure 恒空 → 旧守卫漏报, 修补缺席;
 *     #273 (run b13545da/8a95ce84): failed 节点指纹被旧逻辑当「会复用」→ 误报, 修补计划
 *     替换了本要真重跑的计划, 切片 dep-skip 到死。computeReuse 只认 done+非毒+依赖链全可复用,
 *     两个形状天然都判对 —— 判据抄一份必漂, 这里改成引用引擎那一份 (同 INV-D3-1 教训)。
 *   ⇒ 命中空转, 不执行该计划, 改合成**一个**修补节点:
 *     - task  = accept 失败输出原文 + 「只修这些失败,不动其他」;
 *     - 写集  = 本轮各 leaf 写集 (write_set ∪ filesTouched) 的并集;
 *     - verify = 同一条 accept 命令 (来自 deterministicPlan 的 accept 节点, 节点定义逐字保留)。
 *
 * **零启发式**: 不分析 verifier reason 是不是「机械红 / 语义红」——闭包内是否还有会真跑的节点
 * 就是全部判据。语义红 (闭包内有实装节点被重跑) 不走此路, 照旧重规划。
 *
 * **修补节点 goal 七段构造 (SDD 2026-08-31, owner 裁「先补上下文不升座」)**:
 *   修补节点之前只拿到判词, 看不见「自己上一轮改了什么 / 本来要干什么 / 哪个切片红了」。
 *   本片 (切片 1) 给它拼七段, 顺序按注意力位阶 (D-5):
 *     原任务 → 逐节点结果 → diff (或缺席说明) → 判词 → 红线 → 写集约束 → verify 说明
 *   - 原任务 / 逐节点结果 / diff 三段 = 事实 (调用点已在手, 不新增采集, D-2);
 *   - 判词 / 红线 / 写集约束 / verify 说明 = 旧任务文本体, 段序按近因区重排。
 *   diff 两档分辨 (D-3): 隔离档 (给了 rollbackBaseline) → 注入 diff **正文**;
 *                        head 档 (无 baseline) → 「写集内变了哪些」清单 + 「本档无 diff 正文」。
 *   diff 限定写集内 (D-4) — 越界路径不许塞进 prompt。
 *   diff 6KB 截断带「已截断 N 字节」+ 自取命令 (D-6, No-silent-caps);
 *   git 跑挂 → 段缺席 + 证据行, 不阻断合成 (D-7, fail-open 不吞证据)。
 *
 * **INV**:
 *   - INV-D2-1 引擎侧一个仓库规则都不许硬编码 — 本片零规则, 纯结构判据。
 *   - INV-D2-3 三态语义 — 本片只判结构 (boolean), 不铸 FAIL/UNVERIFIED 票。
 *   - INV-D2-4 fail-open 不吞证据 — 修补节点构造失败 (try/catch) 日志留 runId + 错误原文 + fallback 路径。
 *   - 修补上下文切片 1 (2026-08-31): 七段位置固定 (INV-1), diff 两档分辨 (INV-2),
 *     diff 路径 ⊆ 写集 (INV-3), 截断响亮 (INV-4), git 失败 → 段缺席 + 证据 (INV-5),
 *     既有行为零回归 (INV-6)。
 *
 * **可移植性**: `detectReplanSpin` 与 `buildRepairPlan` 都是**纯函数** —— 输入输出无副作用,
 * 单测可以脱离引擎跑 (O-6 实装前天然红的判别力来源)。引擎只在 deterministic 分支调用。
 */
import type { ConductorPlan } from '../conductor-plan';
import type { LeafResult } from './types';
import {
  changedSinceHeadBaseline,
  type HeadWriteSetBaseline,
} from '../writeset/head-baseline';

// ── 段标题锚 (SDD 2026-08-31 切片 1, INV-1 / 测试用「REPAIR_CONTEXT」字面锚定) ──

/**
 * 修补节点 goal 的七段固定标题锚。测试通过这些字面串断言段位与段序, 散在测试里抄字面量
 * = 漂移点 (刀①的实测教训), 一律走这个常量。
 */
export const REPAIR_CONTEXT = {
  TASK: '==== 原任务 (用户目标) ====',
  PRIOR_RESULTS: '==== 上一轮逐节点结果 ====',
  DIFF: '==== 本轮写入 vs 基线 (diff) ====',
  VERDICT: '==== 上一轮 verifier 失败原文 (accept 闸红) ====',
  RED_LINE: '==== 红线: 只修上面点名的失败 ====',
  WRITE_SET: '==== 写集约束 ====',
  VERIFY_NOTE: '==== verify 说明 ====',
} as const;

/** 段标题锚定用顺序数组 (INV-1 钉死的近因区位阶)。测试可遍历它做段位断言。 */
export const REPAIR_CONTEXT_ORDER: readonly string[] = [
  REPAIR_CONTEXT.TASK,
  REPAIR_CONTEXT.PRIOR_RESULTS,
  REPAIR_CONTEXT.DIFF,
  REPAIR_CONTEXT.VERDICT,
  REPAIR_CONTEXT.RED_LINE,
  REPAIR_CONTEXT.WRITE_SET,
  REPAIR_CONTEXT.VERIFY_NOTE,
];

/** diff 段上限 (D-6): 6KB 已超 LLM 真用注意力窗口, 越界必须响亮截断。 */
export const REPAIR_DIFF_MAX_BYTES = 6 * 1024;

// ── 公共类型 ────────────────────────────────────────────────────────────────

/**
 * `detectReplanSpin` 与 `buildRepairPlan` 共用的输入包。
 * 取自 `engine.ts` 升级重规划分支 (≈:5477) 当时手上的事实, 不引新计算。
 */
export interface ReplanSpinArgs {
  /**
   * 毒集前向闭包 (blame ∪ downstream)。**只用于修补节点的写集并集范围提示**
   * (空/null → 并集退到 priorPlan 全图), 不再参与空转判定 (#272: 仓规红判词无路径时
   * closure 恒空, 拿它当判定前置会漏掉最主流的空转形状)。
   */
  closure: ReadonlySet<string> | null;
  /**
   * 确定性重规划产物 — 本轮要跑的那张图。Spin 检测看的是它「还会不会真跑非门节点」。
   */
  deterministicPlan: ConductorPlan;
  /** 上一轮的 plan (修补节点写集并集的来源图)。 */
  priorPlan: ConductorPlan;
  /**
   * 引擎 `computeReuse` 对 deterministicPlan 的预览结果 (会被 D-21 复用的节点 id 集)。
   * **判据同源 (#273)**: 只有 done + 非毒 + 依赖链全可复用的节点才在这里 —— failed/skipped
   * 节点天然缺席, 空转判定因此不会把「必须重跑的失败切片」误当成「会复用」。
   * 调用方必须传引擎真算的那一份, 禁止用指纹自己近似 (近似即 #273 的病)。
   */
  reusedIds: ReadonlySet<string>;
  /** 调用方在 `config.frozenNodes` 里点名的冻结节点 (run-goal 平铺图 = `['accept']`)。 */
  frozenNodes: readonly string[];
}

/**
 * 修补节点 diff 段的取数函数 (测试可注入, 默认实现在本文件外 — 调用方 (engine) 在隔离档下
 * 调 `git diff <baseline> -- <paths>`; 签名一致, 行为同 `writeset-evidence.defaultRunGit` 但
 * 产出 diff 正文而非 porcelain 状态行)。
 */
export type GitDiffFn = (args: { baseline: string; paths: readonly string[]; cwd: string }) => string;

/**
 * 修补节点上下文补刀 (SDD 2026-08-31 切片 1) — 注入面三件:
 *   - `task`: 原任务字符串 (engine.ts 拼 escTask 用的同一个变量, 同作用域; D-2)
 *   - `baseline`: 隔离档 commit (缺席 = head 档; D-3 两档分辨的判别依据)
 *   - `headSnapshot`: head 档的写集哈希快照 (缺席 = 不给清单, 走「本档无 diff 正文」)
 *   - `gitCwd`: git 跑哪 (隔离档 = execRoot, head 档 = repoRoot; 调用方给)
 *   - `gitDiff`: 取数函数 (测试可注入, 默认在调用方一侧实装; 本片签名先行)
 *   - `logEvidence`: 证据回调 — fail-open 留证 (INV-D2-4 / D-7)
 */
export interface BuildRepairPlanArgs extends ReplanSpinArgs {
  /** 上一轮 results —— 写集 (write_set ∪ filesTouched) 从这里取, 不再重跑产物门。 */
  priorResults: Record<string, LeafResult>;
  /** 上一轮 verifier 的失败原文 (从输出里截掉轮次记号等机械前缀)。 */
  verdictReason: string;
  /**
   * 原任务字符串 (用户目标)。七段之第 1 段, 不传则降级到空串 — 老调用点 (切片 3 的 G-6/G-7)
   * 仍能跑, 但 goal 缺原任务段 (留空白首段以保段序, 不偷偷抹掉位阶)。
   */
  task?: string;
  /**
   * 隔离档的回滚基线 commit (有 → 隔离档, 走 git diff 取 diff 正文; 缺席 → head 档)。
   * D-3 两档分辨的唯一判别依据; 两档混 = 静默把 head 档降级成「没改动」, NULL≠0≠不适用。
   */
  baseline?: string;
  /**
   * head 档的写集哈希快照 (隔离档不入这条 — 隔离档有 baseline 拿正文)。
   * 给则产出「写集内变了哪些」清单 + 「本档无 diff 正文」; 不给 → 仅「本档无 diff 正文」。
   */
  headSnapshot?: HeadWriteSetBaseline;
  /**
   * git 跑哪 (隔离档 = continuity.execRoot, head 档 = continuity.repoRoot; 调用方给)。
   * 缺省 = `process.cwd()` (纯函数语境; 引擎接线处必传, 避免修路径漂移)。
   */
  gitCwd?: string;
  /** diff 取数函数。测试注入; 默认由调用方实装 (切片 2 接线处补真实 git)。 */
  gitDiff?: GitDiffFn;
  /**
   * 证据回调 — fail-open 不吞证据的承载点 (INV-D2-4 / D-7)。
   * 不传 = `() => {}` (纯函数语境); 引擎接线走既有 logger.warn / logger.info。
   */
  logEvidence?: (msg: string, payload?: Record<string, unknown>) => void;
}

// ── 空转检测 (纯函数) ────────────────────────────────────────────────────────

/**
 * 机械空转判据 (2026-08-25 判据同源版, 修 #272 漏报 + #273 误报):
 *   扫 deterministicPlan **全图** (不再以 closure 为前置 —— #272 的守卫排除了主流形状),
 *   每个节点满足下列任一即「不会真跑」:
 *     (a) 冻结命令门 (id ∈ frozenNodes ∧ executor === 'command') — 判据门, 跑了也不改产物;
 *     (b) id ∈ reusedIds — 引擎 computeReuse 预览判它 D-21 复用 (done+非毒+依赖链可复用)。
 *   全图无一会真跑的非门节点 ⇒ spin。存在任何会真跑的非门节点 (含 failed/skipped 切片的重跑,
 *   #273 的形状) ⇒ 不是空转, 让确定性计划正常执行。
 *
 * 证伪方式: 把 (b) 改回指纹近似 (fp ∈ poisoned 判复用) → replan-spin.test.ts 的
 * 「#273 误报形状」用例当场红; 把全图扫描改回 closure 前置 → 「#272 漏报形状」用例当场红。
 */
export function detectReplanSpin(args: ReplanSpinArgs): boolean {
  const { deterministicPlan, reusedIds, frozenNodes } = args;
  const frozenSet = new Set(frozenNodes);

  for (const [id, node] of Object.entries(deterministicPlan.nodes)) {
    // (a) 冻结命令门: 判据门, 故意不被复用 (它们就是被打回的那几位)。
    // 鉴权靠 frozenNodes (调用方显式点名) — 命名启发式 (id === 'accept') 故意不用, INV-D2-1。
    if (frozenSet.has(id) && (node as { executor?: string }).executor === 'command') continue;

    // (b) 引擎预览判复用 → 不真跑。
    if (reusedIds.has(id)) continue;

    // 会真跑的非门节点 (含 failed/skipped 后的强制重跑) → 不是空转。
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

// ── 七段构造纯函数 (SDD 2026-08-31 切片 1) ──────────────────────────────────

/**
 * 逐节点结果段 (段 2) —— 把上一轮各 leaf 的事实压一行:
 *   `<id> [<status>/<kind>] filesTouched=<N> · <summary 截 160 字>`
 * summary 单行化 (换行 → 空格) 防破坏段结构; 截 160 字保 prompt 不被单一长输出吹爆。
 */
export function renderPriorResults(results: Record<string, LeafResult>): string {
  const lines: string[] = [];
  for (const [id, r] of Object.entries(results)) {
    const status = (r && typeof r.status === 'string') ? r.status : '?';
    const kind = (r && typeof r.kind === 'string') ? r.kind : '?';
    const touched = Array.isArray(r?.filesTouched) ? r.filesTouched.length : 0;
    const rawSummary = typeof r?.output === 'string' ? r.output : '';
    const summary = rawSummary.slice(0, 160).replace(/\s+/g, ' ');
    lines.push(`${id} [${status}/${kind}] filesTouched=${touched} · ${summary}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(无逐节点结果)';
}

/**
 * 截断响亮化 (D-6 / No-silent-caps) —— diff 正文超 6KB 时, 截断 + 「已截断 N 字节」+
 * 自取命令 (让人工 / 模型知道这不是全文, 真要全的自己去跑 git diff)。
 */
export function truncateDiff(raw: string, baseline: string): string {
  if (raw.length <= REPAIR_DIFF_MAX_BYTES) return raw;
  const dropped = raw.length - REPAIR_DIFF_MAX_BYTES;
  return [
    raw.slice(0, REPAIR_DIFF_MAX_BYTES),
    '',
    `[已截断 ${dropped} 字节, 完整 diff 自取 git diff ${baseline} -- <paths>]`,
  ].join('\n');
}

/**
 * diff 段三态:
 *   - `{ kind: 'skip' }`           写集空 → 整段缺席 (GWT-3);
 *   - `{ kind: 'body', text }`     隔离档 git 跑成功 → diff 正文 (可能已被 truncateDiff 截断);
 *   - `{ kind: 'absent', reason, changed? }`
 *       head 档 / git 跑挂 / 无基线 → 「无 diff 正文」说明 (head 档带「写集内变了哪些」清单)。
 *
 * D-3 两档分辨在 baseline 字段上判; D-4 限定路径 ⊆ writeSet; D-6 截断带提示;
 * D-7 git 抛错 → logEvidence 一次 + 段缺席 (不阻断合成)。
 */
export function renderDiffSegment(args: {
  writeSet: readonly string[];
  baseline?: string;
  headSnapshot?: HeadWriteSetBaseline;
  gitCwd?: string;
  gitDiff?: GitDiffFn;
  logEvidence?: (msg: string, payload?: Record<string, unknown>) => void;
}): { kind: 'skip' } | { kind: 'body'; text: string } | { kind: 'absent'; reason: string; changed?: string[] } {
  // GWT-3: 写集空 → 整段缺席, git runner 零调用。
  if (args.writeSet.length === 0) return { kind: 'skip' };

  // 隔离档 (baseline 非空) → 走 gitDiff 取正文。throw/fail-open: logEvidence + 段缺席。
  if (args.baseline) {
    if (!args.gitDiff) {
      // 调用方在隔离档下没给 gitDiff — 视为段缺席, 但仍记证据 (缺取数函数 = 装配错)。
      args.logEvidence?.('[omd/repair-spin] 隔离档给了 baseline 但未提供 gitDiff → 段缺席', { baseline: args.baseline });
      return { kind: 'absent', reason: `本档无 diff 正文 (隔离档未注入 gitDiff); 自取 git diff ${args.baseline} -- <paths>` };
    }
    const cwd = args.gitCwd ?? process.cwd();
    try {
      const raw = args.gitDiff({ baseline: args.baseline, paths: [...args.writeSet], cwd });
      return { kind: 'body', text: truncateDiff(raw, args.baseline) };
    } catch (err) {
      // D-7: git 跑挂 → 段缺席 + 证据行, 不阻断合成。
      // ⚠ 错误原文只走 logEvidence —— 不漏进 goal prompt (raw git 错误对模型是噪声,
      // 调试靠日志而非 prompt; 这也是 No-silent-caps 的镜像原则: prompt 侧给的是「有这么回事」,
      // 证据侧给的是「实际是什么事」)。
      args.logEvidence?.('[omd/repair-spin] diff 取数失败 → 段缺席 (fail-open 留证)', {
        baseline: args.baseline,
        pathCount: args.writeSet.length,
        err: (err as Error).message ?? String(err),
      });
      return { kind: 'absent', reason: `diff 取数失败 (git runner 抛错, 详见日志证据); 自取 git diff ${args.baseline} -- <paths>` };
    }
  }

  // head 档 (baseline 缺席) → 「写集内变了哪些」清单 (若有 headSnapshot) + 「本档无 diff 正文」。
  if (args.headSnapshot) {
    const cwd = args.gitCwd ?? process.cwd();
    const ev = changedSinceHeadBaseline({ root: cwd, writeSet: args.writeSet, baseline: args.headSnapshot });
    return {
      kind: 'absent',
      reason: '本档无 diff 正文 (head 档基线是哈希快照, 非文本)',
      changed: ev.changed,
    };
  }

  // baseline + snapshot 都缺席 → 仅无 diff 正文说明 (GWT-2 zero-git-call 形状)。
  return { kind: 'absent', reason: '本档无 diff 正文 (无基线提供)' };
}

/**
 * 七段合成 —— 段序固定 (D-5: 注意力首因区放任务定义/事实, 近因区放本轮反馈/最新失败)。
 * 段标题用 `REPAIR_CONTEXT` 常量, 段间空行隔开。
 *
 * 任一段缺席 (含 diff skip) 时, 跳过那一行 (段序不变, 段位不补) —— 这样既保住了
 * 「线不动」也让缺席段对读的人来说「缺这一格」是肉眼可见的, 不是把整段静默抹掉
 * (NULL≠0≠不适用, 仓规 §1)。
 */
export function renderRepairGoal(args: {
  task?: string;
  priorResults: Record<string, LeafResult>;
  diffSegment: ReturnType<typeof renderDiffSegment>;
  verdict: string;
  writeSet: readonly string[];
}): string {
  const taskText = typeof args.task === 'string' ? args.task : '';
  const diffText =
    args.diffSegment.kind === 'body'
      ? args.diffSegment.text
      : args.diffSegment.kind === 'absent'
        ? [
            ...(args.diffSegment.changed && args.diffSegment.changed.length > 0
              ? ['变更清单 (写集内相对基线改变的文件):', ...args.diffSegment.changed.map((p) => `  - ${p}`)]
              : []),
            `[${args.diffSegment.reason}]`,
          ].join('\n')
        : null;

  const segments: Array<[string, string | null]> = [
    [REPAIR_CONTEXT.TASK, taskText],
    [REPAIR_CONTEXT.PRIOR_RESULTS, renderPriorResults(args.priorResults)],
    [REPAIR_CONTEXT.DIFF, diffText],
    [REPAIR_CONTEXT.VERDICT, args.verdict],
    [REPAIR_CONTEXT.RED_LINE, '**只修上面点名的失败**;不动其他文件、不重构、不补无关测试。'],
    [REPAIR_CONTEXT.WRITE_SET,
      args.writeSet.length > 0 ? args.writeSet.map((p) => `  - ${p}`).join('\n') : '  (无 — 本轮没有任何 leaf 写过文件)'],
    [REPAIR_CONTEXT.VERIFY_NOTE, 'verify 闸 = 同一道 accept 命令, 跑完再判一次。'],
  ];

  return segments
    .filter(([, body]) => body !== null)
    .map(([title, body]) => `${title}\n${body}`)
    .join('\n\n');
}

/**
 * 合成一个**修补节点** — 单 agent 节点, 带着七段上下文 (SDD 2026-08-31 切片 1) + 写集约束,
 * 让模型只修这些, 不动其他。
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
  // #272: 仓规红常态是 closure 空 (判词无路径, blame 挂不上) —— 那时写集并集退到全图,
  // 修补 leaf 拿到的是本轮所有 leaf 碰过的面 (仓规残缺可能落在任何一片里)。
  const unionScope =
    args.closure && args.closure.size > 0 ? args.closure : new Set(Object.keys(args.priorPlan.nodes));
  const writeSet = collectUnionWriteSet({
    plan: args.priorPlan,
    results: args.priorResults,
    closure: unionScope,
  });

  // 任务文本体 = 七段 (D-5 段序):
  //   原任务 → 逐节点结果 → diff → 判词 → 红线 → 写集约束 → verify 说明。
  // 判词截 8KB 防 prompt 膨胀 (旧上限保留, 超 8KB 的判词照旧截 — 那是 verifier 侧的 prompt 策略)。
  const reason = (args.verdictReason ?? '').slice(0, 8192);

  // diff 段 (D-3 / D-4 / D-6 / D-7): 三态 (skip / body / absent), 路径 ⊆ writeSet 已由 renderDiffSegment 守。
  const diffSegment = renderDiffSegment({
    writeSet,
    baseline: args.baseline,
    headSnapshot: args.headSnapshot,
    gitCwd: args.gitCwd,
    gitDiff: args.gitDiff,
    logEvidence: args.logEvidence,
  });

  const taskBody = renderRepairGoal({
    task: args.task,
    priorResults: args.priorResults,
    diffSegment,
    verdict: reason,
    writeSet,
  });

  // 修补节点: agent leaf (吃七段上下文 + 写集约束 + 模型能力)。
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
 *   const spin = detectReplanSpin({ closure, deterministicPlan, priorPlan, reusedIds, frozenNodes });
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