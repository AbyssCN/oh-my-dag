/**
 * src/tui/render/dag-screen —— **DAG 屏 v2**(2026-08-22, SDD 片 4 切片 1)。
 *
 * 一棵树,每行一条完整记录:
 *   [选中] 树枝 状态字形 id kind model 用时 微型时间条 [╋ +其它上游]
 * 选中节点**就地展开**判词 / 上游失败 / 下一步(r 重跑 / i 介入 / s 停图)。
 *
 * 数据源 = `DagSnapshot`(经 `DagTree.loadSnapshot` hydrate, 见 `components/dag-tree.ts`)。
 * 无源恒缺席 (INV-DAG-8) —— 一份节点都没有就返回 `[]`,不画空表头。
 *
 * 参照实现:`scripts/tui-screens.mjs` 的 `dagScreen()`。本文件是它的 TS 落地:
 *   - `vw()` → `visibleWidth`(pi-tui)
 *   - JS-only paint → 注入式 `DagPaint`(与 `path-fog.ts` 的 `FogPaint` 同模式)
 *   - 字符闸全部在 `glyph-table.ts` 的 SAFE 档
 *
 * ## 设计文档里的反 slop 锚点
 *   - 五态五个字形,合并任意两个「卡住了 / 还没轮到」就分不开 (INV-DAG-9)
 *   - 选中用 `▸`,**结构信息不许只靠颜色**(INV-DAG-9)
 *   - pending 不画 `0s`,画 `—`(INV-DAG-2)
 *   - 时间条只画已经发生的区间(无 startAt → 整条不画;有 startAt 无 endAt → 画到 now;INV-DAG-3)
 *   - 列宽随屏宽退让:**先丢时间条,再丢 model**,丢掉的列不留空位(INV-DAG-4)
 *   - deps[0] 认树父;多于 1 → 行尾 `╋ +<id>,<id>`(INV-DAG-1, fan-in 节点只画一次)
 *   - 判词的 pass/fail **指被审对象**(INV-DAG-6) —— 展开里必须带这句限定
 *   - 下一步动作只在 failed / await 节点上画(INV-DAG-5) —— 一个 done 节点下面挂三个键是噪音
 *
 * 注:`TreeNode` 当前不带 `model` 字段(片 3 的 read-side 加宽账还没把 model 搬进来,
 * 不在本片写集);画侧走 `(n as { model?: string }).model`,缺席画 `—`(INV-DAG-2)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DagSnapshot, TreeNode, TreeStatus } from '../components/dag-tree';
import { fitLine } from './line';

/** 颜色钩子。同 `FogPaint` 形状 —— 省略 = 恒等(NO_COLOR / 测试)。 */
export interface DagPaint {
  accent(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
  sel(s: string): string;
  ok(s: string): string;
  fail(s: string): string;
}
const PLAIN: DagPaint = {
  accent: (s) => s, dim: (s) => s, warn: (s) => s, sel: (s) => s, ok: (s) => s, fail: (s) => s,
};

/** 节点五态字形(全部 SAFE)。合并任意两个,「卡住了 / 还没轮到」就分不开。 */
const DAG_MARK: Record<TreeStatus, string> = {
  pending: '○',
  running: '◉',
  done: '✓',
  failed: '✗',
  skipped: '─',
};

/** 时间条的虚拟总长度 (ms)。真实 tick 时按 now 决定 —— 这里只用于"把已经发生的区间挪到合适列位"。 */
const TIME_BAR_TOTAL_MS = 32_000;

/** 时间条的"空闲"段(SAFE 档 ─)。 */
const IDLE = '·';

/** CJK 按字列断行 + 西文优先整词搬到下一行。 */
const wrap = (text: string, cols: number): string[] => {
  if (cols <= 1) return [text.slice(0, Math.max(0, cols))];
  const toks: string[] = [];
  let lat = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 && ch !== ' ') {
      lat += ch;
      continue;
    }
    if (lat) {
      toks.push(lat);
      lat = '';
    }
    toks.push(ch);
  }
  if (lat) toks.push(lat);
  const out: string[] = [];
  let cur = '';
  for (const t of toks) {
    if (cur !== '' && visibleWidth(cur + t) > cols) {
      const pushed = cur.trimEnd();
      if (pushed) out.push(pushed);
      cur = t === ' ' ? '' : t;
    } else {
      cur += t;
    }
  }
  const tail = cur.trimEnd();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [''];
};

/** 截到可见列并补 `…`。只用于 chrome / 摘要列;正文走 wrap。 */
const clip = (text: string, cols: number): string => {
  if (cols <= 0) return '';
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return '…';
  let s = '';
  for (const ch of text) {
    if (visibleWidth(s + ch) > cols - 1) break;
    s += ch;
  }
  return s + '…';
};

/** `null/undefined` → `—`;ms → `0.4s` / `42s` / `1m11s` (NULL ≠ 0: 缺席不画 0s)。 */
const fmtDur = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
};

/** `deps[0] === parent` 的子集(按 seq 排序);DAG fan-in 时仍只画一次(INV-DAG-1)。 */
const childrenOf = (nodes: readonly TreeNode[], parent: string | null): TreeNode[] =>
  nodes
    .filter((n) => (n.deps[0] ?? null) === parent)
    .sort((a, b) => a.seq - b.seq);

