#!/usr/bin/env bun
/**
 * scripts/docs-drift-check —— 面向读者的文档与盘上代码之间的漂移闸。**零 LLM, 零成本, 确定性**。
 *
 *   bun run scripts/docs-drift-check.ts          # 全绿 exit 0 (打印各项计数), 任一项失败 exit 1
 *
 * ## 它守哪七件事
 *
 *   ① 锚点存在   反引号内引用的 `src/...` / `scripts/...` 路径, 逐一验证盘上真有
 *                (`路径:行号` 只取路径部分; 含 `*` 的 glob 跳过 —— 那是模式不是锚点)
 *   ② 工具数一致 README.md 徽章的 "MCP server: N tools" 与 src/mcp/ 真实注册面比对
 *   ③ mermaid 健全  围栏闭合 · 块内 subgraph/end 配平 · `class X y` 引用的 classDef 已定义
 *   ④ 双语结构   README.md 与 README.zh-CN.md 的二级标题 (`## `) 数量一致
 *                (标题**文本**不要求相同 —— 那是翻译; 数量不同才是漏译了一整节)
 *   ⑤ 引用可达   `![](path)` / `<img src=path>` 的图片, 以及 `[x](path.md)` 的仓内 md 链接,
 *                按**所在文档的目录**解析后验证盘上存在 (`#片段` 只验文件部分;
 *                http(s)/mailto/ 站点绝对路径 `/x` 跳过)。死链与坏图就是漂移。
 *   ⑥ 公开面覆盖 面向读者的文档自身、以及它们指出去的仓内引用, 必须都在
 *                `.dev/public-paths.txt` 白名单内。⑤ 验的是**本地盘**, 这条验的是
 *                **公开镜像** —— 本地在、名单里没有 ⇒ 公开仓 404 而 ⑤ 全绿。
 *
 * ## 扫描面: 只扫"写给读者看的", 不扫台账
 *
 * README.md · README.zh-CN.md · docs/*.md (仅顶层) · docs/guide/*.md ·
 * docs/architecture/*.md · docs/diagrams/*.md。目录不存在就跳过 (重组过渡期两种状态都不炸)。
 * **docs/plan/ · docs/handoff/ · docs/notes/ 等台账子目录一概不扫** —— 那是历史记录,
 * 引用一个当时存在、今天已删的文件是**正确的**, 拿锚点闸去修它等于篡改历史。
 *
 * ## ③ 的局限: 这是轻量 lint, **不是完整 mermaid parse**
 *
 * 真 parse 要拖进浏览器环境的重依赖 (mermaid 自身依赖 DOM), 本闸拒绝引入。
 * 于是它**查不出**: 语法错的边 (`A -->> B`) · 未声明就被引用的节点 id ·
 * 方向关键字拼错 · 节点标签里未转义的引号 · 非 flowchart 图型里 `loop/alt/par` 的 `end`
 * (本仓当前全部 mermaid 块都是 flowchart, 只有 subgraph 吃 `end`; 哪天引入
 * sequenceDiagram, ② 这条会假阳性, 那时把开启词表补上)。
 * 换来的是: 零依赖 · 毫秒级 · 能进 CI。三条查得出的正是**改图时最常手滑的三种**。
 *
 * ## 怎么证伪这条闸 (本仓硬性惯例: 每条闸都要证明它真的会红)
 *
 * `scripts/docs-drift-check.test.ts` 对**内置的坏 fixture 字符串**跑同一批纯函数并断言
 * 拿到 finding: 断锚点 (`src/nope/gone.ts`) · 少一个 `end` 的 subgraph · 没闭合的围栏 ·
 * 引用未定义 classDef 的 `class` 行 · 徽章数字与注册数不符 · 双语二级标题数不等 ·
 * 指向不存在图片的 `![](assets/diagrams/nope.svg)` 与指向已删文档的 `[x](../nope.md)`。
 * 每条都配一个**同形状但正确**的样本断言零 finding —— 只证"会红"不证"该绿时不红",
 * 会养出一条永远红的闸, 同样没用。
 *
 * 手工证伪: ① 往 docs/README.md 里加一行 `` `src/nope/gone.ts` ``;
 * ⑤ 往同一份里加一行 `![x](../assets/diagrams/nope.svg)` 或 `[x](nope.md)`;
 * ⑥ 从 `.dev/public-paths.txt` 删掉 `docs/guide` 那行 —— 必须报出 guide/ 下每一份文档。
 * 重跑本脚本, 都应当 exit 1 并指名那一行。改不红 = 闸坏了。
 *
 * ## 分层
 *
 * 纯函数 (checkAnchors / checkToolCount / checkMermaid / checkBilingualHeadings /
 * checkRefs) 吃字符串出 Finding[], 零 I/O; main 入口薄, 只负责读盘 + 排版 + 定退出码。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { TOOL_RENAMES } from '../src/mcp/tool-renames';

const ROOT = new URL('..', import.meta.url).pathname;

// ── 出口形状 ──────────────────────────────────────────────────────────────

/** 一条漂移。`line` 为 1-based; 拿不到具体行 (如整文件级判据) 时为 0。 */
export interface Finding {
  /** 相对仓根的路径, 直接可点。 */
  file: string;
  /** 1-based 行号; 0 = 这条判据不落在某一行上。 */
  line: number;
  /** 是什么问题 —— 人话, 不是规则 id。 */
  what: string;
  /** 该怎么修 —— 具体到动作, 不是"请修复"。 */
  fix: string;
}

