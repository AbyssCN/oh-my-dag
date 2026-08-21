/**
 * scripts/fog-mockup —— Ctrl+P 散雾图**重画候选**的 HTML 稿生成器(2026-08-21)。
 *
 * ## 为什么是脚本而不是手画的 HTML
 *
 * owner 要的是「100% 能复刻在 TUI 里」的稿。手画的 ASCII art 给不了这个保证:
 * CJK 占 2 列、box-drawing 字形有没有被真终端量过、行会不会超宽 —— 三样都看不出来。
 * 所以这里**用 TUI 自己的两个真源**生成:
 *
 *   · 列宽 = `@earendil-works/pi-tui` 的 `visibleWidth`(TUI 排版用的就是它);
 *   · 字形 = `src/tui/render/glyph-table.ts` 的 `SAFE_GLYPH_WIDTHS` / `UNSAFE_GLYPHS`
 *     (`GROUND_TRUTH = true`,真终端量过)。
 *
 * 生成时逐行过闸:超宽 → 抛;用了白名单外的符号 → 抛。**稿子画得出来 = TUI 一定画得出来。**
 *
 * ## 用法
 *   bun run scripts/fog-mockup.ts            # 写 docs/design/2026-08-21-ctrl-p-重画三方案.html
 *   bun run scripts/fog-mockup.ts --check    # 只过闸不写文件(退出码即判据)
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS, GROUND_TRUTH } from '../src/tui/render/glyph-table';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WIDTH = 100;
const HEIGHT = 40;

// ── 色道: 与 src/tui/theme.ts 逐字对应 (Catppuccin Mocha)。稿里只许用这几道。 ──────────
const CH = {
  '': '#cdd6f4', // 默认前景 (P.text)
  a: '#89b4fa', // chrome.accent  = P.blue
  d: '#7f849c', // chrome.dim     = P.overlay1
  w: '#f9e2af', // chrome.warn    = P.yellow
  s: '#89dceb', // chrome.user    = P.sky   (选中态)
  b: '#89b4fa', // brand = 粗体 blue
} as const;
type Ch = keyof typeof CH;
/** 一段带色文本。TUI 侧就是 `paint.<道>(文本)`,所以稿与实装是一一对应的。 */
type Seg = [text: string, ch: Ch];
type Line = Seg[];

// ── 字形闸 ────────────────────────────────────────────────────────────────────────
/**
 * 白名单是**每个宽度类挑的代表字**(`你好世界,。:(】` 那几个 CJK 就是代表),
 * 不是穷举。所以这里分两档判:
 *   · CJK / 全角区 → 按类放行 (宽度 2, 与代表字同类);
 *   · ASCII 可打印 → 放行;
 *   · 其余**符号**(box-drawing / 块元素 / 箭头 / 几何形) → **必须逐个在 SAFE 里**。
 * 第三档才是会翻车的那一档 —— 也正是 `SAFE_GLYPH_WIDTHS` 存在的理由。
 */
const isWideCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
  (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
  (cp >= 0xff01 && cp <= 0xff60) || // 全角形式
  (cp >= 0x3400 && cp <= 0x4dbf);

function checkGlyphs(text: string, where: string): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (UNSAFE_GLYPHS.has(ch)) throw new Error(`${where}: 用了 UNSAFE 字形 U+${cp.toString(16)} ${JSON.stringify(ch)}`);
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (isWideCjk(cp)) continue;
    if (SAFE_GLYPH_WIDTHS.has(ch)) continue;
    throw new Error(`${where}: 字形 U+${cp.toString(16)} ${JSON.stringify(ch)} 不在 SAFE_GLYPH_WIDTHS —— 真终端没量过, 不许进稿`);
  }
}

const lineText = (l: Line): string => l.map(([t]) => t).join('');
const lineWidth = (l: Line): number => visibleWidth(lineText(l));

/** 逐行过闸: 宽度 + 字形。两条都是"稿子成立 = TUI 成立"的前提。 */
function gate(lines: Line[], name: string): Line[] {
  lines.forEach((l, i) => {
    const t = lineText(l);
    checkGlyphs(t, `${name} 第 ${i + 1} 行`);
    const w = lineWidth(l);
    if (w > WIDTH) throw new Error(`${name} 第 ${i + 1} 行超宽 ${w} > ${WIDTH}: ${JSON.stringify(t)}`);
  });
  if (lines.length > HEIGHT) throw new Error(`${name} 超高 ${lines.length} > ${HEIGHT}`);
  return lines;
}

