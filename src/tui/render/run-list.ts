/**
 * src/tui/render/run-list —— **活图列表**(SDD 片 4 切片 2,票 #221)。
 *
 * 渲染器入口:`renderRunList(views, o)`。数据来自**磁盘分片** (`src/hud/load.ts` 的
 * `readDagShards`) —— 这是整片存在的理由:`run`/`research` 恒 detached, 进程内订阅
 * 在生产上基本是空的, 而这个列表画的是**盘上有什么**, 与哪个进程无关。
 *
 * ## 三态三个记号 (INV-DAG-9 的活图版)
 *
 * | phase     | 字形 | 语义                              | 色道  |
 * |-----------|------|-----------------------------------|-------|
 * | `live`    | `▶`  | 正在跑 (age ≤ RUNNING_TTL)         | accent |
 * | `stalled` | `◌`  | 超 TTL 无更新 (server 疑似崩)       | warn   |
 * | `finished`| `↑`  | 终态展示窗内 (done/failed/cancelled) | ok     |
 *
 * 三态三个记号 —— 与 `dag-tree` 的五态五字形同一条纪律 (合并就分不开)。
 *
 * ## 无源恒缺席 (INV-DAG-8)
 *
 * `views` 空 / `[]` → `renderRunList` 返回 `[]`, **不画表头、不画 `0 runs` 的空框**。
 * 同样的语义: 画一个空框会让人以为"有个 run 但没动"。
 *
 * ## NULL ≠ 0 ≠ 不适用 (INV-DAG-2)
 *
 * - `ageMs === Infinity` (坏时戳) → 行里画 `起点未记`, **不**编一个 `0m` 充数。
 * - `views.length === 0` → 返回 `[]`, **不**画 `0 活 · 0 产出 · 0 等`。
 * - 老快照没 `planned` (老 mirror 没记) → `total = 0`, 行里画 `—/—`, **不**画 `0/0`。
 *
 * ## 选中就地展开 (slice 2 适配版)
 *
 * 选中行下面挂两行: 全 goal + 键位提示。这与 DAG 屏的"判词/下一步"不同 ——
 * 活图列表没有失败原文也没有下一步可推 (那是 `DagTree` 的事), 只把截断的 goal 露全。
 *
 * ## 不用 `tui-frames.mjs` 的 `frame()`
 *
 * 那一层是稿件/HTML 渲染器双跑的设计稿语言 (`runScreen` 引用它) —— 这边的目标是
 * `string[]` 给 tui.ts 直接用, 走 `fitLine` 一条线。结构上仍照 `path-fog.ts`
 * 的纯函数 + 注入 paint 模式。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DagView, DagPhase } from '../../hud/load';
import { fitLine } from './line';

/** 色道钩子, 与 `FogPaint` 同形加 `ok` / `fail` —— 注入式, 省略 = 恒等 (NO_COLOR / 测试)。 */
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

/**
 * 活图三态记号。三态三形, 全在白名单 (scripts/tui-frames.mjs 的 G.OK/FAIL/DOT + U+25CC ◌)。
 *
 * ⚠ **不与 NODE_MARK 共享**: 那是节点五态 (`pending/running/done/failed/skipped`),
 *    与这里的活图三态 (`live/stalled/finished`) 是两层不同维度。混用 `running` 字形
 *    会把"节点在跑"和"run 在跑"读成同义, 而这正是这条屏要分开看的。
 */
export const RUN_MARK: Record<DagPhase, string> = {
  live: '▶',
  stalled: '◌',
  finished: '↑',
};

/**
 * 列宽常量。runId 列固定 8 (与片 3 的 `dag-<runId8>.json` 文件名同源), progress 列固定 5
 * (留 `XX/XX` 加 1 个右侧空格), age 列固定 9 (够塞 `12m30s`)。
 *
 * 不动这些数 → 切换窄屏时行尾 goal 跟着缩水, 不会"丢列变错位"。
 */
