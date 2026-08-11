/**
 * src/harness/review/anchor-check.test —— D-3 finding 反幻觉锚点闸 (INV-2 反向自检)。
 *
 * SDD: docs/plan/2026-08-10-cairness-distill-comparison.md, D-3 + G-5。
 * 落点说明: INV-2 原文写「本仓 src/eval/**.test.ts 惯例」, 但切片红线禁碰 src/eval/** ——
 * 按最小解释, 惯例语义 (测试随新闸同置) 保留, 落点让位红线, 测试与本闸同在 src/harness/**。
 *
 * INV-2 证伪方式 (逐条写进各 test): 每条已知违规样本 = 幻觉锚 (行号越界 / 文件不存在 /
 * 无锚点 / 绝对路径)。闸若缺失或判 valid, 该 finding 会以 P0/P1 原档进入终裁 ——
 * 断言 `red === true` + 该条进 `downgrades` 账本, 即当场证伪 (闸红 = 违规样本被拦)。
 * 阴性对照 (G-5 第二 Given): 未填模板 → 断言整体 skipped 且 red === false, 证伪"拿模板占位
 * 文本开刀"的误报形态。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFindingAnchors, type AnchorCheckResult } from './anchor-check';
import { runReview, type RunReviewOpts } from './run';
import { runReviewSingle } from './run-single';
import type { ExtractedFinding, VerifiedFinding } from './verify';
import type { ReviewSendFn } from './verify';

/** fixture cwd: 写一个 N 行文件 x.ts (尾随换行, 物理行数恰 N)。 */
function makeCwd(lines: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-anchor-test-'));
  writeFileSync(
    join(dir, 'x.ts'),
    lines === 0 ? '' : Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  );
  return dir;
}

function finding(over: Partial<ExtractedFinding> & { file: string }): ExtractedFinding {
  return { severity: 'P0', claim: 'test claim', symbols: [], dimension: 'correctness', ...over };
}

