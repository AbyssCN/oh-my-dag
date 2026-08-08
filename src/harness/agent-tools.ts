/**
 * src/harness/agent-tools —— agent leaf 的**自有工具集** (read / write / edit / ls / grep / bash)。
 *
 * 为什么自己长一套, 而不是继续借 `pi-coding-agent` 的:
 *   ① 那是 **CLI 包**的工具 —— 每个都拖着 TUI 渲染 (`renderCall`/`renderResult`/主题/高亮), 而 headless
 *      leaf 一行都用不上; 为了拿工具循环去依赖一个交互式前端, 是整个错配的源头。
 *   ② 闸的位置不对。此前命令白名单 / `dangerous-cmd` / 凭证 basename 拒是靠 `tool-gate` extension
 *      **从外面贴**在通用工具上的 —— 贴上去的闸可以忘了贴 (`cat .env` 那个洞正是这么漏的:
 *      闸落在 command-leaf 的白名单上, agent leaf 的 bash 不经它)。
 *      **工具自己就是闸**的形态下, 拿到工具就拿到闸, 没有"忘了挂"这个状态。
 *
 * 底料取自 `pi-agent-core` 的 primitives (`NodeExecutionEnv` 执行环境 · `executeShellWithCapture`
 * 输出截断 · `truncateHead`/`truncateLine` 上限), 不是从零写 IO。
 *
 * 边界诚实 (同 command-leaf 头): 凭证拒是**护栏不是沙箱** —— `grep -r KEY .` 递归扫到 `.env` 仍会
 * 打印内容, `bun -e` 等价任意代码执行。它挡的是"模型顺手 cat 一下配置"这类手滑, 不是对抗性外泄。
 * 真隔离在 agent leaf 的 bwrap jail (hooks/sandboxed-leaf.ts)。
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  executeShellWithCapture,
  truncateHead,
  truncateLine,
} from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';
import { classifyCommand } from './hooks/dangerous-cmd';
import { secretPathInCommand, SECRET_BASENAMES, SECRET_BASENAME_EXEMPT } from './command-leaf';
import { logger } from '../logger';

/**
 * omd 工具 = `AgentTool` + 两个**给系统提示用**的可选字段。
 *
 * 这两个字段本是 pi CLI 的 `ToolDefinition` 才有的 (它拿去拼默认系统提示)。搬家后系统提示由
 * 我们自己拼 (`buildLeafSystemPrompt`), 于是字段也留在自己这边 —— 工具与"怎么跟模型介绍它"
 * 长在一起, 加一个工具不必再改第二处。
 */
export interface OmdTool<TDetails = unknown> extends AgentTool<TSchema, TDetails> {
  /** 系统提示「可用工具」段的一行说明。省略 = 不进那一段 (工具仍可调用)。 */
  promptSnippet?: string;
  /** 系统提示「守则」段追加的条目 (如 hashline 的用法铁律)。 */
  promptGuidelines?: string[];
}

/** 工具执行体的松类型面 —— 各工具 schema 各不同, 装进同一个数组时统一按这个形状看。 */
export type AnyOmdTool = OmdTool<any>;

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details };
}

