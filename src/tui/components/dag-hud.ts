/**
 * src/tui/components/dag-hud —— **DAG 活体 HUD**(TUI SDD §6,切片 S11)。
 *
 * ## 数据从哪来:进程内直订阅,不读文件
 *
 * SDD §6 owner 已拍板「**进程内直订阅引擎事件**,零文件 IO、零延迟」。所以这个组件吃的是
 * `DagNodeEvent`(引擎的 `onNodeEvent` 接缝),不是 `.omd/hud/dag.json`。
 *
 * ⚠ 那个文件**照写不误** —— 它是 statusline 的数据源。加 TUI 不许把 statusline 断掉,
 * 这条有专门的闸(`dag-hud.test.ts` 与 assemble 侧的断言)。两条路各有各的消费者,不是重复。
 *
 * ## 角色关系(owner 裁决 ③:「关系」= conductor / leaf / verifier)
 *
 * 节点事件里只有 `kind`。角色是从 kind **推**出来的一层视图,所以它必须
 * ① 有明确的映射表(不是散在渲染代码里的 if),② 遇到没见过的 kind 说「未知」而不是猜一个。
 * 顶部那一行画的就是这层关系:`conductor <座位> -> leaf N -> verifier M`。
 *
 * ## 没有 run 的时候画什么
 *
 * **什么都不画**(`render` 返回 `[]`)—— 断链说明卡的第一画法「无源恒缺席」。
 * 画一个空表格 / 画一条 0% 的进度条都会让人以为"有个 run 但没动"。
 */
import type { Component } from '@earendil-works/pi-tui';
import type { DagNodeEvent } from '../../harness/dag/types';
import { logger } from '../../logger';
import { fitLine } from '../render/line';
import { renderBar } from '../render/bar';
import { renderTable } from '../render/table';
import type { OmdTuiTheme } from '../theme';

export type NodeRole = 'leaf' | 'verifier' | 'conductor' | 'unknown';

/**
 * kind → 角色。**一张表,不是散落的 if**(owner 裁决 ③ 要看的就是这层关系)。
 *
 * ⚠ 表里没有的 kind 一律 `unknown`,**不猜**。猜错了画面上是一个看起来很确定的错分类,
 * 而"未知"至少提示这里该补一格。
 */
const KIND_ROLE: Record<string, NodeRole> = {
  agent: 'leaf',
  command: 'leaf',
  research: 'leaf',
  primitive: 'leaf',
  judge: 'verifier',
  judge_synth: 'verifier',
  gate: 'verifier',
  verify: 'verifier',
  map: 'conductor',
  conductor: 'conductor',
};

export function roleOf(kind: string): NodeRole {
  return KIND_ROLE[kind] ?? 'unknown';
}

interface NodeState {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  model?: string;
}

const STATUS_LABEL: Record<NodeState['status'], string> = {
  pending: 'pending',
  running: 'running',
  done: 'ok',
  failed: 'failed',
  skipped: 'skipped',
};

/** 表里最多画几行 —— 一个 200 节点的 map 会把整屏吃光,而 HUD 是配角。 */
export const MAX_ROWS = 12;

export class DagHud implements Component {
  private nodes = new Map<string, NodeState>();
  private runLabel: string | null = null;
  /**
   * 滚动窗口的起点。
   *
   * ⚠ `0` = **跟随模式**:排序是「在跑的排最前」,所以窗口停在 0 就自动跟着活动节点走。
   * 一旦用户滚动过(offset > 0),窗口就**钉住** —— 新节点进来不许把他正在看的那一屏顶走。
   * 想回到跟随:`scrollToTop()`(Alt+Home)。
   */
  private offset = 0;

  constructor(
    private theme: OmdTuiTheme,
    /** 顶部关系行里显示的 conductor 座位;`null` = 还不知道(不编一个)。 */
    private conductorSeat: () => string | null = () => null,
  ) {}

  /** 有没有东西可画。UI 拿它决定要不要把这个组件挂上去。 */
  get active(): boolean {
    return this.nodes.size > 0;
  }

  /** @internal 测试观测口。 */
  get size(): number {
    return this.nodes.size;
  }

  /** 一个新 run 开始 —— 清空上一个 run 的节点。**不清的话两个 run 的节点会混成一张表。** */
  beginRun(label: string): void {
    this.nodes.clear();
    this.runLabel = label;
    this.offset = 0; // 换 run 回到跟随:上一个 run 的滚动位置对新图没有意义
  }

  /**
   * 滚动。**夹在 `[0, max(0, total - MAX_ROWS)]`** —— 滚过头留一屏空白比什么都不显示更糟:
   * 那看起来像"节点都没了"。
   *
   * @returns 位置有没有真的变(没变时调用方可以不重绘)
   */
  scrollBy(delta: number): boolean {
    const max = Math.max(0, this.nodes.size - MAX_ROWS);
    const next = Math.min(Math.max(0, this.offset + delta), max);
    if (next === this.offset) return false;
    this.offset = next;
    return true;
  }

