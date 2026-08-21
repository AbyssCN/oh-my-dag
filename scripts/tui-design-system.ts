/**
 * scripts/tui-design-system —— omd TUI 视觉系统设计稿的**构建器 + 闸**(2026-08-21)。
 *
 * ## 「稿即 TUI」怎么保证
 *
 * 帧引擎 (`tui-frames.mjs` + `tui-screens.mjs`) 是纯 JS, 被**两个消费者**共用:
 * 本构建器 import 它跑闸, 设计稿把同样的源码内联进 `<script>` 跑模拟器。同一份代码。
 *
 * 构建时逐帧过**三道闸**, 任一条红 → 抛, 稿出不来:
 *   ① **字形闸** —— 每个符号必须在 `src/tui/render/glyph-table.ts` 的 SAFE 档
 *      (`GROUND_TRUTH=true`, 真终端量过); UNSAFE 档直接抛。
 *   ② **宽度闸** —— 每行 ≤ 屏宽。
 *   ③ **宽度函数对账闸** —— 引擎自带的 `vw()` 与 pi-tui 真正的 `visibleWidth`
 *      在**实际用到的每一个字符串上**逐个比对。这一条是前两条的地基:
 *      浏览器里没有 pi-tui, 若 `vw()` 与它有偏差, 前两条闸量的就是错的尺子。
 *
 * ## 用法
 *   bun run scripts/tui-design-system.ts          # 写 docs/design/2026-08-21-omd-tui-视觉系统.html
 *   bun run scripts/tui-design-system.ts --check  # 只过闸不写文件 (退出码即判据)
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS, GROUND_TRUTH } from '../src/tui/render/glyph-table';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vw, lineText } from './tui-frames.mjs';
import { SCREENS, T_END } from './tui-screens.mjs';

const WIDTHS = [80, 100, 120] as const;
const HEIGHT = 34;
const TICKS = [0, 2500, 6000, 10000, 15000, 21000, 24000, 29000, 32000];

// ── 闸 ────────────────────────────────────────────────────────────────────────────
const isWideCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) ||
  (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0x3400 && cp <= 0x4dbf);

let checked = 0;
function gateLine(text: string, where: string): void {
  // ③ 对账闸: 引擎的尺子必须与 pi-tui 的尺子读数一致。
  const mine = vw(text);
  const real = visibleWidth(text);
  if (mine !== real) throw new Error(`${where}: vw()=${mine} 但 pi-tui visibleWidth()=${real} — 尺子对不上: ${JSON.stringify(text)}`);
  // ① 字形闸
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (UNSAFE_GLYPHS.has(ch)) throw new Error(`${where}: UNSAFE 字形 U+${cp.toString(16)} ${JSON.stringify(ch)}`);
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (isWideCjk(cp)) continue;
    if (SAFE_GLYPH_WIDTHS.has(ch)) continue;
    throw new Error(`${where}: 字形 U+${cp.toString(16)} ${JSON.stringify(ch)} 不在 SAFE_GLYPH_WIDTHS — 真终端没量过`);
  }
  checked++;
}

/**
 * ④ **列感知闸**(2026-08-21 加): 屏源码里不许出现 `.padEnd(` / `.padStart(`。
 *
 * 它们数字符不数列, 含 CJK 的列会整体错一格 —— 而前三道闸**一条都抓不到**
 * (行没超宽、字形也合法), 只有人眼看得见。用 `padS` / `padSL` 代替。
 * 证伪方式: 把任一屏的 `padS(x, n)` 改回 `x.padEnd(n)` → 本闸当场抛。
 */
for (const f of ['tui-screens.mjs', 'tui-frames.mjs']) {
  const src = readFileSync(join(import.meta.dir, f), 'utf-8');
  for (const bad of ['.padEnd(', '.padStart(']) {
    const at = src.indexOf(bad);
    // frames 的文档注释里要引用这两个名字, 只查**代码**里的调用 (注释行以 ` *` 或 `//` 起头)。
    if (at < 0) continue;
    const line = src.slice(0, at).split('\n').length;
    const text = src.split('\n')[line - 1] ?? '';
    if (/^\s*(\*|\/\/)/.test(text)) continue;
    throw new Error(`${f}:${line} 用了 ${bad} — 它数字符不数列, CJK 会错位; 改用 padS/padSL`);
  }
}

let frames = 0;
for (const sc of SCREENS) {
  for (const w of WIDTHS) {
    for (const t of TICKS) {
      for (const sel of [0, 2, 4]) {
        const lines = sc.fn(t, { w, h: HEIGHT, sel });
        frames++;
        lines.forEach((l: [string, string][], i: number) => {
          const txt = lineText(l);
          gateLine(txt, `${sc.id} w=${w} t=${t} 第 ${i + 1} 行`);
          // ② 宽度闸
          if (vw(txt) > w) throw new Error(`${sc.id} w=${w} t=${t} 第 ${i + 1} 行超宽 ${vw(txt)} > ${w}: ${JSON.stringify(txt)}`);
        });
      }
    }
  }
}

// ── 内联帧引擎: 去掉 ESM 关键字, 两个模块拼成一份浏览器脚本 ─────────────────────────
const strip = (src: string): string =>
  src.replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '').replace(/^export (const|function|let) /gm, '$1 ');
const ENGINE = strip(readFileSync(join(import.meta.dir, 'tui-frames.mjs'), 'utf-8')) + '\n' +
  strip(readFileSync(join(import.meta.dir, 'tui-screens.mjs'), 'utf-8'));

const SAFE_LIST = JSON.stringify([...SAFE_GLYPH_WIDTHS.keys()]);
const UNSAFE_LIST = JSON.stringify([...UNSAFE_GLYPHS]);
const SCREEN_META = JSON.stringify(SCREENS.map((s: { id: string; name: string; tag: string; file: string }) =>
  ({ id: s.id, name: s.name, tag: s.tag, file: s.file })));