/** 一个待检文档: 相对路径 + 全文。纯函数只吃这个, 不碰磁盘。 */
export interface DocFile {
  path: string;
  text: string;
}

// ── 公共小工具 ────────────────────────────────────────────────────────────

/**
 * 逐行标记该行是否落在 ``` 围栏内部 (围栏行本身算"外部")。
 * 锚点扫描要靠它跳过代码块 —— 代码块里的 `bun run scripts/x.ts` 是**命令示例**,
 * 不是行内代码锚点, 拿反引号规则去套会漏也会错。
 */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inside = false;
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    mask.push(inside && !isFence);
    if (isFence) inside = !inside;
  }
  return mask;
}

/** 取出一行里所有行内代码 span 的内容 (不含反引号)。不处理跨行 span —— 本仓没有。 */
function inlineCodeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

// ── ① 锚点存在 ────────────────────────────────────────────────────────────

/** 反引号内看起来像仓内源码路径的东西。行号后缀与末尾标点在 normalize 里剥。 */
const ANCHOR_RE = /(?:src|scripts)\/[A-Za-z0-9_@./+-]*/g;

/**
 * 把一个原始 token 规整成待验证的路径; 返回 null = 这不是要验的锚点。
 *
 * 剥掉 `:12` 行号后缀与句末标点; 含 `*` 的按 glob 跳过 (`src/**\/*.test.ts` 那类是模式,
 * 盘上本就没有同名文件); 剥到只剩 `src/` `scripts/` 这种裸目录前缀也跳过 (那是在说"源码树",
 * 不是在指某个东西)。
 */
export function normalizeAnchor(raw: string): string | null {
  let p = raw.replace(/:\d+(?:-\d+)?$/, ''); // `路径:行号` / `路径:起-止`
  p = p.replace(/[.,;:)]+$/, ''); // 句末标点粘进来的
  if (!p || p.includes('*')) return null;
  if (p === 'src' || p === 'scripts' || p === 'src/' || p === 'scripts/') return null;
  return p;
}

/**
 * 台账性质的顶层文档 —— 内容是历史记录, 引用已删文件是它的本职 (案例讲的就是当时盘上的东西),
 * ① 不对它们判死; mermaid / 双语等其余检查照常。模板示例路径 (`src/x.ts`) 也只出现在这里。
 */
export const ANCHOR_EXEMPT = new Set(['docs/silent-failures.md', 'docs/worktrees-archive.md']);

/**
 * ① 扫文档里反引号包的 `src/...` / `scripts/...` 路径, 逐一验证盘上存在。
 *
 * `exists` 注入 (测试传纯函数, 生产传 existsSync) —— 于是这条判据本身零 I/O 可测。
 */
export function checkAnchors(docs: DocFile[], exists: (path: string) => boolean): Finding[] {
  const out: Finding[] = [];
  for (const doc of docs) {
    if (ANCHOR_EXEMPT.has(doc.path)) continue;
    const lines = doc.text.split('\n');
    const inFence = fenceMask(lines);
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      for (const span of inlineCodeSpans(lines[i]!)) {
        for (const m of span.matchAll(ANCHOR_RE)) {
          const path = normalizeAnchor(m[0]!);
          if (path === null || exists(path)) continue;
          out.push({
            file: doc.path,
            line: i + 1,
            what: `锚点指向盘上不存在的路径: ${path}`,
            fix: `确认它是被改名还是被删了 —— 改名就更新这条引用, 删了就把这句话一起删 (别留一个指向空气的路径)。`,
          });
        }
      }
    }
  }
  return out;
}

