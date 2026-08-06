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

/** 一对**执行窗口真重叠过**的节点, 连同各自写过的绝对路径。 */
export interface OverlapPair {
  a: string;
  b: string;
  /** a 写过的绝对路径; 空集 = 这一侧没报过写(见 {@link detectRuntimeWriteRace} 的三态那段)。 */
  aPaths: ReadonlySet<string>;
  bPaths: ReadonlySet<string>;
  /**
   * **推断口径**的绝对路径(2026-08-06 补):`aPaths` ∪「命令点名要写、且那个文件在本节点
   * 执行窗口内变过」的候选。缺席 = 调用方没给这一层 → 退回严格集(见下面 `inferred` 那段)。
   *
   * ⚠ 与 `aPaths` **刻意分两位, 不合并**:证据强度不同。`aPaths` 是受控写工具的**事实**
   * (确实写了);这一位含**推断** —— `a && b > x` 里 `a` 失败时 `x` 没被写,而同窗口另一个
   * 节点写了它就会被认领。两者压成一个集合之后,「要不要把 ⑧.6 升成闸」这个问题就再也
   * 没法回答了(升闸的人必须先看得见有多少 finding 是推断来的)。
   */
  aInferred?: ReadonlySet<string>;
  bInferred?: ReadonlySet<string>;
}

/** 一个节点的**执行窗口 + 写过的路径**,用来事后重建重叠对。 */
export interface NodeWindow {
  id: string;
  /** 起跑时刻(ms)。 */
  startMs: number;
  /** 结束时刻(ms)。 */
  endMs: number;
  /** 这个节点写过的路径(同一批窗口之间必须**同一个基准**,见下)。 */
  paths: readonly string[];
}

/**
 * 一批节点窗口 → **两两重叠的对**(2026-08-06)。
 *
 * ## 它存在的理由:让回溯与实时**共用同一个判据**
 *
 * `.omd/continuity/<runId>/<nodeId>.json` 里有 `createdAt` + `durationMs`(还原得出窗口)
 * 与 `outputPaths`,于是**历史上的写竞争是可以重建的**。但重建出来的东西**必须喂给
 * {@link detectRuntimeWriteRace} 那同一个判据**,而不是另写一份数法 ——
 * 两处各算一份必漂,而漂了之后"回溯说 1 条、实时说 0 条"就没人分得清是引擎变了还是数法变了。
 *
 * 所以这里只做**一件事**:把窗口两两配对。父子怎么滤、机会怎么算、撞车怎么判,
 * 全在下面那个函数里,一个字都不重复。
 *
 * ⚠ **同一批窗口的 `paths` 必须同一个基准**。checkpoint 的 `outputPaths` 是相对**该 run 的根**
 *   算的 —— 于是**同一个 runId 内可比,跨 run 不可比**(两个 run 里的 `src/a.ts` 是两回事)。
 *   调用方必须按 runId 分组之后再进来。
 * ⚠ 窗口取 `[结束 - 时长, 结束]`,与实时那条同样**比真正的写窗口宽**(节点执行时长里
 *   大部分时间不在写)。方向一致:多算落在分母上,把基率往低了报。
 */
export function overlapPairsFromWindows(nodes: readonly NodeWindow[]): OverlapPair[] {
  const out: OverlapPair[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let k = i + 1; k < nodes.length; k++) {
      const a = nodes[i]!;
      const b = nodes[k]!;
      // 半开区间相交: 严格 `<` 两侧 —— 首尾相接(前一个结束正好是后一个起跑)不算重叠。
      if (!(a.startMs < b.endMs && b.startMs < a.endMs)) continue;
      const [p, q] = a.id <= b.id ? [a, b] : [b, a];
      out.push({ a: p.id, b: q.id, aPaths: new Set(p.paths), bPaths: new Set(q.paths) });
    }
  }
  return out;
}