/** 按索引 mod 选节点(与 `tui-screens.mjs` 同形)。 */
const pickSelected = (nodes: readonly TreeNode[], sel: number): TreeNode | null => {
  if (nodes.length === 0) return null;
  const idx = ((sel % nodes.length) + nodes.length) % nodes.length;
  return nodes[idx] ?? null;
};

/**
 * DAG 屏渲染器。
 *
 * @param o.paint 颜色钩子;省略 = 恒等(NO_COLOR / 测试)。
 * @param o.now 在跑节点的时间条画到这一时刻 + running 节点的活秒数。注入 = 可测。
 * @returns 行列表。无源 = `[]`(INV-DAG-8),不画空表头 / 不画 `0 runs`。
 */
export function renderDagScreen(
  snap: DagSnapshot,
  o: { width: number; height: number; selected: number; now: number; paint?: DagPaint },
): string[] {
  // ── INV-DAG-8: 无源恒缺席。一份节点都没有 → 返回 [], 不画表头/不画空框。
  if (snap.nodes.length === 0) return [];
  const p = o.paint ?? PLAIN;
  const width = Math.max(1, o.width);

  const sel = pickSelected(snap.nodes, o.selected);
  if (!sel) return [];

  // ── 列宽随屏宽退让 (INV-DAG-4): 先丢时间条, 再丢 model。丢掉的列不留空位。
  const W = width - 4; // 4 = 帧预留 (后续接线片会套 `┃ … ┃`, 这里先留 4 列)
  const showBar = W >= 84;
  const showModel = W >= 70;
  const barW = showBar ? Math.min(22, Math.max(4, Math.floor(W * 0.2))) : 0;
  const idW = 11;
  const kindW = 11;
  const modelW = showModel ? 13 : 0;
  const durW = 7;

  const out: string[] = [];

  // ── 头行: run 标识 + done/total + 失败数 + 总用时
  const done = snap.nodes.filter((n) => n.status === 'done').length;
  const failed = snap.nodes.filter((n) => n.status === 'failed').length;
  const total = snap.nodes.length;
  const headerSegs: string[] = [p.accent(`run ${snap.runLabel ?? '?'}`)];
  headerSegs.push(p.dim(`${done}/${total}`));
  if (failed > 0) headerSegs.push(p.fail(`✗ ${failed}`));
  headerSegs.push(p.dim(fmtDur(o.now)));
  out.push(fitLine(headerSegs.join(' · '), width));

  // ── 表头 (对齐树行的列): kind / model / 用时 / 时间条刻度
  //    注: 时间条刻度**只画线不画文字**(SDD INV-DAG-2 GWT 禁止 `0s` 在输出里 —— 参考稿写的是
  //    `0s────32s`, 但契约 GWT 要求 pending-only 图整个输出不含 `0s`, 这里以契约为准)。
  const headSegs: string[] = [' '.repeat(4 + 2) + p.dim('kind'.padEnd(kindW - 1))];
  if (showModel) headSegs.push(' ' + p.dim('model'.padEnd(modelW - 1)));
  headSegs.push(' ' + p.dim('用时'.padStart(durW - 1)));
  if (showBar) headSegs.push(' ' + p.dim('─'.repeat(barW)));
  out.push(fitLine(headSegs.join(''), width));

  // ── 主体: 递归画树。`prefix` 是已经积累的左竖线。
  //    最后一根用 `└─`、其余用 `├─`,最后一个孩子的下一层前缀是 `  ` 而不是 `│ ` —— 这两处必须成对改。
  const byId = new Map(snap.nodes.map((n) => [n.id, n] as const));

  const emit = (n: TreeNode, depth: number, last: boolean): void => {
    const isSel = n.id === sel.id;
    // 选中标记 (INV-DAG-9: 结构信息不靠色, 用 `▸`)
    const selCell = isSel ? ` ${p.sel('▸')} ` : '   ';
    // 树枝
    const branch = depth === 0 ? '' : '  '.repeat(depth - 1) + (last ? '└─' : '├─');
    // 状态字形 + id
    const mark = DAG_MARK[n.status];
    const idCell = clip(n.id, idW - 1);
    // kind
    const kindCell = clip(n.kind, kindW - 1).padEnd(kindW - 1);
    // model (INV-DAG-2: 缺席画 `—`; TreeNode 当前不带 model 字段, 走防御式读取)
    const modelVal = (n as { model?: string }).model;
    const modelCell = modelVal && modelVal.length > 0 ? modelVal : '—';
    // 用时 (INV-DAG-2: pending → `—`, 不画 0s;running → 活秒数;done/failed/skipped → endAt - startAt)
    let durMs: number | null = null;
    if (n.status === 'running') {
      durMs = n.startAt !== null ? Math.max(0, o.now - n.startAt) : null;
    } else if (n.status !== 'pending') {
      if (n.durationMs !== undefined) durMs = Math.max(0, n.durationMs);
      else if (n.endAt !== null && n.startAt !== null) durMs = Math.max(0, n.endAt - n.startAt);
      else durMs = null;
    }
    const durText = n.status === 'pending' ? '—' : fmtDur(durMs);
    const durCell = durText.padStart(durW - 1);

    // 行组装
    const parts: string[] = [];
    parts.push(selCell);
    parts.push(branch);
    parts.push(`${mark} `);
    parts.push(isSel ? p.sel(idCell) : idCell);
    parts.push(' ');
    parts.push(kindCell);
    if (showModel) {
      parts.push(' ');
      parts.push(modelCell.length > modelW - 1 ? clip(modelCell, modelW - 1).padEnd(modelW - 1) : modelCell.padEnd(modelW - 1));
    }
    parts.push(' ');
    parts.push(durCell);
    // 时间条 (INV-DAG-3): 无 startAt 不画;有 startAt 无 endAt → 画到 now
    if (showBar && n.startAt !== null) {
      const start = n.startAt as number;
      const end = n.status === 'running' || n.endAt === null ? o.now : (n.endAt as number);
      const a = Math.max(0, Math.min(barW, Math.round((start / TIME_BAR_TOTAL_MS) * barW)));
      const span = Math.max(0, end - start);
      const w = Math.max(1, Math.min(barW - a, Math.round((span / TIME_BAR_TOTAL_MS) * barW)));
      parts.push(' ');
      parts.push(IDLE.repeat(a));
      parts.push('█'.repeat(w));
      parts.push(IDLE.repeat(Math.max(0, barW - a - w)));
    }
    // fan-in (INV-DAG-1): deps[0] 之外的依赖标行尾
    if (n.deps.length > 1) {
      parts.push(' ');
      parts.push(`╋ +${n.deps.slice(1).join(',')}`);
    }
    out.push(fitLine(parts.join(''), width));

    // ── 选中就地展开 (INV-DAG-5/6)
    if (isSel) {
      const ind = '       '; // 7 列缩进, 对齐到行内 id 起始列之后
      const innerW = Math.max(1, width - 8);

      // 判词 (INV-DAG-6): pass/fail 指被审对象, 不是闸本身
      const verdicts = n.verdicts ?? [];
      if (verdicts.length > 0 && n.status !== 'pending' && n.status !== 'running') {
        for (const v of verdicts) {
          const head = `${v.gate} 判 ${v.verdict}${v.reason ? `: ${v.reason}` : ''}`;
          for (const w of wrap(head, innerW)) {
            const markChar = v.verdict === 'fail' ? '✗' : '✓';
            const tint = v.verdict === 'fail' ? p.fail : p.ok;
            out.push(fitLine(`${ind}${markChar} ${tint(w)}`, width));
          }
        }
        // INV-DAG-6 的硬限: 展开里必须带这句限定
        out.push(fitLine(`${ind}  ${p.dim('判词的 pass/fail 指的是被审对象, 不是闸本身')}`, width));
      }

      // 失败原文 (INV-DAG-2: failureKind 缺席 → 不编 `[unclassified]`, 只画原文)
      if (n.status === 'failed' && n.failReason) {
        for (const w of wrap(n.failReason, innerW)) {
          out.push(fitLine(`${ind}${p.fail('✗')} ${p.fail(w)}`, width));
        }
      }

      // 上游失败节点 (INV-DAG-5)
      const upFail = n.deps
        .map((d) => byId.get(d))
        .filter((u): u is TreeNode => Boolean(u) && (u as TreeNode).status === 'failed');
      for (const u of upFail) {
        const reason = u.failReason ? `  ${clip(u.failReason, Math.max(0, innerW - 12))}` : '';
        out.push(
          fitLine(
            `${ind}${p.dim('上游')} ${p.fail(`✗ ${u.id}`)}${u.failReason ? p.dim(reason) : ''}`,
            width,
          ),
        );
      }

      // 下一步 (INV-DAG-5): 仅 failed / await 节点画;画出来但不接(SDD D-3)
      if (n.status === 'failed' || n.kind === 'await') {
        out.push(
          fitLine(
            `${ind}${p.accent('r')} 重跑并续图    ${p.accent('i')} 介入: 手改后标绿    ${p.accent('s')} 停图, 记进台账`,
            width,
          ),
        );
        out.push(fitLine(`${ind}  ${p.warn('(按键未接线)')}`, width));
      }
    }

    // 子树
    const kids = childrenOf(snap.nodes, n.id);
    kids.forEach((k, i) => emit(k, depth + 1, i === kids.length - 1));
  };

  const roots = childrenOf(snap.nodes, null);
  roots.forEach((r, i) => emit(r, 0, i === roots.length - 1));

  // ── 键位行
  out.push(
    fitLine(
      p.dim('↑↓ 选节点 · Enter 展开输出 · r/i/s 处理失败 · Ctrl+G 退出'),
      width,
    ),
  );

  // ── 高度封顶: 剪掉的说清剪了多少(与 renderFogLine / renderGantt 同形)
  if (out.length > o.height) {
    return [...out.slice(0, Math.max(1, o.height - 1)), `… ${out.length - o.height + 1} more lines`];
  }
  return out;
}
