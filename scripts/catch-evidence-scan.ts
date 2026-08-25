#!/usr/bin/env bun
/**
 * catch-evidence-scan —— 「fail-open 可以吞异常, **不许吞证据**」那条纪律的机械面
 * (仓规 §静默坑 2;纯函数 + 薄 CLI,零模型调用、零建议、零改动)。
 *
 * ## 它治的是什么
 *
 * 规则在 `.claude/CLAUDE.md` 里写了很久:「每个 `catch {}` 至少留一行:runId / 状态 /
 * 错误原文」。2026-08-23 第一次量它:`src/` 非测试文件 **576 个 catch**,其中
 * **76 个空**、**286 个有体但不留证据** —— 63% 不合规。**散文写了三个月,实践没动。**
 *
 * ⇒ 所以它不能是硬闸(要先还 362 笔账),而是**绊线**:今天的数字钉死,**只许降不许涨**。
 * 每一个新写的沉默 catch 从此都要付一次代价 —— 这正是 `COVERAGE_DEBT` 那张表的形状。
 *
 * ## 判据(**刻意粗**,粗的地方写明)
 *
 * 一个 catch 算「留了证据」= 它的块里出现 `logger.` / `console.` / `throw` /
 * `process.stderr` / `reject(` 任一。
 * - ⚠ 会漏:把错误塞进返回值再由上层报的写法,这里算不合规(**宁可严不放过**,
 *   因为放过的那一类正是最难查的)。
 * - ⚠ 不扫 `*.test.ts`:这条纪律管的是**生产 fail-open 路径**,测试里 `catch {}` 常常
 *   就是被测行为本身。
 * - ⚠ 用 TS AST 不用正则啃(照 `gen-seam-catalog.ts` 的惯例)——正则分不清字符串里的
 *   `catch` 与真的 catch 子句。
 *
 * ## 跑法
 *
 *   bun run scripts/catch-evidence-scan.ts            # 扫 src/,印读数
 *   bun run scripts/catch-evidence-scan.ts --list     # 连位置一起印(还账时用)
 *   bun run scripts/catch-evidence-scan.ts --files a.ts b.ts --base HEAD  # 写集 vs base, 净增 > 0 即 exit 1
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export interface CatchSite {
  file: string;
  line: number;
  kind: 'empty' | 'silent';
}

export interface CatchScan {
  total: number;
  sites: CatchSite[];
}

const EVIDENCE = /logger\.|console\.|throw |process\.stderr|reject\(/;

/** 扫一份源码。**纯函数** —— 判别力可以拿手写样本注入验。 */
export function scanCatchEvidence(source: string, fileName: string): CatchScan {
  const src = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: CatchSite[] = [];
  let total = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isCatchClause(n)) {
      total += 1;
      const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (n.block.statements.length === 0) sites.push({ file: fileName, line, kind: 'empty' });
      else if (!EVIDENCE.test(n.block.getText())) sites.push({ file: fileName, line, kind: 'silent' });
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return { total, sites };
}

/** 递归收 `.ts`,跳过 `.test.ts` 与 `node_modules`(见头注的口径)。 */
export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 扫一棵树,合并读数。 */
export function scanTree(root: string): CatchScan {
  let total = 0;
  const sites: CatchSite[] = [];
  for (const f of collectSourceFiles(root)) {
    const r = scanCatchEvidence(readFileSync(f, 'utf8'), f);
    total += r.total;
    sites.push(...r.sites);
  }
  return { total, sites };
}

/**
 * 行号级别的「净增」比较 —— base 里同一行已有 silent/empty ⇒ 不算净增;
 * 文件在 base 缺席 (`baseSites === null`) ⇒ 当前所有站点全算净增。
 *
 * 严格按行号比对而不是按行文本: catch 块可能内容微调但仍是 silent, 我们关心的是
 * **位置层面**是否引入新沉默 —— 同一行被改成合规就是合规, 新行才付代价。
 */