/**
 * **运行时写竞争**的读数(2026-08-06)—— 连同它的分母一起。
 *
 * ## 为什么要有它:今天这个名字下只有静态那一半
 *
 * `static-lint.ts` 的 `write-race` 判的是**跑之前**就看得出的坏 plan:两个节点各自 `output_path`
 * 声明写同一个文件、而图上没有依赖边。它报得早、报得准 —— 但它只看**声明**。
 * 一个 leaf 用 bash 写出去的文件不在任何 `output_path` 里,于是两个并发兄弟真撞在同一条路径上时,
 * **没有任何一处会知道**。台账把静态那 4 次读数当成了运行时那条的证据,而两者的下一步相反:
 * 前者要改 plan(加边或改文件名),后者要问"这两个 leaf 为什么会碰同一个文件"。
 * **同名不同义比没名字更坏**(交接 30 §五 第 2 条)。
 *
 * ## 分母(S-19 的教训:先想清楚这个 0 会被除以什么)
 *
 * 五个数,读的时候别互相替代:
 *   `overlaps`         = 执行窗口真重叠过的节点**对**数 —— 有没有并发这件事本身;
 *   `pairs`            = 其中**两侧都报过受控写**的对数 —— **严格**口径的机会;
 *   `findings`         = 其中路径集真相交的对数(严格);
 *   `pairsInferred`    = 把「命令点名要写 + 盘上核实过」的候选并进来之后的机会数;
 *   `findingsInferred` = 推断口径下真相交的对数。
 *
 * `overlaps - pairsInferred` 才是**今天真正看不见的那部分**(两条判据都够不着)。
 * 而 `pairsInferred - pairs` 是**只有推断才看得见**的那部分 —— 它单独有意义:
 * 那一块的证据比受控写弱(见 `OverlapPair.aInferred`),要升闸的人得先知道有多大一块靠推断。
 *
 * ⚠ 严格那两个数**一个字都没改口径**(2026-08-06 首版逐字同义)。补推断口径时最容易犯的
 *   错就是顺手把它们一起放宽 —— 那样一来「基率是真的还是推出来的」就永久分不开了。
 *
 * ⚠ 窗口取的是 [起跑, leaf 返回],**比真正的写窗口宽**(engine 不记每次写的时刻)。
 *   方向是宁可多算一对重叠:多算落在**分母**上,把基率往低了报,不会凭空造出 finding。
 * ⚠ 路径要**解析成绝对路径再比**:R2 隔离档下两个 leaf 各在自己的 worktree 里写 `out.md`,
 *   那不是竞争。比相对路径会把整个隔离档报成一片红。
 *
 * **只报不拦**:出口是账本 + 观察条目。要不要拦是单独的拨闸决定,而今天连读数都还没有。
 */
