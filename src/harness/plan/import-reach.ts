/**
 * plan/import-reach —— **静态 import 图的可达性**(2026-08-03 从 `reachability.test.ts` 提取)。
 *
 * ## 为什么提取
 *
 * 这几个纯函数原本住在 `reachability.test.ts` 里,唯一的消费者是那条闸本身 ——
 * **机器造好了却只有一个测试在用**,那正是 S-1 的味道。而 `indirect` 档的实验
 * (`scripts/eval-blocking-classify.ts`)量到:模型判「改这个文件的后果可不可逆」时,
 * **穿不过 import 这一层** —— 间接可达的红线漏标 **100%**,给完整链则 100% 修好。
 * 也就是说这张图是第二个真消费者需要的东西,而它已经写好了。
 *
 * ⚠ **提取必须忠实**:原闸(`reachability.test.ts`)现在反过来 import 本模块,
 * 于是"抽出来的这份与原来行为一致"这件事**由那条闸自己保住** ——
 * 抄一份平行实现早晚先漂,而漂了没人知道。
 *
 * ## 诚实边界(逐字承自原闸)
 *
 * **只看静态 import 图。** 按路径字符串动态拉起来的东西它看不见 —— 这不是缺陷,
 * 是这类分析的天花板;原闸靠一张豁免名单处理那一类,本模块把这件事留给调用方。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** `from 'x'` / `import 'x'`(副作用)/ `import('x')` / `require('x')`。 */
export const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** 递归收 `.ts`(跳过 `node_modules` 与 `.test.ts`)。 */
export function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // 目录不在 = 没有文件, 不抛 (调用方多是采证据的路径)
  }
  for (const e of entries) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) tsFiles(p, acc);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
    } catch {
      /* 读不到的条目跳过 */
    }
  }
  return acc;
}

/** 相对 specifier → 真文件(裸 / `.ts` / `index.ts`)。非相对(裸包名)返 null。 */
export function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** 从给定根做 BFS, 返回可达文件绝对路径集(**含根自身**)。 */
export function reachableFrom(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = roots.filter((f) => existsSync(f));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    IMPORT_SPEC.lastIndex = 0;
    let src: string;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = IMPORT_SPEC.exec(src))) {
      const t = resolveSpec(f, m[1]!);
      if (t && !seen.has(t)) queue.push(t);
    }
  }
  return seen;
}
