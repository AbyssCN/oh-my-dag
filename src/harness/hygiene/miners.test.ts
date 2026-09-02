/**
 * hygiene/miners.test —— 九个矿源纯函数的判别力 (零 IO, 零 spawn)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · `mineBigFiles` 的 `>` 改成 `>=` → 「恰好等于阈值不算」那条红。
 *   · `mineStalePlans` 去掉 `referencedText.includes` 那一句 → 「老但被引用的不算」那条红。
 *   · `mineDebt` 换成裸正则不走 `parseDebtLine` → 「散文里提到 ponytail: 不入账」那条红。
 *   · `mineFailedRuns` 改成逐条一项 → 「每簇一项 + metrics.count = 簇大小」那条红。
 *   · `mineSeamDrift` 在 code=0 时也产项 → 「不漂 → 空数组」那条红。
 *   · id 用 `<file>:<line>` 而不是正文 hash → 「挪行不改 id」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { BIG_FILE_LINE_THRESHOLD, MAX_CLUSTER_SAMPLES, STALE_PLAN_DAYS } from './types';
import {
  clusterKeyOf,
  mineBigFiles,
  mineDebt,
  mineFailedRuns,
  mineForks,
  mineKnip,
  mineSeamDrift,
  mineStalePlans,
  mineTestHealth,
  mineTodo,
  parseGrepLine,
  stripAnsi,
} from './miners';

const DAY = 24 * 60 * 60 * 1000;

describe('① mineKnip 四类分开计数', () => {
  const raw = {
    issues: [
      { file: 'src/dead.ts', files: [{ name: 'src/dead.ts' }] },
      { file: 'src/a.ts', exports: [{ name: 'unusedFn', line: 12 }], types: [{ name: 'UnusedT', line: 30 }] },
      { file: 'package.json', dependencies: [{ name: 'left-pad' }], devDependencies: [{ name: 'old-tool' }] },
    ],
  };

  test('死文件 / 死导出 / 死类型 / 死依赖 各归各类', () => {
    const items = mineKnip(raw);
    const by = (s: string): number => items.filter((i) => i.source === s).length;
    expect(by('knip-files')).toBe(1);
    expect(by('knip-exports')).toBe(1);
    expect(by('knip-types')).toBe(1);
    expect(by('knip-deps')).toBe(2);
  });

  test('dep 与 devDep 用 metrics.dev 区分, 不抹平成一个字符串', () => {
    const deps = mineKnip(raw).filter((i) => i.source === 'knip-deps');
    expect(deps.find((d) => d.symbol === 'left-pad')!.metrics!.dev).toBe(0);
    expect(deps.find((d) => d.symbol === 'old-tool')!.metrics!.dev).toBe(1);
  });

  test('死导出 id 带路径与符号 (跨扫描稳定)', () => {
    expect(mineKnip(raw).find((i) => i.source === 'knip-exports')!.id).toBe('knip-exports:src/a.ts#unusedFn');
  });

  test('空报告 → 空数组 (不是抛)', () => {
    expect(mineKnip({})).toEqual([]);
    expect(mineKnip({ issues: [] })).toEqual([]);
  });
});

describe('② mineDebt 走 parseDebtLine 前缀强制', () => {
  test('真标记入账, 散文里顺嘴提到的不入账', () => {
    const items = mineDebt([
      'src/x.ts:10:const a = 1; // ponytail: 全局锁够用, 吞吐成瓶颈时改 per-account 锁',
      'docs/y.md:3:见 skills 里的 ponytail: 说明段落',
      'Binary file src/z.bin matches',
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe('src/x.ts');
    expect(items[0]!.line).toBe(10);
    expect(items[0]!.summary).toContain('全局锁够用');
  });

  test('缺 upgrade 触发条件 → metrics.noUpgradeTrigger=1 (rot 风险单独一列)', () => {
    const withTrigger = mineDebt(['a.ts:1:// ponytail: 上限 X, 触发 Y'])[0]!;
    const without = mineDebt(['a.ts:1:// ponytail: 只有上限没触发'])[0]!;
    expect(withTrigger.metrics!.noUpgradeTrigger).toBe(0);
    expect(without.metrics!.noUpgradeTrigger).toBe(1);
  });

  test('挪行不改 id (id 走正文 hash 不走行号)', () => {
    const a = mineDebt(['a.ts:10:// ponytail: 上限 X, 触发 Y'])[0]!;
    const b = mineDebt(['a.ts:999:// ponytail: 上限 X, 触发 Y'])[0]!;
    expect(a.id).toBe(b.id);
    expect(a.line).not.toBe(b.line);
  });
});

describe('③ mineTodo 四个标记词', () => {
  test('TODO / FIXME / XXX / HACK 都认, 且注释符后紧跟才算', () => {
    const items = mineTodo([
      'a.ts:1:// TODO: 补边界',
      'b.ts:2:  # FIXME 这里会漏',
      'c.ts:3:/* XXX: 临时 */',
      'd.ts:4: * HACK: 绕开上游 bug',
      'e.ts:5:const s = "这句话里有 TODO 但不是注释";',
    ]);
    expect(items.map((i) => i.symbol)).toEqual(['TODO', 'FIXME', 'XXX', 'HACK']);
    expect(items.some((i) => i.path === 'e.ts')).toBe(false);
  });

  test('块注释收尾符不进正文', () => {
    expect(mineTodo(['c.ts:3:/* XXX: 临时 */'])[0]!.summary).toBe('XXX: 临时');
  });
});

