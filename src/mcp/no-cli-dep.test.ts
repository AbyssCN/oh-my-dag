/**
 * **源码级闸: 全仓不许碰 `pi-coding-agent`** (2026-08-01 升级; 原为「MCP 那条路径不许碰」)。
 *
 * ## 这条闸的两个时代
 *
 * **立闸时 (2026-08-01 上午)**: omd 还带交互式 TUI 前端, `tui.ts` 正当地 import 整个 CLI 包。
 * 于是闸只能守**MCP 那条路径** —— 从 `src/mcp/{server,assemble}.ts` 走 import 图, 图上命中即红。
 * 那次迁移把 agent leaf 从 CLI 包的高层门面搬到 `pi-agent-core` 的低层循环, MCP 入口从
 * **13.55 MB 掉到 6.87 MB**。
 *
 * **现在 (同日下午, 交接文 13)**: owner 裁决 **omd 收成纯 MCP**, TUI 前端整个出局,
 * `pi-coding-agent` 已从 `package.json` 移除 (`pi-tui` 随之消失)。保留面只剩
 * `pi-agent-core` (agent leaf 的 runAgentLoop) + `pi-ai` (provider 注册)。
 * 闸随之从「一条路径」升成「**全仓**」—— 这正是文件头当初写下的那一天。
 *
 * ## 为什么升级后反而更简单
 *
 * 守一条路径要走可达性 (谁 import 谁), 而**全仓不许碰**不需要图: 每个文件直接扫就行。
 * 顺带补掉旧版走图时的两个真实漏洞:
 *   · 旧 `SPEC_RE` 的 `from` 分支是惰性跨行匹配, 会把**裸副作用导入** (`import './x'`, 无 `from`)
 *     整条吃掉并错误捕获**下一行**的 specifier —— 于是 `import './拉进CLI的东西'` 对闸隐形;
 *   · 走图只覆盖"从入口够得着的", 够不着的角落 (被删前的 `*-extension.ts`) 天然逃逸。
 *
 * ## 判据是 import 说明符, 不是文本出现
 *
 * 本仓**大量文件头 prose 里写着 `pi-coding-agent`** (agent-leaf / execute-slice / web/index /
 * pi-transport / agent-tools / tui, 以及本文件) —— 它们记的是"为什么不用它"这段历史, 是资产不是违规。
 * 所以闸**先剥注释, 再只认真正的 import/export 语句** (同 `declared-deps.test.ts` 的判法)。
 * 拿文本 grep 当闸会把这些史料全判成红。
 *
 * ## 修法
 *
 * 红了不要把 import 改成 `import type` 糊过去 —— 今天 type-only, 明天有人在同一行加个值导入,
 * 它就悄悄回来了。正确的修法是**把要复用的东西搬出那个文件**, 老约定仍然有效:
 *   `execute-extension.ts` → `execute-slice.ts` · `pathfinder-extension.ts` → `pathfinder/maps.ts`
 *   · `hashline.ts` → `hashline-extension.ts` · `kimi-oauth.ts` → `kimi-oauth-extension.ts`
 *
 * ⚠ `experimental/` 不在扫描面内 (同 `declared-deps.test.ts`): 已按 ADR-0001/0002 移出编译面,
 *   允许 rot。里面 4 个停用件确实还 import 着 CLI 包 —— **复活它们时这条闸会立刻拦下, 那是对的**。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const FORBIDDEN = '@earendil-works/pi-coding-agent';
/** 扫描面: 会被发布或被测试跑到的全部源码。`experimental/` 刻意在外 (见文件头)。 */
const ROOTS = ['src', 'scripts', 'test'];

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/**
 * 一个文件里**真正被 import 的**模块说明符。
 * 先剥块注释/行注释 (文件头 prose 里的包名不算引用), 再只认三种真语句:
 * 行首静态 `import … from` / `export … from` · 行首裸副作用 `import '…'` · 动态 `import('…')`。
 */
export function importedSpecifiers(source: string): string[] {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [
    ...body.matchAll(/^\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/gm),
    ...body.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
}

/** 扫一批文件, 返回 {文件 → 命中的说明符}。 */
function offendersIn(files: string[]): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const f of files) {
    const bad = importedSpecifiers(readFileSync(f, 'utf8')).filter((s) => s.startsWith(FORBIDDEN));
    if (bad.length) hits.set(f, bad);
  }
  return hits;
}

describe('全仓对 pi-coding-agent 零引用', () => {
  it('★ src/ scripts/ test/ 下没有任何文件 import CLI 包', () => {
    const files = ROOTS.flatMap((r) => tsFiles(join(REPO, r)));
    // 扫描面本身要是活的 —— 打错路径导致"扫了 0 个文件"也会绿。
    expect(files.length).toBeGreaterThan(200);

    const offenders = offendersIn(files);
    const detail = [...offenders.entries()]
      .map(([f, specs]) => `  ${relative(REPO, f)}  ← ${specs.join(', ')}`)
      .join('\n');
    expect(
      offenders.size === 0
        ? ''
        : `${offenders.size} 个文件 import 了 ${FORBIDDEN}:\n${detail}\n` +
          '修法: 把要复用的东西从那个文件搬出来, 别把 import 改成 import type 糊过去 (见本文件头)。',
    ).toBe('');
  });

  it('闸本身是活的 —— 合成一个真 import CLI 包的文件, 必须抓得到', () => {
    // 反向自检。旧版拿 `tui.ts` 当阳性对照, 而 tui.ts 现在已经不 import CLI 包了 (它就是被砍的那个),
    // 对照物只能是合成的 —— 否则"全仓干净"会让这条自检永久失去判别力。
    //
    // ⚠ 引号刻意用 `${Q}` 拼而不是直接写: 这些 fixture 字符串**长得就像真 import 语句**,
    //   直接写会被隔壁 `declared-deps.test.ts` 的扫描器当成本文件真的依赖了 `${FORBIDDEN}`
    //   (实测它捞出的"包名"就是字面量 `${FORBIDDEN}`)。写进磁盘的内容仍是真语法, 本闸照抓不误。
    const Q = String.fromCharCode(39); // '
    const dir = mkdtempSync(join(tmpdir(), 'omd-no-cli-'));

    const f = join(dir, 'offender.ts');
    writeFileSync(f, `import { main } from ${Q}${FORBIDDEN}${Q};\nexport const x = main;\n`);
    expect(offendersIn([f]).size).toBe(1);

    // 三种真语句都要抓得到 (裸副作用导入是旧版的真实漏洞, 见文件头)。
    const bare = join(dir, 'bare.ts');
    writeFileSync(bare, `import ${Q}${FORBIDDEN}${Q};\nimport { z } from ${Q}./other${Q};\n`);
    expect(offendersIn([bare]).size).toBe(1);

    const dyn = join(dir, 'dyn.ts');
    writeFileSync(dyn, `export const load = () => import(${Q}${FORBIDDEN}${Q});\n`);
    expect(offendersIn([dyn]).size).toBe(1);
  });

  it('注释里的包名不算引用 —— 本仓文件头 prose 记着这段历史, 是资产不是违规', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-no-cli-prose-'));
    const f = join(dir, 'prose.ts');
    writeFileSync(
      f,
      `/**\n * 我们**不再**用 ${FORBIDDEN} —— 见 ADR。\n */\n// 也不从 ${FORBIDDEN} 导任何东西\nexport const x = 1;\n`,
    );
    expect(offendersIn([f]).size).toBe(0);
  });

  it('package.json 里也不许再声明这个依赖', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(FORBIDDEN);
  });
});
