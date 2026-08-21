/**
 * scripts/tui-frames —— omd TUI 视觉系统的**帧引擎**(2026-08-21)。
 *
 * ## 一份代码, 两个消费者
 *
 * 这个文件是纯 JS、零依赖, 因为它要同时跑在两个地方:
 *   ① 构建时 —— `scripts/tui-design-system.ts` import 它, 把每一屏 × 每一态渲染一遍,
 *      逐行过**字形闸 + 宽度闸**, 并把本文件的 `vw()` 与 pi-tui 真正的 `visibleWidth`
 *      在**实际用到的每一个字符串上**对账。对不上 → 构建抛, 稿出不来。
 *   ② 浏览器里 —— 设计稿把本文件原样内联进 `<script>`, 模拟器实时调同样的函数。
 *
 * 于是「稿里画得出来 = TUI 画得出来」不是声明, 是**同一份代码跑了两遍**。
 *
 * ## 三条不许违反的纪律 (survey 摘自各组件文件头, 都有闸)
 *   ① **无源恒缺席**: 没数据就返回 [], 绝不画空框 / 0% 条。
 *   ② **NULL ≠ 0 ≠ 不适用**: 缺时长不写 `0s`, 缺起点写「起点未记」。
 *   ③ **结构信息不许只靠颜色**: 选中用 `▸`、stale 用 `✗ STALE` 文字。
 *      关色 (NO_COLOR) 下重拼必须逐字节等于原行 —— 模拟器的「关色」开关就是这条的活闸。
 */