export function detectRuntimeWriteRace(pairs: readonly OverlapPair[]): {
  overlaps: number;
  pairs: number;
  findings: number;
  pairsInferred: number;
  findingsInferred: number;
  observations: DagObservation[];
} {
  const observations: DagObservation[] = [];
  let opportunity = 0;
  let opportunityInferred = 0;
  let findingsStrict = 0;
  // 父子对**先滤掉再计总**: 它们不是"并发"的观察 —— 父节点只是子节点的容器, 两者窗口
  // 必然重叠。算进 `overlaps` 会让「看不见的那部分」(`overlaps - pairsInferred`) 虚高,
  // 而那个差额正是判词用来说"该补写的可见性"的那个数。
  const real = pairs.filter((p) => !(p.a.startsWith(`${p.b}::`) || p.b.startsWith(`${p.a}::`)));
  for (const p of real) {
    // **父子不算一对**(2026-08-06 补;与 `lintArtifactEdges` 里那条同一个理由与同一个判据)。
    // conductor/map 父节点的 `filesTouched` 是**子树并集** —— 它自己一个字都没写, 那个写就是
    // 子节点那一次。拿父亲的聚合写去配子节点的写, 等于把同一次写数了两遍, 报出来还是一条
    // **改不了**的"竞争"(让父子写不同文件 / 给父子加边, 两条建议对父子关系都不成立)。
    // 判据用内容寻址 id 的 `<parent>::` 前缀 —— 那是 INV-U2/D-B 构造保证的形状。
    // ⚠ 回溯验过这条的代价: 拿 checkpoint 重建历史窗口时**没有**这条守卫, 46 条"撞车"里
    //   一眼就能看到 `execute × execute::<hash>` 这种父子对。
    // 推断集缺席 = 调用方没接这一层 → 退回严格集。**不是空集** —— 那会把"没给"读成"没写"。
    const aInf = p.aInferred ?? p.aPaths;
    const bInf = p.bInferred ?? p.bPaths;
    const strictOk = p.aPaths.size > 0 && p.bPaths.size > 0;
    const inferredOk = aInf.size > 0 && bInf.size > 0;
    if (strictOk) opportunity++;
    if (inferredOk) opportunityInferred++;
    if (!inferredOk) continue; // 两条判据都够不着 = 真正看不见的那部分, 不进任何分母

    const sharedStrict = strictOk ? [...p.aPaths].filter((x) => p.bPaths.has(x)) : [];
    if (sharedStrict.length > 0) findingsStrict++;
    const shared = [...aInf].filter((x) => bInf.has(x)).sort();
    if (shared.length === 0) continue;
    // 判词要说出**这一条的证据是哪一档** —— 下一步不同: 受控写是确凿的撞车, 推断来的
    // 那条还得先确认命令真跑到了那一步 (见 OverlapPair.aInferred 里 `a && b > x` 那例)。
    const inferredOnly = sharedStrict.length === 0;
    observations.push({
      kind: 'write-race',
      nodes: [p.a, p.b].sort(),
      message:
        `运行时写竞争: 节点 [${p.a}] 与 [${p.b}] 的执行窗口重叠, 而它们都写了 ` +
        `${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` 等 ${shared.length} 个文件` : ''} —— ` +
        '谁最后写谁赢, 而赢家由调度顺序决定, 同一张图每次跑可能不一样。' +
        (inferredOnly
          ? '⚠ **这一条是推断出来的**: 证据是"命令原文点名要写这个文件, 且它在本节点执行窗口内变过", ' +
            '不是受控写工具的记录。先确认命令真跑到了那一步 (`a && b > x` 里 a 失败时 x 并没有被写)。'
          : '') +
        '⚠ 这一条与跑前静态那条**同名不同义**: 这两个节点谁都没在 `output_path` 里声明过这个文件, ' +
        '所以静态检查看不见它。改法二选一: **让它们写不同的文件**, 或者**加一条 depends_on 让顺序确定**。',
    });
  }
  // 确定性序 (同一张图两次跑给出同一份报告; 观察面不许有并发时序的痕迹 —— 同上面那条 lint)。
  observations.sort((x, y) => (x.message < y.message ? -1 : x.message > y.message ? 1 : 0));
  return {
    overlaps: real.length,
    pairs: opportunity,
    findings: findingsStrict,
    pairsInferred: opportunityInferred,
    findingsInferred: observations.length,
    observations,
  };
}

/** 一个 D-Q 图内检测者节点在写这件事上的执行面。 */
export interface DetectorWriteFacts {
  id: string;
  /** leaf kind —— 只有 `agent` 手里有写工具;`inproc`/`command` 没有,不进机会分母。 */
  kind: string;
  /** 受控写工具的**次数**(`writeCounts[0]`)。缺席 = 这条链没人报,与 `0` 是两件事。 */
  writes?: number;
  /** 从命令原文认出并经盘上核实的写目标(**推断**,见 `DagNodeResult.writeCandidates`)。 */
  writeCandidates?: readonly string[];
}

