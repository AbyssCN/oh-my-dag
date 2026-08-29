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
  /**
   * 整条 catch 子句的归一化文本(去掉所有空白)。**净增比较的锚**。
   *
   * 2026-08-26 加: 此前按 `line` 做差集, 于是在文件前部插入 N 行会让后面每一个既有
   * catch 的行号 +N、整批被算成新增 —— run 5bcfa2b2 因此被误杀 (engine.ts 只改 47 行,
   * 却报净增 9 处, 点名的还是既有的 artifactReader fail-open)。行号从来不是这条判据
   * 要认的东西, 内容才是。
   */
  sig: string;
}

export interface CatchScan {
  total: number;
  sites: CatchSite[];
}

const EVIDENCE = /logger\.|console\.|throw |process\.stderr|reject\(/;

/**
 * **证据也可以经返回值交出去** (2026-08-29 补的判别力缺口)。
 *
 * 原判据只认 logger/console/throw/stderr/reject —— 于是这种写法被误判成"沉默":
 *
 * ```ts
 * catch (err) { return { sha: null, why: err instanceof Error ? err.message : String(err) }; }
 * ```
 *
 * 它把错误原文**交给了调用方**, 比只写进日志更强 (调用方能据此分支, 日志只能被人读)。
 * 判据: 绑了错误变量 **且** 在 catch 体里引用了它。
 * `catch (e) { return null; }` 绑了但没引用 → 仍算沉默 (口子没开大)。
 *
 * 实测样本: `src/harness/memory/staleness.ts` 的 `fingerprintFile`。
 */
function bindsAndUsesError(n: ts.CatchClause): boolean {
  const name = n.variableDeclaration?.name;
  if (!name || !ts.isIdentifier(name)) return false;
  const id = name.text;
  let escapes = false;
  /**
   * ⚠ **只"用到"不算**: `catch (e) { if (e instanceof X) return a; return b; }` 拿 e 走了控制流,
   * 却把错误原文丢了 —— 那仍然是吞证据。所以判的是**错误有没有流出去**:
   * 进 return / 进调用参数 / 进对象字面量的值 / 进赋值右边 / 进模板串。
   * 只出现在 if 条件里 → 不算。
   */
  const mentions = (x: ts.Node): boolean => {
    let hit = false;
    const scan = (y: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(y) && y.text === id && y !== name) { hit = true; return; }
      ts.forEachChild(y, scan);
    };
    scan(x);
    return hit;
  };
  const visit = (x: ts.Node): void => {
    if (escapes) return;
    if (ts.isReturnStatement(x) && x.expression && mentions(x.expression)) { escapes = true; return; }
    if (ts.isCallExpression(x) && x.arguments.some(mentions)) { escapes = true; return; }
    if (ts.isPropertyAssignment(x) && mentions(x.initializer)) { escapes = true; return; }
    if (ts.isVariableDeclaration(x) && x.initializer && mentions(x.initializer)) { escapes = true; return; }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && mentions(x.right)) { escapes = true; return; }
    if (ts.isTemplateExpression(x) && mentions(x)) { escapes = true; return; }
    ts.forEachChild(x, visit);
  };
  ts.forEachChild(n.block, visit);
  return escapes;
}

/** 扫一份源码。**纯函数** —— 判别力可以拿手写样本注入验。 */
export function scanCatchEvidence(source: string, fileName: string): CatchScan {
  const src = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: CatchSite[] = [];
  let total = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isCatchClause(n)) {
      total += 1;
      const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const sig = n.getText().replace(/\s+/g, '');
      if (n.block.statements.length === 0) sites.push({ file: fileName, line, kind: 'empty', sig });
      else if (!EVIDENCE.test(n.block.getText()) && !bindsAndUsesError(n)) sites.push({ file: fileName, line, kind: 'silent', sig });
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return { total, sites };
}

/** 递归收 `.ts`,跳过 `.test.ts` 与 `node_modules`(见头注的口径)。 */
/**
 * 已跟踪文件集 (2026-08-29)。**未跟踪文件不进扫描** —— 与可达性闸同一条理由:
 * 未提交 = 对任何人都不存在, 让它把绊线拉红是假警报 (那天一个别人未提交的
 * `src/cli/runs-gc.ts` 就贡献了一条)。`git ls-files` 挂了 → 返 null → 全都算 (fail-closed)。
 */
function trackedSet(root: string): Set<string> | null {
  const r = Bun.spawnSync(['git', 'ls-files', '--', root], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) return null;
  return new Set(r.stdout.toString().split('\n').filter(Boolean));
}

export function collectSourceFiles(root: string): string[] {
  const tracked = trackedSet(root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && (tracked === null || tracked.has(p))) out.push(p);
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
 * 「净增」比较 —— 按 catch 子句的**内容指纹**做**多重集**差, 不按行号。
 * 文件在 base 缺席 (`baseSites === null`) ⇒ 当前所有站点全算净增。
 *
 * ## 为什么不按行号(2026-08-26 改)
 *
 * 原实现是 `new Set(baseSites.map((s) => s.line))` 的差集, 理由写的是「关心位置层面
 * 是否引入新沉默」。实际后果: 在文件前部插入 N 行, 后面每一个既有 catch 的行号都 +N、
 * 全部落在 baseLines 之外, **整批被算成新增**。
 *
 * 真账: run 5bcfa2b2 (conductor S2 后半) 的 s2 节点因此判红 —— `engine.ts` 那一发
 * 只改了 47 行 (+46/-1), 闸却报净增 9 处, 点名的 `engine.ts:1098` 是既有的
 * `artifactReader` fail-open。s2 failed → s2-green/s3/s3-green 级联 skipped,
 * 片 2 与片 3 的交付全丢。engine.ts 是 5000+ 行的高频改动文件, 这个误报是系统性的。
 *
 * ## 为什么是多重集而不是 Set 去重
 *
 * 朴素去重会让「真新增一个与既有 catch 内容完全相同的块」漏报 —— 而
 * `catch { return null; }` 这种恰恰是最常见的写法。按指纹计数, 净增 =
 * Σ max(0, 当前该指纹条数 − base 该指纹条数)。
 *
 * 代价(明写, 不当成强保证): 把一个既有 silent catch 原样搬到别处、同时在原位置补上证据,
 * 净增算 0。位置变了但沉默总数没变 —— 与本闸「只许降不许涨」的口径一致, 不追位置。
 */
export function netIncreaseVsBase(
  currentSites: CatchSite[],
  baseSites: CatchSite[] | null,
): { netIncrease: number; newSites: CatchSite[] } {
  if (baseSites === null) return { netIncrease: currentSites.length, newSites: currentSites };
  const budget = new Map<string, number>();
  for (const s of baseSites) budget.set(s.sig, (budget.get(s.sig) ?? 0) + 1);
  const newSites: CatchSite[] = [];
  for (const s of currentSites) {
    const left = budget.get(s.sig) ?? 0;
    if (left > 0) budget.set(s.sig, left - 1); // base 里还有额度 → 这一个是既有的
    else newSites.push(s); // 额度用尽 → 真多出来的一个
  }
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
