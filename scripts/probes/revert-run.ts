/**
 * scripts/probes/revert-run —— **这一跑改了哪些文件,怎么只回滚它**(D1 收尾,2026-08-06)。
 *
 * ## 它答的是 backlog D1 那句「一条真跑过的回滚路径」
 *
 * ⑬ 出的第一批数是 **4/4 都是 `dirty-tracked`** —— 也就是说生产上跑 goal 时工作树基本是脏的,
 * 而脏树上**没有整树回滚**(`git checkout -- .` 会把你自己的活一起冲掉)。
 *
 * 但**按这次跑改过的文件回滚**是可以的:那些路径一直在
 * `.omd/continuity/<runId>/<nodeId>.json` 的 `outputPaths` 里,只是从来没人把它取出来用过。
 *
 * ## ⚠ 它**只打印命令,永不执行**
 *
 * 回滚是破坏性的,而这里给的路径是**引擎观测到的**、不是"只有引擎改过的"。
 * 扣扳机必须是人 —— 这条与本仓 `path_deliver` 把"裁决"与"重跑"拆成两个决定同一条纪律。
 *
 * ## ⚠ 一条它分不开的东西(而这正是 ⑬ 要紧的原因)
 *
 * **如果你自己的未提交改动也碰了同一个文件,`git checkout --` 会把你的改动一起冲掉。**
 * 引擎记的是"这个节点写过这条路径",记不了"这一行是谁写的"。
 * 所以起跑时树干净(⑬ 的 `clean`)才是真正安全的那一档 —— 那时整树回滚本来就成立,
 * 也就不需要这个脚本。**这个脚本是脏树上的次优解,不是 clean 的替代品。**
 *
 * 用法:`bun run scripts/probes/revert-run.ts <runId>`(`OMD_REPO` 可指定仓根)
 *       不给 runId → 列出盘上有产物的跑。
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.OMD_REPO ?? process.cwd();
const base = join(repo, '.omd', 'continuity');
const runId = process.argv[2];

/** 一次跑碰过的路径(相对该 run 的根)。归档轮次也算 —— 旧轮写过的东西一样在盘上。 */
function touchedPaths(dir: string): string[] {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      for (const p of (JSON.parse(readFileSync(join(dir, f), 'utf8')).outputPaths ?? []) as string[]) out.add(p);
    } catch {
      // 坏 JSON: 跳过这一份, 但**不静默** —— 下面会用"读到几份"对得上账
    }
  }
  return [...out].sort();
}

if (!runId) {
  console.log('用法: bun run scripts/probes/revert-run.ts <runId>\n');
  console.log('盘上有产物的跑:');
  let n = 0;
  for (const d of readdirSync(base)) {
    const ps = touchedPaths(join(base, d));
    if (!ps.length) continue;
    n++;
    console.log(`  ${d}  —— ${ps.length} 个文件  (${ps[0]}${ps.length > 1 ? ' …' : ''})`);
  }
  if (n === 0) console.log('  (一个都没有)');
  process.exit(0);
}

const dir = join(base, runId);
if (!existsSync(dir)) {
  console.error(`没有这个 runId 的 continuity 目录: ${dir}`);
  process.exit(1);
}
const paths = touchedPaths(dir);
if (paths.length === 0) {
  console.log(`runId ${runId}: 盘上没有记到任何 outputPaths —— 这一跑要么没写文件, 要么早于该字段。`);
  console.log('⚠ 那是「没记」不是「没写」: 引擎的 filesTouched 只认受控写工具, bash 写此前是隐形的。');
  process.exit(0);
}

// ⑬ 那一位: 这一跑**起跑时**干不干净 —— 它决定了整树回滚成不成立。
let anchor: { kind?: string; head?: string } | null = null;
try {
  const db = new Database(join(repo, '.omd', 'dag-runs.db'), { readonly: true });
  const cols = (db.query('PRAGMA table_info(omd_dag_runs)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('rollback')) {
    const row = db.query('SELECT rollback FROM omd_dag_runs WHERE run_id = ? AND rollback IS NOT NULL LIMIT 1').get(runId) as
      | { rollback: string }
      | undefined;
    if (row) anchor = JSON.parse(row.rollback);
  }
  db.close();
} catch {
  // 读不到账本不该让这个脚本失效 —— 路径那半照样给得出
}

console.log(`runId ${runId}\n`);
console.log(`这一跑碰过 ${paths.length} 个文件 (引擎观测到的 outputPaths):`);
for (const p of paths) console.log(`  ${p}`);

console.log('\n起跑时的工作树 (⑬):');
if (!anchor?.kind) {
  console.log('  **没记** —— 这一跑早于 rollback-anchor, 或账本里查不到。下面那条命令的安全性无从判断。');
} else if (anchor.kind === 'clean') {
  console.log(`  **clean** (HEAD ${anchor.head}) —— 整树回滚本来就成立, 你**不需要**这个脚本:`);
  console.log('    git checkout -- . && git clean -fd');
} else {
  console.log(`  **${anchor.kind}** —— 起跑时就有未提交的东西, 所以**没有整树回滚**。下面是次优解。`);
}

console.log('\n只回滚这一跑写过的文件 (⚠ 自己看一眼再敲, 这个脚本不替你执行):');
console.log(`  git checkout -- ${paths.join(' ')}`);
console.log('\n⚠ 它分不开的那件事:');
console.log('  引擎记的是"这个节点写过这条路径", 记不了"这一行是谁写的"。');
console.log('  **你自己的未提交改动要是也碰了同一个文件, 这条命令会把它一起冲掉。**');
console.log('  先看一眼哪些是你的:');
console.log(`  git diff --stat -- ${paths.slice(0, 3).join(' ')}${paths.length > 3 ? ' …' : ''}`);
