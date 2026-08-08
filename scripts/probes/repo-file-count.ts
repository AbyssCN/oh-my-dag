/**
 * 量:一个仓里 agent 的 `grep` 会走多少个文件(`SKIP_DIRS` 口径)。
 *
 * 存在的理由:`GREP_WALK_LIMIT` 是 20,000,而"离上限还有多远"是个**要一条命令算出来的数**,
 * 不是凭"感觉这仓挺大"就能说的(本仓 P-2:量化副词背后那个数在哪)。
 *
 * ⚠ 跳过目录表**从实装取**,不在这里抄一份 —— 抄一份就会与 agent 真正走的树漂开。
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GREP_WALK_LIMIT, SKIP_DIRS } from '../../src/harness/agent-tools';

async function count(root: string): Promise<number> {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile()) n++;
    }
  }
  return n;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('用法: bun run scripts/probes/repo-file-count.ts <仓路径> [更多…]');
  process.exit(2);
}
console.log(`遍历上限 GREP_WALK_LIMIT = ${GREP_WALK_LIMIT}\n`);
for (const r of roots) {
  const n = await count(r);
  console.log(`${String(n).padStart(7)}  ${Math.round((100 * n) / GREP_WALK_LIMIT)}% 上限  ${r}`);
}
