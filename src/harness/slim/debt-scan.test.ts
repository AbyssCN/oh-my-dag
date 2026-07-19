/**
 * src/harness/slim/debt-scan —— ponytail: 标记纯扫描件测试 (解析/切分/容错/前缀强制/渲染)
 * + scripts/omd-debt CLI 冒烟 (--help / exit 3 零标记 / exit 0 出 ledger)。
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDebtLine, scanDebtLines, formatLedger } from './debt-scan';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'omd-debt.ts');

describe('debt-scan 标记解析 (纯函数)', () => {
  test('// 标记: ceiling/upgrade 按第一个逗号切, what = 注释前代码', () => {
    const p = parseDebtLine('const lock = globalLock(); // ponytail: 全局锁, 吞吐成瓶颈时改 per-account 锁')!;
    expect(p.what).toBe('const lock = globalLock();');
    expect(p.ceiling).toBe('全局锁');
    expect(p.upgrade).toBe('吞吐成瓶颈时改 per-account 锁');
  });

  test('# 与 /* */ 前缀同理; 块注释收尾符剥掉; upgrade 内逗号保留', () => {
    const py = parseDebtLine('x = naive_scan()  # ponytail: O(n²) 扫描, 超 10k 行换索引')!;
    expect(py.ceiling).toBe('O(n²) 扫描');
    expect(py.upgrade).toBe('超 10k 行换索引');
    const block = parseDebtLine('/* ponytail: 单机内存态, 多实例时上 redis, 或换 DB */')!;
    expect(block.what).toBe('-'); // 独立注释行无代码
    expect(block.ceiling).toBe('单机内存态');
    expect(block.upgrade).toBe('多实例时上 redis, 或换 DB'); // 只按第一个逗号切
  });

  test('容错: 缺 upgrade → "-"; 空 payload → ceiling 也 "-"', () => {
    expect(parseDebtLine('// ponytail: naive heuristic')!.upgrade).toBe('-');
    expect(parseDebtLine('// ponytail: 只留天花板,')!.upgrade).toBe('-'); // 逗号后空
    const empty = parseDebtLine('// ponytail:')!;
    expect(empty.ceiling).toBe('-');
    expect(empty.upgrade).toBe('-');
  });

  test('前缀强制: 字符串/散文里提到 ponytail: 不算标记', () => {
    expect(parseDebtLine('const s = "ponytail: not a marker";')).toBeNull();
    expect(parseDebtLine('把 ponytail: 约定写进文档')).toBeNull();
    expect(parseDebtLine('// see ponytail: convention for details')).toBeNull(); // 注释符后有杂词
    expect(parseDebtLine('const url = "http://x.com ponytail: nope";')).toBeNull();
    expect(parseDebtLine('//ponytail: 无空格也算, 前缀紧跟即可')).not.toBeNull();
  });

  test('scanDebtLines: 1-based 行号, 非标记行跳过', () => {
    const hits = scanDebtLines([
      'line one',
      'doWork(); // ponytail: 同步跑, 慢了改队列',
      '"ponytail: prose" 不算',
      '# ponytail: 缺触发条件',
    ]);
    expect(hits.length).toBe(2);
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.what).toBe('doWork();');
    expect(hits[1]!).toMatchObject({ line: 4, ceiling: '缺触发条件', upgrade: '-' });
  });

  test('formatLedger: 按文件分组, 行格式 <file>:<line> — <what>. ceiling: <x>. upgrade: <y>, 尾行统计', () => {
    const out = formatLedger([
      { file: 'src/a.ts', line: 2, what: 'doWork();', ceiling: '同步跑', upgrade: '慢了改队列' },
      { file: 'src/a.ts', line: 9, what: '-', ceiling: '缺触发', upgrade: '-' },
      { file: 'src/b.ts', line: 1, what: 'x()', ceiling: 'c', upgrade: 'u' },
    ]);
    expect(out).toContain('## src/a.ts');
    expect(out).toContain('src/a.ts:2 — doWork();. ceiling: 同步跑. upgrade: 慢了改队列');
    expect(out).toContain('## src/b.ts');
    expect(out.indexOf('## src/a.ts')).toBeLessThan(out.indexOf('## src/b.ts'));
    expect(out).toContain('3 markers, 1 with no upgrade trigger.');
  });
});

describe('scripts/omd-debt CLI 冒烟 (纯扫描, 零 LLM)', () => {
  test('--help 干净 env 下打印 usage, exit 0 (env -i 等价)', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--help'], { cwd: REPO_ROOT, env: {} });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('usage:');
  });

  test('零标记 → exit 3 + 约定提示', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-debt-empty-'));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'clean.ts'), 'const s = "ponytail: prose only";\n');
    const p = Bun.spawnSync([process.execPath, SCRIPT], { cwd });
    expect(p.exitCode).toBe(3);
    expect(p.stdout.toString()).toContain('0 个 ponytail: 标记');
    expect(p.stdout.toString()).toContain('<ceiling>, <upgrade trigger>');
  });

  test('有标记 → exit 0, ledger 行 + 统计; --paths 覆盖默认根', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-debt-hits-'));
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'lib'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x();\ndoWork(); // ponytail: 同步跑, 慢了改队列\n');
    writeFileSync(join(cwd, 'lib', 'b.ts'), '// ponytail: 只有天花板\n');
    const p = Bun.spawnSync([process.execPath, SCRIPT], { cwd });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain('src/a.ts:2 — doWork();. ceiling: 同步跑. upgrade: 慢了改队列');
    expect(out).not.toContain('lib/b.ts'); // lib 不在默认根
    expect(out).toContain('1 markers, 0 with no upgrade trigger.');
    // --paths 覆盖: 只扫 lib
    const p2 = Bun.spawnSync([process.execPath, SCRIPT, '--paths', 'lib'], { cwd });
    expect(p2.exitCode).toBe(0);
    expect(p2.stdout.toString()).toContain('lib/b.ts:1 — -. ceiling: 只有天花板. upgrade: -');
    expect(p2.stdout.toString()).toContain('1 markers, 1 with no upgrade trigger.');
  });
});