/**
 * **检查者写了东西吗**(D4 / §7.3「检查者只读」,2026-08-06)—— 连同它的分母。
 *
 * ## 这一格今天靠运气成立
 *
 * §7.3 说检查者应当只读。而 omd 的 D-Q 检测者是**图内节点**:它和被它检查的兄弟共享同一棵
 * worktree,并且当 conductor 把它排成 `executor: 'agent'` 时,它手里**就是有写工具的**。
 * 实测(2026-08-06,54 跑):23 个 detector 节点里 7 个是 agent,其中**记了 `writeCounts` 的 4 个
 * 全是 `[0,0]`**(另 3 个是 `skipped`,没记那一位 → 进 `unobserved`,不算「没写」)—— 它们**有机会写却没写**。也就是说这条纪律今天成立,但成立的方式是运气,
 * 不是不变量:**一旦有一个检测者真的写了,没有任何一处会知道。**
 *
 * ## 分母(同 ⑧/⑧.6 那条:先想清楚这个 0 会被除以什么)
 *
 * `opportunities` = 手里**真有写工具**的检测者数(`kind === 'agent'`)。
 * `inproc` 检测者一个写工具都没有,把它算进分母会把基率往低了报 —— 那是拿"不可能"冒充"没发生"。
 *
 * ⚠ 两档证据同 ⑧.6:`writes > 0` 是受控写工具的**事实**;`writeCandidates` 是**推断**
 *   (命令点名要写 + 盘上核实过)。判词分档写,因为下一步不同 —— 前者确凿,后者要先确认
 *   命令真跑到了那一步。
 * ⚠ **缺席 ≠ 0**:`writes` 缺席 = 这条链没人报(旧 runner),它**不算"没写"**,进 `unobserved`。
 *
 * **只报不拦**:出口是观察条目 + 账本。要不要把检测者的写工具真收掉是**单独的拨闸决定**,
 * 而今天 n=4,离得出基率还差得远(rule of three:0/4 的 95% 上界是 75%)。
 */
export function detectDetectorWrites(detectors: readonly DetectorWriteFacts[]): {
  detectors: number;
  opportunities: number;
  unobserved: number;
  findings: number;
  observations: DagObservation[];
} {
  const observations: DagObservation[] = [];
  let opportunities = 0;
  let unobserved = 0;
  for (const d of detectors) {
    // 没有写工具 = **不可能**写, 不是"没写" —— 不进机会分母 (同 ⑧.6 那条纪律)。
    if (d.kind !== 'agent') continue;
    if (d.writes === undefined && d.writeCandidates === undefined) {
      unobserved++; // 这条链没人报: 既不算机会也不算命中
      continue;
    }
    opportunities++;
    const controlled = d.writes ?? 0;
    const inferred = d.writeCandidates ?? [];
    if (controlled === 0 && inferred.length === 0) continue;
    const how =
      controlled > 0
        ? `受控写工具 ${controlled} 次`
        : `**推断**: 命令原文点名要写 ${inferred.slice(0, 3).join(', ')} 且它在本节点执行窗口内变过`;
    observations.push({
      kind: 'detector-wrote',
      nodes: [d.id],
      message:
        `图内检测者 [${d.id}] **写了东西** (${how}) —— §7.3 说检查者只读, 而 D-Q 检测者与被它检查的` +
        '兄弟共享同一棵 worktree。检查者一旦动手改盘, 它给出的裁决就不再是对"兄弟们产出了什么"的' +
        '观察, 而是对"它自己也参与之后的结果"的观察。' +
        (controlled > 0
          ? ''
          : '⚠ 这一条是**推断**的, 先确认那条命令真跑到了写那一步。') +
        '⚠ **只报不拦**: 要不要把检测者的写工具收掉是单独的拨闸决定, 判据与分母见 detectDetectorWrites。',
    });
  }
  observations.sort((x, y) => (x.message < y.message ? -1 : x.message > y.message ? 1 : 0));
  return { detectors: detectors.length, opportunities, unobserved, findings: observations.length, observations };
}

/**
 * 一轮内环在**盘上**留下的东西: 路径 → 内容 hash。
 *
 * `null` = **读不到**(文件不在 / 根对不上 / 读失败)。它是**第三态, 不是"没变"** ——
 * 一个量不到的文件不构成"这一轮什么都没干"的证据, 拿它凑判据就是本仓反复在治的那种补集算法。
 */
/**
 * **「声明了要写、盘上却没有」** 的哨兵值 (N7, 2026-07-31)。
 *
 * 它与 `null` 刻意是两个值, 因为结论相反:
 *   · `null`            = **量不到**(读文件抛错)—— 不是证据, 见到就整轮不判;
 *   · `ARTIFACT_ABSENT` = **确定性事实**: 这个节点声明了产物、而那条路径确实不存在。
 *
 * 后者是**可比较的**: 连着两轮"说要写 a.md 却两轮都没写出来", 正是「盘上没有位移」本身 ——
 * 而在 N7 之前这一类被系统性吃掉了(见 {@link classifyArtifactMove} 的 population 那段)。
 */