/** 锚点扫到的路径总数 (含通过的) —— 报告里给出来, 不然"0 个失败"分不清是全对还是没扫到。 */
export function countAnchors(docs: DocFile[]): number {
  let n = 0;
  for (const doc of docs) {
    if (ANCHOR_EXEMPT.has(doc.path)) continue;
    const lines = doc.text.split('\n');
    const inFence = fenceMask(lines);
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      for (const span of inlineCodeSpans(lines[i]!)) {
        for (const m of span.matchAll(ANCHOR_RE)) if (normalizeAnchor(m[0]!) !== null) n++;
      }
    }
  }
  return n;
}

// ── ② 工具数一致 ──────────────────────────────────────────────────────────

/**
 * 从 src/mcp/ 的源码字面量数出真实注册面, 与 `tools-documented.test.ts` **同一口径**:
 * 字面量经 TOOL_RENAMES 映射到新名, 旧名以 deprecated alias 身份仍在注册面上。
 *
 * 不硬编码数字 —— 硬编码的那一刻这条闸就变成了第二个需要维护的错数字。
 */
export function countRegisteredTools(sources: string[]): number {
  const names = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/name:\s*'((?:dag|omd|path|map|memory|dream|conductor)_[a-z_]+)'/g)) {
      names.add(m[1]!);
    }
  }
  const registered = new Set<string>();
  for (const n of names) {
    const renamed = TOOL_RENAMES[n];
    registered.add(renamed ?? n);
    if (renamed) registered.add(n);
  }
  return registered.size;
}

/**
 * ② README 徽章的工具数 == 真实注册数。
 *
 * 数字在徽章里出现**两次**: alt 文字 `N MCP tools` 与 URL 里的 `MCP%20tools-N-`。
 * (2026-08-24 随 README 改版更新: 旧形状是 `MCP server: N tools` / `MCP%20server-N%20tools`。
 *  这条闸当场红了 —— 它就是这么用的: 改版式必须同时改判据, 不然数字会静默失配。)
 * 两处都查 —— 只改一处会得到一个"文字对、图片错"的徽章, 比两处全错还难发现。
 */
export function checkToolCount(doc: DocFile, registered: number): Finding[] {
  const out: Finding[] = [];
  const lines = doc.text.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const [where, re] of [
      ['徽章 alt 文字', /(\d+) MCP tools/g],
      ['徽章 URL', /MCP%20tools-(\d+)-/g],
    ] as const) {
      for (const m of line.matchAll(re)) {
        seen++;
        const got = Number(m[1]);
        if (got === registered) continue;
        out.push({
          file: doc.path,
          line: i + 1,
          what: `${where}写着 ${got} 个 MCP 工具, src/mcp/ 实际注册 ${registered} 个`,
          fix: `把这处的 ${got} 改成 ${registered}。注意同一个徽章里 alt 文字和 URL 各有一份数字, 两处都要改。`,
        });
      }
    }
  }
  if (seen === 0) {
    out.push({
      file: doc.path,
      line: 0,
      what: '找不到 "MCP server: N tools" 徽章',
      fix: '徽章被删了还是改版式了? 若是有意改版, 连这条闸的正则一起改; 否则把徽章加回文件顶部。',
    });
  }
  return out;
}

// ── ③ mermaid 块健全 (轻量 lint, 非完整 parse —— 局限见文件头) ──────────────

/** 一个 mermaid 围栏块: 起止行 (1-based) + 块内各行。 */
interface MermaidBlock {
  startLine: number;
  endLine: number | null; // null = 到文件末尾都没闭合
  body: string[];
}

/** 切出所有 ```mermaid 块。围栏未闭合时 endLine 为 null, 由调用方报错。 */
function mermaidBlocks(text: string): MermaidBlock[] {
  const lines = text.split('\n');
  const out: MermaidBlock[] = [];
  let open: MermaidBlock | null = null;
  let inOther = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*```/.test(line)) {
      if (open) open.body.push(line);
      continue;
    }
    if (open) {
      open.endLine = i + 1;
      out.push(open);
      open = null;
    } else if (inOther) {
      inOther = false;
    } else if (/^\s*```\s*mermaid\s*$/.test(line)) {
      open = { startLine: i + 1, endLine: null, body: [] };
    } else {
      inOther = true; // 别的语言的围栏, 整块跳过
    }
  }
  if (open) out.push(open);
  return out;
}