// ── 排版小工具 ────────────────────────────────────────────────────────────────────
const pad = (l: Line, to: number, ch: Ch = ''): Line => {
  const gap = to - lineWidth(l);
  return gap > 0 ? [...l, [' '.repeat(gap), ch]] : l;
};

/**
 * CJK 感知 + **不劈开西文单词**的软换行。
 *
 * 按**列**断不按字符数断(CJK 占 2 列);西文/标识符整块搬 —— 稿的第一版把
 * `杀 boot 冻结` 断成 `杀 bo` / `ot 冻结`,那种断法在真终端上会被读成乱码。
 */
function wrap(text: string, cols: number): string[] {
  const tokens: string[] = [];
  let latin = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80 && ch !== ' ') latin += ch;
    else {
      if (latin) { tokens.push(latin); latin = ''; }
      tokens.push(ch);
    }
  }
  if (latin) tokens.push(latin);

  const out: string[] = [];
  let cur = '';
  for (const tk of tokens) {
    if (cur !== '' && visibleWidth(cur + tk) > cols) {
      out.push(cur.trimEnd());
      cur = tk === ' ' ? '' : tk;
    } else cur += tk;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out.length > 0 ? out : [''];
}

/** 一行内截断并补 `…`(只用在左栏这种**故意**给摘要的地方;正文一律换行不截断)。 */
function clipTo(text: string, cols: number): string {
  if (visibleWidth(text) <= cols) return text;
  let s = '';
  for (const ch of text) {
    if (visibleWidth(s + ch) > cols - 1) break;
    s += ch;
  }
  return s + '…';
}

/**
 * 地平线: 雾**只占一行**。
 *
 * 这是这次重画最硬的一条判断 —— 稿的第一版仍在画大片雾纹理(只是从马赛克改成了衰减噪点),
 * 而按本稿自己的版面预算,**雾的信息量是零**。零信息量的东西不配拿版面,淡噪点也是噪点。
 * 所以纹理全删,雾退成一条地平线 + 一个读数;**线以下的空白本身就是"未知"** ——
 * 那比任何抖动纹理都更诚实,也更好看。
 */
function horizon(cols: number, unruled: number): Line {
  const label = unruled > 0 ? ` 雾 · ${unruled} 张票未裁 ` : ' 全图已裁尽 ';
  const bar = cols - visibleWidth(label);
  const l = Math.floor(bar / 2);
  return [['┄'.repeat(Math.max(0, l)), 'd'], [label, 'd'], ['┄'.repeat(Math.max(0, bar - l)), 'd']];
}

// ── 数据 ─────────────────────────────────────────────────────────────────────────
interface Tk { id: string; type: 'task' | 'grill' | 'research' | 'prototype'; title: string; blocked?: boolean; run?: string }
interface Data { slug: string; destination: string; gens: { id: string; gist: string }[]; tickets: Tk[]; runs: number }

const MARK: Record<string, string> = { task: '●', grill: '◆', research: '◇', prototype: '○' };

/** 稀疏态 —— owner 第二张截图那张图 (1 票 0 裁决)。**旧设计正是在这一态崩的**。 */
const SPARSE: Data = {
  slug: 'omd-自主-goal-engine',
  destination:
    'OMD 自主 goal-engine:一个大 goal → 自主 research→spec→execute→review→增量迭代(Design A,OMD 自有 runtime),替代手动编排',
  gens: [],
  runs: 0,
  tickets: [
    {
      id: 'p0',
      type: 'task',
      title:
        'P0 模型解析统一:单 resolver + 单配置源 · 杀硬编码 deepseek(收进单一可配 defaultModel)· 杀 boot 冻结(config 变更同进程生效)',
    },
  ],
};

