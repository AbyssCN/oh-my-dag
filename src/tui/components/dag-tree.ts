/**
 * src/tui/components/dag-tree —— **左栏里的 DAG 图 + 三画法共用的数据模型**(切片③,S-9 复活)。
 *
 * ## 为什么不是那张表
 *
 * `dag-hud.ts` 画的是一张**表**(节点 / 角色 / 状态 / 模型)。表答得了"每个节点怎么样",
 * 答不了 owner 真正要看的那件事:**它在哪儿分裂了、分成了几股**。
 * 一个 map 节点炸成 16 个分片,在表里是 16 个并列的行,和 16 个互不相关的节点长得一样。
 *
 * ## 边是真的,不是画着好看
 *
 * `DagNodeEvent` 的 `expanded` 带 `parent` 与 `deps`(`dag/types.ts:379`)——
 * map/conductor 节点**运行时**把子节点挂进图的那一刻会发一次。所以父子关系是引擎给的事实,
 * 这里只负责把它摆成树。`planned` 那一批没有父,就是根。
 *
 * ## 时间是**事件到达时刻**,不是引擎时钟
 *
 * 事件不带 ts,泳道甘特(画法 B)量的是 start→settle 的到达间隔。这对"谁是串行尾巴"
 * 够用,但**不是**引擎侧的精确墙钟 —— 甘特头上会写明这一点的度量来源。
 *
 * ⚠ **没有 run 时什么都不画**(`render` 返回 `[]`)—— 与 DagHud 同一条:
 * 画一个空框会让人以为"有个 run 但没动"。
 */
import type { Component } from '@earendil-works/pi-tui';
import type { DagNodeEvent } from '../../harness/dag/types';
import { fitLine } from '../render/line';
import type { OmdTuiTheme } from '../theme';

export type TreeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * 状态字形。**五态五个样子** —— 合并任意两个,"卡住了"与"还没轮到"就分不开了。
 * 全部在 S6 白名单里(2026-08-07 真终端读数)。
 */
export const TREE_MARK: Record<TreeStatus, string> = {
  pending: '○',
  running: '·',
  done: '✓',
  failed: '✗',
  skipped: '─',
};

export interface TreeNode {
  id: string;
  kind: string;
  status: TreeStatus;
  /** 父节点 id;`null` = 根(planned 那一批)。 */
  parent: string | null;
  /** 依赖(只有 `expanded` 报的那部分 —— planned 事件不带 deps,这是数据面的实情)。 */
  deps: string[];
  /** 挂进来的顺序 —— 同层按它排,不按字典序:字典序会让 shard-10 排在 shard-2 前面。 */
  seq: number;
  /** start / settle 事件的**到达时刻**(ms)。`null` = 还没发生(与 0 分得开)。 */
  startAt: number | null;
  endAt: number | null;
}

/** 三画法共用的一份快照(纯数据,渲染函数吃它)。 */
export interface DagSnapshot {
  runLabel: string | null;
  nodes: TreeNode[];
}

export class DagTree implements Component {
  private nodes = new Map<string, TreeNode>();
  private runLabel: string | null = null;
  private seq = 0;

  constructor(
    private theme: OmdTuiTheme,
    private now: () => number = Date.now,
  ) {}

  get active(): boolean {
    return this.nodes.size > 0;
  }

  /** @internal 测试观测口。 */
  get size(): number {
    return this.nodes.size;
  }

  /** 三画法共用的快照(按 seq 排)。 */
  snapshot(): DagSnapshot {
    return { runLabel: this.runLabel, nodes: [...this.nodes.values()].sort((a, b) => a.seq - b.seq) };
  }

  /** 换 run:清干净。**不清的话两个 run 的节点会混成一张图**,而图上看不出它们不是一家的。 */
  beginRun(label: string): void {
    this.nodes.clear();
    this.seq = 0;
    this.runLabel = label;
  }

  apply(e: DagNodeEvent): void {
    if (e.type === 'planned') {
      for (const n of e.nodes) this.put(n.id, n.kind, null);
      return;
    }
    if (e.type === 'expanded') {
      // ★ 这一支就是"分裂"本身:parent 是真的, 子节点挂在它下面。
      for (const n of e.nodes) this.put(n.id, n.kind, e.parent, false, n.deps);
      return;
    }
    if (e.type === 'start') {
      const n = this.put(e.id, e.kind, null, true);
      n.status = 'running';
      n.startAt = this.now();
      return;
    }
    const n = this.put(e.id, e.kind, null, true);
    n.status = e.status;
    n.endAt = this.now();
    if (n.startAt === null) n.startAt = n.endAt; // settle 先于 start 到 (乱序): 画零长条, 不编时长
  }

  /**
   * @param keepParent 已存在时**不覆盖父** —— `start`/`settle` 事件不带 parent,
   *   拿它们的 `null` 去覆盖会把已经挂好的子节点打回根,树当场变平。
   */
  private put(id: string, kind: string, parent: string | null, keepParent = false, deps?: string[]): TreeNode {
    const hit = this.nodes.get(id);
    if (hit) {
      if (!keepParent && parent !== null) hit.parent = parent;
      if (kind) hit.kind = kind;
      if (deps) hit.deps = deps;
      return hit;
    }
    const n: TreeNode = { id, kind, status: 'pending', parent, deps: deps ?? [], seq: this.seq++, startAt: null, endAt: null };
    this.nodes.set(id, n);
    return n;
  }

  /** 子节点表(按挂进来的顺序)。 */
  private childrenOf(parent: string | null): TreeNode[] {
    return [...this.nodes.values()].filter((n) => n.parent === parent).sort((a, b) => a.seq - b.seq);
  }

  render(width: number): string[] {
    if (!this.active) return []; // 无源恒缺席
    const paint = (n: TreeNode): ((t: string) => string) => {
      if (n.status === 'failed') return this.theme.chrome.warn;
      if (n.status === 'running') return this.theme.chrome.accent;
      return this.theme.chrome.dim;
    };
    const out: string[] = [this.theme.chrome.accent(fitLine(this.runLabel ? `DAG ${this.runLabel}` : 'DAG', width))];

    /**
     * 递归画一层。`prefix` 是这一层左边已经积累的竖线。
     *
     * ⚠ 最后一个孩子用 `└─`、其余用 `├─`,**并且**最后一个孩子的下一层前缀是空格而不是 `│` ——
     * 这两处必须成对改;只改一处的话竖线会从树的末端继续往下延伸到没有节点的地方。
     */
    const walk = (parent: string | null, prefix: string): void => {
      const kids = this.childrenOf(parent);
      kids.forEach((n, i) => {
        const last = i === kids.length - 1;
        const branch = parent === null ? '' : last ? '└─' : '├─';
        const line = `${prefix}${branch}${TREE_MARK[n.status]} ${n.id} ${n.kind}`;
        out.push(paint(n)(fitLine(line, width)));
        walk(n.id, parent === null ? '' : prefix + (last ? '  ' : '│ '));
      });
    };
    walk(null, '');
    return out;
  }

  invalidate(): void {}
}