const W_SEL = 2;        // `▸ ` / `  `
const W_MARK = 2;       // `▶ ` / `◌ ` / `↑ `
const W_RUNID = 9;      // `XXXXXXXX `
const W_PROG = 5;       // `XX/XX `
const W_AGE = 9;        // `12m30s  ` / `起点未记 `
const FIXED = W_SEL + W_MARK + W_RUNID + W_PROG + W_AGE; // 27

/** 可见列感知的右补白。CJK 列宽 = 2, 西文 = 1 —— 顶掉 `.padEnd`。 */
const padS = (text: string, cols: number): string =>
  text + ' '.repeat(Math.max(0, cols - visibleWidth(text)));

/** 时长。`Infinity` (坏时戳) → null —— 调用方画「起点未记」, 不画 `0m` / `Infinitym`。 */
const fmtAge = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
};

/** 截断补 `…`;只用于 goal 摘要列, 正文不走这条。 */
const clip = (text: string, cols: number): string => {
  if (cols <= 0) return '';
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return '…';
  let out = '';
  for (const ch of text) {
    if (visibleWidth(out + ch) > cols - 1) break;
    out += ch;
  }
  return out + '…';
};

/**
 * 节点进度: `(已 settle 数) / (planned + 还活着的 started)`。
 *
 * 之所以**不全用 `planned.length`**: 老快照可能漏报 planned (这是数据面的实情,
 * 详见 `mirror.ts:INV-HUD-5`), 此刻 settled 是真发生过的, started 是真还活着的,
 * 三者合并 = 这一刻看得见的全部节点;拿这个当分母比单算 `planned.length` 稳。
 *
 * 全空 → `null` (调方画 `—/—`); done=0, total=0 不会出现在列表里(会被 INV-HUD-8 收回)。
 */
function progressOf(view: DagView): { done: number; total: number } | null {
  const snap = view.snap;
  const total = snap.planned.length + snap.started.length;
  if (total === 0) return null;
  const done = snap.settled.length;
  return { done, total };
}

/** 折叠高度溢出:头 kept + 「… N more」 + 尾 3 (chrome 贴底)。 */
const clampHeight = (out: string[], height: number, width: number, p: DagPaint): string[] => {
  if (out.length <= height) return out;
  if (height <= 3) return out.slice(0, height);
  const tail = out.slice(-3);
  const kept = Math.max(0, height - tail.length - 1);
  return [...out.slice(0, kept), p.dim(fitLine(`… ${out.length - height + 1} more`, width)), ...tail];
};

/**
 * 画一行。选中 → 整行 sel;否则各列走自己的色道(选 mark 的相位色, 其余 dim)。
 * 进度列在 done === total 时走 ok(终态), 否则 dim —— 视觉上"跑完了"自带绿勾。
 */
function renderRow(
  view: DagView,
  selected: boolean,
  width: number,
  p: DagPaint,
): string {
  const selMark = selected ? '▸ ' : '  ';
  const phaseMark = RUN_MARK[view.phase] + ' ';
  const runId = padS(view.snap.runId.slice(0, 8), W_RUNID - 1) + ' ';
  const prog = progressOf(view);
  const progStr = prog ? `${prog.done}/${prog.total}` : '—/—';
  const progPad = padS(progStr, W_PROG - 1) + ' ';
  // NULL ≠ 0: 坏时戳 → "起点未记" (warn), 否则 dim。
  const ageStr = fmtAge(view.ageMs) ?? 'start not recorded';
  const agePad = padS(ageStr, W_AGE - 1) + ' ';
  const goalCols = Math.max(0, width - FIXED);
  const goal = clip(view.snap.goal, goalCols);

  const line = `${selMark}${phaseMark}${runId}${progPad}${agePad}${goal}`;
  if (selected) return p.sel(fitLine(line, width));
  // 非选中行: mark 走相位色, 其余 dim (整行 dim 也可读;但 mark 走相位色让"哪个是活"
  // 在扫视时先看到)。
  const phasePaint =
    view.phase === 'live' ? p.accent : view.phase === 'stalled' ? p.warn : p.ok;
  const head = `${selMark}${phaseMark}${runId}`;
  const rest = `${progPad}${agePad}${goal}`;
  return fitLine(phasePaint(head) + p.dim(rest), width);
}

