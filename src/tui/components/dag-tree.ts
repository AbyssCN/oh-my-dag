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
import type { NodeFailureKind } from '../../harness/node-failure';
import type { HudDagSnapshot } from '../../hud/types';
import { logger } from '../../logger';
import { fmtDur } from '../render/dag-gantt';
import { fitLine } from '../render/line';
import { humanTokens } from '../render/pressure';
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
  /**
   * settle 带的**没过的成因** —— 也就是「是哪个闸拦的」(2026-08-21 起事件才带它)。
   *
   * 七个闸里只有三类发 `verdict`; 心跳闸 / 空转熔断 / 产物闸 / oracle / 轮数耗尽全部只以
   * settle{failed} 露面。没有这一位, 观测面只画得出一句被截断的错误原文, 画不出闸名。
   * ⚠ **缺席 ≠ `'unclassified'`**: 缺席 = 早于本次改动的发射点, unclassified = 记了但归不了类。
   */
  failureKind?: NodeFailureKind;
  /**
   * settle 带的词元用量 (`DagNodeEvent.settle.usage`, `dag/types.ts:493-494`)。
   *
   * ⚠ 2026-08-21 补: 这个字段**引擎一直在发, TUI 一直收下就扔**。于是「这一次 run 花了多少」
   * 在 TUI 上一处都没有 —— 而底栏那行是**进程级**的 5h 窗口 (`usage/ledger.ts:96`, 切 /session
   * 都不清零), 答的根本不是同一个问题。按本仓「dogfood 即测量」, run 级用量是一等读数。
   * 缺席 = 老发射点没报, **不是 0** (见 runUsage 的下界标记)。
   */
  usage?: { in: number; out: number };
  /**
   * settle 带的**实际跑这一节点的座位坐标**(`provider:model`)。
   *
   * 2026-08-22 补:事件面(`types.ts:500`)与账本(`RunProgress.settled[].model`)
   * 一直都有它, 只有这里没接 —— 于是 DAG 屏那一列**结构上永远是 `—`**,
   * 一个画得出来却永远没数的列(本仓在杀的空旋钮)。
   * ⚠ 缺席 = 老发射点没报, **不是**「跑在默认座位上」—— 画 `—`, 不编一个坐标。
   */
  model?: string;
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

/**
 * run 级词元合计 —— 「这一次 run 花了多少」。
 *
 * ## 三条读数纪律,一条都不许省
 *
 * ① **无源恒缺席**:一个节点都没报 usage → 返回 `null`,调用方整段不画。
 *    画 `0 tok` 会把「没报」冒充成「没花」。
 * ② **下界要标出来**:只要有**已定局**的节点没报 usage,合计就是**下界不是真值** →
 *    `partial: true`,渲染带 `+`。这个记号本仓已有先例:`statusbar.ts:65-68` 的
 *    `$0.00+` 就是「有未计价调用,是下界」。
 * ③ **只数定局的**:还在跑的节点本来就还没有 usage,不算进「谁没报」。
 */