/** 相对路径对 cwd 解析; 绝对路径原样 (沙箱由 bwrap jail 管, 不在这里拦)。 */
function abs(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** 展示用: 尽量给 cwd 相对路径 (逃出 cwd 的给绝对), 让模型看到的路径可直接回填。 */
function display(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute;
}

/**
 * **凭证文件拒** —— 判据是 basename, 与 command-leaf 同一张表 (`SECRET_BASENAMES`)。
 * 两处各写一份早晚一份先漂, 而漂掉的那份就是下一个 `cat .env`。
 * (export 给 TUI 审批层的 `read_sensitive` 分类用 —— 同一个判据, 不抄第二份。)
 */
export function secretBasenameOf(path: string): string | null {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (SECRET_BASENAME_EXEMPT.test(base)) return null;
  return SECRET_BASENAMES.some((re: RegExp) => re.test(base)) ? base : null;
}

/**
 * 凭证文件**只告警不拦**(owner 2026-08-07 裁决:「去掉这个」)。
 *
 * ## 原来是硬抛, 代价是真的
 *
 * `read` 按 basename 拒、`bash` 把命令按 `;&|` 拆段逐段拒 —— 于是"看一眼 .env 里那一项
 * 是不是配错了"这种**正当排查**也被一并挡死。而它挡的从来只是"模型顺手 cat 一下配置"
 * 这类手滑:同一张表按**文件名**判、不按**内容**判,`grep -r SECRET .` 照样打印命中行,
 * `node -e` 一旦成立读什么都不过这张表。**挡不住对抗,只挡得住手滑** —— 代价却是常规能力。
 *
 * ## 但不许吞证据
 *
 * 告警行原样留着:读过哪个凭证文件必须在日志里看得见。fail-open 可以吞异常, 不许吞证据。
 *
 * ## 它该去哪
 *
 * 正确的形态是审批层的 `read_sensitive` 档(先给预览、要继续才审批)——
 * 见 `docs/design/2026-08-07-omd-agent-架构与-tui-设计稿.html` 第八节。
 * 那一档做出来之后, 这里改成"报给审批层"而不是"直接放行"。
 * ⚠ **command-leaf 那一层的同名闸没有动**:它管的是 DAG 验收命令, 与对话位的手是两回事。
 */
function warnSecret(path: string): void {
  const base = secretBasenameOf(path);
  logger.warn({ path, base }, '[omd/agent-tools] 读了凭证文件 (只告警不拦; 审批层做出来后改走 read_sensitive)');
}

// ── 目录遍历 (grep / 隐式扫描共用) ─────────────────────────────────────────────

/**
 * 遍历默认跳过的目录名 —— 扫进去只会把真命中淹掉 (且 node_modules 动辄十万文件)。
 *
 * export 是给 `scripts/probes/repo-file-count.ts` 用的:「这个仓离遍历上限还有多远」
 * 必须按**实装的同一张表**算, 探针里抄一份就会与 agent 真正走的树漂开。
 */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '.venv',
  '__pycache__', 'target', 'vendor',
]);

/**
 * 跳不跳这个目录。**不是纯精确匹配** —— 精确匹配漏掉了 Python 虚拟环境的全部变体。
 *
 * ## 实测(2026-08-08,本机四个仓)
 *
 * `SKIP_DIRS` 里只有 `.venv`,而真实世界的名字是 `.venv-crawl4ai` / `.venv-seuranta` /
 * `.venv-pg` —— **精确匹配一个都没拦住**,三个仓各有 1–2 个逃出去:
 *
 * | 仓 | 逃出去的 |
 * |---|---|
 * | talous-v2 | `.venv-seuranta` · `.venv-crawl4ai` |
 * | fusang | `.venv-pg` |
 * | bluebell | `.venv-seuranta` |
 *
 * 代价是可量的:`talous-v2` 的 `.venv-crawl4ai` 一个目录就占该仓 SKIP_DIRS 口径文件数的
 * **58%**(11,150 / 19,177)—— 遍历预算全烧在 `site-packages` 上,而那里面**没有一行**
 * 是这个仓的代码。
 *
 * ⚠ 收敛处**要求分隔符**(`venv` 后面必须是结尾或 `-._`),所以 `venvironment/` 这类
 * 正常源码目录不会被误跳。反测钉了这一条。
 */
export function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return /^\.?venv($|[-._])/.test(name);
}

/** 简易 glob → RegExp (`*` 不跨 `/`, `**` 跨, `?` 单字符)。够 `*.ts` / `src/**\/*.test.ts` 用。 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` 也匹配零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

/**
 * 遍历结果。**`capped` 必须往上报** —— 见下面那段。
 */
export interface WalkResult {
  files: string[];
  /** 走到 `limit` 就停了 = **命中可能不全**。`false` 才代表"整棵树都走过了"。 */
  capped: boolean;
}