/** 饱和态 —— 今天开的 map #214 (11 open + 1 blocked + 1 ruled)。量"票多了会不会挤"。 */
const FULL: Data = {
  slug: '214 · OMD TUI 观测面',
  destination: 'OMD TUI 观测面:多 run 活图 HUD · 散雾图可见性 · 截图粘贴 · 音视频进 chat block',
  gens: [{ id: 'g1', gist: '判据 = 可复刻' }],
  runs: 2,
  tickets: [
    { id: '215', type: 'task', title: 'HudMirror 每 run 一文件 dag-<runId8>.json,修并发 run 互踩单文件', run: '78f1951c' },
    { id: '216', type: 'task', title: 'DagTree 快照模式 loadSnapshot():复用 read-api 同机直读盘 + fs.watch 活 tick' },
    { id: '217', type: 'grill', title: '散雾图呼吸动画做不做 + 动画约束怎么定(owner 口味)' },
    { id: '218', type: 'task', title: 'glyph 白名单重生成 → path-fog 换回重线族字形' },
    { id: '219', type: 'task', title: '剪贴板截图粘贴:平台探针 + Ctrl+O + .omd/attachments/ 存储' },
    { id: '220', type: 'grill', title: '音视频接受 ffmpeg + STT 端点外部依赖吗;v1 音频先行还是一起' },
    { id: '221', type: 'task', title: 'Ctrl+G 全屏 run 切换器', run: '78f1951c' },
    { id: '222', type: 'task', title: 'web 端 readDagView 改 per-run mirror 读取' },
    { id: '224', type: 'task', title: 'leaf-media 扩展音视频:MEDIA_REF_RE + collectDepMedia 同一变换' },
    { id: '223', type: 'task', title: 'media-ingest 管线(等 220 裁决)', blocked: true },
  ],
};

const stats = (d: Data): { pct: number; ruled: number; total: number; open: number; blocked: number } => {
  const total = d.gens.length + d.tickets.length;
  const blocked = d.tickets.filter((t) => t.blocked).length;
  return { pct: total > 0 ? Math.round((d.gens.length / total) * 100) : 0, ruled: d.gens.length, total, open: d.tickets.length - blocked, blocked };
};

/** 顶部读数条: `fog 8% ▏███░░░░░░░ 1/13`。gauge 用块元素, 全在白名单。 */
const gauge = (d: Data): Line => {
  const s = stats(d);
  const filled = Math.round((s.pct / 100) * 10);
  return [
    ['fog ', 'd'], [`${s.pct}%`, 'a'], [' ', 'd'],
    ['█'.repeat(filled), 'a'], ['░'.repeat(10 - filled), 'd'],
    [` ${s.ruled}/${s.total}`, 'd'],
  ];
};