/**
 * ③ mermaid 三条轻量判据: 围栏闭合 · subgraph/end 配平 · class 引用的 classDef 已定义。
 *
 * ⚠ 非完整 parse。查不出的清单见文件头注释 —— 别把"本闸绿"读成"图能渲染"。
 */
export function checkMermaid(doc: DocFile): Finding[] {
  const out: Finding[] = [];
  for (const block of mermaidBlocks(doc.text)) {
    if (block.endLine === null) {
      out.push({
        file: doc.path,
        line: block.startLine,
        what: '```mermaid 围栏一直到文件末尾都没闭合',
        fix: '在图的最后一行之后补一行 ``` —— 不然后面整篇正文都会被渲染成代码块。',
      });
      continue; // 边界都不知道在哪, 块内两条不再判 (会得到一串派生噪声)
    }

    // 配平: 本仓当前全是 flowchart, 只有 subgraph 吃 `end`。
    let depth = 0;
    let firstStray = 0;
    const classDefs = new Set<string>();
    const classRefs: { line: number; names: string[] }[] = [];
    for (let i = 0; i < block.body.length; i++) {
      const raw = block.body[i]!;
      const line = raw.replace(/%%.*$/, '').trim(); // 剥行内注释
      const lineNo = block.startLine + 1 + i;
      if (/^subgraph\b/.test(line)) depth++;
      else if (/^end\b/.test(line) || line === 'end') {
        depth--;
        if (depth < 0 && firstStray === 0) firstStray = lineNo;
      }
      const def = line.match(/^classDef\s+([A-Za-z0-9_,-]+)\s/);
      if (def) for (const n of def[1]!.split(',')) classDefs.add(n.trim());
      const ref = line.match(/^class\s+[A-Za-z0-9_,\s-]*?\s([A-Za-z0-9_,-]+);?$/);
      if (ref) classRefs.push({ line: lineNo, names: ref[1]!.split(',').map((n) => n.trim()) });
    }

    if (firstStray > 0) {
      out.push({
        file: doc.path,
        line: firstStray,
        what: '多出一个 end —— 这一行的 end 没有对应的 subgraph',
        fix: '删掉这个 end, 或者补上它本该闭合的那个 subgraph。',
      });
    } else if (depth > 0) {
      out.push({
        file: doc.path,
        line: block.endLine,
        what: `块内 subgraph 比 end 多 ${depth} 个`,
        fix: `在收尾围栏之前补 ${depth} 行 end。mermaid 遇到不配平的 subgraph 会整图渲染失败, 不是只丢一个框。`,
      });
    }

    for (const ref of classRefs) {
      const missing = ref.names.filter((n) => !classDefs.has(n));
      if (missing.length === 0) continue;
      out.push({
        file: doc.path,
        line: ref.line,
        what: `class 行引用了未定义的 classDef: ${missing.join(', ')}`,
        fix: `在同一个 mermaid 块里补 classDef ${missing[0]} fill:...,stroke:...,color:... , 或把这一行改成引用已有的 classDef (本块已定义: ${classDefs.size ? [...classDefs].join(', ') : '一个都没有'})。`,
      });
    }
  }
  return out;
}

/** 文档里 mermaid 块的个数 —— 报告里给计数, 不然"0 个失败"分不清是全对还是没扫到。 */
export function countMermaidBlocks(docs: DocFile[]): number {
  return docs.reduce((n, d) => n + mermaidBlocks(d.text).length, 0);
}

// ── ④ 双语结构对照 ────────────────────────────────────────────────────────

