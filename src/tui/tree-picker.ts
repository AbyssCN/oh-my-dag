/**
 * src/tui/tree-picker —— **`/tree` 的会话树视图**(台账 §1.3 / C11 的导航面)。
 *
 * ## 为什么是这个文件而不是画在 `tui.ts` 里
 *
 * 与 `model-picker` / `seat-picker` 同一条:**选择器的取材与渲染是纯函数**,
 * 而 `tui.ts` 里没有一行是纯的(它握着 host / 焦点 / 事件)。分出来这一层能单测,
 * 于是"分叉点标错了""当前分支标反了"这类**看得见但测不到**的错才有闸。
 * ⚠ 本仓刚吃过一次同形状的账:状态映射的标签是反的,而 `tsc` 干净、测试全绿。
 *
 * ## 它画的是**树**,不是消息列表
 *
 * 分支摘要之后,被放弃的那条分支**仍在同一份 jsonl 里**(这正是 C11 的全部意思)——
 * 于是同一个 `parentId` 下会有两个孩子。看不见分叉就选不回去,那条分支等于丢了。
 * 所以取材必须是 `sessionTree`(整棵树),不是 `loadHistory`(当前分支的投影)。
 */
import type { TuiTreeEntry } from './backend';

/** 树上的一行。**位置信息全在这里算完**,渲染那一层不再做判断。 */
export interface TreeRow {
  id: string;
  /** 到根的层数(0 = 根)。 */
  depth: number;
  kind: string;
  preview: string;
  /** 当前叶(`*`)—— 新消息就接在它后面。 */
  current: boolean;
  /** 在当前分支上(根 → 当前叶那条路径)。 */
  onBranch: boolean;
  /** 分叉点:孩子多于一个。**这是这张图唯一非画不可的东西** —— 别的都是上下文。 */
  branchPoint: boolean;
}

/**
 * 树 → 深度优先的行序(先序:父在前,孩子按 `seq` 升序)。
 *
 * @param leafId 当前叶。`null`(空会话)时**没有任何一行属于当前分支** —— 不是"全都属于"。
 *
 * ⚠ **孤儿条目照画**(`parentId` 指向一个不在集合里的 id):那说明取材漏了东西,
 * 而把它们悄悄丢掉会让树看起来完整无缺。当根画,人一眼看得出不对。
 */
export function buildTreeRows(entries: readonly TuiTreeEntry[], leafId: string | null): TreeRow[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const children = new Map<string | null, TuiTreeEntry[]>();
  for (const e of entries) {
    // 父不在集合里 = 孤儿 ⇒ 当根挂。
    const key = e.parentId !== null && byId.has(e.parentId) ? e.parentId : null;
    const list = children.get(key);
    if (list) list.push(e);
    else children.set(key, [e]);
  }
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);

  // 当前分支 = 当前叶回溯到根那条路径。`null` 叶 ⇒ 空集(不是全集)。
  const onBranch = new Set<string>();
  let cursor = leafId;
  while (cursor !== null) {
    if (onBranch.has(cursor)) break; // 环:数据坏了也不许把这里挂死
    onBranch.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }

  const rows: TreeRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const e of children.get(parent) ?? []) {
      const kids = children.get(e.id) ?? [];
      rows.push({
        id: e.id,
        depth,
        kind: e.kind,
        preview: e.preview,
        current: e.id === leafId,
        onBranch: onBranch.has(e.id),
        branchPoint: kids.length > 1,
      });
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** 一行的样子。`*` 当前叶 · `+` 分叉点 · `|` 在当前分支上 · 空格 = 旁支。 */
export function treeLabel(row: TreeRow): string {
  const mark = row.current ? '*' : row.branchPoint ? '+' : row.onBranch ? '|' : ' ';
  // id 只留前 8 位:uuidv7 的前缀已经足够区分, 全长会把预览挤没。
  return `${mark} ${'  '.repeat(Math.min(row.depth, 8))}${row.id.slice(0, 8)}  ${row.kind}  ${row.preview}`;
}

/**
 * 渲染成给 chat 记录看的几行。
 *
 * @param limit 最多画几行。超了**画最后 `limit` 行**并说清省了多少 —— 树的尾部才是要选的
 *   地方(分叉都在近处),而省掉的那些**仍然进选择器**(它带搜索)。
 *   ⚠ 说出省了多少这一句不许省:没有它,一棵被裁过的树读起来就是一棵完整的树。
 */
export function formatTree(rows: readonly TreeRow[], limit = 40): string {
  if (rows.length === 0) {
    return 'This session has no entries yet (the tree is created when you say something).';
  }
  const shown = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  const head =
    rows.length > limit
      ? `Session tree (last ${limit} of ${rows.length} entries; all of them are in the picker, which has search):`
      : `Session tree (${rows.length} entries):`;
  return [
    head,
    ...shown.map((r) => `  ${treeLabel(r)}`),
    '  `*` = current leaf (new messages attach here) · `+` = branch point · `|` = on the current branch',
    'Pick an earlier entry to branch from it: the branch you are on now is summarized into a [branch summary] node first.',
  ].join('\n');
}

/** `/tree` 的解析。纯函数 —— 分发那一层不是 async, 解析必须能同步问。 */
export function parseTreeCommand(text: string): boolean {
  return text.trim() === '/tree';
}
