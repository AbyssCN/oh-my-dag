/**
 * retry-domain 单测 —— **S3 切片 1** (D-1 / D-2 / D-3, INV-1 / INV-2 / INV-3).
 *
 * 锚串 `RETRY_DOMAIN_ORACLE` 是本片的反作弊钉 —— 不许删, 删了就让
 * `ugrep -q 'RETRY_DOMAIN_ORACLE' ./src/harness/dag/retry-domain.test.ts` 空匹配,
 * O-6 vacuous-verify 闸会判本片空绿.
 *
 * ## 反向自检 (契约 §反向自检 第 1 条)
 * 把 `classifyRetryDomain` 改成恒返 `'generation'` ⇒ RETRY_DOMAIN_ORACLE 用例当场红.
 * 把 `retryBudgetFor` 的 oracle 那一支改成 `return maxRetry ?? 0` ⇒ INV-2 三条 GWT 全部红.
 * 把 `retryBudgetFor` 的 generation 那一支改成与今天不同 ⇒ INV-3 第一条 GWT 红
 * (1 次变 N 次, 单依赖 `timed-out` 跑出非 2 次).
 *
 * ⚠ 测试集是冻结的: 收 GREEN 不能改这些断言, 只能用合法实现让它们转绿.
 */
import { describe, expect, test } from 'bun:test';
import { classifyRetryDomain, retryBudgetFor, type RetryDomain } from './retry-domain';
import type { NodeFailureKind } from '../node-failure';

// ─────────── 锚串 · 反作弊 (deleting this comment WILL fail the slice) ───────────
const ANCHOR = 'RETRY_DOMAIN_ORACLE';
test(`anchor: ${ANCHOR} (deleting the test or the source constant = slice fail)`, () => {
  // 这条用例与反作弊条款 EMPTY MATCH 共线: 它把锚串当字面常量挂在测试名里,
  // 任何让锚串从文件里消失的改动都会让这条用例消失或改名, 触发 O-6.
  expect(ANCHOR).toBe('RETRY_DOMAIN_ORACLE');
  expect(['oracle', 'generation']).toContain('oracle'); // 类型与值同源
});

describe('classifyRetryDomain · 域判定纯函数 (INV-1)', () => {
  // ─────────── GWT1 · oracle 域的唯一形态 · 承重 ───────────
  test('GWT1 RETRY_DOMAIN_ORACLE: command + assert-failed ⇒ oracle', () => {
    expect(classifyRetryDomain('command', 'assert-failed')).toBe('oracle');
  });

  // ─────────── GWT2 · 「没能说话」与「说了不」分两格 · D-3 / 仓规坑 1 ───────────
  test('GWT2 timed-out 与 throw 路径不进 oracle 域 (跑超时 ≠ 跑出错答案)', () => {
    expect(classifyRetryDomain('command', 'timed-out')).toBe('generation');
    // 其余 command failureKind 一律 generation
    const allOtherFailureKinds: NodeFailureKind[] = [
      'gate-rejected',
      'stall',
      'spin-fused',
      'empty-artifact',
      'broken-artifact',
      'no-sources',
      'missing-capability',
      'infra-error',
      'dep-skip',
      'subgraph-failed',
      'rounds-exhausted',
      'unclassified',
    ];
    for (const fk of allOtherFailureKinds) {
      expect(classifyRetryDomain('command', fk)).toBe('generation');
    }
  });

  // ─────────── GWT3 · 非 command 节点一律 generation ───────────
  test('GWT3 非 command kind 一律 generation (8 个 kind 全列)', () => {
    const kinds = [
      'inproc',
      'agent',
      'command',
      'map',
      'primitive',
      'research',
      'conductor',
      'await',
    ] as const;
    for (const k of kinds) {
      if (k === 'command') {
        // command 在 failureKind 非 assert-failed 时仍 generation —— 由 GWT2 覆盖
        // 这里只覆盖非 command 的全部 kind
        continue;
      }
      expect(classifyRetryDomain(k, 'assert-failed' as NodeFailureKind | undefined)).toBe(
        'generation',
      );
    }
  });

  // ─────────── GWT4 · failureKind 缺席 = generation ───────────
  test('GWT4 failureKind 缺席 (status=done 或老记录) ⇒ generation', () => {
    expect(classifyRetryDomain('command', undefined)).toBe('generation');
    expect(classifyRetryDomain('agent', undefined)).toBe('generation');
  });

  // ─────────── GWT5 · 值域恰为两值, 无第三格 · 仓规坑 1 ───────────
  test('GWT5 RetryDomain 是 oracle | generation 的二元联合, 抽样全列穷尽', () => {
    // 把 8 kind × 13 failureKind = 104 种组合全跑一遍; oracle 应只占 1 格.
    const kinds = [
      'inproc',
      'agent',
      'command',
      'map',
      'primitive',
      'research',
      'conductor',
      'await',
    ] as const;
    const failureKinds: ReadonlyArray<NodeFailureKind | undefined> = [
      undefined,
      'assert-failed',
      'timed-out',
      'gate-rejected',
      'stall',
      'spin-fused',
      'empty-artifact',
      'broken-artifact',
      'no-sources',
      'missing-capability',
      'infra-error',
      'dep-skip',
      'subgraph-failed',
      'rounds-exhausted',
      'unclassified',
    ];
    let oracleCount = 0;
    for (const k of kinds) {
      for (const fk of failureKinds) {
        const d = classifyRetryDomain(k, fk);
        expect(['oracle', 'generation']).toContain(d); // 值域二选一, 无第三值
        if (d === 'oracle') oracleCount += 1;
      }
    }
    // 全表里**恰 1 格** oracle, 即 command × assert-failed; 任何多算即闸判废.
    expect(oracleCount).toBe(1);
  });
});