/** 数二级标题 (`## `)。围栏内的 `## ` 是内容不是标题, 跳过。 */
export function countH2(text: string): number {
  const lines = text.split('\n');
  const inFence = fenceMask(lines);
  let n = 0;
  for (let i = 0; i < lines.length; i++) if (!inFence[i] && /^## \S/.test(lines[i]!)) n++;
  return n;
}

/**
 * ④ 两份 README 的二级标题数量一致。
 *
 * 只比**数量**不比文本 —— 中文版是翻译, 标题文本本来就该不同。数量不等 = 有一整节
 * 只存在于一种语言里, 那是读者会看见的缺口。
 */
export function checkBilingualHeadings(en: DocFile, zh: DocFile): Finding[] {
  const a = countH2(en.text);
  const b = countH2(zh.text);
  if (a === b) return [];
  const more = a > b ? en.path : zh.path;
  const less = a > b ? zh.path : en.path;
  return [
    {
      file: less,
      line: 0,
      what: `二级标题数不一致: ${en.path} 有 ${a} 个 ## , ${zh.path} 有 ${b} 个`,
      fix: `${more} 比 ${less} 多 ${Math.abs(a - b)} 节。逐节对读, 把缺的那节译过去 (或者两边一起删)。标题文本不要求相同, 数量要求相同。`,
    },
  ];
}

// ── ⑤ 引用可达 (图片 + 仓内 md 链接) ──────────────────────────────────────

/** 一条从文档指出去的引用。`target` 是**原样**的链接目标, 还没解析。 */
export interface DocRef {
  line: number;
  target: string;
  kind: 'image' | 'link';
}

/** `![alt](path)` —— alt 里不许有 `]`, 目标取到第一个空白 (后面可能跟 `"title"`)。 */
const IMAGE_MD_RE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
/** `<img src="path">` —— 单双引号都吃, 大小写不敏感。 */
const IMAGE_HTML_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi;
/** `[text](path)` —— 只在**图片已被抹掉**的行上跑, 否则 `[![alt](img)](link)` 会认成图片那层。 */
const LINK_MD_RE = /\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
/** 带 scheme 的 (`https:` `mailto:` `data:`) 或协议相对的 (`//cdn/...`) —— 仓外, 本闸管不着。 */
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * 取出一份文档里所有图片与链接引用。围栏内的不算 —— 那是语法示例, 不是真引用。
 *
 * 图片先扫、再从行里抹掉才扫链接: 徽章那种 `[![alt](img)](target)` 嵌套形状,
 * 不抹的话链接正则会先咬住内层的 img url, 外层真正的 target 反而漏掉。
 */
export function extractRefs(doc: DocFile): DocRef[] {
  const out: DocRef[] = [];
  const lines = doc.text.split('\n');
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const line = lines[i]!;
    for (const m of line.matchAll(IMAGE_MD_RE)) out.push({ line: i + 1, target: m[1]!, kind: 'image' });
    for (const m of line.matchAll(IMAGE_HTML_RE)) out.push({ line: i + 1, target: m[1]!, kind: 'image' });
    const stripped = line.replace(IMAGE_MD_RE, (s) => ' '.repeat(s.length));
    for (const m of stripped.matchAll(LINK_MD_RE)) out.push({ line: i + 1, target: m[1]!, kind: 'link' });
  }
  return out;
}

/**
 * 把一个链接目标解析成**相对仓根**的路径; null = 不该验 (仓外 / 纯锚点 / 站点绝对路径)。
 *
 * 相对**文档自己的目录**解析 —— docs/architecture/overview.md 里的 `../README.md`
 * 指的是 docs/README.md, 不是仓根那份。重组之后跨目录相对链接遍地都是, 这一跳不能省。
 */
export function resolveRef(docPath: string, target: string): string | null {
  let t = target.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1); // `[x](<path>)`
  t = t.split('#')[0]!; // `#anchor` 片段只验文件部分; 纯锚点会剩空串
  if (!t || EXTERNAL_RE.test(t) || t.startsWith('/')) return null;
  let decoded = t;
  try {
    decoded = decodeURIComponent(t);
  } catch {
    /* 不是合法 percent-encoding, 按字面路径处理 */
  }
  const p = normalize(join(dirname(docPath), decoded));
  return p.startsWith('..') ? null : p; // 指到仓外
}

/** 这条引用要不要验存在: 图片一律验; 链接只验仓内 `.md` (目录链接/LICENSE 等不在口径内)。 */
function refWorthChecking(ref: DocRef, resolved: string): boolean {
  return ref.kind === 'image' || resolved.toLowerCase().endsWith('.md');
}

/**
 * ⑤ 图片与仓内 md 链接逐一验证盘上存在。`exists` 同 ① 注入, 于是零 I/O 可测。
 *
 * 台账 (ANCHOR_EXEMPT) 只豁免**链接**那一半 —— 理由与 ① 同: 历史记录指向当时存在、
 * 今天已删的文档是正确的。图片不豁免: 坏图对读者就是一个碎图标, 跟这份文档讲的是不是
 * 历史无关。
 */
