/**
 * src/tui/context —— **conductor 的 system prompt 装配**(TUI SDD §5,切片 S4)。
 *
 * ## 今天缺的那块(SDD §5.1 实测,不是推测)
 *
 * `loadProjectContext(cwd)`(`agent-leaf.ts:310`)逐级向上找 `AGENTS.md` / `CLAUDE.md`,
 * **只看目录下**。而两份 harness 都不在那条路上:项目那份在 `<repo>/.claude/CLAUDE.md`,
 * 全局那份在 `~/.claude/CLAUDE.md`。⇒ 在 omd 仓里 `loadProjectContext` 返回**空数组**,
 * owner 要的两份 harness 一个字都没进过 conductor 的 system prompt。
 *
 * ## 为什么不直接改 `loadProjectContext`(SDD §5.2)
 *
 * 它同时是 `buildLeafSystemPrompt` 的输入,而那段是**每个 leaf 请求的冻结前缀** ——
 * 改它 = 全 leaf 的 prompt-cache 失效(实测宽扇出命中 84~98%)。为一个前端的需求去动
 * 全车队的缓存前缀,代价和收益不成比例。所以这里是**另加一条装配**,不动共享加载器。
 *
 * ## 顺序 = 全局 → 向上链 → 项目
 *
 * 与 CLAUDE.md 的既有语义一致:**后者覆盖前者**,越靠近当前仓的越晚出现、越有效。
 * 读不到就跳过 —— 上下文缺席不是错误(同 `loadProjectContext` 的语义)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadProjectContext } from '../harness/agent-leaf';

export interface ContextFile {
  path: string;
  content: string;
}

/** 读不到就返回空数组 —— 调用点用展开语法拼,免得每处都写一个 if。 */
function tryRead(path: string): ContextFile[] {
  try {
    return [{ path, content: readFileSync(path, 'utf-8') }];
  } catch {
    /* 缺席不是错误。这里刻意不记日志: 大多数仓都没有 .claude/, 记了就是每次启动一行噪声 */
    return [];
  }
}

/**
 * 从 `cwd` 逐级向上找**最近的**含 `.git` 的目录。找不到返回 `null`。
 *
 * ⚠ 返回 `null` 与返回 cwd **不是**一回事:前者是"这里不是 git 仓,没有项目 harness 可谈",
 * 后者会让我们去读一个不存在的 `<cwd>/.claude/CLAUDE.md` 并把"没读到"记成同一种结果。
 */
export function findRepoRoot(cwd: string, maxDepth = 32): string | null {
  let dir = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * TUI conductor 的上下文装配。
 *
 * @param opts.home `~` 的位置。**注入是为了可测** —— 不注入的话这个函数会读到跑测试那台
 *   机器上的真 `~/.claude/CLAUDE.md`,断言就成了"取决于谁在跑"。
 */
export function loadConductorContext(cwd: string, opts: { home?: string } = {}): ContextFile[] {
  const home = opts.home ?? homedir();
  const root = findRepoRoot(cwd);
  const all = [
    ...tryRead(join(home, '.claude', 'CLAUDE.md')), // 全局 harness
    ...loadProjectContext(cwd), // 既有: 逐级向上的 AGENTS.md / CLAUDE.md
    ...(root ? tryRead(join(root, '.claude', 'CLAUDE.md')) : []), // 项目 harness
  ];
  // 同一个文件被两条路命中时只留一份 (例:仓根就是 home)。内容相同,留哪个位置不影响装配结果。
  const seen = new Set<string>();
  return all.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

/**
 * 装配结果的**一行摘要**,给 TUI 头部显示。
 *
 * 存在的理由不是好看:conductor 到底吃到了哪几份 harness,是一个**用户没法从别处看到、
 * 而错了会一路错下去**的事实。§5.1 那个"一个字都没进过"的洞正是因为它此前不可见。
 * 一份都没有时说的是**真值**(灰常量画法),不是编一个"已就绪"。
 *
 * 分隔符与省略号刻意用纯 ASCII —— 字形宽度白名单(S6)跑完之前不引入宽度可疑的字符。
 */
export function formatContextLine(files: ContextFile[], opts: { cwd: string; home?: string }): string {
  if (files.length === 0) return 'harness 0 份 (未找到 AGENTS.md / CLAUDE.md)';
  const home = opts.home ?? homedir();
  const short = (p: string) =>
    p.startsWith(`${opts.cwd}/`) ? p.slice(opts.cwd.length + 1) : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
  const MAX = 4;
  const shown = files.slice(0, MAX).map((f) => short(f.path));
  const rest = files.length - shown.length;
  return `harness ${files.length} 份: ${shown.join(', ')}${rest > 0 ? `, +${rest}` : ''}`;
}