/**
 * 走一棵树,最多 `limit` 个文件。
 *
 * ## ★ 2026-08-08:这里原来**吞证据**
 *
 * 老版签名是 `Promise<string[]>`,走到 20_000 就 `return out`,**没有任何回报**。
 * 于是 `grep` 在大仓里会报 `(无命中)`,而真相是"needle 在盘上,只是没走到那儿" ——
 * 而 agent 收到"无命中"的合理反应就是**认定这个符号不存在**。
 *
 * 实测(单一变量 = 文件数,`/tmp/omd-scale/probe2.ts`):
 *
 * | 盘上文件数 | grep 走到并命中 | 漏 | 输出提到上限了吗 |
 * |---|---|---|---|
 * | 5,000 | 5,000 | 0 | — |
 * | 25,000 | **20,000** | **5,000** | **一个字都没说** |
 *
 * 而且不是假想:本机 `repos/talous-v2` 去掉 SKIP_DIRS 之后 **19,177** 个文件 = 上限的 96%。
 *
 * ⇒ 本仓 §3.2「**fail-open 可以吞异常,不许吞证据**」的一条实例。修法不是把上限调大
 * (那只是把同一个静默失效推远一点),是**让它说出来**。
 *
 * ## `filter` 在**走的时候**就用上,不是走完再筛
 *
 * 老版是 `walkFiles(...)` 之后再 `files.filter(globRe)` —— 于是 `grep(x, glob:'*.ts')`
 * 在大仓里先走 20_000 个**任意**文件(哈希序,不是你想要的那 20_000 个)再筛,
 * **glob 一点都帮不上逃出上限**。现在 filter 进了走的过程,上限只数候选文件。
 */
async function walkFiles(root: string, limit: number, filter?: (path: string) => boolean): Promise<WalkResult> {
  const out: string[] = [];
  const stack = [root];
  // ★ 多收**一个**再判:`out.length > limit` 才叫"还有更多"。
  //   直接在 `>= limit` 处 return 分不开"刚好 limit 个"与"还有第 limit+1 个" ——
  //   而那两件事一个该报 capped 一个不该(本仓 NULL ≠ 0 的同一条:别把两种状态抹成一种)。
  const probe = limit + 1;
  outer: while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不动的目录跳过 (权限/竞态) —— 检索 fail-open
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!shouldSkipDir(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (filter && !filter(full)) continue;
        out.push(full);
        if (out.length >= probe) break outer;
      }
    }
  }
  if (out.length > limit) return { files: out.slice(0, limit), capped: true };
  return { files: out, capped: false };
}

// ── 工具 schema ────────────────────────────────────────────────────────────────

const READ_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to read (relative to the working root, or absolute).' }),
  offset: Type.Optional(Type.Number({ description: 'First line to read (1-indexed). Default 1.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read.' })),
});
const WRITE_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to write (relative or absolute). Parent dirs are created.' }),
  content: Type.String({ description: 'Full file content.' }),
});
const EDIT_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to edit (relative or absolute).' }),
  oldText: Type.String({ description: 'Exact text to replace. Must occur exactly once in the file.' }),
  newText: Type.String({ description: 'Replacement text.' }),
});
const LS_SCHEMA = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory to list. Default: working root.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum entries to return. Default 500.' })),
});
const GREP_SCHEMA = Type.Object({
  pattern: Type.String({ description: 'Regular expression (JS syntax) to search for.' }),
  path: Type.Optional(Type.String({ description: 'File or directory to search. Default: working root.' })),
  glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts'." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive match. Default false.' })),
  literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as a literal string. Default false.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum matches to return. Default 100.' })),
});
const BASH_SCHEMA = Type.Object({
  command: Type.String({ description: 'Shell command to run in the working root.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds. Default 120.' })),
});

export interface OmdAgentToolsOpts {
  /** 工作根。相对路径对它解析, bash 在它里面跑。 */
  cwd: string;
  /** bash 不可逆命令 fail-closed 闸。默认 true (安全侧); false = 逃生关闸。 */
  dangerousCommandGuard?: boolean;
  /** bash 单条命令默认超时 (秒)。默认 120。 */
  bashTimeoutSec?: number;
  /**
   * `grep` 一次最多走多少个文件。默认 {@link GREP_WALK_LIMIT}。
   *
   * ⚠ **存在的理由是"让上限可测"**,不是给人调的旋钮:上限一旦静默,症状就是
   * 大仓里 `(无命中)` 骗过 agent(见 `walkFiles` 文件注释里的实测表)。
   * 真要在生产里改这个数,先量一遍时间与内存 —— 别照猜改。
   */
  grepWalkLimit?: number;
}

