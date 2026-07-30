/**
 * plan/static-lint —— **跑之前**就能确定性判死的坏 plan (A4, 2026-07-31)。
 *
 * ## 它填的是 2×2 里最空的那格
 *
 * Martin Fowler 把 harness 的控制分成两轴:
 *
 * ```
 *                Computational (确定性/毫秒)   Inferential (推断/贵/不确定)
 *   Feedforward  ← **本模块住这里, 此前几乎是空的**   conductor prompt / persona / 图式
 *   Feedback     产物闸 · accept · lint · 预算轴      judge / verifier / detector
 * ```
 *
 * 审计下来我们的 feedback 两侧都很厚, **computational feedforward 只有"schema 不合法"一条**。
 * 而下面这些全是**跑之前就能算出来**的,今天却要烧一整轮 agent 调用才发现:
 *
 * - 两个**能并行**的节点声明写同一个文件 → 写竞争。谁最后写谁赢, 而赢家是调度顺序决定的,
 *   也就是**每次跑结果可能不同**。这是最坏的一种: 它不报错, 只是有时候产物不对。
 * - 节点依赖的输入文件**不存在**且图里没有任何节点产出它 → 那一步注定失败。
 * - `depends_on` 指向图里不存在的节点 → 编译期已有闸, 这里不重复。
 *
 * ## 纪律: 只报能**确定性判死**的, 不猜
 *
 * 静态检查一旦开始猜, 它就变成了第三个 judge (而且是个没有证据的)。所以:
 * - 写竞争只在**两个节点互不可达**时才算 (有依赖关系 = 有序 = 不是竞争);
 * - 缺输入只在"路径看起来是仓内相对路径 **且** 图里没有任何节点声明产出它"时才算;
 * - 拿不准一律**不报**。
 *
 * ## 出口: 报告, 不拦截
 *
 * 与制品 lint 同一条纪律 —— 存量 plan 会红一片, 而 fail-closed 的代价是把本来能跑的活拒掉。
 * 发现进**下一轮重展开的 prompt**(环唯一的信息通道), 让 conductor 自己改。
 * ⚠ 而且措辞要**为 LLM 消费优化**(Fowler: "instructions for the self-correction"):
 * 说清是哪两个节点、哪个文件、以及**该怎么改**,而不是只报一个"冲突"。
 */
import type { ConductorPlan } from '../conductor-plan';

type PlanNodeLike = ConductorPlan['nodes'][string];

export interface StaticFinding {
  kind: 'write-race' | 'missing-input';
  /** 涉及的节点 (规划期可读名 —— 下一轮 conductor 认得出的那个名字体系)。 */
  nodes: string[];
  /** 已经是人话, 且带**怎么改**。 */
  message: string;
}

/** 节点的可达闭包 (沿 depends_on 向上)。 */
function ancestors(plan: ConductorPlan, id: string, memo = new Map<string, Set<string>>()): Set<string> {
  const hit = memo.get(id);
  if (hit) return hit;
  const out = new Set<string>();
  memo.set(id, out); // 先放进去防环 (编译期已查环, 这里只是不挂死)
  for (const d of plan.nodes[id]?.depends_on ?? []) {
    out.add(d);
    for (const a of ancestors(plan, d, memo)) out.add(a);
  }
  return out;
}

/** 两个节点是否**可能并行** = 互不在对方的祖先闭包里。 */
function canRunConcurrently(plan: ConductorPlan, a: string, b: string, memo: Map<string, Set<string>>): boolean {
  return !ancestors(plan, a, memo).has(b) && !ancestors(plan, b, memo).has(a);
}

/** 节点声明的产出路径 (只认显式声明的 —— 猜不算)。 */
function declaredOutput(n: PlanNodeLike): string | undefined {
  const p = (n as { output_path?: unknown }).output_path;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/**
 * 跑前静态检查。**只报确定性判死的**, 拿不准一律不报。
 *
 * @param fileExists 注入式存在性探测 (相对仓根)。省略 = 不做 missing-input 检查
 *   (拿不到文件系统时**不猜**, 而不是假设文件不存在 —— 后者会把所有 plan 报红)。
 */
export function staticLintPlan(
  plan: ConductorPlan,
  opts: { fileExists?: (relPath: string) => boolean } = {},
): StaticFinding[] {
  const out: StaticFinding[] = [];
  const ids = Object.keys(plan.nodes);
  const memo = new Map<string, Set<string>>();

  // ── ① 并行写竞争 ────────────────────────────────────────────────────────────
  // 谁最后写谁赢, 而赢家由调度顺序决定 = **同一张图每次跑结果可能不同**。它不报错, 只是
  // 有时候产物不对 —— 这类静默不确定性是最贵的一种。
  const byPath = new Map<string, string[]>();
  for (const id of ids) {
    const p = declaredOutput(plan.nodes[id]!);
    if (p) byPath.set(p, [...(byPath.get(p) ?? []), id]);
  }
  for (const [path, writers] of byPath) {
    if (writers.length < 2) continue;
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i]!, b = writers[j]!;
        if (!canRunConcurrently(plan, a, b, memo)) continue; // 有依赖 = 有序 = 不是竞争
        out.push({
          kind: 'write-race',
          nodes: [a, b],
          message:
            `写竞争: 节点 "${a}" 与 "${b}" 都声明写 ${path}, 而它们之间没有依赖边 —— ` +
            `谁最后写谁赢, 结果由调度顺序决定, 同一张图每次跑可能不一样。` +
            `改法二选一: **让它们写不同的文件**, 或者**给后写的那个加 depends_on 让顺序确定**。`,
        });
      }
    }
  }

  // ── ② 缺输入 ────────────────────────────────────────────────────────────────
  // 节点声明要读某个仓内文件, 而它既不在盘上、图里也没有任何节点产出它 → 那一步注定失败,
  // 却要烧一次 agent 调用才发现。
  if (opts.fileExists) {
    const produced = new Set([...byPath.keys()]);
    for (const id of ids) {
      const n = plan.nodes[id]!;
      const inputs = (n as { input_paths?: unknown }).input_paths;
      if (!Array.isArray(inputs)) continue;
      for (const raw of inputs) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const p = raw.trim();
        // 绝对路径 / URL 一律不判 —— 我们对仓外一无所知, 猜了就是误报。
        if (p.startsWith('/') || p.includes('://')) continue;
        if (produced.has(p)) continue;          // 图里有人产出它
        // ⚠ **在这里兜住**, 不指望调用方恰好包了 try: 不变量是"探不到就当它在"(漏报好过把所有
        // plan 报红), 它该在模块边界成立。第一版只在引擎的包装里兜, 测试当场抓出来。
        let onDisk = true;
        try { onDisk = opts.fileExists(p); } catch { onDisk = true; }
        if (onDisk) continue;                   // 盘上有 (或探不到)
        out.push({
          kind: 'missing-input',
          nodes: [id],
          message:
            `缺输入: 节点 "${id}" 要读 ${p}, 但它既不在仓里、图里也没有任何节点产出它 —— ` +
            `这一步注定失败。改法: **加一个先产出它的节点并 depends_on 它**, 或者改用一个真实存在的路径。`,
        });
      }
    }
  }

  return out;
}