export function checkRefs(docs: DocFile[], exists: (path: string) => boolean): Finding[] {
  const out: Finding[] = [];
  for (const doc of docs) {
    for (const ref of extractRefs(doc)) {
      const resolved = resolveRef(doc.path, ref.target);
      if (resolved === null || !refWorthChecking(ref, resolved)) continue;
      if (ref.kind === 'link' && ANCHOR_EXEMPT.has(doc.path)) continue;
      if (exists(resolved)) continue;
      out.push(
        ref.kind === 'image'
          ? {
              file: doc.path,
              line: ref.line,
              what: `图片指向盘上不存在的文件: ${ref.target} (解析为 ${resolved})`,
              fix: `确认图片是没生成还是被改名/挪了位 —— 生成它, 或把这条引用改到真实路径 (路径按本文档所在目录解析, 跨目录记得写 ../)。`,
            }
          : {
              file: doc.path,
              line: ref.line,
              what: `链接指向盘上不存在的文档: ${ref.target} (解析为 ${resolved})`,
              fix: `死链。文档被挪走就更新这条链接 (相对本文档目录写), 被删了就把这句话一起删。`,
            },
      );
    }
  }
  return out;
}

/** ⑤ 实际验了几条 (含通过的) —— 同 countAnchors, "0 失败"要能和"0 扫到"分开。 */
export function countRefs(docs: DocFile[], kind: DocRef['kind']): number {
  let n = 0;
  for (const doc of docs) {
    for (const ref of extractRefs(doc)) {
      if (ref.kind !== kind) continue;
      const resolved = resolveRef(doc.path, ref.target);
      if (resolved === null || !refWorthChecking(ref, resolved)) continue;
      if (ref.kind === 'link' && ANCHOR_EXEMPT.has(doc.path)) continue;
      n++;
    }
  }
  return n;
}

// ── ⑥ 公开面覆盖 (白名单 vs 面向读者文档) ────────────────────────────────
//
// 为什么 ⑤ 抓不到这一类: ⑤ 验的是**本地盘**上有没有。公开镜像是按
// `.dev/public-paths.txt` 白名单**过滤整条历史**重写出来的 —— 一份文件本地在、
// 名单里没有 ⇒ 公开仓里不存在 ⇒ 公开 README 上那条链接 404, 而 ⑤ 全绿。
//
// 实账两次, 同一形状:
//   2026-08-11  docs 分层重组, 名单里还是旧的 9 条平铺路径 → 整套 guide/architecture 被滤掉。
//   2026-08-24  加 docs/why-omd.md 与 docs/driving-omd.md 时没动名单 → 公开首页两个链接 404。
//
// 反向自检 (证伪方式): 从 `.dev/public-paths.txt` 删掉 `docs/guide` 那行再跑本闸,
// 必须报出 guide/ 下每一份文档 + 每一条指向它们的链接。见 docs-drift-check.test.ts 同名 describe。

/**
 * 住在 docs/ 顶层、但**不是用户面**的台账 —— 它们本地在、公开仓没有, 这是对的。
 * ⑥ 只豁免「这份文档自身要不要公开」那一半; 公开文档**指向**它们的链接照样算 404,
 * 因为读者点得到那条链接。
 */
export const LEDGER_DOCS = new Set(['docs/docs-map.md', 'docs/worktrees-archive.md']);

