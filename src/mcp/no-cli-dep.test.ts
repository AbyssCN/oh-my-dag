/**
 * **源码级闸: MCP 那条路径不许碰 `pi-coding-agent`** (2026-08-01)。
 *
 * ## 为什么要有这条闸而不是"注意一下"
 *
 * `pi-coding-agent` 是**交互式 CLI 包** —— steering 队列 / TUI 渲染 / 扩展运行时 / 资源加载器。
 * omd 的 MCP server 是零 UI 的 stdio 进程, 一样都用不上。2026-08-01 那次迁移把 agent leaf 从
 * 它的高层门面搬到 `pi-agent-core` 的低层循环, 打包出来的 MCP 入口从 **13.55 MB 掉到 6.87 MB**。
 *
 * 但"掉下来了"和"守得住"是两回事。这条依赖最容易以**最不起眼的方式**回来:
 *   · 某个 `*-extension.ts`(TUI 门面)里顺手多导出一个纯函数, MCP 侧图省事直接 import 那个文件 ——
 *     一个函数, 整个 CLI 包跟着进来, 而**没有任何红灯**;
 *   · 或者一个 barrel(`web/index.ts` 那样的)re-export 了 TUI 扩展, 谁 import 这个 barrel 谁中招。
 * 两种都在本轮真实发生过。**人是记不住这条的, 所以让测试记。**
 *
 * ## 判据是"能不能到达", 不是"是不是 type-only"
 *
 * `import type` 编译期就擦除了, 运行时确实为零 —— 但今天是 type-only, 明天有人在同一行加一个值导入,
 * 它就悄悄回来了。**闸按"图上到不到得了"判**, 于是不存在"这次是 type-only 所以放过"这种判断题。
 *
 * ## 修法
 *
 * 红了不要把 import 改成 `import type` 糊过去。正确的修法是**把要复用的东西搬出那个文件**:
 *   `execute-extension.ts` → `execute-slice.ts` · `pathfinder-extension.ts` → `pathfinder/maps.ts`
 *   · `hashline.ts` → `hashline-extension.ts` · `kimi-oauth.ts` → `kimi-oauth-extension.ts`
 * 约定: **`*-extension.ts` 只放 pi TUI 的门面, 能力本体住在别处。**
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
/** MCP 的两个真入口: server 注册工具面, assemble 装配引擎。 */
const ENTRIES = ['src/mcp/server.ts', 'src/mcp/assemble.ts'];
const FORBIDDEN = '@earendil-works/pi-coding-agent';

/** `import ... from 'x'` / `export ... from 'x'` / `await import('x')` 的模块说明符。 */
const SPEC_RE =
  /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(spec: string, from: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 从入口出发走静态 import 图; 返回 {命中文件 → 到它的链}。测试文件不进图 (它们不进生产 bundle)。 */
function reachableOffenders(entries: string[]): Map<string, string[]> {
  const seen = new Set<string>();
  const parent = new Map<string, string>();
  const hits = new Map<string, string[]>();

  const chainTo = (file: string): string[] => {
    const out = [file];
    let cur = file;
    while (parent.has(cur) && out.length < 20) {
      cur = parent.get(cur)!;
      out.push(cur);
    }
    return out.reverse().map((f) => relative(REPO, f));
  };

  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    SPEC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPEC_RE.exec(src))) {
      const spec = m[1] ?? m[2]!;
      if (spec.includes('pi-coding-agent')) {
        if (!hits.has(file)) hits.set(file, chainTo(file));
        continue;
      }
      const next = resolveLocal(spec, file);
      if (!next || next.endsWith('.test.ts')) continue;
      if (!parent.has(next)) parent.set(next, file);
      walk(next);
    }
  };

  for (const e of entries) walk(resolve(REPO, e));
  return hits;
}

describe('MCP 路径对 pi-coding-agent 零引用', () => {
  it('★ 从 MCP 入口走 import 图, 一个文件都不许引用 CLI 包', () => {
    const offenders = reachableOffenders(ENTRIES);
    const detail = [...offenders.values()]
      .map((chain) => `  ${chain.join('\n    → ')}`)
      .join('\n');
    expect(
      offenders.size === 0 ? '' : `MCP 路径上有 ${offenders.size} 个文件引用了 ${FORBIDDEN}:\n${detail}\n` +
        '修法: 把要复用的东西从那个 *-extension.ts 搬出来, 别把 import 改成 import type 糊过去 (见本文件头)。',
    ).toBe('');
  });

  it('闸本身是活的 —— 拿一个真引用 CLI 包的文件当入口, 必须抓得到', () => {
    // 反向自检: 没有这一条, 上面那条在"walker 根本没走起来"时也会绿。
    const offenders = reachableOffenders(['src/harness/tui.ts']);
    expect(offenders.size).toBeGreaterThan(0);
  });
});
