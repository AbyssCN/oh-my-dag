#!/usr/bin/env bun
/**
 * scripts/omd-debt —— `ponytail:` 刻意捷径的债务台账 (纯扫描, 零 LLM, 不改任何东西)。
 *
 * skills/ponytail 的纪律: 刻意简化处留结构化注释 `// ponytail: <ceiling>, <upgrade trigger>`。
 * 本脚本把全仓标记收成一张 ledger, 让"以后再说"不至于烂成"永远不说":
 *   <file>:<line> — <what>. ceiling: <x>. upgrade: <y>     (按文件分组; 缺 upgrade → '-' = rot 风险)
 *
 *   bun run scripts/omd-debt.ts [--paths "src,scripts"]
 *
 * 默认扫 src scripts skills docs (存在者); --paths 逗号分隔覆盖。跳过 node_modules/.git/.omd。
 * shell 定位候选行 (ugrep → grep 兜底), 解析真理源在 src/harness/slim/debt-scan.ts (纯函数,
 * 前缀强制: 注释符后紧跟 ponytail: 才算, 散文/字符串顺嘴提到的不入账)。
 * exit 0 = 有标记出 ledger; exit 3 = 零标记 (打印约定提示)。
 */
import { existsSync } from 'node:fs';
import { $ } from 'bun';
import { parseDebtLine, formatLedger, type DebtMarker } from '../src/harness/slim/debt-scan';

const USAGE =
  'usage: bun run scripts/omd-debt.ts [--paths "src,scripts"]\n' +
  '  收集 `// ponytail: <ceiling>, <upgrade trigger>` 刻意捷径标记 → debt ledger。\n' +
  '  纯扫描零 LLM; exit 3 = 零标记。审查该删什么走 dag-slim; 行为倾向走 skills/ponytail。';

// ---- args ----
const flags: Record<string, string> = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a === '--help') flags.help = 'true';
  else if (a.startsWith('--')) flags[a.slice(2)] = av[++i] ?? '';
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const roots = (flags.paths ? flags.paths.split(',') : ['src', 'scripts', 'skills', 'docs'])
  .map((p) => p.trim())
  .filter((p) => p && existsSync(p));

const HINT =
  '0 个 ponytail: 标记。约定: 刻意捷径处留结构化注释 `// ponytail: <ceiling>, <upgrade trigger>`\n' +
  '(如 `// ponytail: 全局锁够用, 吞吐成瓶颈时改 per-account 锁`), 本工具据此收 debt ledger。';

const markers: DebtMarker[] = [];
if (roots.length > 0) {
  // ugrep → grep 兜底 (verify.ts 同款 idiom); 无命中 exit 1 → nothrow 空文本。
  const pat = String.raw`(#|//|/\*)[[:space:]]*ponytail:`;
  const excl = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.omd';
  const cmd = `(ugrep -rnE '${pat}' ${excl} ${roots.join(' ')} 2>/dev/null || grep -rnE '${pat}' ${excl} ${roots.join(' ')} 2>/dev/null)`;
  const raw = (await $`sh -c ${cmd}`.nothrow().text()).trim();
  for (const line of raw ? raw.split('\n') : []) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue; // "Binary file matches" 等非 file:line:text 行
    const parsed = parseDebtLine(m[3]!); // 解析真理源终裁 (grep 只是候选定位)
    if (parsed) markers.push({ file: m[1]!, line: Number(m[2]), ...parsed });
  }
}

if (markers.length === 0) {
  console.log(HINT);
  process.exit(3);
}
console.log(formatLedger(markers));
process.exit(0);