// ══ 方案 A「地图卡」 ═══════════════════════════════════════════════════════════════
// 重线框把版面**关起来** —— 于是 1 票的图读成「留白」而不是「画崩了」。
// 卡永远撑满全高; 内容之下是空的, 空白就是雾。卡内最后一行是地平线读数。
function designA(d: Data): Line[] {
  const s = stats(d);
  const IN = WIDTH - 4; // 边框 `┃ ` + ` ┃`
  const body: Line[] = [];

  body.push([]);
  for (const t of wrap(d.destination, IN - 2)) body.push([[' ' + t, 'd']]);
  body.push([]);

  const rule = (label: string, right: string): Line => {
    const l: Line = [[' ' + label + ' ', 'a']];
    const bar = IN - visibleWidth(label) - 2 - (right ? visibleWidth(right) + 1 : 0);
    l.push(['─'.repeat(Math.max(0, bar)), 'd']);
    if (right) l.push([' ' + right, 'd']);
    return l;
  };

  body.push(rule('settled', d.gens.length > 0 ? `${d.gens.length} gen` : ''));
  if (d.gens.length === 0) body.push([['   (nothing ruled yet)', 'd']]);
  for (const g of d.gens) body.push([['   ✓ ', 'd'], [g.id, 'w'], ['   ' + g.gist, 'd']]);
  body.push([]);
  body.push(rule('frontier', `${s.open} open${s.blocked ? ` · ${s.blocked} blocked` : ''}`));
  body.push([]);

  // 一票一行 (id + 标记 + 全标题)。100 列下绝大多数标题一行装得下 —— 这是
  // 「票才是主体」那条预算的直接兑现。选中票额外把全文换行摊开 + 挂来源 run。
  d.tickets.forEach((t, i) => {
    const sel = i === 0;
    const ch: Ch = t.blocked ? 'w' : sel ? 's' : '';
    const head: Line = [[sel ? ' ▸ ' : '   ', ch], [t.blocked ? '×' : MARK[t.type]!, ch], ['  ', ''], [t.id, ch], ['  ', '']];
    const room = IN - lineWidth(head);
    if (sel) {
      const ws = wrap(t.title, room);
      head.push([ws[0]!, ch]);
      body.push(head);
      for (const w of ws.slice(1)) body.push([[' '.repeat(lineWidth(head) - visibleWidth(ws[0]!)) + w, ch]]);
      if (t.run) body.push([[' '.repeat(7) + '← run ' + t.run, 'd']]);
    } else {
      head.push([clipTo(t.title, room - (t.blocked ? 18 : 0)), t.blocked ? 'd' : '']);
      if (t.blocked) head.push(...pad([], Math.max(1, IN - lineWidth(head) - 16)), ['blocked by 220', 'w']);
      body.push(head);
    }
  });

  const head: Line = [['┏━ map ━ ', 'd'], [d.slug, 'b'], [' ', '']];
  const g = gauge(d);
  const tail: Line = [[' ', ''], ...g, [` · ${d.runs > 0 ? d.runs + ' runs' : 'no runs'} `, 'd'], ['━┓', 'd']];
  const out: Line[] = [[...head, ['━'.repeat(Math.max(0, WIDTH - lineWidth(head) - lineWidth(tail))), 'd'], ...tail]];

  // 卡内高度固定 = 全高 - 上下边框 - 键位行。内容之后留空, 倒数第二行放地平线。
  const inner = HEIGHT - 3;
  const room = inner - 2; // 地平线 + 它上面的空行
  const shown = body.length > room ? [...body.slice(0, room - 1), [['   … 还有 ' + (d.tickets.length - (room - 1 - (body.length - d.tickets.length))) + ' 张票, ↑↓ 翻', 'd']] as Line] : body;
  for (const l of shown) out.push([['┃ ', 'd'], ...pad(l, IN), [' ┃', 'd']]);
  for (let i = shown.length; i < inner - 1; i++) out.push([['┃', 'd'], ...pad([], WIDTH - 2), ['┃', 'd']]);
  out.push([['┃ ', 'd'], ...horizon(IN, s.total - s.ruled), [' ┃', 'd']]);
  out.push([['┗' + '━'.repeat(WIDTH - 2) + '┛', 'd']]);
  out.push([['↑↓ 选票 · Enter 动作 · Tab 换画法 · Ctrl+P 退出', 'd']]);
  return gate(out, '方案 A');
}

// ══ 方案 B「双栏」 ═════════════════════════════════════════════════════════════════
// 用**宽度**换纵深: 左票列 (摘要, 故意截断) + 右详情 (全文, 永不截断)。
// 详情栏永远有内容, 所以大屏不会空 —— 三个方案里唯一真正吃满宽屏的一版。
function designB(d: Data): Line[] {
  const s = stats(d);
  const L = 38;
  const R = WIDTH - L - 3;
  const left: Line[] = [];
  const right: Line[] = [];

  left.push([[' frontier ', 'a'], [`${s.open}`, ''], ...(s.blocked ? ([[` · ${s.blocked} blocked`, 'w']] as Line) : [])]);
  left.push([]);
  d.tickets.forEach((t, i) => {
    const sel = i === 0;
    const ch: Ch = t.blocked ? 'w' : sel ? 's' : '';
    const head = ` ${sel ? '▸' : ' '} ${t.blocked ? '×' : MARK[t.type]!} ${t.id} `;
    left.push([[head, ch], [clipTo(t.title, L - visibleWidth(head) - 1), t.blocked ? 'd' : sel ? 's' : 'd']]);
  });
  left.push([]);
  left.push([[' settled ', 'a'], [`${d.gens.length}`, '']]);
  if (d.gens.length === 0) left.push([['   (nothing ruled yet)', 'd']]);
  for (const g of d.gens) left.push([['   ✓ ', 'd'], [g.id, 'w'], ['  ' + g.gist, 'd']]);

  const t0 = d.tickets[0]!;
  right.push([[t0.id, 's'], [`   ${t0.type}   ·   ${t0.blocked ? 'blocked' : 'open'}`, 'd']]);
  right.push([]);
  for (const w of wrap(t0.title, R - 1)) right.push([[w, '']]);
  right.push([]);
  right.push([['blocked by   ', 'd'], [t0.blocked ? '220(未裁)' : '—', t0.blocked ? 'w' : 'd']]);
  right.push([['suggested    ', 'd'], [t0.run ? 'run ' + t0.run : '—', 'd']]);
  right.push([]);
  right.push([]);
  right.push([['destination', 'a']]);
  for (const w of wrap(d.destination, R - 1)) right.push([[w, 'd']]);

  const head: Line = [[' map ', 'd'], [d.slug, 'b'], ['   ·   ', 'd'], ...gauge(d), [`   ·   ${d.runs > 0 ? d.runs + ' runs' : 'no runs'}`, 'd']];
  const out: Line[] = [head];
  out.push([['┏' + '━'.repeat(L) + '┳' + '━'.repeat(R) + '┓', 'd']]);
  const rows = HEIGHT - 5;
  for (let i = 0; i < rows; i++) {
    out.push([['┃', 'd'], ...pad(left[i] ?? [], L), ['┃', 'd'], [' ', ''], ...pad(right[i] ?? [], R - 1), ['┃', 'd']]);
  }
  out.push([['┃', 'd'], ...pad([], L), ['┃', 'd'], [' ', ''], ...pad(horizon(R - 1, s.total - s.ruled), R - 1), ['┃', 'd']]);
  out.push([['┗' + '━'.repeat(L) + '┻' + '━'.repeat(R) + '┛', 'd']]);
  out.push([['↑↓ 选票 · Enter 动作 · Tab 换画法 · Ctrl+P 退出', 'd']]);
  return gate(out, '方案 B');
}

