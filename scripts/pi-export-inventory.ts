#!/usr/bin/env bun
/**
 * pi-export-inventory —— **pi 四个包的逐条导出清单 + omd 用没用**(2026-08-14)。
 *
 * ## 为什么要有它
 *
 * owner 原话:「我需要对照分析每个导出的内容和接缝」。四个包合计上千个导出,
 * 手抄一份进台账必然做两件坏事:**抄的时候就漏**,以及**pi 升版之后无声地漂**。
 * 台账 §6 的不变量是「没记过的东西不存在」—— 而人手维护的清单撑不住这条。
 *
 * 所以清单**生成不手写**:这个脚本是那条不变量的执行体。台账里由人写的是**裁决与理由**,
 * 清单那半由它产。两半分开,漂的那半会被下一次运行当场冲掉。
 *
 * ## 口径(与 `docs/bars/pi-agent-core-模块台账.md` §5 逐字一致)
 *
 * 导出 = **唯一名字** · **排除 `testing/`** · **含 `export { … }` re-export**。
 * 三者少一个数就变(该 §5 记了三种口径的三个数)。这里照它,不另立一套。
 *
 * omd 用了 = `src/**\/*.ts` 里从该包 import 的具名符号。**先剥注释再解析** ——
 * import 列表里的注释会被切成假符号(台账实撞过:27 被读成 30)。
 *
 * ## 用法
 *
 * ```
 * bun run scripts/pi-export-inventory.ts                 # 摘要:每包 导出/已用/覆盖率
 * bun run scripts/pi-export-inventory.ts --md            # markdown 全表(喂台账)
 * bun run scripts/pi-export-inventory.ts --md pi-ai      # 只出一个包
 * bun run scripts/pi-export-inventory.ts --unused pi-tui # 只列没用的(裁决从这里开始写)
 * ```
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PI_PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui', 'pi-telemetry'] as const;
export type PiPackage = (typeof PI_PACKAGES)[number];

/** 一个导出的全部可机械取到的事实。裁决**不在这里** —— 那是台账里人写的。 */
export interface ExportRow {
  name: string;
  /** `function` / `class` / `const` / `interface` / `type` / `enum` / `re-export`。 */
  kind: string;
  /** 相对 `dist/` 的声明文件 —— 归族靠它(同目录 = 同一族)。 */
  file: string;
  /**
   * 族 = 声明文件所在的**目录全路径**(顶层文件归 `(root)`)。
   *
   * ⚠ 只取第一层目录**不够用**:`pi-agent-core` 全部 347 个导出会挤进
   * `(root)` 与 `harness` 两族,而 `harness/tools`(工具面)与 `harness/session`
   * (会话存储)是两件完全不同的事、两个不同的裁决 —— 归成一族就没法逐族写理由了。
   */
  family: string;
  /** 签名首行(截断)。**给人判"它是什么"用**,不是给机器比对的。 */
  signature: string;
  /** 紧邻上方 JSDoc 的第一句(有就有,没有就空 —— 不编)。 */
  doc: string;
  /** omd 有没有 import 它。 */
  used: boolean;
}

/** 递归收 `.d.ts`。排除 `testing/`(台账口径)。 */
function declFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'testing') walk(full);
      } else if (e.name.endsWith('.d.ts')) out.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return out.sort();
}

/** 紧邻某个下标上方的 JSDoc 第一句。找不到 → 空串(**不编一句**)。 */
function docAbove(src: string, at: number): string {
  const before = src.slice(0, at);
  const close = before.lastIndexOf('*/');
  if (close < 0) return '';
  // 声明与注释之间只许有空白 —— 中间隔着别的代码就不是它的注释。
  if (before.slice(close + 2).trim() !== '') return '';
  const open = before.lastIndexOf('/**', close);
  if (open < 0) return '';
  const body = before
    .slice(open + 3, close)
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean);
  const first = body.find((l) => !l.startsWith('@')) ?? '';
  return first.replace(/\s+/g, ' ').slice(0, 200);
}

/** 抽一个包的全部导出。 */
export function collectExports(pkg: PiPackage, nodeModules = 'node_modules'): ExportRow[] {
  const dist = join(nodeModules, '@earendil-works', pkg, 'dist');
  const rows = new Map<string, ExportRow>();
  const decl = /^export\s+(?:declare\s+)?(?:abstract\s+)?(function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const reexp = /^export\s*\{([^}]+)\}/gm;
  for (const f of declFiles(dist)) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(dist, f);
    const family = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(root)';
    for (const m of src.matchAll(decl)) {
      const [, kind, name] = m as unknown as [string, string, string];
      // 同名多处声明(重载 / 类型+值)只留第一处 —— 台账口径是"唯一名字"。
      if (rows.has(name)) continue;
      const lineEnd = src.indexOf('\n', m.index ?? 0);
      rows.set(name, {
        name,
        kind,
        file: rel,
        family,
        signature: src.slice(m.index ?? 0, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 240),
        doc: docAbove(src, m.index ?? 0),
        used: false,
      });
    }
    for (const g of src.matchAll(reexp)) {
      for (const part of (g[1] as string).split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim() ?? '';
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || rows.has(name)) continue;
        rows.set(name, { name, kind: 're-export', file: rel, family, signature: '', doc: '', used: false });
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

/**
 * omd 从某个包 import 了哪些具名符号。
 *
 * ⚠ **先剥注释**:import 列表里写注释会被 `split(',')` 切成假符号
 * (台账 2026-08-11 实撞:27 被读成 30)。剥完再拍平换行 —— 多行 import 占了大头
 * (那次实测:20 个符号里有 14 个在 3 处多行 import 里,单行 grep 只数出 6)。
 */
export function collectUsed(pkg: PiPackage, srcRoot = 'src'): Set<string> {
  const used = new Set<string>();
  const pat = new RegExp(`import\\s+(?:type\\s+)?\\{([^{}]*)\\}\\s*from\\s*'@earendil-works/${pkg}[^']*'`, 'g');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) {
        let src = readFileSync(full, 'utf8');
        src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        for (const m of src.replace(/\n/g, ' ').matchAll(pat)) {
          for (const part of (m[1] as string).split(',')) {
            const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '';
            if (/^[A-Za-z_$][\w$]*$/.test(n)) used.add(n);
          }
        }
      }
    }
  };
  if (statSync(srcRoot, { throwIfNoEntry: false })) walk(srcRoot);
  return used;
}

