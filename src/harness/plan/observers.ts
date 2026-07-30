/**
 * plan/observers —— **图外只读观察者** (P3 D-Q) 的确定性 producer。
 *
 * D-Q 说的那个洞: DAG 里一个节点只看得见自己的 `depends_on`, **没法观察边** —— 谁写了什么、
 * 谁读了什么、这一轮和上一轮是不是在原地打转, 没有任何节点站得到那个视角上。
 *
 * 于是观察者住在图**外**: 它不是节点、没有边、不占并发槽、不消费 dep 输出, 只拿引擎手上现成的
 * 事实算一遍, 产出 {@link DagObservation}。**只读的纪律是硬的** —— 观察者不改路由、不改结果、
 * 不铸毒票, 唯一的出口是往前馈通道里写一句话 (进下一轮重展开的 prompt + 进结果面)。
 * 例外只有一个, 且是**确定性**的: {@link detectLoopNoProgress} 判出的空转会让环提前退出 (BLOCKED),
 * 那不是"观察者做了决定", 是"再转一圈按构造不可能有新东西"。
 *
 * 两个 producer 都**零模型调用**: 一个查制品的读写交叉, 一个比两轮的子节点 id 集合。
 * 观察者要是自己也得请一次 LLM, 它就成了第三层 judge —— D-13 明确不加新 gate 层。
 */
import type { DagObservation } from '../executor-dag-types';

/** lint 认得的最小节点形状 (不 import ConductorPlan: 纯函数只要边)。 */
export interface LintNode {
  depends_on?: string[];
}

/** lint 认得的最小结果形状。 */
export interface LintResult {
  filesTouched?: string[];
  filesRead?: string[];
}

/**
 * 路径归一: 相对路径按 root 锚回绝对, 顺手吃掉 `./`。
 *
 * ⚠ **诚实边界**: `filesTouched`/`filesRead` 的相对路径根是**产出它的那个 leaf 的 cwd**
 * (见 AgentLeafResult.cwd), 而这里只给得起一个根。同一个 agentRunner 服务整张图 → 同一个 cwd,
 * 所以实践中两侧可比; 多 runner 混跑时可能对不上 —— 对不上的后果是 lint **漏报** (两个路径不相等),
 * 不是误报, 与"闸拿错根去查存在性"那种误杀不同。lint 只 warn 不拒, 这个失败方向是可接受的。
 */
function normPath(p: string, root: string): string {
  const s = p.startsWith('./') ? p.slice(2) : p;
  return s.startsWith('/') ? s : `${root}/${s}`;
}

/** 一条「未声明的制品依赖」。 */
export interface ArtifactEdgeFinding {
  /** 读了文件的节点。 */
  reader: string;
  /** 写了同一个文件的节点。 */
  writer: string;
  /** 归一后的制品路径。 */
  path: string;
}

/**
 * **未声明的制品依赖 lint** (D-12 / INV-P2-4)。
 *
 * 判据: B 读过 f、A 写过 f、A ≠ B, 而 A **不在** B 的祖先集里 —— 图上没有任何一条边表达
 * "B 吃 A 的产出"。后果不是洁癖问题: 调度器据边决定谁先跑、`computeReuse` 据边算复用闭包、
 * 毒集据边扩散, 三样东西全建在"边是完备的"这个前提上。图外读一旦存在, 三样同时失真。
 *
 * 修法**首选补边** (让 conductor 下一轮把 `depends_on` 写上, 补上后闭包免费覆盖), 读毒只是网 ——
 * 故本函数只报告, 不做任何拦截。
 */