/** 白名单一行 = 一个仓根相对路径, 文件或目录。`#` 开头与空行是注释。 */
export function parseWhitelist(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** 路径被名单覆盖 = 逐字命中某条, 或落在某条目录条目之下。 */
export function coveredByWhitelist(path: string, entries: string[]): boolean {
  return entries.some((e) => path === e || path.startsWith(`${e}/`));
}

/**
 * ⑥ 面向读者的文档**自身**, 以及它们指出去的仓内引用, 必须都在公开白名单内。
 *
 * `entries` 为 null = 名单文件缺席 (公开镜像只在私有真源里配) → 返回空, 由调用方
 * 把标签写成「跳过」而不是「通过」—— 0 失败和 0 扫到是两件事 (仓规坑①)。
 */
export function checkPublicCoverage(docs: DocFile[], entries: string[] | null): Finding[] {
  if (entries === null) return [];
  const out: Finding[] = [];
  for (const doc of docs) {
    if (!LEDGER_DOCS.has(doc.path) && !coveredByWhitelist(doc.path, entries)) {
      out.push({
        file: doc.path,
        line: 0,
        what: `这份文档不在公开白名单内 —— 公开仓里根本没有它, 而它是面向读者的`,
        fix: `把这条路径加进 .dev/public-paths.txt (加完重跑 .dev/sync-public.sh), 或者把它挪进台账区不再当用户面。`,
      });
    }
    for (const ref of extractRefs(doc)) {
      const resolved = resolveRef(doc.path, ref.target);
      if (resolved === null || !refWorthChecking(ref, resolved)) continue;
      if (ref.kind === 'link' && ANCHOR_EXEMPT.has(doc.path)) continue;
      if (coveredByWhitelist(resolved, entries)) continue;
      out.push({
        file: doc.path,
        line: ref.line,
        what: `引用的 ${resolved} 不在公开白名单内 —— 本地能点开, 公开仓上是 404`,
        fix: `目标该公开就加进 .dev/public-paths.txt; 该私有就把这条链接从公开文档里删掉 (别留一条只有你点得开的链接)。`,
      });
    }
  }
  return out;
}

/** ⑥ 实际验了几条 (文档自身 + 够格的引用) —— 同 countRefs, 让「0 失败」与「0 扫到」分得开。 */
export function countCoverageChecks(docs: DocFile[]): number {
  let n = docs.filter((d) => !LEDGER_DOCS.has(d.path)).length;
  for (const doc of docs) {
    for (const ref of extractRefs(doc)) {
      const resolved = resolveRef(doc.path, ref.target);
      if (resolved === null || !refWorthChecking(ref, resolved)) continue;
      if (ref.kind === 'link' && ANCHOR_EXEMPT.has(doc.path)) continue;
      n++;
    }
  }
  return n;
}

// ── ⑦ 表格完整 ──────────────────────────────────────────────────────────
//
// 2026-08-24 实账: 一条没锚定的 `perl -pi -e` 把 docs/README.md 整张表每行都加了前缀,
// 公开仓上渲染成一大坨重复文字。①~⑥ **全绿** —— 链接还在、锚点还在、图片还在,
// 坏的只有表格结构。于是这一类只能靠人眼在 GitHub 上看见, 而那时它已经上线了。
//
// 判据: 一个表块内每行的列数必须一致 (以分隔行 |---|---| 为准)。
// 反向自检: 往任意文档的表里加一行少一列的, 必红。见 test 同名 describe。

/** 一行是不是表格行 (去掉首尾空白后以 | 开头且以 | 结尾)。 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 1;
}

/** 表格行的列数 —— 首尾竖线之间被未转义的 | 切成几段。 */
export function columnCount(line: string): number {
  const t = line.trim();
  // 去掉首尾那对竖线, 再按未转义的 | 切
  const inner = t.slice(1, -1);
  return inner.split(/(?<!\\)\|/).length;
}

/** 分隔行: 每格只有 - : 和空白。 */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!isTableRow(t)) return false;
  return t
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/**
 * ⑦ 每个表块内列数一致。围栏内跳过 (代码示例里的 | 不是表)。
 *
 * 只在**见到分隔行**之后才判 —— 没有分隔行的连续 | 行不是 markdown 表, 是别的东西
 * (如 ASCII 图), 拿表格判据去套会假阳性。
 */
export function checkTables(doc: DocFile): Finding[] {
  const out: Finding[] = [];
  const lines = doc.text.split('\n');
  const inFence = fenceMask(lines);
  let expect = -1; // -1 = 不在表内
  let headerLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFence[i] || !isTableRow(line)) {
      expect = -1;
      continue;
    }
    if (isDelimiterRow(line)) {
      // 分隔行定下这张表的列数; 表头就在上一行
      expect = columnCount(line);
      headerLine = i; // 1-based 在下面加
      continue;
    }
    if (expect < 0) continue; // 还没见到分隔行 —— 不当表判
    const got = columnCount(line);
    if (got === expect) continue;
    out.push({
      file: doc.path,
      line: i + 1,
      what: `表格列数不一致: 本行 ${got} 列, 该表(分隔行在第 ${headerLine + 1} 行)是 ${expect} 列`,
      fix: `补齐或删掉多出来的 \`|\` —— 列数对不上时 GitHub 会把整张表渲染成一坨, 而链接闸看不出来。`,
    });
  }
  return out;
}

/** ⑦ 一共判了几行表格行 (含通过的)。 */
export function countTableRows(docs: DocFile[]): number {
  let n = 0;
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    const inFence = fenceMask(lines);
    let inTable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (inFence[i] || !isTableRow(line)) { inTable = false; continue; }
      if (isDelimiterRow(line)) { inTable = true; continue; }
      if (inTable) n++;
    }
  }
  return n;
}

// ── 编排层: 唯一碰磁盘的地方 ──────────────────────────────────────────────

