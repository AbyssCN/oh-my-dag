/**
 * design-review 纯核测试 (P4): G-4 调度判定 / G-5 指纹去重 / INV-3 失败不影响收敛。
 *
 * 测试 maybeRunDesignReview 直接, 不经 run-goal 复杂夹具。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeRunDesignReview, DEFAULT_FRONTEND_GLOB, type DesignReviewResult } from './design-review';
import { fingerprintOf, loadLedger } from '../profiles/review-ledger';
import { setCoreLogger, type CoreLogger } from '../logger';

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-dr-'));
  setCoreLogger(consoleLogger);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('maybeRunDesignReview — G-4 调度判定', () => {
  test('G-4: 写集无前端文件 → 不调度, usage 零', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/model/foo.ts', 'src/harness/bar.ts', 'README.md'],
    });
    expect(r.scheduled).toBe(false);
    expect(r.usage.in).toBe(0);
    expect(r.usage.out).toBe(0);
    expect(r.added).toBe(0);
  });

  test('G-4: 写集含 tsx → 调度', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/App.tsx'],
    });
    expect(r.scheduled).toBe(true);
  });

  test('G-4: 写集含 css/jsx/html/vue/svelte 各一 → 调度', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['styles/main.css', 'components/Card.jsx', 'index.html', 'App.vue', 'Widget.svelte'],
    });
    expect(r.scheduled).toBe(true);
  });

  test('G-4: 写集混有前后端文件 → 仅前端命中即调度', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/model/types.ts', 'src/ui/Button.tsx', 'src/harness/run.ts'],
    });
    expect(r.scheduled).toBe(true);
  });
});

describe('maybeRunDesignReview — G-5 指纹去重 (跨轮)', () => {
  test('G-5 前半: 同一指纹二轮不重报 → deduped+1', async () => {
    // 第一轮: 写入一个 finding 到台账 (指纹须与 buildDiffOnlyFindings 一致)
    const evidence = 'diff-only 文本审 (D-10): 文件 src/App.tsx 在前端写集中, 无截图命令故仅审文件名/路径。';
    const fp = fingerprintOf('src/App.tsx', evidence);
    const ledgerPath = join(cwd, '.omd', 'review-ledger.json');
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({ findings: [{ where: 'src/App.tsx', severity: 'p2', evidence, suggestion: 'fix', uncertainty: 'low', fingerprint: fp }], overflows: [] }));

    // 第二轮: 同一文件, 应被去重
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/App.tsx'],
    });
    expect(r.scheduled).toBe(true);
    // 指纹已存在 → added=0, deduped≥1 (diff-only 路径也经 appendFindings 去重)
    expect(r.added + r.deduped).toBeGreaterThanOrEqual(1);
    expect(r.deduped).toBeGreaterThanOrEqual(1);
  });

  test('G-5: 新指纹正常落账 → added≥1, deduped=0', async () => {
    // 空台账
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/NewPage.tsx'],
    });
    expect(r.scheduled).toBe(true);
    expect(r.added).toBeGreaterThanOrEqual(1);
    expect(r.deduped).toBe(0);
  });
});

describe('maybeRunDesignReview — INV-3 审核失败不影响收敛', () => {
  test('INV-3: runReview 抛错 → scheduled=true 但不抛, added=0, usage 零', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/App.tsx'],
      runReview: async () => { throw new Error('审核叶崩了'); },
    });
    // 不抛到调用方
    expect(r.scheduled).toBe(true);
    expect(r.added).toBe(0);
    expect(r.usage.in).toBe(0);
  });

  test('INV-3: diff-only 路径始终可用 (不因缺 runner 抛错)', async () => {
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/index.css'],
    });
    expect(r.scheduled).toBe(true);
    // diff-only 路径不抛错
  });
});

describe('maybeRunDesignReview — 注入式 runner', () => {
  test('注入 runReview → 走注入路径, findings 经 ledger 存盘', async () => {
    const fp1 = fingerprintOf('src/App.tsx', 'bad spacing');
    const r = await maybeRunDesignReview({
      cwd,
      changedFiles: ['src/App.tsx'],
      runReview: async () => ({
        findings: [{
          where: 'src/App.tsx',
          severity: 'p1' as const,
          evidence: 'bad spacing',
          suggestion: 'add gap-4',
          uncertainty: 'low',
          fingerprint: fp1,
        }],
        usage: { in: 100, out: 50 },
      }),
    });
    expect(r.scheduled).toBe(true);
    expect(r.usage.in).toBe(100);
    expect(r.usage.out).toBe(50);
    expect(r.added).toBe(1);

    // 台账写入磁盘可读
    const found = loadLedger(join(cwd, '.omd', 'review-ledger.json'));
    expect(found).toHaveLength(1);
    expect(found[0]!.fingerprint).toBe(fp1);
  });
});

describe('DEFAULT_FRONTEND_GLOB', () => {
  test('默认 glob 命中 tsx/jsx/css/html/vue/svelte', () => {
    const glob = DEFAULT_FRONTEND_GLOB;
    expect(glob).toContain('tsx');
    expect(glob).toContain('jsx');
    expect(glob).toContain('css');
    expect(glob).toContain('html');
    expect(glob).toContain('vue');
    expect(glob).toContain('svelte');
  });
});
