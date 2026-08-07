/**
 * scripts/tui-shot —— **屏幕快照**(不是累积缓冲)。2026-08-07 新增。
 *
 * ## 它补的是一把不存在的尺子
 *
 * `tui-pty-check.mjs` 的 oracle 是 **累积缓冲**:打印过的字永远在 `p.text()` 里。
 * 那把尺子能判"这个行为发生过",**判不了"这一屏长什么样"** —— 于是「好不好看」
 * 没有任何收敛判据,只能自说自话。(交接 37 坑 #2 撞过两次的正是这件事。)
 *
 * 这个脚本量的是**终端的屏幕状态**:tmux 托管一个真 pty,`capture-pane -e` 取
 * 当前可见的那一屏(含 ANSI),再渲染成 PNG —— 于是「丑」这件事有了可以看的读数。
 *
 * ## 为什么是 tmux 而不是自己写 VT 解析
 *
 * 屏幕状态 = 光标定位 / 清行 / 滚动区 / 换行回绕全部算完之后的结果。自己解析等于写半个
 * 终端模拟器,而**它错了我不会知道**(错的快照和真屏幕都是"一堆字符")。tmux 是真终端,
 * 它算的就是用户会看到的。
 *
 * ⚠ 用**独立 socket**(`-L omd-shot`)起服务器:`new-session` 会继承**已存在**的 tmux
 * 服务器的环境变量,共用默认 socket 时快照的环境取决于机器上碰巧开着什么。
 *
 * ## 用法
 *
 * ```
 * node scripts/tui-shot.mjs --out /tmp/a.png --cols 120 --rows 40 \
 *   --steps 'wait:2500;type:/help;key:Enter;wait:1200'
 * ```
 *
 * 步骤语法(`;` 分隔):`wait:<ms>` · `type:<字面文本>` · `key:<tmux 键名, 如 Enter C-c Escape>`。
 * 同时写出 `<out>.txt`(去色纯文本)与 `<out>.ansi`(原样),PNG 只是给人看的那一份。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOCKET = 'omd-shot';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const OUT = arg('out', '/tmp/omd-tui-shot.png');
const COLS = Number(arg('cols', '120'));
const ROWS = Number(arg('rows', '40'));
const CMD = arg('cmd', `cd ${ROOT} && bun run --env-file=.env src/harness/cli.ts tui`);
const STEPS = arg('steps', 'wait:3000');

/** tmux 一发。`check` 为真时非零退出即抛 —— 静默失败会产出一张"上一次的"图。 */
function tmux(args, check = true) {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
  if (check && r.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} 失败 (status=${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSteps(spec) {
  for (const raw of spec.split(';')) {
    const step = raw.trim();
    if (!step) continue;
    const idx = step.indexOf(':');
    const kind = idx < 0 ? step : step.slice(0, idx);
    const val = idx < 0 ? '' : step.slice(idx + 1);
    if (kind === 'wait') await sleep(Number(val));
    else if (kind === 'type') tmux(['send-keys', '-t', 'shot', '-l', val]);
    else if (kind === 'key') tmux(['send-keys', '-t', 'shot', val]);
    else throw new Error(`未知步骤 ${JSON.stringify(step)}(只认 wait/type/key)`);
    // 每一发之间留一拍:终端把 `\x1b`+字符 读成一个 Alt 序列(交接 37 坑 #3)。
    if (kind !== 'wait') await sleep(120);
  }
}

/* ---------------------------------- ANSI → HTML ---------------------------------- */

/** xterm 默认前 16 色。快照要还原的是**终端**的观感,不是网页调色板。 */
const BASE16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

/** 256 色表:0-15 同上,16-231 是 6×6×6 立方,232-255 是灰阶。 */
function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const c = n - 16;
    const lv = [0, 95, 135, 175, 215, 255];
    const hex = (x) => lv[x].toString(16).padStart(2, '0');
    return `#${hex(Math.floor(c / 36))}${hex(Math.floor(c / 6) % 6)}${hex(c % 6)}`;
  }
  const g = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
  return `#${g}${g}${g}`;
}

const ESCAPE_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESCAPE_HTML[c]);

function blankStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

