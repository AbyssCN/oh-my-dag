/**
 * src/tui/render/dag-gantt —— **画法 B · 泳道甘特**(切片③,v5 第二节)。纯函数,零 pi-tui。
 *
 * 看得见:真并发度 · 谁是串行尾巴 · 空转窗口。看不见:依赖结构(那是画法 C 的活)。
 *
 * ## 度量来源写在头行里
 *
 * 事件不带引擎时钟,条子量的是 **start/settle 事件的到达间隔**(DagTree 记的)。
 * 对"谁占了 71% 墙钟"这类相对读数够用;绝对毫秒别拿它当官方读数 —— 头行标着「事件到达时刻」。
 */
import type { DagSnapshot, TreeNode } from '../components/dag-tree';
import { BAR_DONE } from './bar';
import { fitLine } from './line';
import { TREE_MARK } from '../components/dag-tree';

const IDLE = '·';

/** `42s` / `1m11s` / `0.4s`。 */
export function fmtDur(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
}

/**
 * 泳道甘特。每个**动过**的节点一条泳道(pending 的收进尾行计数 —— 没动过的节点没有时间条可画)。
 *
 * @param o.now 在跑节点的条子画到"现在"。注入换可测。
 */
export function renderGantt(snap: DagSnapshot, o: { width: number; height: number; now: number }): string[] {
  const started = snap.nodes.filter((n) => n.startAt !== null);
  const head = `DAG ${snap.runLabel ?? '?'} · swimlane gantt (event arrival time) · ${snap.nodes.length} nodes`;
  if (started.length === 0) return [fitLine(head, o.width), '(no node has moved yet - nothing to draw bars for)'];

  const t0 = Math.min(...started.map((n) => n.startAt as number));
  const tEnd = Math.max(o.now, ...started.map((n) => n.endAt ?? o.now));
  const span = Math.max(1, tEnd - t0);

  const label = (n: TreeNode): string => `${TREE_MARK[n.status]} ${n.id}`;
  const labelW = Math.min(22, Math.max(...started.map((n) => label(n).length), 8));
  const barW = Math.max(10, o.width - labelW - 12); // 12 = 间隔 + 右侧时长列

  const rows = started
    .slice()
    .sort((a, b) => (a.startAt as number) - (b.startAt as number) || a.seq - b.seq)
    .map((n) => {
      const s = n.startAt as number;
      const e = n.endAt ?? o.now;
      const from = Math.round(((s - t0) / span) * (barW - 1));
      const len = Math.max(1, Math.round(((e - s) / span) * barW));
      const bar = IDLE.repeat(from) + BAR_DONE.repeat(Math.min(len, barW - from)) + IDLE.repeat(Math.max(0, barW - from - len));
      const dur = n.endAt === null ? 'running' : fmtDur(e - s);
      return fitLine(`${label(n).padEnd(labelW)} ${bar} ${dur}`, o.width);
    });

  const axis = fitLine(`${' '.repeat(labelW + 1)}0s${' '.repeat(Math.max(0, barW - 2 - fmtDur(span).length))}${fmtDur(span)}`, o.width);
  const pendingN = snap.nodes.length - started.length;
  const out = [fitLine(head, o.width), axis, ...rows];
  // 瓶颈行 (v5 稿有): 占墙钟最长的那个节点。只有一个节点时它必然是 100%, 不值得说。
  if (started.length > 1) {
    const longest = started.reduce((a, b) => ((a.endAt ?? o.now) - (a.startAt as number) >= (b.endAt ?? o.now) - (b.startAt as number) ? a : b));
    const share = Math.round((((longest.endAt ?? o.now) - (longest.startAt as number)) / span) * 100);
    if (share > 0) out.push(fitLine(`bottleneck ${longest.id} takes ${share}% of wall clock${longest.endAt === null ? ' (running)' : ''}`, o.width));
  }
  if (pendingN > 0) out.push(`(${pendingN} nodes have not moved - no empty bars drawn)`);
  // 高度封顶: 全屏也有底, 剪掉的说清剪了多少。
  if (out.length > o.height) return [...out.slice(0, Math.max(1, o.height - 1)), `… ${out.length - o.height + 1} more lines`];
  return out;
}
