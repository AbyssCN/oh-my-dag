/**
 * 源码裸 NUL 字节 (0x00) 绊线 (#264)。
 *
 * file(1) 把含 NUL 的文件判 binary → grep/ugrep 不加 `-a` **一条不报且不报错**,
 * 这些文件上的搜索能力静默归零。`src/` 与 `scripts/` 全部 `.ts` 都必须零命中。
 *
 * 2026-09-02 扩到 `docs/**.md`: 同一条危害对文档**一模一样**, 而当时不在扫描面内 ——
 * 实测 `ugrep` 拒搜 `docs/silent-failures.md` (「Binary file matches」), 那份图鉴的
 * 全部价值就是「下一次靠**认**」, 也就是靠搜。扩闸时天然红 2 文件
 * (`docs/silent-failures.md` · `docs/plan/2026-08-25-w2-264-nul-hygiene.md`),
 * 两处都是想写四个字符 `\x00` 却嵌了一个真 NUL。
 *
 * 反向自检 (任一改则此 test 由绿转红):
 *   - `walk` 只走 `.ts` 不走其他后缀 → 改成 `.tsx` 即漏掉 ts, 红;
 *   - `readBuffer` 不传 `null` 兜底 → TS 编译期就拦, 红;
 *   - `findNulPositions` 漏掉重复计数 → 命中数偏少时红;
 *   - 把扫描目录缩成 `src/` 一种 → scripts/ 或 docs/ 出现裸 NUL 时红;
 *   - 把 docs 那格的后缀改回 `.ts` → docs/*.md 的裸 NUL 漏掉, 红;
 *   - 改 `findNulOffsets` 起始偏移为 1 → 偏移错位, 红;
 *   - 误把 string 当 buffer 用 (`String.prototype.indexOf` 不认 NUL) → 全 0 红。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();
/**
 * 扫描面 = (根目录, 后缀) 对。后缀跟着根走, 不是全局常量 ——
 * docs 那格是 `.md`, 写成全局 `TARGET_EXT` 会让两种面互相绑架。
 */
const SCAN_TARGETS = [
  { dir: 'src', ext: '.ts' },
  { dir: 'scripts', ext: '.ts' },
  { dir: 'docs', ext: '.md' },
] as const;

/** 递归列出一个根下所有指定后缀的相对路径。 */
function walkExt(root: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkExt(abs, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
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
  test('★ src/ 与 scripts/ 的 .ts、docs/ 的 .md 都不含裸 0x00 字节', () => {
    const hits: { file: string; offsets: number[] }[] = [];
    let totalFiles = 0;
    for (const { dir, ext } of SCAN_TARGETS) {
      const abs = join(REPO_ROOT, dir);
      if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const file of walkExt(abs, ext)) {
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

  test('★ `walkExt` 真的递归 —— 深层文件也会被列出', () => {
    // 用仓内真实存在路径当 fixture, 不造临时目录。src/harness/no-raw-nul.test.ts
    // 自身在 src/harness/ 下 —— 必须能找到。
    const found = walkExt(join(REPO_ROOT, 'src'), '.ts');
    expect(found).toContain('src/harness/no-raw-nul.test.ts');
  });

  test('★ 后缀跟着根走 —— docs/ 那格扫的是 .md 不是 .ts', () => {
    // 反向自检: 把 SCAN_TARGETS 里 docs 的 ext 改回 '.ts' → 扫到的是
    // docs/examples/ 下那个 hook 脚本而不是文档, 主条会因漏掉 .md 的裸 NUL 而**假绿**。
    // ⚠ 这里刻意不断言「docs 下零个 .ts」—— 写这条时就是那么推的, 实测 docs/examples/
    // claude-code/hooks/session-continuity.ts 在, 当场红。判别力靠「同一个真文件在
    // .md 那格在、在 .ts 那格不在」, 不靠一个我没查过的计数。
    const mds = walkExt(join(REPO_ROOT, 'docs'), '.md');
    expect(mds).toContain('docs/silent-failures.md');
    expect(mds.every((f) => f.endsWith('.md'))).toBe(true);
    expect(walkExt(join(REPO_ROOT, 'docs'), '.ts')).not.toContain('docs/silent-failures.md');
  });
});