// ── 文档区: 设计系统参考 ──────────────────────────────────────────────────────────
const CH_ROWS: [string, string, string, string][] = [
  ['sel', '#89dceb', '<b>等你裁 / 当前选中</b> — 全屏最亮的一处', 'theme.chrome.user'],
  ['accent', '#89b4fa', '在动:running · 前沿线 · 所有头行', 'theme.chrome.accent'],
  ['(默认)', '#cdd6f4', '事实内容:节点名、票标题', 'P.text'],
  ['dim', '#7f849c', '结构与已结的账:框线、地层、时长', 'theme.chrome.dim'],
  ['warn', '#f9e2af', '<b>卡住了但不是失败</b>:blocked · 等人 · stale', 'theme.chrome.warn'],
  ['ok', '#a6e3a1', '过了:✓ done / ruled', 'theme.chrome.toolOk'],
  ['fail', '#f38ba8', '<b>没过</b>:✗ failed / STALE', 'theme.chrome.toolFail'],
];

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>omd TUI 视觉系统 · 可玩模拟器</title>
<style>
:root{
  --bg:#0f1119;--bg2:#161927;--bg3:#1c2032;--line:#272c40;--line2:#343a52;
  --fg:#cdd6f4;--dim:#8b91a8;--mute:#636980;
  --blue:#89b4fa;--sky:#89dceb;--yellow:#f9e2af;--green:#a6e3a1;--red:#f38ba8;
  --mono:'JetBrains Mono','Cascadia Mono','Sarasa Mono SC','Noto Sans Mono CJK SC',Consolas,monospace;
  --r:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,-apple-system,'Noto Sans CJK SC',sans-serif;
     -webkit-font-smoothing:antialiased}
main{max-width:1280px;margin:0 auto;padding:52px 24px 120px}

/* ── 头 ── */
.hero{border-bottom:1px solid var(--line);padding-bottom:30px;margin-bottom:40px}
h1{font-size:32px;line-height:1.2;margin:0 0 10px;letter-spacing:-.02em;font-weight:650}
h1 em{font-style:normal;color:var(--blue)}
.pov{font-size:17px;color:var(--dim);margin:0;max-width:74ch}
.pov b{color:var(--sky);font-weight:600}
.meta{margin-top:18px;font:12px var(--mono);color:var(--mute);display:flex;gap:18px;flex-wrap:wrap}
.meta span{white-space:nowrap}
.gatechip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line2);border-radius:999px;
  padding:4px 13px;font:12px var(--mono);background:var(--bg2)}