describe('④ mineBigFiles 阈值', () => {
  test('严格大于阈值才算; 恰好等于不算', () => {
    const items = mineBigFiles([
      { path: 'big.ts', lines: BIG_FILE_LINE_THRESHOLD + 1 },
      { path: 'edge.ts', lines: BIG_FILE_LINE_THRESHOLD },
      { path: 'small.ts', lines: 10 },
    ]);
    expect(items.map((i) => i.path)).toEqual(['big.ts']);
    expect(items[0]!.metrics!.lines).toBe(BIG_FILE_LINE_THRESHOLD + 1);
  });

  test('按行数降序 (最长的先进分诊叶)', () => {
    const items = mineBigFiles([
      { path: 'a.ts', lines: BIG_FILE_LINE_THRESHOLD + 5 },
      { path: 'b.ts', lines: BIG_FILE_LINE_THRESHOLD + 500 },
    ]);
    expect(items.map((i) => i.path)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('⑤ mineStalePlans 两个条件缺一不可', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  const old = now - (STALE_PLAN_DAYS + 5) * DAY;
  const fresh = now - 3 * DAY;

  test('老 ∧ 无人引用 → 入账', () => {
    const items = mineStalePlans([{ path: 'docs/plan/old.md', mtimeMs: old }], '', now);
    expect(items).toHaveLength(1);
    expect(items[0]!.metrics!.ageDays).toBe(STALE_PLAN_DAYS + 5);
  });

  test('老但被 NOTES / docs-map 引用 → 是档案不是腐败', () => {
    expect(mineStalePlans([{ path: 'docs/plan/old.md', mtimeMs: old }], '见 docs/plan/old.md', now)).toEqual([]);
    expect(mineStalePlans([{ path: 'docs/plan/old.md', mtimeMs: old }], '参考 old.md', now)).toEqual([]);
  });

  test('新但无人引用 → 不算 (还在写)', () => {
    expect(mineStalePlans([{ path: 'docs/plan/new.md', mtimeMs: fresh }], '', now)).toEqual([]);
  });
});

describe('⑥ mineSeamDrift 只在漂时产项', () => {
  test('退出 0 → 空数组 (不漂 ≠ 读不到)', () => {
    expect(mineSeamDrift({ code: 0, out: 'seam-catalog --check: OK' })).toEqual([]);
  });

  test('退出非 0 → 一条 item, evidence 剥了 ANSI', () => {
    const items = mineSeamDrift({ code: 1, out: '[31mseams.md 与类型真源不一致[0m' });
    expect(items).toHaveLength(1);
    expect(items[0]!.evidence[0]).toBe('seams.md 与类型真源不一致');
    expect(items[0]!.metrics!.exitCode).toBe(1);
  });
});

describe('⑦ mineTestHealth 三类逐条', () => {
  test('一条失败一项, totals 读不到写 null 不写 0', () => {
    const items = mineTestHealth({
      failures: [
        { kind: 'runner-timeout', test: 'a > b', evidence: '^ this test timed out after 240000ms.' },
        { kind: 'assertion', test: 'c > d', evidence: 'error: expected 1 to be 2' },
      ],
      totals: { pass: 9101, fail: 2, skip: null },
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toContain('test-health:runner-timeout:');
    expect(items[0]!.metrics!.skip).toBeNull();
    expect(items[0]!.metrics!.pass).toBe(9101);
  });

  test('零失败 → 空数组', () => {
    expect(mineTestHealth({ failures: [], totals: { pass: 1, fail: 0, skip: 0 } })).toEqual([]);
  });
});

describe('⑧ mineFailedRuns 按终止原因聚类', () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({
      run_id: `r${i}`,
      status: 'failed',
      error: '终止原因: not-converged (STALLED) · 下一步: 加 maxRounds 后 resume',
    })),
    { run_id: 'x1', status: 'failed', error: '终止原因: infra-error (ERROR) · 下一步: 看栈 / 换池' },
    { run_id: 'x2', status: 'failed', error: '[31mexit 2: 无 diff[0m' },
    { run_id: 'x3', status: 'failed', error: null },
  ];

  test('每簇一项, metrics.count = 簇大小, 按簇大小降序', () => {
    const items = mineFailedRuns(rows);
    expect(items).toHaveLength(4);
    expect(items[0]!.id).toBe('failed-runs:not-converged');
    expect(items[0]!.metrics!.count).toBe(4);
    expect(items.map((i) => i.metrics!.count)).toEqual([4, 1, 1, 1]);
  });

  test(`样本 runId 至多 ${MAX_CLUSTER_SAMPLES} 个`, () => {
    const sample = mineFailedRuns(rows)[0]!.evidence[1]!;
    expect(sample.split(',')).toHaveLength(MAX_CLUSTER_SAMPLES);
  });

  test('无判词自成一簇, 不被塞进别的簇 (NULL ≠ 别的原因)', () => {
    expect(mineFailedRuns(rows).some((i) => i.id === 'failed-runs:(无判词)')).toBe(true);
  });

  test('clusterKeyOf: 无终止原因 → 剥色后的首行前缀', () => {
    expect(clusterKeyOf('[31mexit 2: 无 diff[0m')).toBe('exit 2: 无 diff');
  });
});

describe('⑨ mineForks 逐条', () => {
  test('未裁 fork 一条一项, evidence 带 runId', () => {
    const items = mineForks([{ id: 'f1', run_id: 'r9', question: '选 A 还是 B', created_at: '2026-08-01' }]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('forks:f1');
    expect(items[0]!.evidence[0]).toContain('r9');
  });
});

describe('共用小工具', () => {
  test('parseGrepLine 拒不成形状的行', () => {
    expect(parseGrepLine('Binary file x matches')).toBeNull();
    expect(parseGrepLine('a.ts:7:code')).toEqual({ file: 'a.ts', line: 7, text: 'code' });
  });

  test('stripAnsi 剥色不动正文', () => {
    expect(stripAnsi('[0m[31m红[0m')).toBe('红');
  });
});