/**
 * 待扫的文档: 两份 README + docs 顶层 + docs/guide + docs/architecture + docs/diagrams。
 *
 * 目录不存在就跳过 —— docs 重组把顶层文件往 guide/ architecture/ 里搬, 搬之前搬之后
 * 这条闸都得能跑。台账子目录 (plan/ handoff/ notes/ ...) 一概不进。
 */
export function scanTargets(root: string): string[] {
  const out = ['README.md', 'README.zh-CN.md'];
  for (const dir of ['docs', join('docs', 'guide'), join('docs', 'architecture'), join('docs', 'diagrams')]) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const e of readdirSync(abs).sort()) {
      const p = join(abs, e);
      if (statSync(p).isFile() && e.endsWith('.md')) out.push(relative(root, p));
    }
  }
  return out.filter((p) => existsSync(join(root, p)));
}

/** src/mcp/ 下所有非测试 .ts 的全文 —— ② 的输入。 */
function mcpSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'src', 'mcp'));
  return out;
}

function main(): number {
  const docs: DocFile[] = scanTargets(ROOT).map((p) => ({ path: p, text: readFileSync(join(ROOT, p), 'utf8') }));
  const byPath = new Map(docs.map((d) => [d.path, d]));

  const onDisk = (p: string) => existsSync(join(ROOT, p));
  const registered = countRegisteredTools(mcpSources(ROOT));
  const anchorFindings = checkAnchors(docs, onDisk);
  const mermaidFindings = docs.flatMap(checkMermaid);
  const refFindings = checkRefs(docs, onDisk);

  const en = byPath.get('README.md');
  const zh = byPath.get('README.zh-CN.md');
  const toolFindings = en ? checkToolCount(en, registered) : [];
  const bilingualFindings = en && zh ? checkBilingualHeadings(en, zh) : [];

  // 名单只住在私有真源里; 公开仓 clone 出来跑本闸时它不存在 → null = 跳过, 不是通过。
  const whitelistPath = join(ROOT, '.dev', 'public-paths.txt');
  const whitelist = existsSync(whitelistPath) ? parseWhitelist(readFileSync(whitelistPath, 'utf8')) : null;
  const coverageFindings = checkPublicCoverage(docs, whitelist);
  const tableFindings = docs.flatMap(checkTables);

  const groups = [
    { label: `① 锚点存在 (扫到 ${countAnchors(docs)} 处 src/ · scripts/ 引用)`, findings: anchorFindings },
    { label: `② 工具数一致 (src/mcp/ 实际注册 ${registered} 个)`, findings: toolFindings },
    { label: `③ mermaid 健全 (${countMermaidBlocks(docs)} 个块; 轻量 lint, 非完整 parse)`, findings: mermaidFindings },
    {
      label: `④ 双语结构 (README.md ${en ? countH2(en.text) : '?'} 节 vs README.zh-CN.md ${zh ? countH2(zh.text) : '?'} 节)`,
      findings: bilingualFindings,
    },
    {
      label: `⑤ 引用可达 (${countRefs(docs, 'image')} 张仓内图片 + ${countRefs(docs, 'link')} 条仓内 md 链接)`,
      findings: refFindings,
    },
    {
      label:
        whitelist === null
          ? `⑥ 公开面覆盖 —— 跳过 (.dev/public-paths.txt 缺席; 这是私有真源才有的名单)`
          : `⑥ 公开面覆盖 (${countCoverageChecks(docs)} 条: 文档自身 + 指出去的仓内引用)`,
      findings: coverageFindings,
    },
    { label: `⑦ 表格完整 (${countTableRows(docs)} 行表格行, 列数逐表比对)`, findings: tableFindings },
  ];

  console.log(`docs-drift-check —— 扫描 ${docs.length} 份面向读者的文档 (docs/plan · docs/handoff 等台账区不扫)\n`);
  let total = 0;
  for (const g of groups) {
    total += g.findings.length;
    console.log(`${g.findings.length === 0 ? '✅' : '❌'} ${g.label}${g.findings.length ? ` —— ${g.findings.length} 处漂移` : ''}`);
    for (const f of g.findings) {
      console.log(`   ${f.file}${f.line ? `:${f.line}` : ''}`);
      console.log(`     是什么: ${f.what}`);
      console.log(`     怎么修: ${f.fix}`);
    }
  }

  console.log(total === 0 ? '\n全绿。' : `\n共 ${total} 处漂移 —— 文档在对读者说盘上没有的事。`);
  return total === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
