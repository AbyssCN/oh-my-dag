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
import type { DagNodeEvent } from '../../harness/executor-dag-types';
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
  pending: '待跑',
  running: '在跑',
  done: 'ok',
  failed: '失败',
  skipped: '跳过',
};

/** 表里最多画几行 —— 一个 200 节点的 map 会把整屏吃光,而 HUD 是配角。 */
const MAX_ROWS = 12;

export class DagHud implements Component {
  private nodes = new Map<string, NodeState>();
  private runLabel: string | null = null;

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
  }

  apply(e: DagNodeEvent): void {
    if (e.type === 'planned') {
      for (const n of e.nodes) this.upsert(n.id, n.kind, 'pending');
      return;
    }
    if (e.type === 'expanded') {
      // 运行时挂进来的子节点。少了这一条,一个 map 节点在 HUD 上永远只有一个点 ——
      // 而实际上它底下正在跑几十个 leaf(`DagNodeEvent.expanded` 的注释记的就是这个洞)。
      for (const n of e.nodes) this.upsert(n.id, n.kind, 'pending');
      return;
    }
    if (e.type === 'start') {
      this.upsert(e.id, e.kind, 'running');
      return;
    }
    this.upsert(e.id, e.kind, e.status, e.model);
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
    const relation = `conductor ${seat ?? '(未知座位)'} -> leaf ${byRole('leaf')} -> verifier ${byRole('verifier')}`;
    const out: string[] = [
      this.theme.chrome.accent(fitLine(this.runLabel ? `DAG ${this.runLabel}` : 'DAG', width)),
      this.theme.chrome.dim(fitLine(relation, width)),
      this.theme.chrome.dim(fitLine(renderBar(settled.length, all.length, width), width)),
    ];

    // 在跑的排前面 —— HUD 是用来看"现在怎么样"的, 不是流水账。
    const order: Record<NodeState['status'], number> = { running: 0, failed: 1, pending: 2, done: 3, skipped: 4 };
    const sorted = [...all].sort((a, b) => order[a.status] - order[b.status]);
    const shown = sorted.slice(0, MAX_ROWS);
    const rows = [
      ['节点', '角色', '状态', '模型'],
      ...shown.map((n) => [n.id, roleOf(n.kind), STATUS_LABEL[n.status], n.model ?? '-']),
    ];
    out.push(...renderTable(rows, width));
    if (sorted.length > shown.length) {
      out.push(this.theme.chrome.dim(fitLine(`... 另有 ${sorted.length - shown.length} 个节点`, width)));
    }
    return out;
  }

  invalidate(): void {}
}