export const ARTIFACT_ABSENT = '\u0000absent';

export interface RoundArtifacts {
  hashes: Readonly<Record<string, string | null>>;
}

/**
 * 一次**跨轮比较**的三态结论 —— 分母就藏在这一层(2026-08-06)。
 *
 * 为什么不能只返回「有没有观察条目」: 读数板 ⑧ 段此前把 `loop-no-artifact-change` 的 0 次
 * 除以**运行次数**当活体基率读。而这条判据的机会单位根本不是"一次运行" —— 它住在 conductor
 * 内环里, 一次比较要同时满足 ① 有上一轮(`max_rounds > 1` 且真的转了第二圈)② 两轮都有产物信号
 * ③ 两侧都读得到。多数生产流量(`dag_run` 的单轮档 / 内环首轮就收敛)**一次比较都没有**,
 * 于是那个 0 是「够不着」而不是「查过零检出」。
 *
 * 这正是 ⑧.5 已经付过一次学费的形状(`claimCheck` 的 conductor 面): 判据只活在内环, 而账本
 * 记出来的空数组与"查过零检出"逐字相同。仓规第一条 —— NULL ≠ 0 ≠ 不适用。
 *
 * 三态的读法:
 *   · `unobserved` = **判不了**(不进分母);`why` 分得出是哪一种够不着;
 *   · `moved`      = 判了, 盘上有位移(进分母, 不是发现);
 *   · `no-move`    = 判了, 盘上没位移(进分母, 是发现)。
 */
export type ArtifactMoveVerdict =
  | { kind: 'unobserved'; why: 'first-round' | 'no-population' | 'unreadable' }
  | { kind: 'moved' }
  | { kind: 'no-move'; observation: DagObservation };

/**
 * **「产物没变」检测器** (2026-07-31, G5 的正解; D-AD 诊断出的那条死路的绕法)。
 *
 * ## 为什么要换判据
 *
 * D-AD 的结构性发现: 我们**所有**的"卡住"检测器都键在「agent 重复了自己」上 ——
 * `detectLoopNoProgress` 要整轮子图逐个相同 · §8.4 熔断要同一条命令逐字相同 ·
 * detector 要模型自己标。而 **LLM conductor 每轮重画, 从不逐字重复自己**:
 * 换个引号、换个节点名、把两步合成一步,内容寻址 id 就全变了。
 * **非确定性从结构上打败了基于"相同"的检测** —— 所以那几条在 live 上恒 0,
 * 再跑多少次都是 0(拿钱撞一个已诊断的负结果是浪费)。
 *
 * 绕法: 换一个 **agent 不重新生成的东西** 当信号。盘上的产物就是那个 ——
 * 它不是模型每轮重掷的文本, 是这个环里唯一稳定的物证。
 * **判据从「它有没有重复自己」变成「盘上有没有发生位移」。**
 *
 * ## 三条纪律 (每一条都是踩过的坑的反面)
 *
 * ① **population 闸**: 只在**两轮都有产物信号**时判。一轮纯分析(不产文件)没有产物信号 ——
 *    那是 `Unobserved` 不是"没位移", 直接返 null。少了这条, 所有非文件型的目标会被一路误报。
 *
 *    ⚠ **N7 (2026-07-31) 把"产物信号"的定义改宽了一格。** 此前 population 只收 `filesTouched`,
 *    而**产物闸判 empty-artifact 的节点恰好没有 filesTouched** —— 于是"自报完成却什么都没写"
 *    这一整类会让 population 归零, 检测器**静默不判**。2026-07-31 两跑 live 的两个 0 里
 *    第二个就是这么来的: 不是"没卡住", 是**被更具体的仪表先接住之后这条就瞎了**。
 *    现在声明了产物却不在盘上的路径以 {@link ARTIFACT_ABSENT} 进 population ——
 *    连着两轮都 absent 就是位移为零的**最强**形态(它连东西都没产出来)。
 *
 *    两条检测器的边界因此说得清了: `empty-artifact` 判的是**单个节点这一次**有没有产出;
 *    本检测器判的是**整个环跨轮**有没有位移。前者仍会先命中(它更具体), 但不再让后者失明。
 * ② **「读不到」不算「没变」**: 任一侧出现 `null` hash 就不判(fail-open, 倾向不报)。
 *    一个量不到的文件不是"没变"的证据。
 * ③ **只报不拦**(至少现在): 出口是观察条目进下一轮 prompt, **不是 BLOCKED**。
 *    理由是算得清的账 —— `max_rounds ≤ 4`, 误拦一次的代价是**掐死一个本可收敛的 run**,
 *    而漏报一次的代价上限只有一两轮。在这个比价下, 0 读数时就上硬闸是拿大风险换小收益。
 *    先记, 攒到分布再定要不要升成 BLOCKED 以及 K 取几 —— 与 `exitCode` 那一位同一条路子。
 *
 * ## 为什么返回三态而不是 `DagObservation | null`(2026-08-06)
 *
 * 见 {@link ArtifactMoveVerdict}。一句话: `null` 此前把「这次判不了」和「判了, 有位移」压成了
 * 同一个值, 于是**分母在返回值里就不存在了** —— 读数板只能拿运行次数当分母, 而那是错的单位。
 */