export function lintArtifactEdges(
  nodes: Readonly<Record<string, LintNode>>,
  results: Readonly<Record<string, LintResult>>,
  opts: { root: string },
): ArtifactEdgeFinding[] {
  // 写方索引: 归一路径 → 写它的节点 id 集。
  const writers = new Map<string, Set<string>>();
  for (const [id, r] of Object.entries(results)) {
    for (const f of r.filesTouched ?? []) {
      const k = normPath(f, opts.root);
      let set = writers.get(k);
      if (!set) writers.set(k, (set = new Set()));
      set.add(id);
    }
  }
  if (writers.size === 0) return [];

  // 祖先闭包 (memo; 环在建图期已拒, 这里 visiting 集是纯函数自保)。
  const ancestorMemo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const ancestorsOf = (id: string): Set<string> => {
    const memo = ancestorMemo.get(id);
    if (memo) return memo;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const out = new Set<string>();
    for (const d of nodes[id]?.depends_on ?? []) {
      out.add(d);
      for (const a of ancestorsOf(d)) out.add(a);
    }
    visiting.delete(id);
    ancestorMemo.set(id, out);
    return out;
  };

  const findings: ArtifactEdgeFinding[] = [];
  for (const [reader, r] of Object.entries(results)) {
    const reads = r.filesRead ?? [];
    if (reads.length === 0) continue;
    const anc = ancestorsOf(reader);
    for (const f of reads) {
      const k = normPath(f, opts.root);
      for (const writer of writers.get(k) ?? []) {
        if (writer === reader) continue; // 自己写自己读, 没有边可言
        if (anc.has(writer)) continue; // 图上已经表达了这条依赖
        // **父子不算一条边** (2026-07-30 实测揪出的误报): map/conductor 节点的 `filesTouched` 是
        // 子树并集 —— 它自己没写任何东西, 那个写就是子节点那一次。拿子节点的读去配它父亲的
        // 聚合写, 等于把同一次写数了两遍, 报出来的还是一条**修不了**的边 (子节点依赖自己的父亲
        // 是环)。判据用内容寻址 id 的 `<parent>::` 前缀 —— 那是 INV-U2/D-B 构造保证的形状。
        if (reader.startsWith(`${writer}::`) || writer.startsWith(`${reader}::`)) continue;
        findings.push({ reader, writer, path: k });
      }
    }
  }
  // 确定性序 (同一张图两次跑给出同一份报告; 观察面不许有并发时序的痕迹)。
  findings.sort((a, b) =>
    a.reader !== b.reader ? (a.reader < b.reader ? -1 : 1)
    : a.writer !== b.writer ? (a.writer < b.writer ? -1 : 1)
    : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return findings;
}

/**
 * lint 结果 → 观察条目 (指名两个节点, 照 INV-P2-4 的 GWT)。
 *
 * `names` = 运行期内容寻址 id → **规划期可读名**。给它的理由是 2026-07-30 live 撞出来的:
 * 这条消息的**唯一读者是下一轮重画的 conductor**, 而它写的是自己起的名字 —— 一句
 * 「请给 [execute::1dsso0lqe0kky] 补上 [execute::1errm3oj42qds]」它既没见过那两个 id、
 * 也造不出它们 (内容寻址 id 是展开那一刻才算的)。**报得对但按它做不了任何事**。
 *
 * 所以人话部分用可读名, 并且**建议写成通则而不是点名**: 下一轮的节点名可能又变了,
 * 「读谁的产出就 depends_on 谁」这句照做得了, 「补上 X」不一定。id 仍留在 `nodes` 字段
 * 里供审计 —— 事实与判词分开, 与 judge 视图那条同源。
 */
export function artifactLintObservations(
  findings: readonly ArtifactEdgeFinding[],
  names?: ReadonlyMap<string, string>,
): DagObservation[] {
  const label = (id: string): string => {
    const n = names?.get(id);
    return n && n !== id ? `"${n}"` : `[${id}]`;
  };
  return findings.map((f) => ({
    kind: 'undeclared-artifact-dep' as const,
    nodes: [f.reader, f.writer],
    message:
      `未声明的制品依赖: 节点 ${label(f.reader)} 读了 ${label(f.writer)} 写的 ${f.path}, ` +
      '但图上没有这条边 —— 下一轮画图时请把它画出来: **读了哪个节点产出的文件, 就要 depends_on 它**。',
  }));
}

/** 一轮内环的可比快照 (只取"下一轮会不会不一样"真正取决于的两样东西)。 */
export interface RoundShape {
  /** 本轮展开出的子节点 id (内容寻址 → 同 id ≡ 同规格 + 同祖先规格)。 */
  childIds: readonly string[];
  /** 本轮 judge 点名拒绝的子节点 id。 */
  rejected: readonly string[];
}

/**
 * **环空转检测** (D-Q 的 BLOCKED 出口)。
 *
 * 判据刻意苛刻, 两条同时成立才算空转:
 *  ① 这一轮展开出的子节点 id 集**与上一轮逐个相同** —— 子节点 id 是内容寻址的 (D-B), 于是
 *     "同一个 id 集"不是"看起来差不多", 是**按构造完全同一张子图**: conductor 拿着上一轮的
 *     失败原因重画, 画出来的还是同一张。
 *  ② judge 点名拒绝的也**还是同一批** —— 同一张图 + 同一批坏节点 = 上一轮的信息一点没起作用。
 *
 * 两条都成立时再转一圈**按构造**不会有新东西 (输入相同 → 展开相同 → 结果相同), 剩下的轮数是纯烧钱。
 * 出口是 BLOCKED 而不是 failed: 图没坏、节点没挂, 是这个 goal 在**没有外部输入的情况下推不动**
 * —— 该由 owner 看一眼, 不是该判它失败。
 *
 * ⚠ 只在**至少两轮**上判 (第一轮没有可比对象), 且 rejected 用集合比不用顺序比 (judge 点名顺序不稳)。
 */
export function detectLoopNoProgress(prev: RoundShape | null, cur: RoundShape): DagObservation | null {
  if (!prev) return null;
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((x) => s.has(x));
  };
  if (!sameSet(prev.childIds, cur.childIds)) return null;
  if (!sameSet(prev.rejected, cur.rejected)) return null;
  // 一个坏节点都没有却判了空转 = 上一轮其实是"整轮没过但没点出名"(judge 漏填票)。那种情况下
  // 重画仍然可能有用 (下一轮 conductor 拿到的失败原因可能不同), 不该锁死 → 不判空转。
  if (cur.rejected.length === 0) return null;
  return {
    kind: 'loop-no-progress',
    nodes: [...cur.rejected],
    message:
      `环空转: 这一轮重展开得到与上一轮**完全相同**的子图 (${cur.childIds.length} 个内容寻址 id 逐个相同), ` +
      `且 judge 点名拒绝的还是同一批 (${cur.rejected.join(', ')})。再转一轮按构造不会有新结果 —— ` +
      '需要外部输入 (改目标 / 补事实 / 换做法)。',
  };
}
