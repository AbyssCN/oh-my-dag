/**
 * arch/deepen-report —— dag-deepen 的 HTML 报告渲染器 (纯函数, 注入 synth 输出可测)。
 *
 * 输入 = synthesis 叶的 markdown (CANDIDATE_FORMAT 固定标题契约, 见 deepen-plan) + 热点元数据。
 * 输出 = 单文件 HTML: Tailwind CDN + Mermaid CDN, 一卡一候选 (files/friction/deletion-test/
 * before-after/leverage/strength)。before/after 里的 ```mermaid 围栏渲染成 <pre class="mermaid">
 * (mermaid.js 读 textContent → 内容照常 HTML 转义, 不引入注入面); 其余按轻量 markdown 转 div。
 *
 * 除两个 CDN <script> 外自包含 — 报告是本地一次性产物, 不是长期部署页。
 */
import type { Hotspot } from './hotspots';

export interface DeepenReportInput {
  /** 扫描范围标签 ('repo-wide' 或用户点名的 scope 路径)。 */
  scopeLabel: string;
  /** 热点发现所扫的 commit 数。 */
  commits: number;
  hotspots: Hotspot[];
  /** synthesis 叶输出 (CANDIDATE_FORMAT markdown)。 */
  synthMarkdown: string;
  /** 各叶终态 (失败热点在报告标出, 候选不装全知)。 */
  leafStatuses?: { id: string; status: 'done' | 'failed' }[];
  /** 生成时刻 (注入可测; 缺省 now)。 */
  generatedAt?: string;
}

export interface Candidate {
  title: string;
  body: string;
}

/** HTML 转义 (所有模型产文本入 HTML 前必过)。 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 按 `## ` 标题把 synth markdown 切成候选块 (首标题前的前言丢弃)。 */
export function splitCandidates(md: string): Candidate[] {
  const out: Candidate[] = [];
  let current: Candidate | null = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) out.push(current);
      current = { title: m[1]!.trim(), body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) out.push(current);
  return out;
}

/** 从候选 body 抠 strength 字段 (badge 用; 认不出 → 'unrated')。 */
function strengthOf(body: string): string {
  const m = body.match(/\*\*strength\*\*\s*:?\s*[`*]*\s*(strong|moderate|speculative)/i);
  return m ? m[1]!.toLowerCase() : 'unrated';
}

const STRENGTH_CLASS: Record<string, string> = {
  strong: 'bg-emerald-100 text-emerald-800',
  moderate: 'bg-amber-100 text-amber-800',
  speculative: 'bg-slate-200 text-slate-600',
  unrated: 'bg-slate-100 text-slate-500',
};

/**
 * 候选 body 的轻量 markdown → HTML: 先按围栏切段 (```mermaid → <pre class="mermaid">, 其余围栏
 * → <pre><code>), 非围栏段逐行转 (字段行 `- **k**: v` → 定义行, 其余 → 段落), 全程 esc。
 */
function bodyToHtml(body: string): string {
  // 行式状态机 (regex-split 的 stride 会在围栏后错位吞正文): 开栏行记 lang, 收栏行 flush 代码块,
  // 其余按当前态归 prose / fenced。未闭合围栏 → 余下按代码块 flush (best-effort 不丢内容)。
  const html: string[] = [];
  const prose: string[] = [];
  const fenced: string[] = [];
  let lang: string | null = null; // null = 不在围栏内
  const flushProse = () => {
    if (prose.length > 0) html.push(proseToHtml(prose.join('\n')));
    prose.length = 0;
  };
  const flushFenced = () => {
    const code = fenced.join('\n').trim();
    if (lang === 'mermaid') html.push(`<pre class="mermaid">${esc(code)}</pre>`);
    else html.push(`<pre class="bg-slate-900 text-slate-100 rounded-lg p-3 text-xs overflow-x-auto"><code>${esc(code)}</code></pre>`);
    fenced.length = 0;
  };
  for (const line of body.split('\n')) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence && lang === null) {
      flushProse();
      lang = (fence[1] ?? '').toLowerCase();
    } else if (fence && lang !== null) {
      flushFenced();
      lang = null;
    } else if (lang !== null) {
      fenced.push(line);
    } else {
      prose.push(line);
    }
  }
  if (lang !== null) flushFenced();
  else flushProse();
  return html.join('\n');
}

