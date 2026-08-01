/**
 * **源码级闸: `src/` 里 import 的每个外部包都必须在 package.json 里声明** (2026-08-01)。
 *
 * ## 起因
 *
 * `@earendil-works/pi-agent-core` 被 `agent-leaf.ts` / `agent-tools.ts` 直接 import(还用了子路径
 * `/node`), 却**不在 dependencies 里**。能装上纯粹因为 `pi-coding-agent` 依赖它, 包管理器把它
 * 提升到了我们够得着的位置 —— 也就是说, 我们对**拿到哪个版本**没有任何话语权。
 *
 * 这类"借来的依赖"会在四种情况下咬人, 而且**四种都没有红灯**:
 *   ① 上游哪天不再依赖它(改名/内联/换实现)→ import 直接找不到模块;
 *   ② 版本由别人决定 —— 上游把它升到下一个 minor 并改了签名, 我们一个字没改就继承了;
 *   ③ 严格包管理器(pnpm / npm 隔离模式)**不允许** import 未声明的依赖, 别人一装就硬失败;
 *   ④ 我们的 `files` 字段发布 `src/` —— 装了这个包的人拿到的源码 import 了一个我们没声明的东西。
 *
 * ## 为什么是闸而不是"记得加"
 *
 * 这条不是"某个包漏了", 是**一整类**: 任何一次新 import 都可能再漏一个, 而漏了的症状
 * (在别人的机器上、或上游动手时才炸)离原因很远。人记不住, 让测试记 —— 同 `no-cli-dep.test.ts`。
 *
 * ## 判据
 *
 * 走 `src/` 全部 `.ts`(含测试)的 import 说明符, 取裸包名(`@scope/name` 或 `name`, 子路径剥掉),
 * 排除相对路径、`node:` 内置、bun 内置。剩下的必须出现在 `dependencies` ∪ `devDependencies`。
 *
 * `experimental/` 不在扫描面内 —— 它已按 ADR-0001 移出编译面, 允许 rot。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** import 说明符 → 裸包名。相对路径/内置 → null。 */
function bareName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('node:') || spec.startsWith('bun:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** bun 自带、无需声明的运行时全局模块。 */
const BUILTIN = new Set(['bun', 'bun:test', 'bun:sqlite', 'bun:ffi', 'bun:jsc']);

describe('依赖声明闸', () => {
  test('src/ 里 import 的每个外部包都在 package.json 里声明', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

    const undeclared = new Map<string, string[]>(); // 包名 → 用它的文件
    for (const file of tsFiles(join(ROOT, 'src'))) {
      // 先剥注释再扫 —— 注释里的示例 import(本仓文件头很爱写)会被当成真依赖。
      const body = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // 只认**真正的 import/export 语句**: 行首的静态导入(含 `export … from`)、行首的副作用导入、
      // 以及动态 `import('…')`。此前用宽松的 `from|import + 引号` 会把模板串、prose、`.map()` 链里的
      // 引号一起吃进来(第一版实测捞出 `https:` / `png-bytes` / `,` 这类垃圾)。
      const specs = [
        ...body.matchAll(/^\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/gm),
        ...body.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
        ...body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];
      for (const m of specs) {
        const spec = m[1]!;
        if (BUILTIN.has(spec)) continue;
        if (spec.includes('://')) continue; // URL 导入(生成的 HTML 里的 CDN <script>)不是包依赖
        const name = bareName(spec);
        if (!name || declared.has(name)) continue;
        const rel = file.slice(ROOT.length);
        const arr = undeclared.get(name) ?? [];
        if (!arr.includes(rel)) arr.push(rel);
        undeclared.set(name, arr);
      }
    }

    // 报出来的信息要**直接可行动**: 哪个包、被谁 import、怎么修。
    const detail = [...undeclared.entries()]
      .map(([name, files]) => `  ${name}  ← ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}`)
      .join('\n');
    expect(
      undeclared.size === 0 ? '' : `以下包被 src/ import 但没在 package.json 声明 (借的是别人的传递依赖):\n${detail}\n修法: 把它加进 dependencies, 版本取当前实装值。`,
    ).toBe('');
  });

  /**
   * 三个 pi 包是**同版本齐发**的(pi-ai / pi-agent-core / pi-coding-agent 现均为 0.80.10)。
   * 版本区间写歪一个, 就会出现"两个 pi 包解析到不同 minor"的诡异局面, 而症状会伪装成别的东西。
   */
  test('三个 @earendil-works/pi-* 包的版本区间一致', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const ranges = Object.entries(pkg.dependencies).filter(([k]) => k.startsWith('@earendil-works/pi-'));
    expect(ranges.length).toBeGreaterThanOrEqual(3); // 少了说明有人把某个删了/改名了
    expect(new Set(ranges.map(([, v]) => v)).size).toBe(1);
  });
});