describe('retryBudgetFor · 预算裁决纯函数 (INV-2 / INV-3)', () => {
  // ─────────── GWT6 · oracle 域判否 = 越过 max_retry, 任意值都给 0 ───────────
  test('GWT6 oracle 域: max_retry=0/3/9 都给 0 (D-2 / INV-2 钉闸)', () => {
    expect(retryBudgetFor('oracle', 0, false)).toBe(0);
    expect(retryBudgetFor('oracle', 0, true)).toBe(0);
    expect(retryBudgetFor('oracle', 3, false)).toBe(0);
    expect(retryBudgetFor('oracle', 3, true)).toBe(0);
    expect(retryBudgetFor('oracle', 9, false)).toBe(0);
    expect(retryBudgetFor('oracle', undefined, true)).toBe(0);
  });

  // ─────────── GWT7 · generation 域: 显式 max_retry 压过一切 ───────────
  test('GWT7 generation 域: 显式 max_retry 压过抛错补 1 的缺省', () => {
    expect(retryBudgetFor('generation', 3, false)).toBe(3);
    expect(retryBudgetFor('generation', 3, true)).toBe(3); // 显式含 0 也压过
    expect(retryBudgetFor('generation', 0, true)).toBe(0); // 含 0 也压过 (这条很关键)
  });

  // ─────────── GWT8 · generation 域: 抛错补 1 次 ───────────
  test('GWT8 generation 域: 未声明 max_retry, 抛错补 1', () => {
    expect(retryBudgetFor('generation', undefined, true)).toBe(1);
  });

  // ─────────── GWT8b · R-1 (2026-08-30): 「交了东西但东西不对」也补 1 次 ───────────
  //
  // 反向自检: 把 retryBudgetFor 的最后一行改回 `return 0` ⇒ 本条前两个断言红。
  // 把 REPAIRABLE_BY_CAUSE 扩成"全给" ⇒ 后面那组 (超时/stall/闸拒…) 全红 ——
  // 那正是 2026-08-30 第一版切太宽时全量 dag 片 6 红的形式化。
  test('GWT8b R-1: 没抛错时按失败分型分 —— 有产出可注的补 1, 没能说话的仍 0', () => {
    // 有东西可注 (leaf 交了东西但东西不对) → 1
    expect(retryBudgetFor('generation', undefined, false, 'empty-artifact')).toBe(1);
    expect(retryBudgetFor('generation', undefined, false, 'broken-artifact')).toBe(1);
    // 没能说话 / 闸拒 / 缺能力 / 控制流终态 → 仍 0 (重试只会原地翻倍等待)
    for (const k of ['timed-out', 'stall', 'gate-rejected', 'missing-capability',
                     'dep-skip', 'spin-fused', 'rounds-exhausted', 'infra-error'] as const) {
      expect(retryBudgetFor('generation', undefined, false, k), `${k} 不该拿到预算`).toBe(0);
    }
    // 「不知道」不是「可以」—— retryable=null 的两格与缺席一律 0
    expect(retryBudgetFor('generation', undefined, false, 'subgraph-failed')).toBe(0);
    expect(retryBudgetFor('generation', undefined, false, 'unclassified')).toBe(0);
    expect(retryBudgetFor('generation', undefined, false)).toBe(0); // failureKind 缺席
  });

  // ─────────── GWT8c · oracle 域不受 R-1 影响 (retry-masking 仍然挡住) ───────────
  test('GWT8c oracle 域: 即便分型在白名单里也一律 0 (判词不是故障)', () => {
    expect(retryBudgetFor('oracle', undefined, false, 'empty-artifact')).toBe(0);
    expect(retryBudgetFor('oracle', 3, false, 'broken-artifact')).toBe(0);
  });

  // ─────────── GWT9 · 「timed-out 与抛错」分两轴的恒等式 · INV-3 第二条 GWT ───────────
  test('GWT9 max_retry=1 时 timed-out 跑出 2 次, assert-failed 跑出 1 次 (两个数必不相等)', () => {
    // 用 retryBudgetFor 的语言直接表达: 同一 max_retry=1 下,
    //   · 「上一次抛错」(thrown=true)  ⇒ budget = 1 ⇒ 总尝试 = budget + 1 = 2
    //   · 「说了不」(oracle) ⇒ budget = 0 ⇒ 总尝试 = 1
    // 这是 INV-3 反向自检的形式化: 两个数相等即判红.
    const timedOut = retryBudgetFor('generation', 1, true); // timed-out 走 generation 域 + thrown=true
    const oracleRed = retryBudgetFor('oracle', 1, false); // assert-failed 走 oracle 域
    expect(timedOut).toBe(1); // → 总尝试 2
    expect(oracleRed).toBe(0); // → 总尝试 1
    expect(timedOut).not.toBe(oracleRed);
  });
});