/**
 * `grep` 的遍历上限。
 *
 * ⚠ **这个数没有被论证过,它是个够用的护栏**:本机最大的仓
 * (`repos/talous-v2`,去掉 SKIP_DIRS)是 **19,177** 个文件 = 上限的 96% ——
 * 也就是说**再大一点的仓就会撞上**。撞上不再是静默的(会带 `[⚠ 只走到前 N 个…]`),
 * 但"该调多大"仍是个没量过的问题,别在这里凭感觉加零。
 */
export const GREP_WALK_LIMIT = 20_000;

/**
 * 造一套 scope 到 cwd 的 agent 工具。**每个 leaf 建一份** (cwd 各不同, 且 NodeExecutionEnv 持
 * 子进程资源)。返回顺序即系统提示里的列举顺序。
 */
export function createOmdAgentTools(opts: OmdAgentToolsOpts): AnyOmdTool[] {
  const cwd = resolve(opts.cwd);
  const guardDangerous = opts.dangerousCommandGuard !== false;
  const defaultTimeout = opts.bashTimeoutSec ?? 120;
  const walkLimit = opts.grepWalkLimit ?? GREP_WALK_LIMIT;
  const env = new NodeExecutionEnv({ cwd });

  const read: OmdTool<{ path: string; lines: number; truncated: boolean }> = {
    name: 'read',
    label: 'read',
    description:
      `Read a text file. Output is truncated at ${DEFAULT_MAX_LINES} lines or ` +
      `${Math.round(DEFAULT_MAX_BYTES / 1024)}KB, whichever comes first — use offset/limit to page ` +
      'through large files. Lines are prefixed with their 1-indexed line number.',
    promptSnippet: 'read(path, offset?, limit?) — 读文件 (带行号)。别用 bash 的 cat/sed 代替。',
    parameters: READ_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { path, offset, limit } = params as Static<typeof READ_SCHEMA>;
      if (secretBasenameOf(path)) warnSecret(path);
      const full = abs(cwd, path);
      let raw: string;
      try {
        raw = await readFile(full, 'utf-8');
      } catch (err) {
        throw new Error(`read 失败: ${display(cwd, full)}: ${(err as Error).message}`);
      }
      const all = raw.split('\n');
      const start = offset && offset > 0 ? offset - 1 : 0;
      if (start >= all.length && all.length > 0) {
        throw new Error(`offset ${offset} 超出文件末尾 (共 ${all.length} 行)`);
      }
      const end = limit && limit > 0 ? Math.min(start + limit, all.length) : all.length;
      const body = all
        .slice(start, end)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n');
      const t = truncateHead(body);
      const note = t.truncated
        ? `\n[truncated: 只给了前 ${t.outputLines} 行, 共 ${all.length} 行 — 用 offset 继续读]`
        : '';
      return textResult(`${t.content}${note}`, { path: display(cwd, full), lines: all.length, truncated: t.truncated });
    },
  };

  const write: OmdTool<{ path: string; bytes: number }> = {
    name: 'write',
    label: 'write',
    description: 'Create a file or overwrite it in full. Parent directories are created as needed.',
    promptSnippet: 'write(path, content) — 新建文件 / 整体覆写。改已存在文件优先用行锚定 patch。',
    parameters: WRITE_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params) {
      const { path, content } = params as Static<typeof WRITE_SCHEMA>;
      const full = abs(cwd, path);
      const r = await env.writeFile(full, content);
      if (!r.ok) throw new Error(`write 失败: ${display(cwd, full)}: ${r.error.message}`);
      return textResult(`✓ 写入 ${display(cwd, full)} (${content.length} 字节)`, {
        path: display(cwd, full),
        bytes: content.length,
      });
    },
  };

  const edit: OmdTool<{ path: string; replaced: boolean }> = {
    name: 'edit',
    label: 'edit',
    description:
      'Replace one exact occurrence of oldText with newText in an existing file. ' +
      'oldText must appear exactly once — include enough surrounding context to make it unique.',
    promptSnippet: 'edit(path, oldText, newText) — 唯一匹配的精确替换。',
    parameters: EDIT_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params) {
      const { path, oldText, newText } = params as Static<typeof EDIT_SCHEMA>;
      const full = abs(cwd, path);
      let raw: string;
      try {
        raw = await readFile(full, 'utf-8');
      } catch (err) {
        throw new Error(`edit 失败 (读不到): ${display(cwd, full)}: ${(err as Error).message}`);
      }
      const first = raw.indexOf(oldText);
      if (first === -1) throw new Error(`edit 失败: oldText 在 ${display(cwd, full)} 中找不到 (逐字匹配, 含空白)`);
      if (raw.indexOf(oldText, first + 1) !== -1) {
        throw new Error(`edit 失败: oldText 在 ${display(cwd, full)} 中出现多次 — 补足上下文使其唯一`);
      }
      const next = `${raw.slice(0, first)}${newText}${raw.slice(first + oldText.length)}`;
      const w = await env.writeFile(full, next);
      if (!w.ok) throw new Error(`edit 失败 (写回): ${display(cwd, full)}: ${w.error.message}`);
      return textResult(`✓ 已替换 ${display(cwd, full)} 中 1 处`, { path: display(cwd, full), replaced: true });
    },
  };

  const ls: OmdTool<{ path: string; count: number }> = {
    name: 'ls',
    label: 'ls',
    description: 'List the direct children of a directory. Directories are suffixed with "/".',
    promptSnippet: 'ls(path?) — 列目录直接子项。',
    parameters: LS_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { path, limit } = params as Static<typeof LS_SCHEMA>;
      const full = abs(cwd, path ?? '.');
      const r = await env.listDir(full);
      if (!r.ok) throw new Error(`ls 失败: ${display(cwd, full)}: ${r.error.message}`);
      const cap = limit && limit > 0 ? limit : 500;
      const entries = r.value
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name));
      const shown = entries.slice(0, cap);
      const more = entries.length > shown.length ? `\n… 还有 ${entries.length - shown.length} 项 (调大 limit)` : '';
      return textResult(`${display(cwd, full)}:\n${shown.join('\n')}${more}`, {
        path: display(cwd, full),
        count: entries.length,
      });
    },
  };

  const grep: OmdTool<{ matches: number; files: number; walked: number; walkCapped: boolean }> = {
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents by regular expression. Skips .git/node_modules/build output. ' +
      'Returns "path:line: text" per match. Use it to find literal text — for symbol definitions ' +
      'and call graphs prefer codegraph via bash.',
    promptSnippet: 'grep(pattern, path?, glob?) — 按正则找文本, 返 `路径:行号: 内容`。',
    parameters: GREP_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { pattern, path, glob, ignoreCase, literal, limit } = params as Static<typeof GREP_SCHEMA>;
      const cap = limit && limit > 0 ? limit : 100;
      const root = abs(cwd, path ?? '.');
      let re: RegExp;
      try {
        const src = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
        re = new RegExp(src, ignoreCase ? 'i' : '');
      } catch (err) {
        throw new Error(`grep 失败: 正则不合法 ${pattern}: ${(err as Error).message}`);
      }
      const globRe = glob ? globToRegExp(glob) : null;
      const info = await stat(root).catch(() => null);
      if (!info) throw new Error(`grep 失败: 路径不存在 ${display(cwd, root)}`);
      // glob 进遍历(不是走完再筛)—— 否则上限数的是**任意** 20_000 个文件, glob 帮不上忙。
      const walked = info.isDirectory()
        ? await walkFiles(root, walkLimit, globRe ? (f) => globRe.test(f.split(sep).join('/')) : undefined)
        : { files: [root], capped: false };
      const files = walked.files;
      const hits: string[] = [];
      let filesWithHits = 0;
      for (const f of files) {
        if (hits.length >= cap) break;
        let content: string;
        try {
          content = await readFile(f, 'utf-8');
        } catch {
          continue; // 二进制/权限 → 跳过, 检索 fail-open
        }
        if (content.includes('\u0000')) continue; // NUL = 二进制, 别把它的"行"倒进上下文
        let hitHere = false;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (!re.test(lines[i]!)) continue;
          hitHere = true;
          hits.push(`${display(cwd, f)}:${i + 1}: ${truncateLine(lines[i]!, GREP_MAX_LINE_LENGTH).text}`);
        }
        if (hitHere) filesWithHits++;
      }
      const head = hits.length === 0 ? `(无命中) ${pattern}` : hits.join('\n');
      const more = hits.length >= cap ? `\n[已达 limit ${cap}, 可能还有更多命中]` : '';
      /**
       * ★ **走到上限必须说出来** —— 尤其在 `(无命中)` 那一支上。
       *
       * 「没走到那儿」与「那儿没有」是两件事,抹成一句 `(无命中)` 之后,agent 收到的
       * 是"这个符号不存在"这个**错误结论**,而它没有任何线索去怀疑。
       */
      const cut = walked.capped
        ? `\n[⚠ 只走到前 ${files.length} 个文件就到遍历上限了 —— **命中很可能不全**` +
          `${hits.length === 0 ? '(上面那句"无命中"因此不代表它不存在)' : ''}。用 path= 收窄目录, 或 glob= 收窄文件名]`
        : '';
      return textResult(`${head}${more}${cut}`, {
        matches: hits.length,
        files: filesWithHits,
        // 走了几个 / 有没有被截 —— 让调用方也能程序化地看见, 不只靠读那句话。
        walked: files.length,
        walkCapped: walked.capped,
      });
    },
  };

  const bash: OmdTool<{ exitCode: number | undefined; truncated: boolean }> = {
    name: 'bash',
    label: 'bash',
    description:
      'Run a shell command in the working root. Irreversible commands (rm -rf /, git push --force, ' +
      'DROP TABLE, …) and commands that read credential files are refused.',
    promptSnippet: 'bash(command, timeout?) — 在工作根跑 shell (不可逆命令与读凭证文件会被拒)。',
    parameters: BASH_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      const { command, timeout } = params as Static<typeof BASH_SCHEMA>;
      // ① 不可逆命令 fail-closed (与 command-leaf 共用同一个分类器)。分类器抛错也算拦 ——
      //    fail-closed 契约不能因为异常就变成 fail-open。
      if (guardDangerous) {
        let dangerous: ReturnType<typeof classifyCommand>;
        try {
          dangerous = classifyCommand(command);
        } catch (err) {
          logger.error({ command, err: (err as Error).message }, '[omd/agent-tools] 命令分类器异常 → 拦');
          throw new Error('BLOCKED: 命令分类器异常 (fail-closed)');
        }
        if (dangerous.dangerous) {
          logger.warn({ command, label: dangerous.label }, '[omd/agent-tools] 危险命令拦截 (fail-closed)');
          throw new Error(`BLOCKED 不可逆命令 [${dangerous.label}]: ${dangerous.reason}`);
        }
      }
      // ② 凭证文件拒: 按 shell 分隔符拆段逐段查 —— `ls && cat .env` 的尾环也要被看见。
      //    (`secretPathInCommand` 跳过每段首 token = bin, 故必须先拆段再喂。)
      for (const seg of command.split(/[;&|]+|\n/)) {
        const s = seg.trim();
        if (!s) continue;
        const secret = secretPathInCommand(s);
        if (secret) warnSecret(secret);
      }
      const r = await executeShellWithCapture(env, command, {
        timeout: timeout && timeout > 0 ? timeout : defaultTimeout,
        ...(signal ? { abortSignal: signal } : {}),
      });
      if (!r.ok) throw new Error(`bash 失败: ${r.error.message}`);
      const { output, exitCode, cancelled, truncated } = r.value;
      const tail = [
        cancelled ? '[命令被中止]' : '',
        exitCode !== undefined && exitCode !== 0 ? `[exit ${exitCode}]` : '',
        truncated ? '[输出已截断, 只保留尾部]' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return textResult(`${output}${tail ? `\n${tail}` : ''}`, { exitCode, truncated });
    },
  };

  return [read, write, edit, ls, grep, bash];
}