export function runUsage(nodes: readonly TreeNode[]): { in: number; out: number; partial: boolean } | null {
  const settled = nodes.filter((n) => n.status === 'done' || n.status === 'failed' || n.status === 'skipped');
  const withUsage = settled.filter((n) => n.usage !== undefined);
  if (withUsage.length === 0) return null;
  return {
    in: withUsage.reduce((a, n) => a + (n.usage?.in ?? 0), 0),
    out: withUsage.reduce((a, n) => a + (n.usage?.out ?? 0), 0),
    partial: withUsage.length < settled.length,
  };
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

  /**
   * 从磁盘快照 hydrate 一棵树 (2026-08-22 SDD 片 3, INV-HUD-6)。
   *
   * 设计为**与事件驱动逐字段等价**(钉在 `dag-tree-snapshot.test.ts`):
   * 同一组事实 (planned + start/settle 经 `RunProgress` 落到 `HudDagSnapshot`),
   * 走事件 vs 走 hydrate, `snapshot()` 必须相等。
   *
   ## 三相位 (与 `apply` 的事件到达序同形, 保证 `seq` 对得上)
   *  ① `snap.planned` —— 按数组序 put (assigned seq); `deps` 缺席 = 根, 否则按
   *     `deps[0]` 认树父 (SDD 逐字; 见 `dag-tree-snapshot.test.ts` §deps[0] 与
   *     apply expanded 的差异注释)。
   *  ② `snap.settled` —— 走 `put(id, kind, null, keepParent=true)` 把状态落到
   *     既有的 planned 节点上 (或新建, 当节点**没有**经过 planned/expanded —— 罕见)。
   *     有 `startedAt` + `durationMs` → endAt = startAt + durationMs (稳);
   *     有 `startedAt` 但无 `durationMs` → endAt = `now()` (与 `apply` 的 settle
   *     分支同形); 都没 → startAt = endAt = `now()` (与「settle 先于 start」同形)。
   *  ③ `snap.started` —— 同 put 模式, status='running', endAt=null,
   *     startAt = parseISO(snap.startedAt[id])。
   *
   * `runLabel` 直接落到 `snap.goal` (与 `beginRun(label)` 同形)。
   */
  loadSnapshot(snap: HudDagSnapshot): void {
    this.nodes.clear();
    this.seq = 0;
    this.runLabel = snap.goal;

    // ① planned —— 给所有节点按到达序发 seq
    for (const p of snap.planned) {
      const parent = p.deps && p.deps.length > 0 ? p.deps[0]! : null;
      this.put(p.id, p.kind, parent, false, p.deps);
    }

    // ② settled —— 落状态, 沿用 put 的 keepParent (planned 已有父 → 不覆盖)
    for (const s of snap.settled) {
      const n = this.put(s.id, s.kind, null, true);
      n.status = s.status;
      if (s.startedAt) {
        n.startAt = Date.parse(s.startedAt);
        n.endAt = s.durationMs !== undefined ? n.startAt + s.durationMs : this.now();
      } else {
        // 无 prior start —— 与 apply 的「settle 先于 start」同形: startAt=endAt=now
        n.endAt = this.now();
        n.startAt = n.endAt;
      }
      if (s.durationMs !== undefined) n.durationMs = s.durationMs;
      if (s.usage !== undefined) n.usage = s.usage;
      // 双通路等价 (INV-HUD-6): 事件那侧接了 model, 这侧也必须接, 否则同一份事实
      // 走两条路画出两棵不一样的树。
      if (s.model !== undefined) n.model = s.model;
      // snap.failureKind 是 string, TreeNode 是 NodeFailureKind 联合 —— 运行期同形态 (生产端
      // 由 `withFailureKind` 收尾, 见 harness/dag/types.ts:643), 此处直接断言。
      if (s.failureKind !== undefined) n.failureKind = s.failureKind as NodeFailureKind;
    }

    // ③ running —— startAt 来自 snap.startedAt, endAt=null
    for (const id of snap.started) {
      const n = this.put(id, '', null, true); // kind='' 留待既有的 planned 提供
      n.status = 'running';
      const at = snap.startedAt[id];
      n.startAt = at ? Date.parse(at) : null;
      n.endAt = null;
    }
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
        // endAt 真源 = 引擎侧墙钟 (startAt+durationMs); 缺席回落观察时刻。
        // 这一改与 hydrate 路径同源 (snapshot 只存 startedAt+durationMs, 拿不到 settle 观察时刻)
        // —— 双通路等价闸 (INV-HUD-6) 钉在 dag-tree-snapshot.test.ts。
        n.endAt = e.durationMs !== undefined && n.startAt !== null
          ? n.startAt + e.durationMs
          : this.now();
        if (n.startAt === null) n.startAt = n.endAt; // settle 先于 start 到 (乱序): 画零长条, 不编时长
        // D-5: 耗时真源 = 引擎侧墙钟;老发射点不给 → 渲染回落到达间隔。
        if (e.durationMs !== undefined) n.durationMs = e.durationMs;
        if (e.failReason !== undefined) n.failReason = e.failReason;
        if (e.failureKind !== undefined) n.failureKind = e.failureKind;
        if (e.usage !== undefined) n.usage = e.usage; // 2026-08-21: 此前收下就扔
        if (e.model !== undefined) n.model = e.model; // 2026-08-22: 同上, model 也一直收下就扔
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
        logger.warn({ type: u.type }, '[dag-tree] C-1: ignoring unknown DAG event (no node created)');
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
    // 头行带 run 级词元合计 (2026-08-21)。**没有一个节点报过就整段不画** —— 底栏那行是
    // 进程级 5h 窗口, 答的不是同一个问题, 这里画 0 会让人以为这次 run 没花钱。
    const u = runUsage([...this.nodes.values()]);
    const tok = u ? ` · ${humanTokens(u.in + u.out)}${u.partial ? '+' : ''} tok` : '';
    const out: string[] = [
      this.theme.chrome.accent(fitLine(`${this.runLabel ? `DAG ${this.runLabel}` : 'DAG'}${tok}`, width)),
    ];

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
        if (n.status === 'failed' && n.failReason) {
          // 成因前缀 = 「是哪个闸拦的」。缺席就只画原文 —— 不编一个 `unclassified` 出来充数。
          const why = n.failureKind ? `[${n.failureKind}] ` : '';
          out.push(paint(n)(fitLine(`${subPrefix}${why}${n.failReason}`, width)));
        }
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
