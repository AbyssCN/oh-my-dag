/**
 * 第二版:不再靠 needle 的位置(readdir 是目录哈希序, 名字排不出访问序 —— 第一版就错在这)。
 * 改为**每个文件都埋 needle**, 把 grep 的命中上限调到远高于文件数,
 * 于是 `matches` 直接等于"grep 真正走到了多少个文件"。
 *
 * 单一变量 = 文件数。预先声明:
 *   - H1 成立 = 25000 个文件里 matches < 25000, 且输出**没有**任何"走到上限"的话
 *   - H1 不成立 = matches == 文件数, 或者输出说了
 * 对照基线 = 同一棵树的小号版(5000), matches 必须 == 5000
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools } from '../../src/harness/agent-tools';

const NEEDLE = 'ZZQQ_needle_7f3a';

function buildTree(root: string, n: number): number {
  rmSync(root, { recursive: true, force: true });
  let made = 0;
  const perDir = 250;
  for (let d = 0; made < n; d++) {
    const dir = join(root, `d${String(d).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perDir && made < n; i++, made++) {
      writeFileSync(join(dir, `f${i}.ts`), `export const m = '${NEEDLE}';\n`);
    }
  }
  return made;
}

async function run(label: string, n: number): Promise<void> {
  const root = `${tmpdir()}/omd-walkcap-${label}`;
  const made = buildTree(root, n);
  const tools = createOmdAgentTools({ cwd: root });
  const grep = tools.find((t) => t.name === 'grep')!;
  const r: any = await grep.execute('p', { pattern: NEEDLE, limit: 200_000 }, undefined as never);
  const text = r.content?.map?.((c: any) => c.text).join('\n') ?? '';
  const matches = r.metadata?.matches ?? r.details?.matches;
  const saysCapped = /上限|limit|截断|truncat/.test(text);
  console.log(`\n── ${label}: 盘上 ${made} 个文件(每个都埋了 needle)`);
  console.log(`   grep 走到并命中: ${matches}  ⇒ 漏掉 ${made - matches} 个`);
  console.log(`   输出提到走到上限: ${saysCapped ? '是' : '**否 —— 一个字都没说**'}`);
  console.log(`   输出末尾: ${JSON.stringify(text.slice(-120))}`);
}

await run('base-5k', 5_000);
await run('over-25k', 25_000);