export function classifyArtifactMove(prev: RoundArtifacts | null, cur: RoundArtifacts): ArtifactMoveVerdict {
  // ⓪ 没有上一轮就没有"跨轮"可言 —— 这不是一次比较, 连轮转都不算。
  if (!prev) return { kind: 'unobserved', why: 'first-round' };
  const prevPaths = Object.keys(prev.hashes).sort();
  const curPaths = Object.keys(cur.hashes).sort();
  // ① population 闸: 没有产物就没有产物信号 (Unobserved, 不是"没位移")。
  if (prevPaths.length === 0 || curPaths.length === 0) return { kind: 'unobserved', why: 'no-population' };
  // ② 任一侧有**量不到**的 → 不判。⚠ 只挡 null(读文件出错); ARTIFACT_ABSENT 是确定性事实,
  //    照常参与比较 —— 那正是 N7 要救回来的那一类。
  //
  //    ⚠ 这里原本写的是 `p in prev.hashes ? prev.hashes[p] : cur.hashes[p]` —— 只要路径在上一轮
  //    出现过, **本轮那侧的 null 就永远看不到**。旧接口下这个洞是隐形的: 漏掉的那一格会往下掉进
  //    "hash 不等 → 有位移", 而两条路的返回值都是 `null`(不报), 于是既有用例照样全绿。
  //    改成三态之后它当场红了 —— 因为两条路现在的**结论**不同: 一个是"判不了"(不进分母),
  //    一个是"判了, 有位移"(进分母)。拿一次量不到的轮次去撑基率的分母, 正是这次改动要治的病。
  if ([...prevPaths, ...curPaths].some((p) => prev.hashes[p] === null || cur.hashes[p] === null))
    return { kind: 'unobserved', why: 'unreadable' };
  // ③ 到这里两侧都可比了 —— 下面每一条出口都**进分母**, 差别只在判成"有位移"还是"没位移"。
  if (prevPaths.length !== curPaths.length || prevPaths.some((p, i) => p !== curPaths[i])) return { kind: 'moved' };
  if (prevPaths.some((p) => prev.hashes[p] !== cur.hashes[p])) return { kind: 'moved' };
  return {
    kind: 'no-move',
    observation: {
      kind: 'loop-no-artifact-change',
      nodes: [],
      // A5: 读者是下一轮重画的 conductor。所以不播报状态, 直接给它**做得了的事** ——
      // 并且点破它最可能正在做的那件无效功: 换个名字把同样的步骤再排一遍。
      message:
        (curPaths.every((p) => cur.hashes[p] === ARTIFACT_ABSENT)
          ? `盘上没有位移, 而且更糟: 这一轮**声明**要产出的 ${curPaths.length} 个文件里, 一个都不在盘上 ` +
            `(${curPaths.slice(0, 3).join(', ')}${curPaths.length > 3 ? ' 等' : ''}), 上一轮也是。` +
            '也就是说连着两轮都只是**说做了**。这一轮别再排步骤, 先把其中一个文件真正写出来, ' +
            '写完用一条跑得起来的命令确认它在盘上。'
          : '') ||
        `盘上没有位移: 这一轮结束时, ${curPaths.length} 个产物文件的内容与上一轮**逐字节相同** ` +
        `(${curPaths.slice(0, 3).join(', ')}${curPaths.length > 3 ? ' 等' : ''})。` +
        '也就是说上一轮的反馈**一点也没落到产物上** —— 你很可能只是把同样的步骤换个名字重排了一遍。' +
        '这一轮请改**内容**而不是改结构: 挑一个具体的产物, 说清它哪一处不满足要求, 然后直接改那一处; ' +
        '若你判断产物其实已经对了, 那就补一个**能判对错的验证步骤**(跑得起来的命令), 别再重排。',
    },
  };
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

// ─────────────────────────────────────────────────────────────────────────────
// #13 逐字引文丢失探针 (2026-08-04, r2 逐跳取证驱动)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从文本里抠**逐字引文**片段。
 *
 * 认三种引号对(直角双引号 / 中文弯引号 / 反引号),只收**够长**的片段:
 * 短引号绝大多数是术语标注(`"budget"`)而不是引文,把它们算进来会让判据在任何图上都命中。
 * 长度阈值取 24 —— 不是调出来的,是"一句可定位的原文"的量级下限;拿不准就不报(同 static-lint)。
 */
export function extractQuotedSpans(text: string, minLen = 24): string[] {
  const out: string[] = [];
  for (const re of [/"([^"\n]{24,})"/g, /[“]([^”\n]{24,})[”]/g, /`([^`\n]{24,})`/g]) {
    for (const m of text.matchAll(re)) {
      const s = m[1]!.trim();
      if (s.length >= minLen) out.push(s);
    }
  }
  return out;
}