// ══ 宽度 ══════════════════════════════════════════════════════════════════════════
// 与 pi-tui `visibleWidth` 对账过 (构建时逐字符串比对, 不一致就抛)。
// 只处理本稿真正会遇到的三类: ANSI 转义(稿里没有) / 宽字符 2 列 / 其余 1 列。
export function vw(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue; // ZWJ / 组合符号 0 列
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

// ══ 字形表 ════════════════════════════════════════════════════════════════════════
/**
 * 全部取自 `src/tui/render/glyph-table.ts` 的 safe 档 (GROUND_TRUTH=true,
 * 2026-08-08 量于 Windows Terminal + JetBrainsMono Nerd Font Mono)。
 *
 * ⚠ **升级点**: 重线族 `━ ┃ ┏ ┓ ┗ ┛ ┣ ┳ ┻ ╋`、`┄ ┅`、圆角 `╭╮╰╯`、`◉ ▼ ▲ ⛓ ◌`
 * 早已在 safe 档, 而 `path-fog.ts` 头注仍写着「待量」并在用降级的 `─ · ↓ ●`。本系统直接升级。
 */
export const G = {
  // 重框 = 全屏主容器
  tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', tj: '┳', bj: '┻', lj: '┣', rj: '┫', x: '╋',
  // 轻线 = 屏内分区
  lh: '─', lv: '│', ltl: '┌', ltr: '┐', lbl: '└', lbr: '┘', llj: '├', lrj: '┤',
  // 虚线 = 未知的边界 (地平线)
  dh: '┄',
  // 块 = 量
  full: '█', shade: '░', half: '▒',
  // 箭头
  right: '→', left: '←', up: '↑', down: '↓',
  // 记号
  sel: '▸', ok: '✓', fail: '✗', dot: '·', warn: '⚠', star: '★', times: '×', ell: '…',
};

/**
 * DAG 节点五态。**五态五个样子** —— 合并任意两个,「卡住了」与「还没轮到」就分不开
 * (survey §7.1 的原话)。今天 `dag-tree` 的 running 用 `·`, 与 `dot` 撞且太弱 → 升级成 `◉`。
 */
export const NODE_MARK = { pending: '○', running: '◉', done: '✓', failed: '✗', skipped: '─' };
/** 状态 → 色道。`failed` 走 red 不走 yellow —— 见下面 CHANNELS 的语义分工。 */
export const NODE_CH = { pending: 'dim', running: 'accent', done: 'ok', failed: 'fail', skipped: 'dim' };

/** 票类型 (pathfinder)。与 `render/path-fog.ts:34` 的 TICKET_MARK 同域。 */
export const TICKET_MARK = { task: '●', grill: '◆', research: '◇', prototype: '○' };

/**
 * run 看板三态。⚠ **修一个现存字形闸违规**: `run-board.ts:40` 用的 `⏳`(U+23F3)
 * 在 `UNSAFE_GLYPHS` 里 (emoji, 各终端宽度分歧最大)。换成 `◌`(U+25CC, safe 档) ——
 * 「虚线圈」本身就读作「悬着、还没落」, 语义比沙漏更准。
 */
export const RUN_MARK = { live: '▶', published: '↑', awaiting: '◌' };

// ══ 色道 ══════════════════════════════════════════════════════════════════════════
/**
 * 七道, **全部已存在于 `theme.chrome`, 零新增 token**。
 * 语义分工按 PRODUCT.md 的定位句排:「omd 把**哪一件事在等你**放在最亮处」。
 *
 *   sel    等你裁 / 当前选中   —— 全屏最亮
 *   accent 在动 (running / 头行 / 前沿)
 *   (默认) 事实内容 (标题、节点名)
 *   dim    结构与已结的账 (框线、地层、done 的时长)
 *   warn   卡住了但不是失败 (blocked / waiting / stale)
 *   ok     过了       fail  没过
 *
 * ⚠ **统一一处现存不一致**: `dag-tree` 把 failed 画成 warn(黄), `ticket-board` 把 STALE
 * 画成 toolFail(红)。本系统钉死: **红 = 引擎判的终局失败, 黄 = 需要人介入**。两件事。
 */
export const CHANNELS = ['', 'a', 'd', 'w', 's', 'ok', 'fail', 'b'];
export const PALETTE = {
  mocha: { '': '#cdd6f4', a: '#89b4fa', d: '#7f849c', w: '#f9e2af', s: '#89dceb', ok: '#a6e3a1', fail: '#f38ba8', b: '#89b4fa', bg: '#1e1e2e' },
  latte: { '': '#4c4f69', a: '#1e66f5', d: '#8c8fa1', w: '#df8e1d', s: '#04a5e5', ok: '#40a02b', fail: '#d20f39', b: '#1e66f5', bg: '#eff1f5' },
};

// ══ 排版原语 ══════════════════════════════════════════════════════════════════════
export { padS, padSL };
export const lineText = (l) => l.map((sg) => sg[0]).join('');
export const lineW = (l) => vw(lineText(l));

/** 补空格到 `to` 列。 */
export const pad = (l, to) => {
  const gap = to - lineW(l);
  return gap > 0 ? [...l, [' '.repeat(gap), '']] : l;
};

/** CJK 按列断 + **西文整词搬**。断在单词中间在真终端上会被读成乱码。 */
export function wrap(text, cols) {
  if (cols <= 1) return [text];
  const toks = [];
  let lat = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 && ch !== ' ') lat += ch;
    else { if (lat) { toks.push(lat); lat = ''; } toks.push(ch); }
  }
  if (lat) toks.push(lat);
  const out = [];
  let cur = '';
  for (const t of toks) {
    if (cur !== '' && vw(cur + t) > cols) { out.push(cur.trimEnd()); cur = t === ' ' ? '' : t; }
    else cur += t;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out.length ? out : [''];
}

/**
 * **列感知**的补白 —— 顶掉 `String.padEnd` / `padStart`。
 *
 * ⚠ 这是本仓的老坑, `render/table.ts` 头注专门记过:「全走 `visibleWidth`, 不用 `.length`」。
 * `padEnd` 数的是**字符**: `'你'.padEnd(5)` 给 5 个字符 = **6 列**, 而 `'omd'.padEnd(5)` 是 5 列,
 * 于是含 CJK 的那一列整体错开一格。**而三道闸一条都抓不到它** —— 行没超宽、字形也合法,
 * 只有人眼看得见 (2026-08-21 实测: 全景屏的 `你`/`omd` 与 palette 的 `收件箱`/`会话` 都错了位)。
 * 所以另加了第四道闸: 构建器扫屏源码, 出现 `.padEnd(` / `.padStart(` 就抛。
 */