/** 非围栏 prose: 字段行成键值行, 其余行成段; **bold** → <strong>。 */
function proseToHtml(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const field = line.match(/^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/);
    if (field) {
      lines.push(
        `<div class="flex gap-2 text-sm"><span class="shrink-0 font-semibold text-slate-500 w-36">${esc(field[1]!)}</span><span>${inline(field[2]!)}</span></div>`,
      );
    } else {
      lines.push(`<p class="text-sm text-slate-700">${inline(line)}</p>`);
    }
  }
  return lines.join('\n');
}

/** 行内 markdown: esc 后还原 **bold** 与 `code`。 */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="bg-slate-100 rounded px-1 text-xs">$1</code>');
}

/** 渲染整份报告 HTML (自包含单文件, CDN 除外)。 */
export function renderDeepenReport(input: DeepenReportInput): string {
  const when = input.generatedAt ?? new Date().toISOString();
  const candidates = splitCandidates(input.synthMarkdown);
  const failed = (input.leafStatuses ?? []).filter((l) => l.status === 'failed');

  const hotspotRows = input.hotspots
    .map(
      (h, i) =>
        `<tr class="border-b border-slate-100"><td class="py-1 pr-3 text-slate-400">${i + 1}</td>` +
        `<td class="py-1 pr-3 font-mono text-xs">${esc(h.dir)}</td>` +
        `<td class="py-1 pr-3 text-right">${h.touches}</td>` +
        `<td class="py-1 text-xs text-slate-500">${esc(h.files.slice(0, 3).map((f) => f.path.split('/').pop() ?? f.path).join(', '))}${h.files.length > 3 ? ' …' : ''}</td></tr>`,
    )
    .join('\n');

  const cards = candidates.length
    ? candidates
        .map((c) => {
          const strength = strengthOf(c.body);
          return `<article class="candidate-card bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-2">
  <header class="flex items-start justify-between gap-3">
    <h2 class="text-base font-semibold text-slate-800">${esc(c.title)}</h2>
    <span class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STRENGTH_CLASS[strength] ?? STRENGTH_CLASS.unrated}">${esc(strength)}</span>
  </header>
${bodyToHtml(c.body)}
</article>`;
        })
        .join('\n')
    : '<p class="text-slate-500">synthesis 未产出候选 (可能各热点均报 "无候选", 或 synth 叶失败)。</p>';

  const failedNote = failed.length
    ? `<p class="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">⚠ ${failed.length} 个扫描叶失败 (${esc(failed.map((f) => f.id).join(', '))}) — 对应热点未被覆盖, 候选清单不完整。</p>`
    : '';

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dag-deepen — 架构加深候选 (${esc(input.scopeLabel)})</title>
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>
</head>
<body class="bg-slate-50 text-slate-900">
<main class="max-w-4xl mx-auto px-6 py-10 space-y-8">
  <header class="space-y-1">
    <h1 class="text-2xl font-bold">dag-deepen · 架构加深候选</h1>
    <p class="text-sm text-slate-500">范围 <span class="font-mono">${esc(input.scopeLabel)}</span> · 近 ${input.commits} commit · ${input.hotspots.length} 热点 · ${candidates.length} 候选 · ${esc(when)}</p>
  </header>
  ${failedNote}
  <section>
    <h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">热点 (触碰频率)</h2>
    <table class="w-full text-sm"><tbody>
${hotspotRows}
    </tbody></table>
  </section>
  <section class="space-y-4">
    <h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wide">加深候选 (leverage 降序)</h2>
${cards}
  </section>
  <footer class="text-sm text-slate-500 border-t border-slate-200 pt-4">
    候选 ≠ 结论: 动手重构前先 <code class="bg-slate-100 rounded px-1">/grill</code> 选中的候选 (对抗逼问契约面), 本报告永不自动产 PR。
  </footer>
</main>
</body>
</html>
`;
}