// ══ 方案 C「雾退线 v2」 ═══════════════════════════════════════════════════════════
// 不加边框, 纯排版层级 —— 最接近今天的实装, 也最贴 owner 2026-08-08「主 C」的构图裁决。
// 只修三处: 标题换行不截断 · 雾纹理全删换成一条地平线 · 读数与键位贴底。
function designC(d: Data): Line[] {
  const s = stats(d);
  const out: Line[] = [];
  out.push([['map ', 'd'], [d.slug, 'b'], ['   ', ''], ...gauge(d), [`   ${s.open} open`, 'd'],
    ...(s.blocked ? ([[` · ${s.blocked} blocked`, 'w']] as Line) : []), [` · ${d.runs > 0 ? d.runs + ' runs' : 'no runs'}`, 'd']]);
  for (const w of wrap(d.destination, WIDTH)) out.push([[w, 'd']]);
  out.push([]);

  out.push([['━━ settled ', 'a'], ['━'.repeat(WIDTH - 12), 'd']]);
  if (d.gens.length === 0) out.push([['   (nothing ruled yet)', 'd']]);
  for (const g of d.gens) out.push([['   ✓ ', 'd'], [g.id, 'w'], ['   ' + g.gist, 'd']]);
  out.push([]);
  const fLabel = ` ${s.open} open${s.blocked ? ` · ${s.blocked} blocked` : ''} `;
  out.push([['━━ frontier ', 'a'], ['━'.repeat(Math.max(0, WIDTH - 12 - visibleWidth(fLabel) - 4)), 'd'],
    [fLabel, 'd'], ['━━━━', 'd']]);
  out.push([]);

  d.tickets.forEach((t, i) => {
    const sel = i === 0;
    const ch: Ch = t.blocked ? 'w' : sel ? 's' : '';
    const head: Line = [[sel ? ' ▸ ' : '   ', ch], [t.blocked ? '×' : MARK[t.type]!, ch], ['  ', ''], [t.id, ch], ['  ', '']];
    const room = WIDTH - lineWidth(head);
    if (sel) {
      const ws = wrap(t.title, room);
      head.push([ws[0]!, ch]);
      out.push(head);
      for (const w of ws.slice(1)) out.push([[' '.repeat(lineWidth(head) - visibleWidth(ws[0]!)) + w, ch]]);
      if (t.run) out.push([[' '.repeat(7) + '← run ' + t.run, 'd']]);
    } else {
      head.push([clipTo(t.title, room - (t.blocked ? 18 : 0)), t.blocked ? 'd' : '']);
      if (t.blocked) head.push(...pad([], Math.max(1, WIDTH - lineWidth(head) - 14)), ['blocked by 220', 'w']);
      out.push(head);
    }
  });

  while (out.length < HEIGHT - 2) out.push([]);
  out.push(horizon(WIDTH, s.total - s.ruled));
  out.push([['↑↓ 选票 · Enter 动作 · Tab 换画法 · Ctrl+P 退出', 'd']]);
  return gate(out, '方案 C');
}

