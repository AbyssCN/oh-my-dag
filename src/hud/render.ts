/**
 * src/hud/render — omd-hud 多行 HUD 渲染 (纯函数)。
 *
 * 三态:
 *   DAG live     → ⚡header(进度条+计数) + renderProgressAscii 层级图 + ▶running 节点耗时
 *   DAG stalled  → ⚠ 最后已知进度 (server 疑似崩)
 *   DAG finished → ✔/✘ 终态计数 (grace 内短暂展示, 之后 load 收起)
 *   无 DAG       → 空闲退化行 (⟨model⟩ repo · ctx% · 5h% · $cost)
 * 恒: pathfinder 迷雾条独立追加 (地图存在即显, 与 DAG 无关)。
 *
 * 宽度: ANSI 感知 dispWidth + clamp 到 $COLUMNS (banner 截断教训: 宽字符按 2 计, 超宽截 + …)。
 * 颜色: 整行着色 (clamp 后再包 ANSI, 永不切断转义序列); NO_COLOR / color=false → 纯文本。
 */
import { renderProgressAscii } from '../mcp/tools/dag-ascii';
import type { DagView } from './load';
import type { HudFogSnapshot } from './types';

export interface HudSession {
  model: string;
  repo: string;
  ctxPct: number;
  costUsd?: number;
  fiveHourPct?: number;
}

export interface RenderInput {
  dag: DagView | null;
  fog: HudFogSnapshot | null;
  session: HudSession;
  cols: number;
  nowMs: number;
  /** 关色 (测试 / NO_COLOR)。默认开。 */
  color?: boolean;
}

// ── 宽度 (ANSI 感知, 宽字符=2) ────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function charWidth(cp: number): number {
  // emoji-presentation Misc-Symbols 我实际发的宽字符 (⚠ ⚡): 终端里占 2。
  // 刻意不整段收 0x2600–0x27bf —— 那里含 ✔✘▶ 等状态字形, 须与 renderProgressAscii 的宽度-1 模型一致。
  if (cp === 0x26a0 || cp === 0x26a1) return 2;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / pictographs
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, '')) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** 截到 cols 显示宽 (宽字符按 2); 超宽末位替 …。入参应为纯文本 (无 ANSI)。 */
export function clamp(s: string, cols: number): string {
  if (cols <= 0) return '';
  if (dispWidth(s) <= cols) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > cols - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

// ── 小工具 ────────────────────────────────────────────────────────────────────
/** 毫秒 → 人读耗时 (0s / 45s / 3m12s / 1h2m3s)。 */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
}

/** 进度条 (█=done ▓=running ░=rest), 宽 W。 */
function progressBar(done: number, running: number, total: number, W: number): string {
  if (total <= 0) return '░'.repeat(W);
  const d = Math.min(W, Math.round((done / total) * W));
  const r = Math.min(W - d, Math.round((running / total) * W));
  const rest = Math.max(0, W - d - r);
  return '█'.repeat(d) + '▓'.repeat(r) + '░'.repeat(rest);
}

interface Palette {
  dim: string;
  green: string;
  yellow: string;
  red: string;
  cyan: string;
  reset: string;
}
const COLOR: Palette = { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const PLAIN: Palette = { dim: '', green: '', yellow: '', red: '', cyan: '', reset: '' };

interface Ctx {
  cols: number;
  nowMs: number;
  c: Palette;
}

/** clamp 到宽度后整行着色 (color='' → 纯文本)。 */
function line(text: string, ctx: Ctx, color = ''): string {
  const t = clamp(text, ctx.cols);
  return color ? `${color}${t}${ctx.c.reset}` : t;
}

// ── 各段 ──────────────────────────────────────────────────────────────────────
function dagLines(view: DagView, ctx: Ctx): string[] {
  const { snap, phase } = view;
  const total = snap.planned.length || snap.started.length + snap.settled.length;
  const done = snap.settled.filter((s) => s.status === 'done').length;
  const failed = snap.settled.length - done;
  const running = snap.started.length;
  const bar = progressBar(done, running, total, 12);
  const goal = snap.goal || snap.runId.slice(0, 8);

  let label: string;
  let headColor: string;
  if (phase === 'live') {
    label = `running ${running}▶`;
    headColor = ctx.c.cyan;
  } else if (phase === 'stalled') {
    label = `⚠ stalled ${fmtDur(view.ageMs)}`;
    headColor = ctx.c.yellow;
  } else {
    label = failed ? '✘ failed' : '✔ done';
    headColor = failed ? ctx.c.red : ctx.c.green;
  }
  const header = `⚡ ${goal} · ${label} · ${bar} ${done}/${total}${failed ? ` ✘${failed}` : ''}`;
  const out = [line(header, ctx, headColor)];

  // 层级图 (finished/stalled 也画最后已知形状)。renderProgressAscii 内部已按 cols 截, 再过 clamp 兜 ANSI 无。
  const graph = renderProgressAscii(snap.levels ?? undefined, { planned: snap.planned, started: snap.started, settled: snap.settled }, ctx.cols);
  for (const g of graph.split('\n')) if (g) out.push(line(g, ctx));

  // 在跑节点 + 耗时 (仅 live)
  if (phase === 'live' && snap.started.length) {
    const kindOf = new Map(snap.planned.map((n) => [n.id, n.kind]));
    const parts = snap.started.map((id) => {
      const at = snap.startedAt[id];
      const el = at ? fmtDur(ctx.nowMs - Date.parse(at)) : '?';
      return `${id}(${kindOf.get(id) ?? '?'} ${el})`;
    });
    out.push(line(`▶ ${parts.join('  ')}`, ctx, ctx.c.yellow));
  }
  return out;
}

function idleLine(session: HudSession, ctx: Ctx): string {
  const bits = [`⟨${session.model}⟩`];
  if (session.repo) bits.push(session.repo);
  bits.push(`ctx ${session.ctxPct}%`);
  if (session.fiveHourPct != null) bits.push(`5h ${Math.round(session.fiveHourPct)}%`);
  if (session.costUsd != null && session.costUsd > 0) bits.push(`$${session.costUsd.toFixed(2)}`);
  return line(bits.join(' · '), ctx, ctx.c.dim);
}

function fogLine(fog: HudFogSnapshot, ctx: Ctx): string {
  return line(`🧭 ${fog.destination} ${fog.bar} ${fog.ruled}/${fog.total} 散雾`, ctx, ctx.c.dim);
}

/** 组装多行 HUD; 全空 → 空串 (statusline 不打印)。 */
export function renderHud(input: RenderInput): string {
  const ctx: Ctx = { cols: input.cols, nowMs: input.nowMs, c: input.color === false ? PLAIN : COLOR };
  const lines: string[] = [];
  if (input.dag) lines.push(...dagLines(input.dag, ctx));
  else lines.push(idleLine(input.session, ctx));
  if (input.fog) lines.push(fogLine(input.fog, ctx));
  return lines.join('\n');
}