export function netIncreaseVsBase(
  currentSites: CatchSite[],
  baseSites: CatchSite[] | null,
): { netIncrease: number; newSites: CatchSite[] } {
  if (baseSites === null) return { netIncrease: currentSites.length, newSites: currentSites };
  const baseLines = new Set(baseSites.map((s) => s.line));
  const newSites = currentSites.filter((s) => !baseLines.has(s.line));
  return { netIncrease: newSites.length, newSites };
}

/**
 * 取 base ref 处某文件的源码 —— 文件在 base 缺席返 null。封装 git show,
 * 调用方是 CLI(给 leaf 检查用),不打算被脚本之间复用。
 * `cwd` 给测试用(临时 git 树),CLI 走默认 `process.cwd()`。
 */
export function fetchBaseSource(file: string, baseRef: string, cwd?: string): string | null {
  const r = spawnSync('git', ['show', `${baseRef}:${file}`], { encoding: 'utf8', cwd });
  if (r.status !== 0) return null;
  return r.stdout;
}

/**
 * 把任意形式的 `file` 解析成 `cwd` 下的绝对路径 + repo-相对路径。
 * `git show <ref>:<path>` 要求 repo-相对, 而 `readFileSync` 吃绝对 —— 同一调用两套口径。
 *
 * 路径不在 `cwd` 子树内时, `git show` 会拒,调用方此时已用错 cwd —— 不在这里兜底掩盖。
 */
function resolvePaths(file: string, cwd: string): { abs: string; rel: string } {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = isAbsolute(file) && abs.startsWith(cwd + '/') ? abs.slice(cwd.length + 1) : file;
  return { abs, rel };
}

/**
 * 对给定文件逐个跑当前扫描 + 与 base 比对 —— 给 leaf 检查用(写集局部入口)。
 * 返回每个文件的「净增」明细,合计一处。
 */
export interface FileNetIncrease {
  file: string;
  netIncrease: number;
  newSites: CatchSite[];
}
export function scanFilesVsBase(files: readonly string[], baseRef: string, cwd: string = process.cwd()): FileNetIncrease[] {
  return files.map((f) => {
    const { abs, rel } = resolvePaths(f, cwd);
    const cur = scanCatchEvidence(readFileSync(abs, 'utf8'), f);
    const baseSrc = fetchBaseSource(rel, baseRef, cwd);
    const base = baseSrc === null ? null : scanCatchEvidence(baseSrc, f).sites;
    const { netIncrease, newSites } = netIncreaseVsBase(cur.sites, base);
    return { file: f, netIncrease, newSites };
  });
}

if (import.meta.main) {
  const argv = process.argv;
  const filesIdx = argv.indexOf('--files');
  const baseIdx = argv.indexOf('--base');
  // 文件列表到下一个 `--` flag 即止 —— 避免吃掉 `--base` 的取值等。
  const afterFiles = filesIdx >= 0 ? argv.slice(filesIdx + 1) : [];
  const fileArgs: string[] = [];
  for (const a of afterFiles) {
    if (a.startsWith('--')) break;
    fileArgs.push(a);
  }
  const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  if (fileArgs.length > 0) {
    if (!baseRef) {
      console.error('--files 必须配 --base <git-ref>');
      process.exit(2);
    }
    const diffs = scanFilesVsBase(fileArgs, baseRef);
    const totalNet = diffs.reduce((n, d) => n + d.netIncrease, 0);
    for (const d of diffs) {
      for (const s of d.newSites) {
        console.log(`${s.file}:${s.line} ${s.kind === 'empty' ? '空' : '无证据'} (+${d.netIncrease})`);
      }
    }
    console.error(`净增 ${totalNet} 处 / ${fileArgs.length} 文件`);
    process.exit(totalNet > 0 ? 1 : 0);
  }
  const r = scanTree('src');
  const empty = r.sites.filter((s) => s.kind === 'empty');
  const silent = r.sites.filter((s) => s.kind === 'silent');
  console.log(`catch 总数=${r.total} 空=${empty.length} 有体但无证据=${silent.length}`);
  if (argv.includes('--list')) {
    for (const s of r.sites) console.log(`${s.file}:${s.line} ${s.kind === 'empty' ? '空' : '无证据'}`);
  }
}
