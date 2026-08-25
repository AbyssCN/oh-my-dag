/**
 * jargon-scan `--files` 入口的判别力闸 (SDD s1 切片 1, O-6)。
 *
 * 两层各自两条用例(正例 + 反例):
 *   ① 纯函数 `scanFiles(files)` —— 注入文件列表, 命中归位;
 *   ② CLI `--files f1 f2 ...` —— spawn 跑实命令, 退出码与输出对应。
 *
 * 反向自检 (任一改则此 test 由绿转红):
 *   - 把 `scanFiles` 删掉或让它返回 `scanTree(...)` ⇒ ① 的「命中只来自这两个文件」红;
 *   - CLI 把 `--files` 当成无操作 ⇒ ② 的「exit 1 + 行内 file:line」红;
 *   - 退出码逻辑写反 (命中时 exit 0) ⇒ ② 红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXCLUDE_FILES, JARGON, scanFiles } from './jargon-scan';

const TMP = mkdtempSync(join(tmpdir(), 'jargon-files-'));

function writeFixture(rel: string, body: string): string {
  const abs = join(TMP, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

describe('禁词扫描器 --files 入口', () => {
  describe('① 纯函数 scanFiles', () => {
    test('正例: 两个 fixture 文件, 命中按 (file, line, word) 归位', () => {
      const a = writeFixture('a.ts', ['// 把数据落盘', "const m = '收口失败';"].join('\n'));
      const b = writeFixture('b.ts', '/** 这里用抓手 */');
      const hits = scanFiles([a, b]);
      const words = new Set(hits.map((h) => h.word));
      expect(words.has('落盘')).toBe(true);
      expect(words.has('抓手')).toBe(true);
      // 文件归属: 两个 fixture 的命中**只**来自这两个文件
      const files = new Set(hits.map((h) => h.file));
      expect(files).toEqual(new Set([a, b]));
      expect(hits.find((h) => h.file === a && h.line === 1)?.kind).toBe('comment');
    });

    test('反例: 喂合规文件, 返回空数组 (扫到的就是真命中, 不是恒真断言)', () => {
      const clean = writeFixture('clean.ts', '// 这是合规注释\nexport const x = 1;\n');
      expect(scanFiles([clean])).toEqual([]);
      // 分母: 扫描器真的在读文件 (不是把所有路径都跳过)
      const dirty = writeFixture('dirty.ts', '把结果落盘。');
      expect(scanFiles([dirty]).length).toBe(1);
    });

    test('不应用 EXCLUDE_FILES: 调用方是引擎, 自引用由它自己避', () => {
      // EXCLUDE_FILES 里有 scripts/jargon-scan.ts, 但 scanFiles 不该用它去静默过滤
      const hits = scanFiles(['scripts/jargon-scan.ts']);
      // 自引用必有命中 —— 至少一条
      expect(hits.length).toBeGreaterThan(0);
      expect(EXCLUDE_FILES).toContain('scripts/jargon-scan.ts'); // 旁证: 排除名单确实有它
      // 同时 JARGON 词典本身没被换空 —— 否则 scanFiles 会返回 []
      expect(Object.keys(JARGON).length).toBeGreaterThan(0);
    });
  });

  describe('② CLI --files', () => {
    let a: string;
    let b: string;
    beforeEach(() => {
      a = writeFixture('cli-a.ts', '// 把数据落盘\n');
      b = writeFixture('cli-b.ts', "const s = '抓手来了';\n");
    });

    test('正例: 只扫给定的文件, 命中 exit 1 + 输出含 file:line', () => {
      const p = Bun.spawnSync([
        'bun', 'run', 'scripts/jargon-scan.ts', '--files', a, b,
      ], { cwd: process.cwd() });
      expect(p.exitCode).toBe(1);
      const out = new TextDecoder().decode(p.stdout);
      expect(out).toContain(`${a}:1`);
      expect(out).toContain('落盘');
      // 没有 --json: 默认人读格式
      expect(out).toContain('合计');
    });

    test('反例: 喂一个空文件 + 一个合规文件, exit 0', () => {
      const clean = writeFixture('cli-clean.ts', '// 合规注释\nconst x = 1;\n');
      const p = Bun.spawnSync([
        'bun', 'run', 'scripts/jargon-scan.ts', '--files', clean, a,
      ], { cwd: process.cwd() });
      // a 里有禁词 → exit 1 (这条不是「全合规」的对照)
      expect(p.exitCode).toBe(1);
      const onlyClean = Bun.spawnSync([
        'bun', 'run', 'scripts/jargon-scan.ts', '--files', clean,
      ], { cwd: process.cwd() });
      expect(onlyClean.exitCode).toBe(0);
    });
  });
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));