.gatechip.pass{color:var(--green);border-color:#2c4a33}
.gatechip.fail{color:var(--red);border-color:#5a2a35}

h2{font-size:21px;margin:64px 0 6px;letter-spacing:-.01em;font-weight:640}
h2 small{font:12px var(--mono);color:var(--mute);margin-left:10px;font-weight:400;letter-spacing:0}
.sub{color:var(--dim);margin:0 0 22px;max-width:80ch;font-size:14.5px}

/* ── 模拟器 ── */
.sim{border:1px solid var(--line);border-radius:var(--r);background:var(--bg2);overflow:hidden;
     box-shadow:0 18px 50px -22px rgba(0,0,0,.85)}
.tabs{display:flex;gap:2px;padding:9px 9px 0;background:var(--bg3);border-bottom:1px solid var(--line);overflow-x:auto}
.tab{appearance:none;border:0;background:transparent;color:var(--dim);font:12px var(--mono);cursor:pointer;
  padding:8px 13px;border-radius:7px 7px 0 0;white-space:nowrap;position:relative;top:1px;border:1px solid transparent;border-bottom:0}
.tab:hover{color:var(--fg);background:#1f2437}
.tab[aria-selected=true]{background:var(--bg2);color:var(--sky);border-color:var(--line)}
.tab .nw{color:var(--yellow);font-size:10px;margin-left:5px;letter-spacing:.06em}
.ctl{display:flex;gap:22px;align-items:center;flex-wrap:wrap;padding:11px 15px;border-bottom:1px solid var(--line);background:var(--bg3)}
.grp{display:flex;gap:7px;align-items:center}
.grp>label{font:11px var(--mono);color:var(--mute);letter-spacing:.05em}
.seg{display:flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden}
.seg button{appearance:none;border:0;background:transparent;color:var(--dim);font:11px var(--mono);
  padding:5px 11px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line2)}
.seg button:hover{color:var(--fg);background:#232840}
.seg button[aria-pressed=true]{background:var(--blue);color:#0f1119;font-weight:600}
.play{appearance:none;border:1px solid var(--line2);background:transparent;color:var(--sky);
  font:12px var(--mono);border-radius:6px;padding:5px 12px;cursor:pointer;min-width:64px}
.play:hover{background:#232840}
input[type=range]{width:min(320px,42vw);accent-color:var(--blue)}
.tval{font:11px var(--mono);color:var(--dim);min-width:52px}

.screen{padding:20px 18px;overflow-x:auto;background:#1e1e2e;transition:background .18s}
.screen.latte{background:#eff1f5}
pre.tui{margin:0;font-family:var(--mono);font-size:12.5px;line-height:1.32;white-space:pre;
  font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;letter-spacing:0}
.foot{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;
  padding:9px 15px;border-top:1px solid var(--line);background:var(--bg3);font:11px var(--mono);color:var(--mute)}
.foot kbd{background:var(--bg);border:1px solid var(--line2);border-radius:4px;padding:1px 6px;color:var(--dim);
  font:inherit;margin:0 1px}
.srcfile{color:var(--dim)}

/* ── 文档 ── */
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13.5px}
td,th{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--bg2);color:var(--sky);font-weight:600;font-size:12.5px;letter-spacing:.02em}
td code,p code,li code{font:12px var(--mono);color:var(--sky)}
.sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:-2px;margin-right:8px;border:1px solid rgba(255,255,255,.14)}
.glyphs{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:9px;margin:16px 0}
.gl{border:1px solid var(--line);border-radius:7px;padding:10px 12px;background:var(--bg2)}
.gl b{font:17px var(--mono);color:var(--fg);display:block;margin-bottom:3px;letter-spacing:2px}
.gl span{font-size:11.5px;color:var(--mute);line-height:1.4;display:block}
.note{position:relative;border:1px solid var(--line2);background:var(--bg2);padding:20px 18px 15px;
  margin:26px 0 18px;color:var(--dim);font-size:14px;border-radius:8px}
.note::before{content:attr(data-tag);position:absolute;top:-8px;left:15px;background:var(--bg);padding:0 9px;
  font:11px var(--mono);letter-spacing:.09em;color:var(--dim)}
.note.warn{border-color:#4a4230}.note.warn::before{color:var(--yellow)}
.note.good{border-color:#2c4a33}.note.good::before{color:var(--green)}
.note:not(.warn):not(.good)::before{color:var(--blue)}
.note b{color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:18px 0}
.card{border:1px solid var(--line);border-radius:8px;padding:15px 17px;background:var(--bg2)}
.card h4{margin:0 0 7px;font-size:13.5px;color:var(--sky)}
.card p{margin:0;font-size:13px;color:var(--dim)}
.card .fix{color:var(--green);font:11px var(--mono);display:block;margin-top:9px}
ul{padding-left:20px;color:var(--dim);font-size:14px}li{margin:5px 0}
</style>
<main>

<div class="hero">
  <h1>omd TUI <em>视觉系统</em></h1>
  <p class="pov">整套语言只服从 PRODUCT.md 那一条定位:别人把「跑得多快」放在最亮处,
  <b>omd 把「哪一件事在等你」放在最亮处</b>。亮度层级、色道分工、新提案的三屏,全部由它推出来。</p>
  <div class="meta">
    <span id="gate" class="gatechip">闸检测中…</span>
    <span>${SCREENS.length} 屏 · ${WIDTHS.join('/')} 列 · 构建时过闸 ${frames} 帧 / ${checked} 行</span>
    <span>字形真源 glyph-table.ts · GROUND_TRUTH=${GROUND_TRUTH}</span>
  </div>
</div>

<div class="note warn" data-tag="v3 头条 · 这不是设计问题, 是接线问题">
上一版四屏全是<b>模态全屏</b>——你得先想起来去按某个键。而查下来更糟:<b>生产 run 在 TUI 上本来就是黑的</b>,
两条独立的断线。<br><br>
<b>断线一(已修)</b>:<code>solve</code> / <code>dag_goal</code> 这条路<b>根本不往 TUI 转发事件</b>。
<code>goal.ts</code> 的 <code>onNodeEvent</code> 只写 registry 和 hudMirror,而 <code>dag_run</code> 那条线
(<code>dag-tools.ts:415-425</code>)有<b>三半</b>,第三半是转发给订阅者。<br>
最刺的是 <code>goal.ts:704-707</code> 的注释自己记着上一次同款事故:<br>
<i>「<code>dag_goal</code> 此前一个事件都不发……goal 这条从 P1 起就漏了」</i><br>
补的时候<b>补了两半,TUI 那半没补</b>。之所以活到今天没人撞见,正因为它<b>只坏了一半</b>——
statusline 吃 <code>.omd/hud/dag.json</code> 所以是亮的,TUI 吃进程内订阅所以是黑的。
「一个观测面有、另一个没有」比「两个都没有」隐蔽得多。<br>
<b>已补</b>,并加了回归测试(<code>goal-node-events.test.ts</code>),两条不变量各证伪过一次。<br><br>
<b>另外两件也照建议做了</b>:<b>会话选择器</b>——title 提成主标签、开 <code>search</code>、放宽到 12 行
(<code>sessionPickerOptions</code> 是纯函数,可测);<b>run 级词元读数</b>与 <b><code>failureKind</code> 进事件</b>见下文两节。<br><br>
<b>断线二(未修)</b>:生产 run 全走 detached 子进程,母进程的 <code>onNodeEvent</code> 压根不触发。
这条正是票 <code>#215</code>/<code>#216</code> 那条流要解的——它们走磁盘镜像,绕开了两条断线,方向是对的。</div>

<h2>可玩模拟器 <small>键盘是活的:↑↓ 选 · Tab 换屏 · 空格 播放</small></h2>
<p class="sub">这不是截图。每一帧都是<b>浏览器现算</b>的,跑的是与构建器<b>同一份</b>帧引擎源码。
右下角的闸实时扫当前帧:你改宽度、切主题、拖时间轴,它每次都重新判一遍。</p>

<div class="sim">
  <div class="tabs" id="tabs" role="tablist"></div>
  <div class="ctl">
    <div class="grp"><label>宽度</label><div class="seg" id="wseg"></div></div>
    <div class="grp"><label>主题</label><div class="seg" id="tseg"></div></div>
    <div class="grp"><label>时间</label>
      <button class="play" id="play">▶ 播放</button>
      <input type="range" id="time" min="0" max="${T_END}" step="250" value="15000">
      <span class="tval" id="tval">15.0s</span>
    </div>
  </div>
  <div class="screen" id="screen"><pre class="tui" id="pre"></pre></div>
  <div class="foot">
    <span class="srcfile" id="srcfile"></span>
    <span><kbd>↑</kbd><kbd>↓</kbd> 选 · <kbd>Tab</kbd> 换屏 · <kbd>空格</kbd> 播放 · 点画面后生效</span>
  </div>
</div>

<div class="note good" data-tag="先玩这三件事 · 三条纪律的活闸">
① 把主题切到 <b>关色(NO_COLOR)</b>:每一屏都必须<b>照样读得懂</b>。选中是 <code>▸</code>、
stale 是 <code>✗ STALE</code> 文字、状态是五个不同字形,<b>没有一条信息只靠颜色携带</b>。<br>
② 把宽度切到 <b>80</b>:标题换行不截断,双栏该收的收,没有一行溢出。<br>
③ 把时间轴拖到 <b>0s</b>:还没跑的节点用时是 <code>—</code> 而<b>不是</b> <code>11.2s</code>。(第一版这里真错过:把「未来会花多久」印成了「已经花了多久」,而引擎那一刻根本没这个数。)<br>④ 切到 <b>全景 +「当前」区</b> 再拖时间轴:带子会从「闲」→「欠账」→「在跑」→「等你」逐档翻,这就是那条优先级阶梯本身。</div>

<h2>亮度层级 <small>七道色, 零新增 token</small></h2>
<p class="sub">全部已存在于 <code>theme.chrome</code>。排序不是好看,是 PRODUCT.md 那条定位句的直接翻译:越靠上的越亮,而最亮的一定是「在等你」。</p>
<table><tr><th style="width:110px">色道</th><th style="width:280px">语义</th><th>真源</th></tr>
${CH_ROWS.map(([n, hex, sem, src]) => `<tr><td><span class="sw" style="background:${hex}"></span><code>${n}</code></td><td>${sem}</td><td><code>${src}</code></td></tr>`).join('\n')}
</table>
<div class="note warn" data-tag="统一了一处现存不一致">
今天 <code>dag-tree</code> 把 failed 画成 <b>warn 黄</b>,而 <code>ticket-board</code> 把 STALE 画成 <b>toolFail 红</b>。
本系统钉死两者的分工:<b>红 = 引擎判的终局失败</b>(它已经结束了),<b>黄 = 需要人介入</b>(它还在等)。
这不是配色偏好,是两件不同的事;合并了就分不开「挂了」与「等你」。</div>

<h2>字形词表 <small>全部取自 SAFE 档, 真终端量过</small></h2>
<div class="glyphs">
  <div class="gl"><b>┏ ━ ┓ ┃ ┗ ┛</b><span>重框 = 全屏主容器</span></div>
  <div class="gl"><b>┌ ─ ┐ │ └ ┘</b><span>轻线 = 屏内分区</span></div>
  <div class="gl"><b>┄ ┄ ┄</b><span>虚线 = 未知的边界(地平线)</span></div>
  <div class="gl"><b>○ ◉ ✓ ✗ ─</b><span>节点五态:待/跑/成/败/跳。<b>五态五个样子</b></span></div>
  <div class="gl"><b>● ◆ ◇ ○</b><span>票类型:task/grill/research/prototype</span></div>
  <div class="gl"><b>▶ ↑ ◌</b><span>run 三态:活/已产出/等收</span></div>
  <div class="gl"><b>█ ░</b><span>量条 — <b>全系统只此一套</b></span></div>
  <div class="gl"><b>▸</b><span>选中。结构可见,不靠色</span></div>
</div>

<h2>顺手修掉的三个现存缺陷 <small>survey 扫出来的</small></h2>
<div class="cards">
  <div class="card"><h4>字形闸违规</h4><p><code>run-board.ts:40</code> 用 <code>⏳</code>(U+23F3),
  而它在 <code>UNSAFE_GLYPHS</code> 里,emoji 各终端宽度分歧最大。
  <span class="fix">→ 换 ◌(U+25CC,safe)。「虚线圈」本就读作悬着、还没落,语义比沙漏更准</span></p></div>
  <div class="card"><h4>三个屏零色道</h4><p><code>renderGantt</code> / <code>renderLayers</code> /
  <code>renderRunBoard</code> 今天完全不上色,全靠字形。
  <span class="fix">→ 三个都接上色道;甘特的条按终局状态上色,在跑的走 accent</span></p></div>
  <div class="card"><h4>量条有两套</h4><p><code>renderBar</code> 用 <code>█░</code>,
  而 <code>formatStatusGauge</code> 用 ASCII <code>#-</code>。同一个屏两种进度条。
  <span class="fix">→ 统一 █░ 一套</span></p></div>
  <div class="card"><h4>词表漂移(附带)</h4><p><code>dag-hud</code> 的 kind→role 表比真源少了
  <code>inproc</code> 和 <code>await</code>,这两种今天在表上显示成 <code>unknown</code>。
  <span class="fix">→ 补齐,且 await 单列成一个 role:它就是「在等你」</span></p></div>
  <div class="card"><h4>重线族误判为「待量」</h4><p><code>path-fog.ts</code> 头注说
  <code>━ ┄ ┃ ◉ ▼ ⛓</code> 字形闸判 unmeasured,票 #218 也照这条开的。
  实况:六个全在 SAFE 档,<code>GROUND_TRUTH=true</code>。
  <span class="fix">→ 本系统直接用重线族;#218 的阻塞前提不成立</span></p></div>
</div>

<h2>减法:10 个形态 → 4 屏 <small>v1 是菜单, 不是承诺</small></h2>
<p class="sub">v1 给了 10 个形态供挑。owner 挑完并指出真问题:<b>信息整合在一起,而不是分这么多形态、信息分散</b>。
下面每一行都是「这个屏不该独立存在」的理由。</p>
<table><tr><th style="width:190px">砍掉的形态</th><th style="width:90px">并进</th><th>为什么</th></tr>
<tr><td>DAG 表 <code>dag-hud</code></td><td><b>DAG</b></td><td>status / model 是树行上的<b>列</b>,不是另一个屏</td></tr>
<tr><td>泳道甘特</td><td><b>DAG</b></td><td>每行右侧一条微型时间条,「谁慢」就地看得见</td></tr>
<tr><td>分层依赖</td><td><b>删</b></td><td>树已表达拓扑;而且它的数据本就不全 —— <code>planned</code> 事件不带 deps</td></tr>
<tr><td>节点详情 / 失败诊断</td><td><b>DAG</b></td><td>选中<b>就地展开</b>判词 / 上游 / 下一步,不另开屏</td></tr>
<tr><td>票看板</td><td><b>Map</b></td><td>徽章 · STALE · 等人时长 · 来源 run 全部并进散雾层级</td></tr>
<tr><td>活图切换器 + run 看板</td><td><b>Run</b></td><td>「哪些 run 在跑」与「切到哪个」是同一件事的两半</td></tr>
<tr><td><code>kind</code> / <code>role</code> 两列</td><td><b>一列</b></td><td>role 本来就是 kind 映射出来的(<code>dag-hud.ts:39-50</code>),同时显示是纯重复</td></tr>
</table>

<h2>「当前」区 <small>一个区域, 不是三个面板堆叠</small></h2>
<p class="sub">今天是 pathHud + ticketBoard + runBoard <b>三块</b>摞着,而且 <code>hasDialogue</code> 一刀切
(<code>chat-log.ts:148</code>):<b>人一开口全部消失</b>。于是闲着时满屏仪表盘,真跑起来反而什么都没有。完全反了。</p>
<div class="note good" data-tag="盲比那条裁决其实站在这一侧">
原话(<code>tui.ts:861-863</code>,台账 <code>docs/bars/gauntlet-p3-账本.md:56</code>):<br>
<i>「流式回答下方混入<b>与本题无关</b>的仪表盘内容(进度条 8/23、前沿票工单表、阻塞集)<b>共 3 块</b>,稀释了答案主体」</i><br>
判的是<b>「3 块」+「与本题无关」</b>,不是「不许有常驻区」。一条按状态选内容、闲时只剩一行的带子,
正是对这条判词的<b>正解</b>——这里不是推翻它。</div>
<p class="sub">内容由一条优先级阶梯选,而这条阶梯就是 PRODUCT.md 那句定位的机械化。拖时间轴能把四档都走一遍:</p>
<table><tr><th style="width:90px">优先级</th><th style="width:130px">什么时候</th><th>带子上是什么</th></tr>
<tr><td><b>① 等你</b></td><td>有东西卡在人手里</td><td>几件 + 最急的那一条 + <code>Ctrl+I</code>。<b>永远压过其它</b></td></tr>
<tr><td><b>② 在跑</b></td><td>有活 run</td><td>哪个节点 / 几分之几 / 烧了多少 / <b>哪个闸在守</b></td></tr>
<tr><td><b>③ 欠账</b></td><td>checkpoint 落后 · stale 票 · 产物逼近超时</td><td>一行点名</td></tr>
<tr><td><b>④ 闲</b></td><td>以上都没有</td><td>才轮到今天那种 map 摘要。<b>大多数时候只有一行</b></td></tr>
</table>

<h2>checkpoint / 提醒该放哪 <small>一条干净的界</small></h2>
<table><tr><th style="width:150px">类别</th><th style="width:120px">去哪</th><th>为什么</th></tr>
<tr><td><b>发生过的事</b><br><span style="color:var(--mute);font-size:12px">checkpoint 已写 · verifier 判 fail · run 收工</span></td>
<td>转录一行<br><span style="color:var(--mute);font-size:12px">不可变 · 带时间</span></td>
<td>它们是<b>记录</b>。进 scrollback 天经地义</td></tr>
<tr><td><b>当前的状态</b><br><span style="color:var(--mute);font-size:12px">等你几件 · 跑到哪 · 欠了多少账</span></td>
<td>「当前」区<br><span style="color:var(--mute);font-size:12px">可覆盖 · 不进 scrollback</span></td>
<td>判据是你们自己的品牌承诺:<b>「说得出我看见了什么,不冒充发生了什么」</b>。
一条 10 秒后就过期、却永远留在转录里的提醒,恰恰是「冒充发生了什么」</td></tr></table>
<div class="note warn" data-tag="关于 todo: 建议不要造">
仓里<b>没有 todo 这个概念</b>(全仓搜下来唯一命中是一个 eval 任务里的关键词)。
而 pathfinder 票就是这个仓的 todo——有类型、有状态机、有 stale、有等人四态。
再造一个 todo 就是<b>第二个事实源</b>,而 PRODUCT.md 明写「不做第二个事实源」。
所以「当前」区里的欠账指的是<b>票</b>与 <b>checkpoint</b>,不是新造一张清单。</div>
<div class="note" data-tag="checkpoint 今天在 TUI 上是零">
两套 checkpoint 刻意分开:DAG run 的在 <code>.omd/continuity/&lt;runId&gt;/</code>,
会话交接的在 <code>…/session/&lt;id&gt;/checkpoint.md</code>(<code>session/writer.ts:1-17</code> 记了分离裁决)。
退出时 detached 派子进程写(<code>tui.ts:1016</code>),<b>屏上一个字都不出</b>,写挂了也只记 warn。
数据在盘上,缺的是读路。</div>

<h2>闸的可见性 <small>坏消息: 今天只有 3/7</small></h2>
<p class="sub">这是我认为最要紧的一条:<b>可靠性来自模型之外</b>是这个产品与 codex 类工具的分界线,
而它在界面上几乎是隐形的。查下来比预想更糟:</p>
<table><tr><th style="width:150px">闸</th><th style="width:120px">怎么露面</th><th>TUI 上看得见吗</th></tr>
<tr><td>judge / 谎报完成 / verifier</td><td><code>verdict</code> 事件</td><td>✓ 但<b>只画在 DagTree 上</b>,而 DagTree 只在终端 ≥90 列时画(<code>tui.ts:699</code>);窄屏换成 DagHud,而它<b>明确丢弃 verdict</b>(<code>dag-hud.ts:154-161</code>)</td></tr>
<tr><td>心跳闸 <code>stall</code> · 空转熔断 <code>spin-fused</code> · 产物闸 · <code>expect_exit</code> oracle · 轮数耗尽</td>
<td>只有 <code>settle{failed, failReason}</code></td>
<td>✗ <b><code>failureKind</code> 根本不在 <code>DagNodeEvent</code> 字段里</b>(<code>types.ts:489-500</code>),
它只进 checkpoint。事件面上<b>闸的分类信息是丢失的</b>,TUI 只拿得到失败原文首行截 160 字符</td></tr>
<tr><td>写集越界</td><td>不发任何 node 事件</td><td>✗ 它不是 DAG 引擎的闸,住在 goal 层(<code>run-goal.ts:286-295</code>)</td></tr>
<tr><td><code>gate: 'acceptance'</code></td><td>词表里有</td><td>—— <b>全仓没有任何发射点</b>,空档位</td></tr></table>
<div class="note good" data-tag="2026-08-21 已补: failureKind 进事件了">
模拟器里那条 <code>闸 verifier ◉守  写集 ✓3  产物 ✓  心跳 ✓  空转 ✓   已拦 1</code> 是<b>目标态</b>。
上一版写着「今天只画得出 3/7,要画满得先让 <code>failureKind</code> 进 <code>DagNodeEvent</code>」——
<b>那条前提已经补上了</b>:<code>LeafResult.failureKind</code> 一直都在(<code>types.ts:640</code>),
只是没往事件里放;现在 <code>settleEvent</code> 带它出去,DagTree 把它画成失败子行的前缀
<code>[stall] provider 30s 无字节</code>。<br>
⚠ 仍然守住的一条:<b>缺席 ≠ <code>unclassified</code></b>——缺席是「早于本次改动的发射点」,
unclassified 是「记了但归不了类」。老发射点没带成因时只画原文,<b>不编一个出来充数</b>。<br>
⚠ 补这条时撞到一件事:只写消费端的测试,把引擎那行删掉<b>整个 dag 目录 160 测全绿</b>——
「一条永远绿的闸不是闸」,所以引擎侧那半的闸单独加在 <code>engine-events.test.ts</code>。</div>

<h2>会话:选择器与改名 <small>owner 提的两条</small></h2>
<p class="sub"><b>选择器其实有</b>(<code>tui.ts:1583-1590</code>),但三处让它形同虚设:</p>
<table><tr><th style="width:150px">问题</th><th style="width:250px">实况</th><th>对照</th></tr>
<tr><td>主标签是裸 id</td><td><code>label</code> = <code>s-1787309805-834625</code>,标题被降到第二列</td><td>Claude Code 是标题当主行</td></tr>
<tr><td>没有搜索</td><td>没传 <code>search: true</code></td><td><code>/models</code>(<code>tui.ts:1287</code>)、<code>/tree</code> 都开了</td></tr>
<tr><td>只 10 行</td><td>没传 <code>maxVisible</code></td><td><code>/models</code> 传 12</td></tr>
<tr><td>启动不问 resume</td><td><code>defaultTuiSessionId</code>(<code>sessions.ts:101</code>)让每个 TUI 进程直接开新会话</td><td>Claude Code 有 resume 入口</td></tr></table>
<div class="note" data-tag="做到 Claude Code 那样, 分三档">
<b>一行参数</b>:加 <code>search: true</code> + <code>maxVisible</code>,主标签换成 title。今天就能好用一大截。<br>
<b>小改</b>:<code>2.9MB</code>——<code>repo.list</code> 已经给了绝对 <code>path</code>,<code>stat</code> 一下就有;
相对时间要写个格式化器,<code>updatedAt</code> 现成。<br>
<b>要动组件</b>:<code>main</code> 分支<b>无源</b>(会话侧一个 git 字段都没记);而且 pi-tui 的
<code>SelectList</code> <b>一个 item 只画一行</b>,Claude Code 那种两行卡片<b>现成件撑不住</b>——
模拟器里的 palette 就是照这条约束设计的<b>一行式</b>,今天能落。要两行卡片,得给
<code>selectComponent</code> 传它<b>已支持但没用上</b>的 <code>SelectListLayoutOptions</code>(<code>dialog.ts:104-109</code>)。</div>
<div class="note warn" data-tag="/rename 不只是加个命令">
会话<b>有</b> title,但它是<b>首条 prompt 截 60 字自动生成、只写一次</b>的(<code>agent.ts:416</code>),
而 <code>OmdSessionStore</code> 接口(<code>session-store.ts:171-181</code>)只有 list/open/search/create/fork/delete
——<b>没有 update/setTitle</b>。要 rename 得新开一条改 JSONL header metadata 的写路。</div>

<h2>一个白捡的读数 <small>已经在事件里了, 只是没人接</small></h2>
<div class="note good" data-tag="2026-08-21 已接: run 级词元读数">
<code>settle</code> 事件<b>一直带着</b> <code>usage:{in,out}</code>(<code>types.ts:493-494</code>),
而 TUI <b>收下就扔</b>。现在 DagTree 收下并合计,头行画 <code>DAG run-1 · 2.5k tok</code>。<br>
三条读数纪律一条没省:①<b>无源恒缺席</b>——一个节点都没报就整段不画,不画 <code>0 tok</code> 冒充没花钱;
②<b>下界要标出来</b>——有定局节点没报时合计是下界,渲染带 <code>+</code>
(沿用 <code>statusbar.ts:65-68</code> 的 <code>$0.00+</code> 那个记号);
③<b>只数定局的</b>——还在跑的节点本来就还没有 usage,不算进「谁没报」。<br>
⚠ 顺带:底栏那行<b>不是会话级,是进程级</b>——<code>sessionTotal()</code> 读内存数组,
<b>切 <code>/session</code> 不清零</b>(<code>usage/ledger.ts:96</code>)。所以「本会话花了多少」今天是错的。</div>

<h2>Map 屏为什么重画 <small>owner 对 v1 方案 B 的三条意见</small></h2>
<p class="sub">v1 的双栏被否,原因很具体:看不到 goal、看不到扩散层级、看不到票。逐条兑现:</p>
<table><tr><th style="width:200px">意见</th><th>怎么改的</th></tr>
<tr><td>看不到 Map 的 goal</td><td>goal 顶格独占一段,<b>换行不截断</b></td></tr>
<tr><td>看不到不同扩散的层级</td><td>整屏<b>按层级分段</b>:已散 <code>gen-N</code> → 前沿可动 → 受阻 → 机器建议未收件 → 雾</td></tr>
<tr><td>要把票看板整合进去</td><td>每行带票看板全部信息:类型徽章 · <code>✗ STALE</code> · 等你多久 · 来源 run</td></tr>
</table>
<div class="note" data-tag="双栏改回单栏满宽">
栏宽是拿来给标题的,不是拿来切两半的。v1 双栏里左栏 38 列装不下标题只能省略号,
右栏又大片空着 —— 两头都不划算。单栏满宽之后,选中的票<b>就地展开</b>,详情不需要一个常驻的栏位。</div>

<h2>裁决到底怎么走 <small>读自代码, 不是设想</small></h2>
<p class="sub">这是 owner 问的:在收件箱里输入,是直接被 conductor 接受,还是能单独对话?
先说今天的实况,再说这套设计怎么定。</p>
<table><tr><th style="width:150px">事实</th><th>出处</th></tr>
<tr><td><b>今天是间接的</b>:Enter 弹 g/d/c/r 选单,选完只<b>预填输入框不发送</b>;
你回车把那段话发给 conductor,再由它去调 <code>map_rule</code>。每次裁决绕一趟模型。</td><td><code>tui.ts:1920</code></td></tr>
<tr><td><code>map_rule</code> 的 <code>disposition</code> 二选一:<code>execute</code>(默认,裁后进区域)/
<code>close</code>(裁决即终结,不进区域不执行)</td><td><code>pathfinder.ts:482</code></td></tr>
<tr><td><b>裁决 ≠ 执行</b>:「区域散尽只报信,执行必须显式 <code>path_deliver</code>(owner 扣扳机)」
—— 所以<b>就地直裁是安全的</b>,它不会自己把图跑起来</td><td><code>pathfinder.ts:10</code></td></tr>
<tr><td>⚠ <code>ruling</code> 文本<b>会成为 task 票的 slice node goal</b> —— 你打的字就是执行体后来照着干的那句</td><td><code>pathfinder.ts:480</code></td></tr>
<tr><td><code>suggested</code>(机器建议)票<b>按不进裁决</b>,必须先 <code>map_confirm accept/reject</code></td><td><code>pathfinder.ts:503</code></td></tr>
</table>
<div class="note good" data-tag="于是收件箱给两条路, 并把两条注意事项常驻印在底边">
<b>Enter = 就地裁</b> —— 直接落 <code>map_rule</code>,不烧模型。<b>x = 裁完即终结</b>(<code>disposition=close</code>)。<br>
<b>g = 先问清楚</b> —— 开 grill 对话,掰扯完再裁(今天那条路)。<br>
机器建议票只给 <b>c 收件 / x 退回</b>,直裁的键<b>根本不出现</b> —— 闸在服务端(<code>INV-S1-1</code>),
但界面不该让人先按了再被拒。<br>
底边常驻那行不是装饰:<b>裁决不等于执行</b>,以及 <b>ruling 会成为执行体的 goal</b>。
这两条都属于「按下去之前必须知道」,不该靠人记。</div>

<h2>怎么落地 <small>稿 → 代码</small></h2>
<p class="sub">帧引擎的每个函数签名都与 <code>src/tui/render/*</code> 同形(<code>(data, {width, height, selected, paint}) =&gt; string[]</code>),
色道经注入接口给,与 <code>path-fog.ts</code> 的 <code>FogPaint</code> 是同一个模式;survey 判它是三种注入风格里最干净的一种。</p>
<div class="note" data-tag="两个文件就是可交付物本身">
<code>scripts/tui-frames.mjs</code>(排版原语 + 字形 + 色道)与 <code>scripts/tui-screens.mjs</code>(十屏)。
它们是纯函数、零依赖,<b>照抄进 <code>src/tui/render/</code> 即可</b>;把 <code>vw()</code> 换成
<code>visibleWidth</code>、把色道 key 换成 <code>paint.*</code> 调用,就是实装。<br>
<code>bun run scripts/tui-design-system.ts --check</code> 的退出码是这份稿的判据。</div>
</main>

<script>
const SAFE=new Set(${SAFE_LIST});
const UNSAFE=new Set(${UNSAFE_LIST});
const META=${SCREEN_META};
const HEIGHT=${HEIGHT};
const T_MAX=${T_END};
${ENGINE}

const SCREEN_FN={dag:dagScreen,map:mapScreen,inbox:inboxScreen,run:runScreen};


let S={view:'tree',w:100,theme:'mocha',t:15000,sel:0,playing:false};
const $=(id)=>document.getElementById(id);

function wideCjk(cp){return (cp>=0x4e00&&cp<=0x9fff)||(cp>=0x3000&&cp<=0x303f)||(cp>=0xff01&&cp<=0xff60)||(cp>=0x3400&&cp<=0x4dbf);}
/** 浏览器侧的同一道闸: 字形 + 宽度。模拟器每帧现判。 */
function runGate(lines,w){
  const bad=[];
  lines.forEach((l,i)=>{
    const txt=l.map(s=>s[0]).join('');
    if(vw(txt)>w) bad.push('第'+(i+1)+'行超宽 '+vw(txt)+'>'+w);
    for(const ch of txt){
      const cp=ch.codePointAt(0);
      if(UNSAFE.has(ch)){bad.push('第'+(i+1)+'行 UNSAFE '+ch);continue;}
      if(cp>=0x20&&cp<=0x7e)continue;
      if(wideCjk(cp))continue;
      if(!SAFE.has(ch))bad.push('第'+(i+1)+'行 未量字形 '+ch);
    }
  });
  return bad;
}

function render(){
  const meta=META.find(m=>m.id===S.view);
  const lines=SCREEN_FN[S.view](S.t,{w:S.w,h:HEIGHT,sel:S.sel});
  const pal=PALETTE[S.theme==='latte'?'latte':'mocha'];
  const mono=S.theme==='plain';
  $('pre').innerHTML=lines.map(l=>{
    const h=l.map(([t,c])=>{
      const e=t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      // 关色 = 恒等函数, 与 theme.ts 的 NO_COLOR 行为逐字一致
      return mono?e:(c?'<span style="color:'+pal[c]+'">'+e+'</span>':e);
    }).join('');
    return h||' ';
  }).join('\\n');
  $('pre').style.color=mono?'#cdd6f4':pal[''];
  $('screen').className='screen'+(S.theme==='latte'?' latte':'');
  if(S.theme==='latte')$('pre').style.color=PALETTE.latte[''];
  $('srcfile').textContent=(meta.tag==='NEW'?'新提案 · ':'合并自 · ')+meta.file;
  const bad=runGate(lines,S.w);
  const g=$('gate');
  g.className='gatechip '+(bad.length?'fail':'pass');
  g.textContent=bad.length?('闸 ✗ '+bad[0]):('闸 ✓ 字形 + 宽度 · 本帧 '+lines.length+' 行全过');
  $('tval').textContent=(S.t/1000).toFixed(1)+'s';
  $('time').value=S.t;
}

// 控件
$('tabs').innerHTML=META.map(m=>'<button class="tab" role="tab" data-v="'+m.id+'">'+m.name+
  (m.tag==='NEW'?'<span class="nw">NEW</span>':'')+'</button>').join('');
$('tabs').onclick=e=>{const b=e.target.closest('.tab');if(!b)return;S.view=b.dataset.v;S.sel=0;sync();};
$('wseg').innerHTML=${JSON.stringify(WIDTHS)}.map(w=>'<button data-w="'+w+'">'+w+'</button>').join('');
$('wseg').onclick=e=>{const b=e.target.closest('button');if(!b)return;S.w=+b.dataset.w;sync();};
$('tseg').innerHTML=[['mocha','暗'],['latte','亮'],['plain','关色']].map(([k,n])=>'<button data-t="'+k+'">'+n+'</button>').join('');
$('tseg').onclick=e=>{const b=e.target.closest('button');if(!b)return;S.theme=b.dataset.t;sync();};
$('time').oninput=e=>{S.t=+e.target.value;S.playing=false;$('play').textContent='▶ 播放';render();};
$('play').onclick=()=>{S.playing=!S.playing;$('play').textContent=S.playing?'❚❚ 暂停':'▶ 播放';};

function sync(){
  [...$('tabs').children].forEach(b=>b.setAttribute('aria-selected',b.dataset.v===S.view));
  [...$('wseg').children].forEach(b=>b.setAttribute('aria-pressed',+b.dataset.w===S.w));
  [...$('tseg').children].forEach(b=>b.setAttribute('aria-pressed',b.dataset.t===S.theme));
  render();
}
addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  if(e.key==='ArrowUp'){S.sel--;e.preventDefault();sync();}
  else if(e.key==='ArrowDown'){S.sel++;e.preventDefault();sync();}
  else if(e.key==='Tab'){const i=META.findIndex(m=>m.id===S.view);S.view=META[(i+1)%META.length].id;S.sel=0;e.preventDefault();sync();}
  else if(e.key===' '){S.playing=!S.playing;$('play').textContent=S.playing?'❚❚ 暂停':'▶ 播放';e.preventDefault();}
});
setInterval(()=>{if(S.playing){S.t+=400;if(S.t>T_MAX)S.t=0;render();}},60);
sync();
</script>
</html>`;

if (process.argv.includes('--check')) {
  console.log(`✓ ${SCREENS.length} 屏 × ${WIDTHS.length} 宽 × ${TICKS.length} 时刻 × 2 选中 = ${frames} 帧`);
  console.log(`✓ ${checked} 行全过三道闸 (字形 SAFE / 宽度 / vw()↔pi-tui 对账)`);
} else {
  const out = join(import.meta.dir, '..', 'docs', 'design', '2026-08-21-omd-tui-视觉系统.html');
  writeFileSync(out, html);
  console.log(`✓ ${out}`);
  console.log(`✓ ${frames} 帧 / ${checked} 行全过三道闸 · GROUND_TRUTH=${GROUND_TRUTH}`);
}
export {};
