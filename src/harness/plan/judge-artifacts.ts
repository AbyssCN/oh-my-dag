/**
 * plan/judge-artifacts —— 把**声明产物的内容**读进 judge 视图 (S1, 2026-08-03)。
 *
 * ## 它补的是哪个洞
 *
 * `[引擎实测]` 这一行 (2026-07-30 第三次 live 冒烟加的) 救回的是「真做完的活被判成捏造」——
 * 但它只给**存在性**: `写入文件: docs/from-api.md`。而两次带种 live 的目标要的是**内容**:
 *
 * > 节点…**声称写入了文件**, 但给出的摘要内容仅为表格片段或描述性文字, **未展示完整的
 * > 摘要文件内容, 无法逐条对照**"单次上限"与"支持格式"是否在每份摘要中如实陈述
 *
 * judge 没冤枉谁 —— 它被要求裁决它看不见的东西, 于是 fail-closed, 于是不收敛。两次 live 交付物
 * 全对、全判未收敛。**推论: 交付物是文件且验收在内容上的目标, 倾向于永不收敛。**
 *
 * ## 为什么是引擎读盘, 不是让 leaf 自己复述
 *
 * 与 `[引擎实测]` 那一行同源: 引擎读盘是**机器可核的事实**; 让 leaf 把文件内容复述进 output
 * 就又回到自证 —— 而"自证"正是反捏造判词要杀的东西。**这个模块只把盘上真有的字节搬进视图,
 * 一个字都不加工。**
 *
 * ## 诚实边界 (都以"如实说没读到"结尾, 绝不用沉默或编造填补)
 *
 * - **路径根只有一个** (`repoRoot ?? cwd`), 而 `filesTouched` 的相对路径根是**产出它的那个 leaf
 *   的 cwd**。多 runner 混跑时可能对不上 —— 后果是读不到, 而读不到会**如实写进视图**
 *   (`引擎未能读到`), 不是悄悄跳过。与制品 lint 那条同一个已知边界。
 * - **预算是硬的**。这段进的是**每一次** judge 调用, 没有上限就是给每轮判决挂一个无界成本。
 *   超预算的文件**列出来说明没展示**, 不静默截断掉整个文件 (no-silent-caps)。
 * - **只读写过的** (`filesTouched`)。`filesRead` 是输入不是交付物, 把它也搬进来既涨钱又跑题。
 */

/** 一份被搬进 judge 视图的产物。 */
export interface JudgeArtifact {
  path: string;
  /** 文件正文 (可能被截断; 截断时 `truncated` 为真)。读不到时是一句如实说明, 见 `readable`。 */
  body: string;
  truncated?: boolean;
  /** false = 这一条不是文件内容, 是"为什么没有内容"的说明 (读不到 / 非文本 / 超预算)。 */
  readable: boolean;
}

export interface ArtifactBudget {
  /** 单文件上限 (字符)。超出 → 截断 + 标注真实大小。 */
  perFile: number;
  /** 本节点全部产物合计上限 (字符)。用尽后剩下的文件只列路径, 说明未展示。 */
  total: number;
}

/** 默认预算: 单文件 4000 / 合计 12000 字符。**没有实测依据**, 是与 fan-in 摘要同量级的结构性取值。 */
export const DEFAULT_ARTIFACT_BUDGET: ArtifactBudget = { perFile: 4_000, total: 12_000 };

/** 读一个文件 (注入式: 测试给假的, 生产给 readFileSync)。读不到 → null。 */
export type ArtifactReader = (path: string) => string | null;

/** 二进制判据: 前 1KB 里有 NUL 就当非文本 (与常见 `grep -I` 同款启发式)。 */
function looksBinary(s: string): boolean {
  return s.slice(0, 1024).includes('\0');
}

/**
 * 把一批声明产物读成 judge 视图条目。
 *
 * `paths` 顺序即优先序 —— 预算先给前面的。调用方 (executor-dag) 传的是 `filesTouched` 的原序,
 * 也就是 leaf 真写它们的顺序。
 */
export function collectJudgeArtifacts(
  paths: readonly string[],
  read: ArtifactReader,
  budget: ArtifactBudget = DEFAULT_ARTIFACT_BUDGET,
): JudgeArtifact[] {
  const out: JudgeArtifact[] = [];
  let spent = 0;
  for (const path of paths) {
    if (spent >= budget.total) {
      // no-silent-caps: 预算用尽的文件**要出现在视图里**。悄悄丢掉它, judge 看到的就是一份
      // 不完整的产物清单, 而它无从知道自己看的是残的 —— 那正是"让它裁决看不见的东西"的老毛病。
      out.push({ path, body: '(超出本节点产物预算, 未展示内容)', readable: false });
      continue;
    }
    const raw = read(path);
    if (raw === null) {
      // 声明写了、盘上读不到 —— 这**本身就是判据**, 而且是最该让 judge 看见的那种。
      out.push({ path, body: '(引擎未能读到该文件)', readable: false });
      continue;
    }
    if (looksBinary(raw)) {
      out.push({ path, body: '(非文本文件, 未展示内容)', readable: false });
      continue;
    }
    const room = Math.min(budget.perFile, budget.total - spent);
    const truncated = raw.length > room;
    const body = truncated ? raw.slice(0, room) : raw;
    spent += body.length;
    out.push({
      path,
      body,
      readable: true,
      ...(truncated ? { truncated: true } : {}),
    });
  }
  return out;
}

/**
 * 渲染成 judge 视图里的一段。
 *
 * ⚠ **一个结论词都不许有**。这里出现 "✅ 内容正确" 之类的东西, 就等于把判决替 judge 做了 ——
 * 与 `[引擎实测]` 那一行刻意不写 "3/3 通过" 是同一条纪律 (2026-07-29 实测删掉的那条
 * "都好着呢"暗示, 代价是三成谎报完成)。这里只有路径、字节、和"为什么没有内容"。
 */
export function renderJudgeArtifacts(artifacts: readonly JudgeArtifact[]): string {
  if (!artifacts.length) return '';
  const blocks = artifacts.map((a) => {
    const head = a.readable
      ? `--- ${a.path}${a.truncated ? ' (前 ' + a.body.length + ' 字符, 已截断)' : ''} ---`
      : `--- ${a.path} ---`;
    return `${head}\n${a.body}`;
  });
  return `[产物内容 · 引擎读盘]\n${blocks.join('\n')}`;
}