// ── HTML ─────────────────────────────────────────────────────────────────────────
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (lines: Line[]): string =>
  lines.map((l) => l.map(([t, c]) => (c ? `<span class="${c}">${esc(t)}</span>` : esc(t))).join('') || ' ').join('\n');

const ruler = (): string => {
  let a = '';
  for (let i = 0; i < WIDTH; i += 10) a += String(i).padEnd(10, ' ');
  return `<span class="ru">${esc(a.slice(0, WIDTH))}\n${esc('|123456789'.repeat(WIDTH / 10))}</span>`;
};

interface Card { id: string; name: string; lede: string; pros: string[]; cons: string[]; sparse: Line[]; full: Line[] }

const CARDS: Card[] = [
  {
    id: 'A', name: '地图卡', lede: '整张图关进一个重线框,卡永远撑满全高。空白被边框<b>关住</b> —— 于是 1 票的图读成「留白」,不是「画崩了」。卡内最后一行是地平线。',
    pros: ['稀疏态不塌 —— 这是旧设计唯一真正翻车的一态', '边框自带分组,不靠缩进硬撑层级', '一票一行 + 全标题,10 张票整屏读得完(见饱和态)'],
    cons: ['边框吃掉 4 列 + 2 行', '票极多时卡内要折叠(`… 还有 N 张票`)', '稀疏态仍有大片空白 —— 只是这次空白是<b>被框住的</b>'],
    sparse: designA(SPARSE), full: designA(FULL),
  },
  {
    id: 'B', name: '双栏', lede: '用**宽度**换纵深:左票列、右详情。详情栏永远有内容(全标题 / 依赖 / 来源 run / destination),所以大屏不会空。',
    pros: ['唯一真正用满宽屏的一版', '全标题不截断 —— 现在这条是最大痛点', '票多票少都撑得住,布局不随票数抖'],
    cons: ['左栏 38 列, 长标题仍是摘要 —— 但全文在右栏, 不算丢信息', '与稿的「雾退线」构图偏离最大(owner 2026-08-08 裁过主 C)'],
    sparse: designB(SPARSE), full: designB(FULL),
  },
  {
    id: 'C', name: '雾退线 v2', lede: '不加边框,纯排版层级 —— 最接近今天的实装。只修三处:标题换行不截断 · 雾纹理全删换成一条地平线 · 读数与键位贴底。',
    pros: ['离现状最近,改动面最小', '守住 owner 2026-08-08「主 C」的构图裁决', '没有边框,横向一列不浪费'],
    cons: ['稀疏态是一大片<b>没有边界的</b>空白 —— 三个里最像"画崩了"的一版', '宽屏下右半边基本闲着'],
    sparse: designC(SPARSE), full: designC(FULL),
  },
];