/**
 * 选中行的就地展开:
 *   ① 全 goal (主行被截掉的尾巴在这露) —— 选中时画。
 *   ② 键位提示 `Enter 进这张图` —— 始终画, 明说"按了进图"。
 *
 * 切片 2 没做"判词/上游失败"展开 (那是 DAG 屏的活), 也不写 `r`/`i`/`s` 提示
 * (D-3: 只画不接, 不在本片)。
 */
function renderSelectedDetail(
  view: DagView,
  width: number,
  p: DagPaint,
): string[] {
  const indent = '  '; // 对齐主行 runId 起点 (W_SEL + W_MARK = 4 → 视觉上 2 个 space 就够)
  const goalCols = Math.max(1, width - indent.length * 2);
  const goalWrap = clip(view.snap.goal, goalCols);
  const keysHint = p.dim(`${indent}${indent}Enter enters`);
  return [p.dim(fitLine(`${indent}goal`, width)), p.dim(fitLine(`${indent}${goalWrap}`, width)), fitLine(keysHint, width)];
}

/**
 * 头行 + 右侧计数。
 *
 * 三态三计数:`X 活 · Y 产出 · Z 等`。`0` 不省略 —— "现在 0 活"是真值,与"列表空"
 * 不同: 列表空直接走 INV-DAG-8 的早返回,根本不到这一步; 到了这一步说明至少有
 * 一份分片, 那 `0 活` 也比省略更可读。
 */
function renderHeader(views: readonly DagView[], width: number, p: DagPaint): string {
  let live = 0, finished = 0, stalled = 0;
  for (const v of views) {
    if (v.phase === 'live') live++;
    else if (v.phase === 'finished') finished++;
    else stalled++;
  }
  const left = p.accent('run');
  const mid1 = p.accent(` ${live} live`);
  const mid2 = p.dim(' · ');
  const mid3 = p.ok(` ${finished} published`);
  const mid4 = p.dim(' · ');
  const mid5 = p.warn(` ${stalled} waiting`);
  return fitLine(left + mid1 + mid2 + mid3 + mid4 + mid5, width);
}

/** 底部键位行。`数据源 = 磁盘分片` 写在这里 —— 别的进程跑的 run 也画得出来。 */
function renderKeysLine(width: number, p: DagPaint): string {
  return p.dim(fitLine('up/down picks a run · Enter enters · Ctrl+G exits · source = .omd/hud/dag-*.json', width));
}

/**
 * 活图列表渲染器。
 *
 * @param views    `readDagShards` 返回的视图列表 (空数组 → `[]`)
 * @param o.width  屏宽 (可见列, CJK = 2)
 * @param o.height 屏高;超出 → 头 kept + 「… N more」 + 尾 3 (keys 贴底)
 * @param o.selected 当前选中索引 (负数 / 超界 → 自动 mod)
 * @param o.now    当前 ms (注入, 防 `Date.now()` 跑单测时漂移;本渲染器主用在 head/age, age 主要用 view.ageMs)
 * @param o.paint  色道钩子;省略 = 恒等 (NO_COLOR 与测试)
 */
export function renderRunList(
  views: readonly DagView[],
  o: { width: number; height: number; selected: number; now: number; paint?: DagPaint },
): string[] {
  // INV-DAG-8: 无源恒缺席 —— 一份分片都没有 → [];不画表头, 不画 `0 runs` 空框。
  if (views.length === 0) return [];
  const p = o.paint ?? PLAIN;
  const width = o.width;
  const len = views.length;
  const sel = ((o.selected % len) + len) % len;
  const out: string[] = [renderHeader(views, width, p)];
  for (let i = 0; i < len; i++) {
    out.push(renderRow(views[i]!, i === sel, width, p));
    if (i === sel) out.push(...renderSelectedDetail(views[i]!, width, p));
  }
  out.push(renderKeysLine(width, p));
  return clampHeight(out, o.height, width, p);
}
