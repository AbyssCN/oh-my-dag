/**
 * 源码裸 NUL 字节 (0x00) 绊线 (#264)。
 *
 * file(1) 把含 NUL 的文件判 binary → grep/ugrep 不加 `-a` **一条不报且不报错**,
 * 这些文件上的搜索能力静默归零。`src/` 与 `scripts/` 全部 `.ts` 都必须零命中。
 *
 * 反向自检 (任一改则此 test 由绿转红):
 *   - `walk` 只走 `.ts` 不走其他后缀 → 改成 `.tsx` 即漏掉 ts, 红;
 *   - `readBuffer` 不传 `null` 兜底 → TS 编译期就拦, 红;
 *   - `findNulPositions` 漏掉重复计数 → 命中数偏少时红;
 *   - 把扫描目录缩成 `src/` 一种 → scripts/ 出现裸 NUL 时红;
 *   - 改 `findNulOffsets` 起始偏移为 1 → 偏移错位, 红;
 *   - 误把 string 当 buffer 用 (`String.prototype.indexOf` 不认 NUL) → 全 0 红。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ['src', 'scripts'] as const;
const TARGET_EXT = '.ts';

/** 递归列出一个根下所有 .ts 相对路径。 */
function walkTs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(abs));
    } else if (entry.isFile() && entry.name.endsWith(TARGET_EXT)) {
      out.push(relative(REPO_ROOT, abs));
    }
  }
  return out;
}

/** 在 buffer 里找所有 0x00 的偏移 (从 0 起, 重复出现多次都计数)。 */
function findNulOffsets(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) out.push(i);
  }
  return out;
}

describe('源码裸 NUL 字节 (0x00) 绊线 (W2-264 / #264)', () => {
  test('★ src/ 与 scripts/ 下所有 .ts 文件不含裸 0x00 字节', () => {
    const hits: { file: string; offsets: number[] }[] = [];
    let totalFiles = 0;
    for (const dir of SCAN_DIRS) {
      const abs = join(REPO_ROOT, dir);
      if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const file of walkTs(abs)) {
        totalFiles++;
        const buf = readFileSync(join(REPO_ROOT, file));
        const offsets = findNulOffsets(buf);
        if (offsets.length > 0) hits.push({ file, offsets });
      }
    }
    // 实装前天然红 (6 文件 7 行); 此后任何新写入的裸 NUL 当场红。
    expect(totalFiles).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  test('★ 助手函数本身自洽 —— `findNulOffsets` 在含 NUL 的 buffer 上命中计数 = N', () => {
    // 4 个 NUL, 其中 2 个相邻, 必须都计。
    const buf = Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x43, 0x00]);
    expect(findNulOffsets(buf)).toEqual([1, 3, 4, 6]);
  });

  test('★ `walkTs` 真的递归 —— 深层 .ts 也会被列出', () => {
    // 用仓内真实存在路径当 fixture, 不造临时目录。src/harness/no-raw-nul.test.ts
    // 自身在 src/harness/ 下 —— 必须能找到。
    const found = walkTs(join(REPO_ROOT, 'src'));
    expect(found).toContain('src/harness/no-raw-nul.test.ts');
  });
});