describe('retry-domain · 模块边界 (INV-1 第二条 GWT)', () => {
  // ─────────── GWT10 · 零 IO, 零日志, 零 conductor-plan 依赖 ───────────
  test('GWT10 retry-domain.ts 是纯模块: 不读 logger, 不引用 conductor-plan 模块', async () => {
    // 用静态 grep 而非运行时 import —— 测试也是契约的一部分, 它不该让被测模块
    // 知道有人会来 grep 它, 否则它可以写个 dummy `logger` 把 grep 骗过.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./retry-domain.ts', import.meta.url), 'utf8');
    // 0 条 logger 命中 —— 任何 logger.* / logger. 调用都判红.
    const loggerHits = (src.match(/\blogger\b/g) ?? []).length;
    expect(loggerHits).toBe(0);
    // 0 条 conductor-plan 模块导入 —— 纯函数, 零外部计划层依赖.
    // 用 `from './conductor-plan'` 与 `from '../conductor-plan'` 两个真实形态去匹配,
    // 避免被注释里的字面串骗到.
    const planImportHits =
      (src.match(/from\s+['"]\.\.?\/conductor-plan['"]/g) ?? []).length;
    expect(planImportHits).toBe(0);
  });
});

// ── P2b-runtime (2026-09-02): 'oracle-inconclusive' 的域归属 —— 新增, 不改冻结区块 ──
//
// 加这一格是因为 P2b-runtime 把 'assert-failed' 之外的成因从 classifyCommandExit 分出来一格
// (harness 自己没跑起来 ≠ 断言没成立), 而域分类只对 'assert-failed' 特判 → 这一格照 GWT2 的
// "其余一律 generation" 落 generation, 是意料之中的域翻转, 这里把它钉成一条显式断言。
describe('P2b-runtime: oracle-inconclusive 的域归属 (域翻转是意料之中的, 不是巧合)', () => {
  test("classifyRetryDomain('command', 'oracle-inconclusive') === 'generation', 不是 'oracle'", () => {
    expect(classifyRetryDomain('command', 'oracle-inconclusive')).toBe('generation');
  });

  test('域翻转之后, 声明了显式 max_retry 的节点会被照单全收 (今天没有节点这么声明, 但闸的行为要锁死)', () => {
    // 与 GWT7 (generation 域: 显式 max_retry 压过一切) 同一条闸, 只是换了 failureKind 参数 ——
    // 证明 retryBudgetFor 对 'oracle-inconclusive' 走的是普通 generation 路径, 不是隐藏的例外。
    expect(retryBudgetFor('generation', 3, false, 'oracle-inconclusive')).toBe(3);
  });
});
