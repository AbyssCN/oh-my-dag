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
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

if (import.meta.main) {
  const r = scanTree('src');
  const empty = r.sites.filter((s) => s.kind === 'empty');
  const silent = r.sites.filter((s) => s.kind === 'silent');
  console.log(`catch 总数=${r.total} 空=${empty.length} 有体但无证据=${silent.length}`);
  if (process.argv.includes('--list')) {
    for (const s of r.sites) console.log(`${s.file}:${s.line} ${s.kind === 'empty' ? '空' : '无证据'}`);
  }
}
