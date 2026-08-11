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
 * ## 时间:settle.durationMs 是耗时真源 (D-5, SDD 2026-08-11)
 *
 * settle 事件带引擎侧墙钟 (`durationMs`) 时优先用它;老发射点不给 → 回落到达间隔。
 * running 态的活秒数是 `now() - startAt`(render 时现算,由 tui 的 render tick 驱动递增)——
 * 那是"活着"的证据,不是精确墙钟。泳道甘特(画法 B)仍量到达间隔,头行有声明。
 *
 * ⚠ **没有 run 时什么都不画**(`render` 返回 `[]`)—— 与 DagHud 同一条:
 * 画一个空框会让人以为"有个 run 但没动"。
 */
import type { Component } from '@earendil-works/pi-tui';
import type { DagNodeEvent } from '../../harness/dag/types';
import { logger } from '../../logger';
import { fmtDur } from '../render/dag-gantt';
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
  /** settle 带的引擎侧墙钟 (D-5 耗时真源)。缺席 = 老发射点, 渲染回落到达间隔。 */
  durationMs?: number;
  /** settle 带的失败原文首行 (≤160 字符, S1 截断)。只画在 failed 行下 (C-6 ②)。 */
  failReason?: string;
  /** 最近一条 progress 的展示量 (C-6 ④; 生产端已节流 ≥500ms, 只留最新)。 */
  progress?: { tool?: string; note?: string };
  /**
   * 审核判决子行 (C-6 ③, 按到达序陈列)。DagTree 恒初始化成 `[]`;
   * 可选是因为树外的快照字面量 (render/ 测试) 可能不带它, 渲染侧 `?? []` 兜底。
   */
  verdicts?: VerdictLine[];
}

/**
 * 一条审核判决 (verdict 事件)。pass/fail **指被审对象** (D-9):
 * review CONFIRMED finding → fail, 证伪撤销 → pass —— 与引擎 verifier 同一读法。
 */
export interface VerdictLine {
  gate: 'judge' | 'verifier' | 'gate' | 'acceptance' | 'review';
  verdict: 'pass' | 'fail';
  round: number;
  reason?: string;
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
  /** 有没有节点还在跑 —— tui 的 render tick 拿它决定要不要继续刷活秒数 (C-6 ①)。 */
  hasRunning(): boolean {
    for (const n of this.nodes.values()) if (n.status === 'running') return true;
    return false;
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
    switch (e.type) {
      case 'planned': {
        for (const n of e.nodes) this.put(n.id, n.kind, null);
        return;
      }
      case 'expanded': {
        // ★ 这一支就是"分裂"本身:parent 是真的, 子节点挂在它下面。
        for (const n of e.nodes) this.put(n.id, n.kind, e.parent, false, n.deps);
        return;
      }
      case 'start': {
        const n = this.put(e.id, e.kind, null, true);
        n.status = 'running';
        n.startAt = this.now();
        return;
      }
      case 'settle': {
        const n = this.put(e.id, e.kind, null, true);
        n.status = e.status;
        n.endAt = this.now();
        if (n.startAt === null) n.startAt = n.endAt; // settle 先于 start 到 (乱序): 画零长条, 不编时长
        // D-5: 耗时真源 = 引擎侧墙钟;老发射点不给 → 渲染回落到达间隔。
        if (e.durationMs !== undefined) n.durationMs = e.durationMs;
        if (e.failReason !== undefined) n.failReason = e.failReason;
        return;
      }
      case 'progress': {
        // C-6 ④: tool/note 挂节点行尾。id 是真实节点 (生产端已节流 ≥500ms), 只留最近一条。
        const n = this.put(e.id, '', null, true);
        n.progress = { tool: e.tool, note: e.note };
        return;
      }
      case 'verdict': {
        // C-6 ③: 判决陈列成子行。pass/fail 指被审对象 (D-9), 画法只陈列不解释。
        const n = this.put(e.id, '', null, true);
        (n.verdicts ??= []).push({ gate: e.gate, verdict: e.verdict, round: e.round, reason: e.reason });
        return;
      }
      case 'replan': {
        // C-1: 无节点 id, 图上没有可画的位置 —— 静默忽略。
        // 老兜底会把整个对象当 settle 处理并 `put(undefined)` 造幽灵节点 (D-7 grill F1)。
        return;
      }
      default: {
        // C-1 (SDD 2026-08-11): 词表外 type / 缺 type 的畸形对象 —— fail-open:
        // 不 throw、不造节点、既有渲染不变, 只留一条日志痕。
        const u = e as unknown as { type?: unknown };
        logger.warn({ type: u.type }, '[dag-tree] C-1: 忽略未知 DAG 事件 (不造节点)');
      }
    }
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
    const n: TreeNode = { id, kind, status: 'pending', parent, deps: deps ?? [], seq: this.seq++, startAt: null, endAt: null, verdicts: [] };
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
        // 行尾:C-6 ① 活秒数/耗时 (D-5: durationMs 优先, 缺席回落到达间隔) + C-6 ④ progress 的 tool/note。
        // ⚠ 秒数**排在 progress 前**: 侧栏只有 34 列, 截断从尾巴开始 —— "活着"的秒数
        //   (C-6 ① 的判据主体) 必须活得过截断, progress 尾巴截掉只是少看半句。
        const tail: string[] = [];
        if (n.status === 'running') tail.push(fmtDur(Math.max(0, this.now() - (n.startAt ?? this.now()))));
        else if (n.endAt !== null) tail.push(fmtDur(Math.max(0, n.durationMs ?? n.endAt - (n.startAt ?? n.endAt))));
        if (n.progress) {
          const bits = [n.progress.tool, n.progress.note].filter((b): b is string => Boolean(b)).join(' ');
          if (bits) tail.push(`[${bits}]`);
        }
        const line = `${prefix}${branch}${TREE_MARK[n.status]} ${n.id}${n.kind ? ` ${n.kind}` : ''}${tail.length > 0 ? ` ${tail.join(' ')}` : ''}`;
        out.push(paint(n)(fitLine(line, width)));
        // 子行:C-6 ② failed 节点下一行缩进画 failReason; C-6 ③ 审核判决子行 (✗/✓ <gate> r<N>: <reason>)。
        // 子行缩进对齐节点行的 **id 起始列**(行首 = prefix + 分支宽 2 + 标记 2)。
        const subPrefix = prefix + (branch ? '    ' : '  ');
        if (n.status === 'failed' && n.failReason) out.push(paint(n)(fitLine(`${subPrefix}${n.failReason}`, width)));
        for (const v of n.verdicts ?? []) {
          out.push(this.theme.chrome.dim(fitLine(`${subPrefix}${v.verdict === 'pass' ? TREE_MARK.done : TREE_MARK.failed} ${v.gate} r${v.round}${v.reason ? `: ${v.reason}` : ''}`, width)));
        }
        walk(n.id, parent === null ? '' : prefix + (last ? '  ' : '│ '));
      });
    };
    walk(null, '');
    return out;
  }

  invalidate(): void {}
}