/** 一个汇总节点的逐字保真读数。 */
export interface VerbatimCheck {
  /** 汇总节点 id。 */
  node: string;
  /** 上游合计的引文片段数。 */
  upstreamSpans: number;
  /** 本节点输出里**原样留下**的片段数 (子串命中)。 */
  kept: number;
}

/**
 * 判「汇总跳把上游逐字引文转述没了」。
 *
 * 只在三条同时成立时报(拿不准不报):
 *   ① 本节点 ≥2 个上游 —— 单入不是汇总,是接力;
 *   ② 上游合计 ≥3 段够长引文 —— 一两段可能只是碰巧;
 *   ③ 本节点输出**一段都没留** —— 留了一部分说明它知道要保真,判据不该管它留几段
 *      (那是质量问题,不是"通道断了"这个确定性事实)。
 *
 * 返回 null = 不报。**只报不拦**:转述在多数任务上正当,引擎判不了任务性质。
 */
export function detectVerbatimDrop(
  nodeId: string,
  upstreamOutputs: readonly string[],
  ownOutput: string,
): DagObservation | null {
  if (upstreamOutputs.length < 2) return null;
  const spans = upstreamOutputs.flatMap((t) => extractQuotedSpans(t));
  if (spans.length < 3) return null;
  const kept = spans.filter((s) => ownOutput.includes(s)).length;
  if (kept > 0) return null;
  return {
    kind: 'verbatim-drop',
    nodes: [nodeId],
    message:
      `汇总跳丢逐字引文: 节点 [${nodeId}] 的 ${upstreamOutputs.length} 个上游合计带了 ${spans.length} 段逐字引文, ` +
      '而本节点的输出**一段都没留下** —— 全部改写成了自己的话。' +
      '如果下游要按原文逐字定位 (引用/出处核对/证据链), 这一跳就把它要的东西弄没了。' +
      '改法: 让汇总节点**原样透传引文**(把引文放进结构化字段, 或在 goal 里明确"逐字保留原句, 不要转述"), ' +
      '或者干脆别在证据与交付物之间加这一跳。',
  };
}
