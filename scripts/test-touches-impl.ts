#!/usr/bin/env bun
/**
 * scripts/test-touches-impl —— 「测试必须真的碰它声称测的模块」闸(2026-08-26)。
 *
 * 接线与 `jargon-scan` 同款: 进 `.omd-repo-checks.json`, leaf 收尾时以本次写集为输入跑一遍。
 *
 * ## 它防的是什么
 *
 * 阶梯 S2 片 3 的写集含 `src/harness/dag/engine.ts`, 交付的测试叫「engine 接线」、
 * 11 条用例全绿, 而它的 import 里**没有 engine** —— 只有片 1 的纯函数和两个类型。
 * 于是接线层真有一个 bug(座位坐标缺失时编占位串)时, 这 11 条一条都没红,
 * 最后是全量里的 seat 闸偶然抓到的。
 *
 * 测试与实装由同一次改动一起产出时会一起错、并且互相背书 —— 这是本仓写在
 * `.claude/CLAUDE.md` 里的静默坑 #3。机械闸挡不住「断言写反」那一层,
 * 但**能**挡住「整个模块碰都没碰」这一层, 而后者正是片 3 的形态。
 *
 * ## 判据(刻意取弱的一版)
 *
 * 写集里每个**有值导出**的实现文件, 必须被同一写集里的某个 `.test.ts` **值导入**。
 *   - `import type { … }` 不算触达: 只引类型不构成跑过它的代码。
 *   - 纯类型文件(没有值导出)豁免 —— 对它要求值导入是不可能满足的判据。
 *   - 写集里没有任何 `.test.ts` → 整片跳过。登记面收尾片、纯文档片天然没有测试,
 *     在这里拒是误杀;「该不该有测试」是契约段的活。
 *   - 既有测试也算数, 不是只认新建的。
 *
 * 为什么不更强(覆盖率 / 要求真调用被测函数): 那要跑起来才知道, 而这道闸要在 leaf 收尾时
 * 零成本静态判完。弱判据先立住。
 *
 * ⚠ 已知的弱处, 写在这里以免被当成强保证: `import { type A, B } from './x'` 这种
 * inline type 修饰的混合导入, 本闸按值导入算(整条 import 没有前置 `type` 关键字)。
 * 要收紧得上 AST, 那是下一版的事。
 *
 * 用法:
 *   bun run scripts/test-touches-impl.ts --files a.ts b.test.ts …
 * 退出码: 0 = 全过 · 1 = 有实现文件没被本次写集里的测试值导入。
 */
import { readFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';

export interface TouchFinding {
  /** 没被任何本次测试值导入的实现文件(仓根相对路径)。 */
  implFile: string;
  /** 同一写集里参与判定的测试文件, 给人一眼看出该往哪补。 */
  candidateTests: string[];
}

export interface TouchReport {
  findings: TouchFinding[];
  /** 参与判定的实现文件数(0 = 本次写集没有实现文件, 判定不适用 —— NULL ≠ 0)。 */
  implCount: number;
}

const isTest = (f: string): boolean => f.endsWith('.test.ts');
const isTs = (f: string): boolean => f.endsWith('.ts');

/** 有没有值导出。纯类型文件(只有 type / interface)返回 false。 */
export function hasValueExport(source: string): boolean {
  // export function|const|class|let|var|enum|default|async function —— 都是值。
  if (/^\s*export\s+(async\s+)?(function|const|class|let|var|enum|default)\b/m.test(source)) return true;
  // `export { a, b }` 里只要有一个不带 type 前缀就是值导出。
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    const names = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.some((n) => !n.startsWith('type '))) return true;
  }
  return false;
}

/** 一份源码里的**值导入**目标(相对说明符原文, 不含 `import type`)。 */
export function valueImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  // 整条 import 带前置 `type` 关键字的跳过; 其余算值导入。
  for (const m of source.matchAll(/^\s*import\s+(type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue;
    out.push(m[2]!);
  }
  return out;
}

/** 说明符 → 仓根相对路径。非相对说明符(包名)返回 null。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  return joined.endsWith('.ts') ? joined : `${joined}.ts`;
}

export function checkTestTouchesImpl(root: string, files: readonly string[]): TouchReport {
  const tests = files.filter((f) => isTest(f));
  const impls = files.filter((f) => isTs(f) && !isTest(f));
  // 写集里没有测试 → 判定不适用(不是「通过」, 是没问这个问题)。
  if (tests.length === 0) return { findings: [], implCount: impls.length };

  const touched = new Set<string>();
  for (const t of tests) {
    const p = posix.join(root, t);
    if (!existsSync(p)) continue; // 声明了要新建但还没写出来 —— 那由别的闸管
    for (const spec of valueImportSpecifiers(readFileSync(p, 'utf8'))) {
      const target = resolveSpec(t, spec);
      if (target) touched.add(target);
    }
  }

  const findings: TouchFinding[] = [];
  for (const impl of impls) {
    const p = posix.join(root, impl);
    if (!existsSync(p)) continue;
    if (!hasValueExport(readFileSync(p, 'utf8'))) continue; // 纯类型文件豁免
    if (touched.has(impl)) continue;
    findings.push({ implFile: impl, candidateTests: [...tests] });
  }
  return { findings, implCount: impls.length };
}

if (import.meta.main) {
  const argv = process.argv;
  const i = argv.indexOf('--files');
  const files: string[] = [];
  if (i >= 0) {
    for (const a of argv.slice(i + 1)) {
      if (a.startsWith('--')) break;
      files.push(a);
    }
  }
  if (files.length === 0) {
    process.stderr.write('用法: bun run scripts/test-touches-impl.ts --files <f1> <f2> …\n');
    process.exit(2);
  }
  const r = checkTestTouchesImpl(process.cwd(), files);
  if (r.findings.length === 0) {
    process.exit(0);
  }
  for (const f of r.findings) {
    process.stderr.write(
      `${f.implFile}: 本次写集里的测试没有一个**值导入**它 ` +
        `(参与判定的测试: ${f.candidateTests.join(' · ')})\n` +
        '  —— 名为「接线」而一条真路径都没跑的测试, 全绿也证明不了接线对。\n' +
        "  修法: 在其中一个测试里真正 import 并驱动它; 只 `import type` 不算触达。\n",
    );
  }
  process.stderr.write(`\n合计 ${r.findings.length} 个实现文件未被触达 / 共 ${r.implCount} 个\n`);
  process.exit(1);
}