const sec = (c: Card): string => `
<h2>方案 ${c.id} 「${c.name}」</h2>
<p class="lede">${c.lede}</p>
<div class="cols">
  <div><h4 class="ok">留着的理由</h4><ul>${c.pros.map((x) => `<li>${x}</li>`).join('')}</ul></div>
  <div><h4 class="no">代价</h4><ul>${c.cons.map((x) => `<li>${x}</li>`).join('')}</ul></div>
</div>
<h3>稀疏态 · 1 票 0 裁决 <span class="tag">旧设计正是在这一态崩的</span></h3>
<div class="term"><div class="bar">${WIDTH}×${HEIGHT} · omd tui · Ctrl+P</div><pre>${toHtml(c.sparse)}</pre></div>
<h3>饱和态 · map #214,11 open + 1 blocked</h3>
<div class="term"><div class="bar">${WIDTH}×${HEIGHT} · omd tui · Ctrl+P</div><pre>${toHtml(c.full)}</pre></div>`;

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>Ctrl+P 散雾图重画 · 三方案</title>
<style>
  :root{--bg:#12141f;--bg2:#1a1d2c;--line:#2a2f45;--fg:#cdd6f4;--dim:#7f849c;--mute:#5c6178;
        --blue:#89b4fa;--sky:#89dceb;--yellow:#f9e2af;--green:#a6e3a1;--red:#f38ba8;
        --mono:'JetBrains Mono','Cascadia Mono','Noto Sans Mono CJK SC',Consolas,monospace}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,'Noto Sans CJK SC',sans-serif}
  main{max-width:1180px;margin:0 auto;padding:44px 26px 90px}
  h1{font-size:28px;margin:0 0 6px}h1 span{color:var(--blue)}
  h2{font-size:22px;margin:60px 0 12px;padding-bottom:9px;border-bottom:1px solid var(--line);color:var(--blue)}
  h3{font-size:15px;margin:26px 0 9px;color:var(--sky);font-weight:600}
  h4{font-size:13px;margin:0 0 6px;letter-spacing:.04em}
  h4.ok{color:var(--green)}h4.no{color:var(--yellow)}
  p{margin:9px 0}.lede{color:var(--dim)}
  ul{margin:0;padding-left:19px;color:var(--dim);font-size:14px}li{margin:3px 0}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin:16px 0 4px}
  .note{border-left:3px solid var(--blue);background:var(--bg2);padding:11px 15px;margin:16px 0;color:var(--dim);font-size:14px}
  .note.warn{border-left-color:var(--yellow)}.note.good{border-left-color:var(--green)}
  .note b{color:var(--fg)}
  code{font:13px var(--mono);color:var(--sky)}
  .tag{font:11px var(--mono);color:var(--yellow);border:1px solid var(--line);border-radius:3px;padding:1px 6px;margin-left:6px;vertical-align:1px}
  .term{background:#1e1e2e;border:1px solid var(--line);border-radius:7px;overflow:hidden;margin:10px 0 26px}
  .term .bar{background:#181825;border-bottom:1px solid var(--line);padding:5px 12px;font:11px var(--mono);color:var(--mute)}
  .term pre{margin:0;padding:14px 16px;font:12.5px/1.35 var(--mono);white-space:pre;overflow-x:auto;color:#cdd6f4;
            font-variant-ligatures:none;font-feature-settings:"liga" 0}
  .a{color:${CH.a}}.d{color:${CH.d}}.w{color:${CH.w}}.s{color:${CH.s}}.b{color:${CH.b};font-weight:700}
  .ru{color:#3d4258}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
  td,th{border:1px solid var(--line);padding:7px 11px;text-align:left;vertical-align:top}
  th{background:var(--bg2);color:var(--sky);font-weight:600}
</style>
<main>
<h1>Ctrl+P 散雾图 <span>重画三方案</span></h1>
<p class="lede">2026-08-21 · 起因:owner 两张截图 —— 先是整屏马赛克,封顶后又变成一片空洞。两次都是**同一个根因**。</p>

<div class="note warn"><b>根因(不是渲染 bug,是设计判断错了)</b><br>
旧实装把雾「撑满剩余高度」(<code>path-fog.ts</code> 原注释:稿里雾是大面积的,三行雾读不出体量)。
可雾携带的信息只有<b>一个标量</b> —— fog%,而底部读数条已经印过它。于是屏幕 85% 在重复一个数字,
真正随票数增长的信息(票标题)反被压在前沿线上缩到 8 个字。<br>
<b>判据</b>:版面份额该按<b>信息量</b>分,不按隐喻分。</div>

<div class="note good"><b>这份稿 100% 能复刻在 TUI 里 —— 这句话是验出来的,不是声明的</b><br>
稿子不是手画的,是 <code>scripts/fog-mockup.ts</code> 用 TUI <b>自己的两个真源</b>生成的:<br>
· 列宽 = <code>@earendil-works/pi-tui</code> 的 <code>visibleWidth</code>(TUI 排版用的就是它,CJK 按 2 列算);<br>
· 字形 = <code>src/tui/render/glyph-table.ts</code> 的 <code>SAFE_GLYPH_WIDTHS</code>(<code>GROUND_TRUTH = ${GROUND_TRUTH}</code>,真终端量过)。<br>
生成时逐行过闸:<b>超宽抛、白名单外的符号抛</b>。<code>bun run scripts/fog-mockup.ts --check</code> 退出码即判据。<br>
色只用 <code>theme.ts</code> 的四道:<span class="a">accent</span> · <span class="d">dim</span> · <span class="w">warn</span> · <span class="s">user/选中</span>。</div>

<div class="note"><b>顺带一个过期前提</b><br>
<code>path-fog.ts</code> 头部记着「重线族 <code>━ ┄ ┃ ◉ ▼ ⛓</code> 字形闸判 unmeasured」,票 #218 也是照这条开的。
实况:六个<b>全都已在白名单里</b>且 <code>GROUND_TRUTH = true</code>(歧义档已裁决完)。所以本稿直接用了重线族,
#218 的阻塞前提已经不成立。</div>

<h2>版面预算(三方案共用的判据)</h2>
<table>
<tr><th>元素</th><th>信息量</th><th>该占多少</th></tr>
<tr><td>票标题</td><td>随票数增长,是这屏唯一的主体</td><td><b>大头</b> —— 且不许截断</td></tr>
<tr><td>destination</td><td>一段定长文本</td><td>2–3 行,<b>换行不省略号</b></td></tr>
<tr><td>settled 地层</td><td>随裁决数增长</td><td>中等,可折叠</td></tr>
<tr><td>fog%</td><td><b>一个标量</b></td><td>一条 gauge,10 列</td></tr>
<tr><td>雾纹理</td><td><b>零</b></td><td><b>删掉</b> —— 退成一条地平线 + 读数;线以下的空白本身就是"未知"</td></tr>
</table>

<h3>列标尺(对齐自查用)</h3>
<div class="term"><div class="bar">${WIDTH} 列</div><pre>${ruler()}</pre></div>
${CARDS.map(sec).join('\n')}

<h2>我的推荐</h2>
<div class="note good"><b>选 A「地图卡」。</b><br>
理由只有一条,但是决定性的:旧设计唯一真正翻车的是<b>稀疏态</b>(1 票 / 40 行屏),
而 A 是三个里唯一<b>从结构上</b>解决它的 —— 边框把空白关住,空白就从「画崩了」变成「留白」。
C 保住了 owner 2026-08-08「主 C」的构图裁决,但它的稀疏态是一大片<b>没有边界</b>的空白,
问题只是从"太吵"换成了"太空";B 最好用,可它偏离那条构图裁决最远,<b>值得单开一张票裁,不该夹在修 bug 里做</b>。<br>
<b>代价说清楚</b>:A 吃掉 4 列 + 2 行边框;票极多时卡内要折叠;稀疏态仍有大片空白,只是这次被框住了。</div>

<div class="note warn"><b>这份稿推翻了它自己的第一版 —— 记下来,不静默</b><br>
第一版三个方案都还画着大片雾纹理,只是把「马赛克」改成了「衰减到 0 的噪点」。
生成出来一看:<b>淡噪点也是噪点</b>。而本页自己的版面预算写着「雾的信息量 = 零」——
零信息量的东西不配拿版面,那条判据同样适用于淡的。于是纹理全删,雾退成一条地平线 + 一个读数。<br>
<b>教训</b>:把隐喻(fog-of-war)当成必须画出来的东西,是这个视图两次翻车的<b>同一个</b>根因。</div>

<div class="note"><b>还没定、留给 owner 的两处</b><br>
· <b>#217</b>(已在图上):雾要不要呼吸。本稿三个方案<b>都是静态的</b> —— 没替你预设。<br>
· 卡内票的选中态:现在是 <code>▎</code> 竖条 + sky 色。要不要改成整行反色,是口味,顺 #217 一起裁。</div>
</main></html>`;

if (process.argv.includes('--check')) {
  console.log(`✓ 三方案 × 两态 全过闸 (宽度 ≤ ${WIDTH}, 字形全在 SAFE_GLYPH_WIDTHS, GROUND_TRUTH=${GROUND_TRUTH})`);
} else {
  const out = join(import.meta.dir, '..', 'docs', 'design', '2026-08-21-ctrl-p-散雾图重画三方案.html');
  writeFileSync(out, html);
  console.log(`✓ ${out}`);
  console.log(`✓ 全过闸: 宽度 ≤ ${WIDTH} · 字形全在 SAFE_GLYPH_WIDTHS · GROUND_TRUTH=${GROUND_TRUTH}`);
}
