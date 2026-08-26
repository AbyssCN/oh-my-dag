#!/usr/bin/env bun
/**
 * `frozen-tests` —— 本次写集有没有动到**既有**测试。
 *
 * 到绿的禁行路线里最难机械发现的一条是**放松断言**:测试与实装由同一个执行体在同一轮产出时,
 * 「改实装让测试过」与「改测试让它别红」结果同形,都是全绿。此前对这条只有散文
 * (`INV-10` 的 THE MARKING SCHEME IS FROZEN)与契约里的手工 `git diff` 步骤。
 *
 * 判据:写集里的 `.test.ts`,凡在 base 上已存在的,报出来;新建的不报。
 *
 * 它是 `advisory`(见 `.omd-repo-checks.json`):合法更新既有测试确实存在 —— 判据本身错了要改、
 * 锚过期要重钉。判据是启发式的,按本仓的层级规则就不配 fail-closed。它给的是**痕迹**,
 * 让「这一轮动过既有断言」这件事在验收时可见,而不是让人去猜。
 *
 * 用法:`bun run scripts/frozen-tests.ts --files <f1> <f2> … --base <git-ref>`
 * 退出码:0 = 没动既有测试 · 1 = 动了(逐个点名)· 2 = 用法错。
 */
import { spawnSync } from 'node:child_process';

const isTest = (f: string): boolean => f.endsWith('.test.ts');

/** 挑出「本次写集里、base 上已存在」的测试文件。纯函数,base 存在性由调用方注入。 */
export function pickFrozenTestEdits(
  files: readonly string[],
  existsInBase: (file: string) => boolean,
): string[] {
  return files.filter((f) => isTest(f) && existsInBase(f));
}

function existsInBaseViaGit(baseRef: string, cwd?: string): (file: string) => boolean {
  return (file) => {
    const r = spawnSync('git', ['cat-file', '-e', `${baseRef}:${file}`], { cwd, encoding: 'utf8' });
    return r.status === 0;
  };
}

if (import.meta.main) {
  const argv = process.argv;
  const fi = argv.indexOf('--files');
  const bi = argv.indexOf('--base');
  const files: string[] = [];
  if (fi >= 0) {
    for (const a of argv.slice(fi + 1)) {
      if (a.startsWith('--')) break;
      files.push(a);
    }
  }
  const baseRef = bi >= 0 ? argv[bi + 1] : undefined;
  if (files.length === 0 || !baseRef) {
    process.stderr.write('用法: bun run scripts/frozen-tests.ts --files <f1> … --base <git-ref>\n');
    process.exit(2);
  }
  const hits = pickFrozenTestEdits(files, existsInBaseViaGit(baseRef, process.cwd()));
  if (hits.length === 0) process.exit(0);
  for (const f of hits) {
    process.stderr.write(
      `${f}: 本次改动了一个**已存在**的测试\n` +
        '  —— 若这是判据本身有错(锚过期 / 断言写反), 说明理由; 若是为了让实现转绿而放松断言,\n' +
        '     那是 failure reported as success。两者在全绿的结果上完全同形, 只有理由能分开。\n',
    );
  }
  process.stderr.write(`\n合计 ${hits.length} 个既有测试被改动 / 写集 ${files.length} 个文件\n`);
  process.exit(1);
}
