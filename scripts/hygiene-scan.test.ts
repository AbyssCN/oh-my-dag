/**
 * hygiene-scan.test —— INV-1「扫描零 LLM 且 fail-open 留证据」(GWT-1 / GWT-1b)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · 在 `scripts/hygiene-scan.ts` 或 `src/harness/hygiene/*.ts` 里加一行
 *     `import { send } from '../src/model/gateway'` → 「import 白名单」那条红。
 *     (这是「零 LLM」唯一机械可核实的形态: 不是数 gateway.send 的调用次数 ——
 *      一个根本没有那条 import 边的模块, 数出来的 0 是空判据。)
 *   · 把 `collectScan` 里 db 失败分支的 `errors.push` 删掉 → GWT-1b 那条红。
 *   · 把 `errors` 那一路改成 throw → 「读不到也退出 0」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BIG_FILE_LINE_THRESHOLD, STALE_PLAN_DAYS } from '../src/harness/hygiene/types';
import {
  BIG_FILE_ROOTS,
  MARKER_ROOTS,
  PLAN_DIR,
  REFERENCE_DOCS,
  buildBaseline,
  collectScan,
  renderCounts,
  walkFiles,
  type ScanIO,
} from './hygiene-scan';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-02T00:00:00Z');

function write(root: string, rel: string, text: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** GWT-1 的临时仓: 1 死文件 + 1 死导出 (由 knip 替身给) + 1 ponytail + 1 TODO + 1 个超阈值文件。 */
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-fixture-'));
  write(root, `${MARKER_ROOTS[0]}/debt.ts`, 'export const a = 1; // ponytail: 只做单机, 上云时改\n');
  write(root, `${MARKER_ROOTS[0]}/todo.ts`, '// TODO: 补上边界检查\nexport const b = 2;\n');
  write(
    root,
    `${BIG_FILE_ROOTS[0]}/huge.ts`,
    `${Array.from({ length: BIG_FILE_LINE_THRESHOLD + 100 }, (_, i) => `// line ${i}`).join('\n')}\n`,
  );
  // 陈旧 plan: 老 + 无人引用; 另一份老但被 NOTES 引用 (对照, 不该入账)
  const stale = write(root, `${PLAN_DIR}/2020-old.md`, '# 老计划\n');
  const cited = write(root, `${PLAN_DIR}/2020-cited.md`, '# 仍被引用\n');
  const old = (NOW - (STALE_PLAN_DAYS + 10) * DAY) / 1000;
  utimesSync(stale, old, old);
  utimesSync(cited, old, old);
  write(root, REFERENCE_DOCS[0]!, '见 2020-cited.md\n');
  return root;
}

/** 全部外部依赖走替身 → 零外部进程、零 LLM。 */
function fixtureIO(cwd: string, over: Partial<ScanIO> = {}): ScanIO {
  return {
    cwd,
    nowMs: NOW,
    knip: () => ({
      ok: true,
      report: {
        issues: [
          { file: 'src/dead.ts', files: [{ name: 'src/dead.ts' }] },
          { file: 'src/live.ts', exports: [{ name: 'unusedExport', line: 3 }] },
        ],
      },
    }),
    seamCheck: () => ({ ok: true, code: 0, out: 'seam-catalog --check: OK' }),
    db: () => ({
      ok: true,
      failedRuns: [{ run_id: 'r1', status: 'failed', error: '终止原因: not-converged (STALLED)' }],
      openForks: [{ id: 'f1', run_id: 'r1', question: '要不要拆' }],
    }),
    testLog: () => ({ ok: true, log: '9101 pass\n0 fail\n' }),
    headSha: () => 'abc123def456',
    // fixture 不是 git 仓 → 返回空表, 陈旧判据退回 fs mtime (utimesSync 摆出来的)。
    lastChangeMs: () => ({}),
    ...over,
  };
}