/** 一条 SGR 参数串作用到样式上。认不得的参数**忽略**(而不是抛)—— 快照不是校验器。 */
function applySgr(st, params) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(st, blankStyle());
    else if (p === 1) st.bold = true;
    else if (p === 2) st.dim = true;
    else if (p === 3) st.italic = true;
    else if (p === 4) st.underline = true;
    else if (p === 7) st.inverse = true;
    else if (p === 9) st.strike = true;
    else if (p === 22) { st.bold = false; st.dim = false; }
    else if (p === 23) st.italic = false;
    else if (p === 24) st.underline = false;
    else if (p === 27) st.inverse = false;
    else if (p === 29) st.strike = false;
    else if (p >= 30 && p <= 37) st.fg = BASE16[p - 30];
    else if (p === 39) st.fg = null;
    else if (p >= 40 && p <= 47) st.bg = BASE16[p - 40];
    else if (p === 49) st.bg = null;
    else if (p >= 90 && p <= 97) st.fg = BASE16[p - 90 + 8];
    else if (p >= 100 && p <= 107) st.bg = BASE16[p - 100 + 8];
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5) { st[target] = xterm256(params[i + 2] ?? 0); i += 2; }
      else if (params[i + 1] === 2) {
        const [r, g, b] = [params[i + 3] ?? 0, params[i + 4] ?? 0, params[i + 5] ?? 0];
        st[target] = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        i += 5;
      }
    }
  }
}

function styleCss(st) {
  const out = [];
  const fg = st.inverse ? (st.bg ?? '#11111b') : st.fg;
  const bg = st.inverse ? (st.fg ?? '#cdd6f4') : st.bg;
  if (fg) out.push(`color:${fg}`);
  if (bg) out.push(`background:${bg}`);
  if (st.bold) out.push('font-weight:700');
  if (st.dim) out.push('opacity:.62');
  if (st.italic) out.push('font-style:italic');
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean);
  if (deco.length) out.push(`text-decoration:${deco.join(' ')}`);
  return out.join(';');
}

/** ANSI 文本 → `{ html, plain }`。逐行处理:样式**不跨行**(TUI 每行行末补 reset)。 */
export function ansiToHtml(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const htmlLines = [];
  const plainLines = [];
  for (const line of lines) {
    const st = blankStyle();
    let html = '';
    let plain = '';
    // SGR 之外的 CSI/OSC 一律丢掉:capture-pane 给的是算完之后的屏,不该再有定位序列。
    const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b./g;
    let last = 0;
    let m;
    const emit = (chunk) => {
      if (!chunk) return;
      plain += chunk;
      const css = styleCss(st);
      html += css ? `<span style="${css}">${esc(chunk)}</span>` : esc(chunk);
    };
    while ((m = re.exec(line)) !== null) {
      emit(line.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) {
        const params = m[1].split(';').map((x) => (x === '' ? 0 : Number(x.split(':')[0])));
        applySgr(st, params);
      }
    }
    emit(line.slice(last));
    htmlLines.push(html || '&nbsp;');
    plainLines.push(plain);
  }
  return { html: htmlLines.join('\n'), plain: plainLines.join('\n') };
}

/** 终端底色:tmux 不吐"默认背景"是什么,所以这里定死一个深色底(与 Mocha 同族)。 */
const TERM_BG = '#11111b';

function pageHtml(bodyHtml, cols) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:${TERM_BG}}
  pre{margin:0;padding:14px 16px;background:${TERM_BG};color:#cdd6f4;
      font-family:'Noto Sans Mono CJK SC','DejaVu Sans Mono',monospace;
      font-size:15px;line-height:1.32;white-space:pre;
      width:${cols}ch;box-sizing:content-box}
  </style><pre id="s">${bodyHtml}</pre>`;
}

async function toPng(html, out, cols) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setContent(pageHtml(html, cols), { waitUntil: 'load' });
    const el = await page.$('#s');
    await el.screenshot({ path: out });
  } finally {
    await browser.close();
  }
}

/* ------------------------------------- main ------------------------------------- */

async function main() {
  tmux(['kill-session', '-t', 'shot'], false); // 上一次留下的,幂等
  tmux(['new-session', '-d', '-s', 'shot', '-x', String(COLS), '-y', String(ROWS), CMD]);
  try {
    // tmux 自己的状态栏会吃掉一行,并且它会出现在快照里冒充 TUI 的一部分。
    tmux(['set-option', '-t', 'shot', 'status', 'off']);
    await runSteps(STEPS);
    const ansi = tmux(['capture-pane', '-p', '-e', '-t', 'shot']);
    const { html, plain } = ansiToHtml(ansi);
    writeFileSync(`${OUT}.ansi`, ansi);
    writeFileSync(`${OUT}.txt`, plain);
    await toPng(html, OUT, COLS);
    const nonBlank = plain.split('\n').filter((l) => l.trim()).length;
    console.log(`shot: ${OUT} (${COLS}x${ROWS}, 非空行 ${nonBlank})`);
    // 全空 = TUI 根本没起来(命令找不到 / 立刻崩)。一张空图比没有图更危险。
    if (nonBlank === 0) {
      console.error('屏幕全空 —— TUI 没起来, 看 .txt 与 tmux 命令');
      process.exitCode = 1;
    }
  } finally {
    tmux(['kill-session', '-t', 'shot'], false);
    tmux(['kill-server'], false);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