describe('D-3 锚点反幻觉闸 (checkFindingAnchors)', () => {
  test('INV-2 样本 A: 锚 src/x.ts:9999 而文件仅 100 行 → invalid-anchor, P0 降级记账, 闸红', async () => {
    // 证伪方式: 闸缺失时该 P0 幻觉锚原样进入终裁 (无人拦); 断言 red=true + 该条
    // downgrades 账本命中 (severity P0→P1), 即当场证伪 —— 违规样本必须红。
    const cwd = makeCwd(100);
    const res = await checkFindingAnchors([finding({ severity: 'P0', file: 'x.ts', line: 9999 })], cwd);
    expect(res.skipped).toBe(false);
    expect(res.red).toBe(true);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('文件仅 100 行');
    const d = res.downgrades[0]!;
    expect(d.downgraded).toBe(true);
    expect(d.downgradedSeverity).toBe('P1');
    expect(d.finding.severity).toBe('P0');
  });

  test('INV-2 样本 B: 锚指向不存在文件 → invalid-anchor, 闸红', async () => {
    // 证伪方式: 文件不存在而闸判 valid → 幻觉锚漏网; 断言 red=true + verdict=invalid-anchor 即证伪。
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ severity: 'P1', file: 'ghost.ts', line: 3 })], cwd);
    expect(res.red).toBe(true);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('不存在');
    expect(res.downgrades[0]!.downgradedSeverity).toBe('P2'); // P1→P2 非阻断档
  });

  test('G-5 阴性对照: 整份 review 为未填模板 (零 finding) → 整体 skipped, 零误报', async () => {
    // 证伪方式: 未填模板若被当成"锚点全部非法"红掉 → 误伤 (模板占位文本不是 finding);
    // 断言 skipped=true + red=false + 零降级, 即证伪该误报形态。
    const cwd = makeCwd(100);
    const res = await checkFindingAnchors([], cwd);
    expect(res.skipped).toBe(true);
    expect(res.red).toBe(false);
    expect(res.results).toHaveLength(0);
    expect(res.downgrades).toHaveLength(0);
  });

  test('合法锚点 (含边界 line == 行数) → valid, 不降级, 闸不红', async () => {
    const cwd = makeCwd(100);
    const res = await checkFindingAnchors(
      [
        finding({ severity: 'P1', file: 'x.ts', line: 1 }),
        finding({ severity: 'P0', file: 'x.ts', line: 100 }), // 边界: line ≤ 行数 → 合法
      ],
      cwd,
    );
    expect(res.red).toBe(false);
    expect(res.downgrades).toHaveLength(0);
    expect(res.results.every((r) => r.verdict === 'valid')).toBe(true);
  });

  test('越界边界: line = 行数 + 1 → invalid-anchor', async () => {
    const cwd = makeCwd(100);
    const res = await checkFindingAnchors([finding({ file: 'x.ts', line: 101 })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.red).toBe(true);
  });

  test('no-anchor: P0/P1 finding 无 line → 降级记账 (无合法锚点 = 无证据的 Critical 档)', async () => {
    // 证伪方式: 无 line 的 P0 声称若以原档放行 → 无锚点证据的 Critical 档进终裁; 断言降级即证伪。
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ severity: 'P0', file: 'x.ts' })], cwd);
    expect(res.results[0]!.verdict).toBe('no-anchor');
    expect(res.red).toBe(true);
    expect(res.downgrades[0]!.downgradedSeverity).toBe('P1');
  });

  test('绝对路径锚 → invalid-anchor (extract 契约要求 repo 相对路径, 出仓即幻觉)', async () => {
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ severity: 'P1', file: '/etc/hostname', line: 1 })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('非仓库相对路径');
    expect(res.red).toBe(true);
  });
  test('line ≤ 0 (line 0) → invalid-anchor, detail 钉死判据 (line 必须为正整数)', async () => {
    // 证伪方式: 判据面写「line 必须为正整数」而闸若只查 file 存在 → line 0 的幻觉锚漏网;
    // 断言 verdict=invalid-anchor + red=true, 即证伪「≤0 不被拦」的缺口形态。
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ severity: 'P0', file: 'x.ts', line: 0 })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('line 必须为正整数');
    expect(res.red).toBe(true);
    expect(res.downgrades[0]!.downgradedSeverity).toBe('P1');
  });

  test('非整数 line (1.5) → invalid-anchor (锚点必须是整数行号, 小数即幻觉)', async () => {
    // 证伪方式: 审查模型声称 x.ts:1.5 —— 行号无小数语义, 若闸按 1 处理即误放行;
    // 断言 verdict=invalid-anchor + red=true 即证伪「非整数被近似放行」的缺口形态。
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ file: 'x.ts', line: 1.5 })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('line 必须为正整数');
    expect(res.red).toBe(true);
  });

  test('空文件 (0 行) 锚 line 1 → invalid-anchor (文件存在但 line 越界)', async () => {
    // 证伪方式: 空文件真实存在, 闸若只查「文件在」不查行数 → 0 行文件被 anchor 到第 1 行;
    // 断言 detail 含「文件仅 0 行」+ red=true 即证伪「存在即合法」的缺口形态。
    const cwd = makeCwd(0);
    const res = await checkFindingAnchors([finding({ file: 'x.ts', line: 1 })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('文件仅 0 行');
    expect(res.red).toBe(true);
  });

  test('空 file 名 (提取层漏填) → invalid-anchor (extract 契约要求 file 必有 repo 相对路径)', async () => {
    // 证伪方式: extract 契约要求 file 必有 repo 相对路径, 空 file 的 finding 若被当
    // 「待查」放行 → 无定位的 P0 进终裁; 断言 verdict=invalid-anchor + detail 钉非相对路径即证伪。
    // (注: 生产者 detail 用 ?? 拼接 —— 空串走「非仓库相对路径」分支, 断言锚该分支而非 (空)。)
    const cwd = makeCwd(10);
    const res = await checkFindingAnchors([finding({ severity: 'P0', file: '' })], cwd);
    expect(res.results[0]!.verdict).toBe('invalid-anchor');
    expect(res.results[0]!.detail).toContain('非仓库相对路径');
    expect(res.red).toBe(true);
    expect(res.downgrades).toHaveLength(1);
  });

  test('混合输入: 合法锚 + 幻觉锚同批 → 账本只记违规条, 合法条原档不动', async () => {
    // 证伪方式: 闸若把整批一刀切 (全红或全放) → 混批里真 finding 被误伤或幻觉锚漏网;
    // 断言 downgrades 恰 1 条 (只含幻觉锚) + 合法条 verdict=valid 且 severity 保持 P1 即证伪。
    const cwd = makeCwd(100);
    const res = await checkFindingAnchors(
      [
        finding({ severity: 'P1', file: 'x.ts', line: 42 }),
        finding({ severity: 'P0', file: 'x.ts', line: 9999 }),
      ],
      cwd,
    );
    expect(res.results).toHaveLength(2);
    expect(res.results[0]!.verdict).toBe('valid');
    expect(res.results[0]!.downgraded).toBe(false);
    expect(res.results[0]!.finding.severity).toBe('P1'); // 合法条原档不被降级毁证
    expect(res.downgrades).toHaveLength(1);
    expect(res.downgrades[0]!.finding.line).toBe(9999);
    expect(res.red).toBe(true);
  });
});