describe('INV-1 GWT-1 扫描覆盖五类且零外部进程', () => {
  const scan = collectScan(fixtureIO(makeFixtureRepo()));

  test('knip-files / knip-exports / debt / todo / big-file 五类各 ≥ 1', () => {
    for (const s of ['knip-files', 'knip-exports', 'debt', 'todo', 'big-file'] as const) {
      expect(scan.counts[s]).toBeGreaterThanOrEqual(1);
    }
  });

  test('counts 与 items 对账 (合计相等, 没有掉队的项)', () => {
    const sum = Object.values(scan.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(scan.items.length);
  });

  test('陈旧 plan 只收无人引用那一份', () => {
    const stale = scan.items.filter((i) => i.source === 'stale-plan');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.path).toContain('2020-old.md');
  });

  test('seam 不漂 → 该类 0 且不进 errors (0 ≠ 读不到)', () => {
    expect(scan.counts['seam-drift']).toBe(0);
    expect(scan.errors.some((e) => e.source === 'seam-drift')).toBe(false);
  });

  test('git 提交时刻优先于 fs mtime (worktree 会把 mtime 重置成 checkout 时刻)', () => {
    // 同一个 fixture: fs mtime 说"很老", git 说"昨天刚动" → 不算陈旧。
    const root = makeFixtureRepo();
    const withGit = collectScan(
      fixtureIO(root, {
        lastChangeMs: (paths) => Object.fromEntries(paths.map((p) => [p, NOW - DAY])),
      }),
    );
    expect(withGit.counts['stale-plan']).toBe(0);
    expect(collectScan(fixtureIO(root)).counts['stale-plan']).toBe(1);
  });

  test('version / sha / generatedAt 三个头字段照实写', () => {
    expect(scan.version).toBe(1);
    expect(scan.sha).toBe('abc123def456');
    expect(scan.generatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('INV-1 GWT-1b 矿源读不到 → errors[] 有证据, 不中断', () => {
  const scan = collectScan(
    fixtureIO(makeFixtureRepo(), {
      db: () => ({ ok: false, error: '.omd/runs.db 缺席 (/nowhere/.omd/runs.db)' }),
      knip: () => ({ ok: false, error: 'knip 退出 2: 配置错' }),
      testLog: () => ({ ok: false, error: '没有 /tmp/omd-test-run-*.txt' }),
    }),
  );

  test('failed-runs 与 forks 都进 errors 且带错误原文', () => {
    const sources = scan.errors.map((e) => e.source);
    expect(sources).toContain('failed-runs');
    expect(sources).toContain('forks');
    expect(scan.errors.find((e) => e.source === 'failed-runs')!.error).toContain('runs.db');
  });

  test('读不到的类 counts 停在 0 —— 与"真是零"靠 errors 分辨', () => {
    expect(scan.counts['failed-runs']).toBe(0);
    expect(scan.counts['knip-files']).toBe(0);
    expect(scan.errors.filter((e) => e.source.startsWith('knip-'))).toHaveLength(4);
  });

  test('本地 fs 那几类照常有数 (一个矿源塌不带塌全趟)', () => {
    expect(scan.counts.debt).toBeGreaterThanOrEqual(1);
    expect(scan.counts['big-file']).toBeGreaterThanOrEqual(1);
  });

  test('renderCounts 把读不到的类单独列出来', () => {
    expect(renderCounts(scan)).toContain('读不到的矿源');
    expect(renderCounts(scan)).toContain('failed-runs');
  });
});

describe('D-2 基线带 id 清单', () => {
  test('buildBaseline 的 counts 与 ids 逐类对齐', () => {
    const scan = collectScan(fixtureIO(makeFixtureRepo()));
    const base = buildBaseline(scan);
    for (const [source, n] of Object.entries(scan.counts)) {
      expect(base.ids[source as keyof typeof base.ids]).toHaveLength(n);
    }
  });
});

describe('INV-1 零 LLM 由 import 白名单机械核实', () => {
  /** 治理链的全部源文件 —— 任何一条通向模型件的 import 边都是违规。 */
  const FILES = [
    'scripts/hygiene-scan.ts',
    'src/harness/hygiene/types.ts',
    'src/harness/hygiene/miners.ts',
  ];
  /** 出现在 import 语句里就算命中的模型件关键词。 */
  const FORBIDDEN = ['model/gateway', 'model/seats', 'src/model/', 'anthropic', 'openai', '/agent-runner'];

  test('三个源文件都不 import 任何模型件', () => {
    for (const f of FILES) {
      const text = readFileSync(join(import.meta.dir, '..', f), 'utf-8');
      const imports = text.split('\n').filter((l) => /^\s*import\s/.test(l));
      for (const line of imports) {
        for (const bad of FORBIDDEN) {
          expect(`${f}: ${line}`).not.toContain(bad);
        }
      }
    }
  });
});

describe('walkFiles 跳过产物目录', () => {
  test('node_modules / runs 下的文件不进清单', () => {
    const root = mkdtempSync(join(tmpdir(), 'hygiene-walk-'));
    write(root, 'src/keep.ts', 'x');
    write(root, 'src/node_modules/skip.ts', 'x');
    write(root, 'src/runs/skip2.ts', 'x');
    expect(walkFiles(root, 'src', ['.ts'])).toEqual(['src/keep.ts']);
  });

  test('目录不存在 → 空数组 (不抛)', () => {
    expect(walkFiles(mkdtempSync(join(tmpdir(), 'hygiene-empty-')), 'nope', ['.ts'])).toEqual([]);
  });
});