export function inventory(pkg: PiPackage): ExportRow[] {
  const used = collectUsed(pkg);
  return collectExports(pkg).map((r) => ({ ...r, used: used.has(r.name) }));
}

/** markdown 全表 —— 直接贴进台账的那一半(裁决列留空由人填)。 */
function toMarkdown(pkg: PiPackage, rows: ExportRow[], onlyUnused: boolean): string {
  const out: string[] = [];
  const families = [...new Set(rows.map((r) => r.family))].sort();
  for (const fam of families) {
    const inFam = rows.filter((r) => r.family === fam && (!onlyUnused || !r.used));
    if (inFam.length === 0) continue;
    const total = rows.filter((r) => r.family === fam).length;
    const usedN = rows.filter((r) => r.family === fam && r.used).length;
    out.push(`\n#### \`${pkg}/${fam}\` —— ${total} 个导出, omd 用了 ${usedN}\n`);
    out.push('| 导出 | 种类 | omd | 它提供什么 | 裁决与理由 |');
    out.push('|---|---|:--:|---|---|');
    for (const r of inFam) {
      const cap = (r.doc || r.signature.replace(/^export\s+(declare\s+)?/, '')).replace(/\|/g, '\\|').slice(0, 150);
      out.push(`| \`${r.name}\` | ${r.kind} | ${r.used ? '✅' : '—'} | ${cap} | |`);
    }
  }
  return out.join('\n');
}

/**
 * 生成的表写进 `docs/bars/pi-导出全表.md`。
 *
 * ⚠ **只覆盖生成段**(`<!-- GENERATED:BEGIN -->` … `:END`),标记之外的人写文字原样保留 ——
 * 裁决与理由是人写的那一半,被生成器冲掉的话这份台账第二天就没人信了。
 * 标记不存在 = 整份重写(首次生成)。
 */
function writeInventoryFile(path: string): void {
  const BEGIN = '<!-- GENERATED:BEGIN 本段由 scripts/pi-export-inventory.ts 产, 手改会被下次运行冲掉 -->';
  const END = '<!-- GENERATED:END -->';
  const body = [BEGIN, '', `> 生成于 pi 当前版本;数与口径见本文件头。**裁决写在标记之外**。`, ''];
  for (const pkg of PI_PACKAGES) {
    const rows = inventory(pkg);
    const usedN = rows.filter((r) => r.used).length;
    body.push(`\n### \`${pkg}\` —— ${rows.length} 个导出, omd 用了 ${usedN}`);
    body.push(toMarkdown(pkg, rows, false));
  }
  body.push('', END);
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    /* 首次生成 */
  }
  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  const next = i >= 0 && j > i ? existing.slice(0, i) + body.join('\n') + existing.slice(j + END.length) : body.join('\n');
  writeFileSync(path, next);
  console.log(`写入 ${path}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const md = args.includes('--md');
  if (args.includes('--write')) {
    writeInventoryFile('docs/bars/pi-导出全表.md');
    process.exit(0);
  }
  const onlyUnused = args.includes('--unused');
  const pick = args.find((a) => (PI_PACKAGES as readonly string[]).includes(a)) as PiPackage | undefined;
  const targets = pick ? [pick] : [...PI_PACKAGES];

  if (!md && !onlyUnused) {
    console.log(`${'包'.padEnd(16)}${'导出'.padStart(8)}${'omd 用了'.padStart(10)}${'覆盖率'.padStart(9)}   族数`);
    for (const pkg of targets) {
      const rows = inventory(pkg);
      const usedN = rows.filter((r) => r.used).length;
      const fams = new Set(rows.map((r) => r.family)).size;
      const pct = rows.length ? ((usedN / rows.length) * 100).toFixed(1) : '0.0';
      console.log(`${pkg.padEnd(16)}${String(rows.length).padStart(8)}${String(usedN).padStart(10)}${`${pct}%`.padStart(9)}   ${fams}`);
    }
    console.log('\n⚠ 覆盖率低**不等于**有欠账 —— 大半导出是类型与内部件。');
    console.log('   逐条裁决看 docs/bars/*-模块台账.md;这里只给可复跑的底数。');
  } else {
    for (const pkg of targets) console.log(toMarkdown(pkg, inventory(pkg), onlyUnused));
  }
}