// ---- 挂点测试: review/audit 产出出口 (runReview + runReviewSingle) 必须带上 anchorCheck ----

/** 内容路由 fake send: find 层 → '无真 bug。'; extract → 已知违规样本 (锚 x.ts:9999); verifyOne → CONFIRMED。
 *  (run.ts 多维度路径调用的是真 verifyFindings, 只能经 send 路由喂样本; 单 agent 臂才走 deps.verifyFindings。) */
function routingSend(extractReply: () => unknown[] = () => [
  { severity: 'P0', file: 'x.ts', line: 9999, claim: '幻觉锚', symbols: [], dimension: 'correctness' },
]) {
  return (async (req: { messages: { content: string }[] }) => {
    const content = String(req.messages[0]!.content);
    if (content.includes('证伪裁决员')) return { text: 'VERDICT: CONFIRMED\n依据: fake' };
    if (content.includes('下面是')) return { text: JSON.stringify(extractReply()) };
    return { text: '无真 bug。' };
  }) as unknown as ReviewSendFn;
}

/** 注入 verifyFindings: 返回一条已知违规样本 (锚 x.ts:9999, 文件实仅 100 行)。 */
function badAnchorVerify() {
  return async (): Promise<VerifiedFinding[]> => [
    {
      severity: 'P0', file: 'x.ts', line: 9999, claim: '幻觉锚', symbols: [], dimension: 'correctness',
      verdict: 'CONFIRMED', reason: 'fake',
    },
  ];
}

test('挂点 runReview: 产出出口带 anchorCheck, 违规锚 → red + 报告含降级记账段', async () => {
  // 证伪方式: 若挂点没接 (产出出口裸放 verified), 幻觉锚以 P0 原档流出且报告无降级段;
  // 断言 res.anchorCheck.red=true + 落盘 doc 含「降级记账」即证伪。
  const cwd = makeCwd(100);
  const opts: RunReviewOpts = {
    diff: 'diff --git a/x.ts b/x.ts\n+const x = 1;',
    scope: 'x.ts',
    gate: 'G1',
    model: 'test:find-model',
    outPath: join(mkdtempSync(join(tmpdir(), 'omd-anchor-run-')), 'out.md'),
    verify: true,
    cwd,
    deps: { send: routingSend(), env: {} },
  };
  const res = await runReview(opts);
  expect(res.anchorCheck).toBeDefined();
  expect(res.anchorCheck!.red).toBe(true);
  expect(res.anchorCheck!.downgrades).toHaveLength(1);
  const doc = await Bun.file(opts.outPath!).text();
  expect(doc).toContain('锚点反幻觉闸');
  expect(doc).toContain('降级记账');
  expect(doc).toContain('x.ts:9999');
});

test('挂点 runReviewSingle: 单 agent 臂同样带 anchorCheck, 违规锚 → red', async () => {
  const cwd = makeCwd(100);
  const res = await runReviewSingle({
    diff: 'diff\n+const y=1;',
    scope: 'x.ts',
    gate: 'G2',
    outPath: join(mkdtempSync(join(tmpdir(), 'omd-anchor-single-')), 'out.md'),
    model: 'fake:review',
    cwd,
    deps: {
      env: {},
      agentRun: async () => ({ text: 'P0 x.ts:9999 幻觉 bug' }),
      verifyFindings: badAnchorVerify(),
    },
  });
  expect(res.anchorCheck).toBeDefined();
  expect(res.anchorCheck!.red).toBe(true);
  expect(res.anchorCheck!.downgrades[0]!.finding.line).toBe(9999);
  const doc = await Bun.file(res.outPath).text();
  expect(doc).toContain('降级记账');
});

test('挂点 runReview: 未填模板 (verifyFindings 返回 []) → anchorCheck.skipped, 闸不红', async () => {
  // G-5 第二 Given 的挂点侧: 零 finding → 整体 skipped, 零误报 (报告含模板豁免说明)。
  const cwd = makeCwd(100);
  const res = await runReview({
    diff: 'diff --git a/x.ts b/x.ts\n+const x = 1;',
    scope: 'x.ts',
    gate: 'G1',
    model: 'test:find-model',
    outPath: join(mkdtempSync(join(tmpdir(), 'omd-anchor-empty-')), 'out.md'),
    verify: true,
    cwd,
    deps: { send: routingSend(() => []), env: {} },
  });
  expect(res.anchorCheck!.skipped).toBe(true);
  expect(res.anchorCheck!.red).toBe(false);
  const doc = await Bun.file(res.outPath).text();
  expect(doc).toContain('整体 skipped');
});