const padS = (text, cols) => text + ' '.repeat(Math.max(0, cols - vw(text)));
const padSL = (text, cols) => ' '.repeat(Math.max(0, cols - vw(text))) + text;

/** 截断补 `…`。**只用在明确的摘要列**;正文一律换行不截断。 */
export function clip(text, cols) {
  if (vw(text) <= cols) return text;
  let s = '';
  for (const ch of text) { if (vw(s + ch) > cols - 1) break; s += ch; }
  return s + G.ell;
}

/** `━━ label ━━━━━━━━ right ━━` 分区线。底部块用它替代边框。 */
export function rule(label, right, cols, heavy = true) {
  const bar = heavy ? G.h : G.lh;
  const head = `${bar}${bar} ${label} `;
  const tailTxt = right ? ` ${right} ${bar}${bar}` : '';
  const mid = Math.max(0, cols - vw(head) - vw(tailTxt));
  const l = [[head, 'a'], [bar.repeat(mid), 'd']];
  if (right) l.push([tailTxt, 'd']);
  return l;
}

/** 量条 `████░░░░░░ 6/12`。**统一成 `█░` 一套** —— statusbar 的 `#-` 是现存不一致。 */
export function bar(done, total, cells = 12) {
  const f = total > 0 ? Math.round((done / total) * cells) : 0;
  return [[G.full.repeat(f), 'a'], [G.shade.repeat(cells - f), 'd'], [` ${done}/${total}`, 'd']];
}

/** 地平线: 未知的边界。线以下的空白**本身就是未知** —— 不画纹理。 */
export function horizon(cols, label) {
  const t = ` ${label} `;
  const n = Math.max(0, cols - vw(t));
  const l = Math.floor(n / 2);
  return [[G.dh.repeat(l), 'd'], [t, 'd'], [G.dh.repeat(n - l), 'd']];
}

/** 时长。**NULL ≠ 0**: 没有就返回 null, 由调用方画「—」, 绝不画 `0s`。 */
export function dur(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** 重框容器: 给内容行加 `┃ … ┃`, 撑到 h 行, 头行嵌标题与右侧读数。 */
export function frame(titleSegs, rightSegs, body, w, h, footerSegs) {
  const head = [[G.tl + G.h + ' ', 'd'], ...titleSegs, [' ', '']];
  const tail = [[' ', ''], ...rightSegs, [' ' + G.h + G.tr, 'd']];
  const mid = Math.max(0, w - lineW(head) - lineW(tail));
  const out = [[...head, [G.h.repeat(mid), 'd'], ...tail]];
  const inner = h - 2 - (footerSegs ? 1 : 0);
  const shown = body.length > inner ? [...body.slice(0, inner - 1), [[`   ${G.ell} 还有 ${body.length - inner + 1} 行, ${G.up}${G.down} 翻`, 'd']]] : body;
  for (const l of shown) out.push([[G.v + ' ', 'd'], ...pad(l, w - 4), [' ' + G.v, 'd']]);
  for (let i = shown.length; i < inner; i++) out.push([[G.v, 'd'], ...pad([], w - 2), [G.v, 'd']]);
  if (footerSegs) out.push([[G.v + ' ', 'd'], ...pad(footerSegs, w - 4), [' ' + G.v, 'd']]);
  out.push([[G.bl + G.h.repeat(w - 2) + G.br, 'd']]);
  return out;
}

/** 键位行(每屏最后一行)。 */
export const keys = (txt) => [[txt, 'd']];