  /** 回到跟随模式(窗口重新跟着在跑的节点走)。 */
  scrollToTop(): boolean {
    if (this.offset === 0) return false;
    this.offset = 0;
    return true;
  }

  /** @internal 测试观测口。 */
  get scrollOffset(): number {
    return this.offset;
  }

  apply(e: DagNodeEvent): void {
    switch (e.type) {
      case 'planned': {
        for (const n of e.nodes) this.upsert(n.id, n.kind, 'pending');
        return;
      }
      case 'expanded': {
        // 运行时挂进来的子节点。少了这一条,一个 map 节点在 HUD 上永远只有一个点 ——
        // 而实际上它底下正在跑几十个 leaf(`DagNodeEvent.expanded` 的注释记的就是这个洞)。
        for (const n of e.nodes) this.upsert(n.id, n.kind, 'pending');
        return;
      }
      case 'start': {
        this.upsert(e.id, e.kind, 'running');
        return;
      }
      case 'settle': {
        this.upsert(e.id, e.kind, e.status, e.model);
        return;
      }
      case 'progress':
      case 'verdict':
      case 'replan': {
        // C-6 的展示量 (活秒数/failReason/判决/progress) 画在树上 (dag-tree);
        // HUD 表只保节点态, 这些事件不改变它。C-1: 不造节点 ——
        // 老兜底会把 progress/verdict 的 id 当 settle 用, replan 更是 `put(undefined)`。
        return;
      }
      default: {
        // C-1 (SDD 2026-08-11): 词表外 type / 缺 type 的畸形对象 —— fail-open:
        // 不 throw、不造节点、既有渲染不变, 只留一条日志痕。
        const u = e as unknown as { type?: unknown };
        logger.warn({ type: u.type }, '[dag-hud] C-1: 忽略未知 DAG 事件 (不造节点)');
      }
    }
  }

  private upsert(id: string, kind: string, status: NodeState['status'], model?: string): void {
    const prev = this.nodes.get(id);
    this.nodes.set(id, { id, kind, status, ...(model ?? prev?.model ? { model: model ?? prev?.model } : {}) });
  }

  render(width: number): string[] {
    if (!this.active) return []; // 无源恒缺席 —— 不画空表, 不画 0% 的条
    const all = [...this.nodes.values()];
    const settled = all.filter((n) => n.status === 'done' || n.status === 'failed' || n.status === 'skipped');
    const byRole = (r: NodeRole) => all.filter((n) => roleOf(n.kind) === r).length;

    const seat = this.conductorSeat();
    // 角色关系行 (裁决 ③): conductor 在最前, 后面是它派出去的两档。
    const relation = `conductor ${seat ?? '(seat unknown)'} -> leaf ${byRole('leaf')} -> verifier ${byRole('verifier')}`;
    const out: string[] = [
      this.theme.chrome.accent(fitLine(this.runLabel ? `DAG ${this.runLabel}` : 'DAG', width)),
      this.theme.chrome.dim(fitLine(relation, width)),
      this.theme.chrome.dim(fitLine(renderBar(settled.length, all.length, width), width)),
    ];

    // 在跑的排前面 —— HUD 是用来看"现在怎么样"的, 不是流水账。
    const order: Record<NodeState['status'], number> = { running: 0, failed: 1, pending: 2, done: 3, skipped: 4 };
    const sorted = [...all].sort((a, b) => order[a.status] - order[b.status]);
    // 节点变少时(换 run / 重规划)把越界的 offset 收回来 —— 否则会画出一屏空白。
    const max = Math.max(0, sorted.length - MAX_ROWS);
    if (this.offset > max) this.offset = max;
    const shown = sorted.slice(this.offset, this.offset + MAX_ROWS);
    const rows = [
      ['node', 'role', 'status', 'model'],
      ...shown.map((n) => [n.id, roleOf(n.kind), STATUS_LABEL[n.status], n.model ?? '-']),
    ];
    out.push(...renderTable(rows, width));
    if (sorted.length > MAX_ROWS) {
      // ⚠ 画的是**窗口位置**不只是"还有多少" —— 只说"另有 N 个"的话,滚动之后
      // 你不知道自己在哪一段,也不知道还能不能往下滚。
      const from = this.offset + 1;
      const to = this.offset + shown.length;
      const follow = this.offset === 0 ? ' following' : '';
      out.push(this.theme.chrome.dim(fitLine(`nodes ${from}-${to} / ${sorted.length}${follow}  Alt+↑↓ scrolls, Alt+Home returns to top`, width)));
    }
    return out;
  }

  invalidate(): void {}
}
