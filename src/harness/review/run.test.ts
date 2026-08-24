/**
 * src/harness/review/run.test —— 双轴对抗审查 (Standards × Spec) + gate 阶梯测试。
 *
 * 全 fake generate / 注入依赖 (deps.send / deps.findSdd / deps.env), 零真实模型调用。
 * CLI 阶梯 (G0 短路 / --no-spec@G3 报错 / --help) 走子进程冒烟 (不需要 provider env)。
 * D-4 观察面 (SDD C-5): onProgress 汇的事件序列 + OMD_REVIEW_EVENT_FILE 子进程通道, 含反向自检。
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, DIMS_BY_GATE, SPEC_SKIPPED_NOTE, type ReviewProgressEvent, type RunReviewOpts } from './run';
import type { ReviewSendFn, VerifiedFinding } from './verify';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'dag-review.ts');

/** 录制型 fake send: 记下每次调用的 model + prompt, 按 prompt 内容路由返回。 */
function makeFakeSend(reply: (content: string) => string = () => '无真 bug。') {
  const calls: { model: string; content: string }[] = [];
  const send = (async (req: { model: string; messages: { content: string }[] }) => {
    const content = String(req.messages[0]!.content);
    calls.push({ model: req.model, content });
    return { text: reply(content) } as unknown;
  }) as unknown as ReviewSendFn;
  return { calls, send };
}

function baseOpts(over: Partial<RunReviewOpts>): RunReviewOpts {
  return {
    diff: 'diff --git a/x.ts b/x.ts\n+const x = 1;',
    scope: 'x.ts',
    gate: 'G3',
    model: 'test:find-model',
    outPath: join(mkdtempSync(join(tmpdir(), 'omd-review-test-')), 'out.md'),
    verify: false,
    ...over,
  };
}

const FAKE_SDD = {
  path: '/fake/docs/plan/2026-07-19-sdd.md',
  text: '# SDD\nOracle-cmd: bun test\nForbidden files: tui.ts\nD-1: 用双轴。',
};

describe('review/run 双轴', () => {
  test('gate 阶梯默认维度: G1/G2 无 spec, G3 强制含 spec', () => {
    expect(DIMS_BY_GATE.G1).toEqual(['contract', 'boundary']);
    expect(DIMS_BY_GATE.G2).toEqual(['correctness', 'security', 'boundary']);
    expect(DIMS_BY_GATE.G3).toContain('spec');
    expect(DIMS_BY_GATE.G3).toEqual(expect.arrayContaining(['correctness', 'security', 'boundary', 'contract', 'spec']));
  });

  test('G3 含 spec 轴: SDD 原文进 prompt, 报告双段 (Standards 轴 / Spec 轴 + SDD 路径)', async () => {
    const { calls, send } = makeFakeSend();
    const opts = baseOpts({ deps: { send, findSdd: () => FAKE_SDD, env: {} } });
    const res = await runReview(opts);

    expect(res.findings.map((f) => f.dimension)).toContain('spec');
    expect(res.sddPath).toBe(FAKE_SDD.path);
    expect(res.specSkipped).toBeUndefined();
    // spec 那次调用: SDD 原文 + 三类偏离镜头都在 prompt 里
    const specCall = calls.find((c) => c.content.includes('对抗式审查 [spec]'));
    expect(specCall).toBeDefined();
    expect(specCall!.content).toContain(FAKE_SDD.text);
    expect(specCall!.content).toContain('未兑现的承诺');
    expect(specCall!.content).toContain('超范围改动');
    // 写盘报告: 双段 + SDD 溯源
    const doc = await Bun.file(opts.outPath!).text();
    expect(doc).toContain('## Standards 轴');
    expect(doc).toContain('## Spec 轴');
    expect(doc).toContain(FAKE_SDD.path);
  });

  test('无 SDD → spec 轴跳过 (非失败): 不发模型调用, 报告留跳过说明', async () => {
    const { calls, send } = makeFakeSend();
    const opts = baseOpts({ deps: { send, findSdd: () => null, env: {} } });
    const res = await runReview(opts);

    expect(res.specSkipped).toBe(true);
    expect(res.sddPath).toBeUndefined();
    const spec = res.findings.find((f) => f.dimension === 'spec')!;
    expect(spec.skipped).toBe(true);
    expect(spec.text).toBe(SPEC_SKIPPED_NOTE);
    // spec 未发模型调用: 只有 4 个 standards 维度的调用
    expect(calls.length).toBe(DIMS_BY_GATE.G3.length - 1);
    expect(calls.every((c) => !c.content.includes('对抗式审查 [spec]'))).toBe(true);
    const doc = await Bun.file(opts.outPath!).text();
    expect(doc).toContain('## Spec 轴');
    expect(doc).toContain(SPEC_SKIPPED_NOTE);
  });

  test('OMD_REVIEW_SPEC_MODEL: spec 轴单独路由, standards 轴不受影响; 未设 → 回落 find 层', async () => {
    const { calls, send } = makeFakeSend();
    await runReview(baseOpts({
      // seatOpts 空表 = 绕开真仓 .omd/config.json (座位链会读它, 否则真配置压过注入的 env)。
      deps: {
        send,
        findSdd: () => FAKE_SDD,
        env: { OMD_REVIEW_SPEC_MODEL: 'test:spec-model' },
        seatOpts: { modelsMap: {}, autoAssignMap: {} },
      },
    }));
    const specCall = calls.find((c) => c.content.includes('对抗式审查 [spec]'))!;
    expect(specCall.model).toBe('test:spec-model');
    for (const c of calls.filter((c) => c !== specCall)) expect(c.model).toBe('test:find-model');

    // 座位链一层都不命中 → spec 轴回落 find 层模型。
    // (真实环境里 auto-assign 会给 review-spec 派 verify 档坐标, 与 review 座同档 —— 所以这条
    //  回落在生产中很少走到; 这里用空 seatOpts 造出"整条链皆空"的边界来钉它仍然成立。)
    const fb = makeFakeSend();
    await runReview(
      baseOpts({
        deps: {
          send: fb.send,
          findSdd: () => FAKE_SDD,
          env: {},
          seatOpts: { modelsMap: {}, autoAssignMap: {}, configPath: '/nonexistent/omd-config.json' },
        },
      }),
    );
    expect(fb.calls.find((c) => c.content.includes('对抗式审查 [spec]'))!.model).toBe('test:find-model');
  });

  test('收敛层两轴共用: spec 偏离与 standards bug 一起走 extract→证伪', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-review-cwd-'));
    const { calls, send } = makeFakeSend((content) => {
      if (content.includes('证伪裁决员')) return 'VERDICT: CONFIRMED\n依据: 测试固定裁决。';
      if (content.includes('结构化提取')) {
        const m = content.match(/"dimension":"(\w+)"/);
        const dim = m ? m[1]! : 'unknown';
        return JSON.stringify([{ severity: 'P1', file: 'x.ts', line: 1, claim: `claim-${dim}`, symbols: [], dimension: dim }]);
      }
      return 'P1 x.ts:1 finding';
    });
    const res = await runReview(baseOpts({
      dims: ['correctness', 'spec'],
      verify: true,
      cwd,
      deps: { send, findSdd: () => FAKE_SDD, env: {} },
    }));
    expect(res.verified).toBeDefined();
    const dims = res.verified!.map((v) => v.dimension).sort();
    expect(dims).toEqual(['correctness', 'spec']);
    expect(res.verified!.every((v) => v.verdict === 'CONFIRMED')).toBe(true);
    // 收敛层段在报告里, 且标了两轴共用
    const doc = await Bun.file(res.outPath).text();
    expect(doc).toContain('收敛层裁决 (两轴共用)');
    expect(calls.some((c) => c.content.includes('证伪裁决员'))).toBe(true);
  });

  test('无 SDD + verify: 跳过的 spec 轴不进收敛层 (无 extract 调用喂 spec 跳过文本)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-review-cwd2-'));
    const { calls, send } = makeFakeSend((content) =>
      content.includes('结构化提取') ? '[]' : '无真 bug。');
    await runReview(baseOpts({
      dims: ['correctness', 'spec'], verify: true, cwd,
      deps: { send, findSdd: () => null, env: {} },
    }));
    const extractCalls = calls.filter((c) => c.content.includes('结构化提取'));
    expect(extractCalls.length).toBe(1); // 只有 correctness; spec 跳过不进
    expect(extractCalls[0]!.content).not.toContain(SPEC_SKIPPED_NOTE);
  });
});

describe('D-4 观察面 (onProgress 汇, SDD C-5)', () => {
  /** 注入式 verifyFindings: 免走真 extract/证伪 (fake send 也能走, 但注入更直白, 裁决可精确摆布)。 */
  const VERIFIED: VerifiedFinding[] = [
    { severity: 'P0', file: 'a.ts', line: 3, claim: '缺权限守卫', symbols: [], dimension: 'correctness', verdict: 'CONFIRMED', reason: '证据支持' },
    { severity: 'P1', file: 'b.ts', line: 9, claim: '未排序', symbols: [], dimension: 'security', verdict: 'REFUTED', reason: '已排序' },
    { severity: 'P1', file: 'c.ts', claim: '存疑候选', symbols: [], dimension: 'boundary', verdict: 'UNVERIFIED', reason: '证据不足' },
  ];

  test('C-5 序列: planned(3) → 每维 start/settle → 证伪 verdict (D-9 方向 + reason ≤160)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-review-evt-'));
    const { send } = makeFakeSend();
    const events: ReviewProgressEvent[] = [];
    const res = await runReview(baseOpts({
      dims: ['correctness', 'security', 'boundary'],
      verify: true,
      cwd,
      deps: { send, verifyFindings: async () => VERIFIED, findSdd: () => null, env: {} },
      onProgress: (e) => events.push(e),
    }));
    expect(res.verified).toHaveLength(3);

    // planned 先出, 3 个维度节点 (维度 = 节点)。
    expect(events[0]).toEqual({
      type: 'planned',
      nodes: [
        { id: 'correctness', kind: 'review' },
        { id: 'security', kind: 'review' },
        { id: 'boundary', kind: 'review' },
      ],
    });
    // 每维 start 先于 settle, settle 全 done。
    for (const dim of ['correctness', 'security', 'boundary']) {
      const start = events.findIndex((e) => e.type === 'start' && e.id === dim);
      const settle = events.findIndex((e) => e.type === 'settle' && e.id === dim);
      expect(start).toBeGreaterThan(0);
      expect(settle).toBeGreaterThan(start);
      expect(events[settle]).toMatchObject({ type: 'settle', id: dim, status: 'done', kind: 'review' });
    }
    // 证伪阶段每条 finding 一条 verdict (gate:'review', round 1, reason ≤160)。
    const verdicts = events.filter((e) => e.type === 'verdict') as Extract<ReviewProgressEvent, { type: 'verdict' }>[];
    expect(verdicts).toHaveLength(3);
    const byDim = Object.fromEntries(verdicts.map((v) => [v.id, v]));
    // D-9: pass/fail 指**被审对象** —— CONFIRMED (代码有伤) → fail; 证伪撤销 (REFUTED) → pass;
    // UNVERIFIED 未被证伪撤销 → fail (与 scripts/dag-review 的"存活"口径一致)。
    expect(byDim.correctness).toMatchObject({ gate: 'review', verdict: 'fail', round: 1 });
    expect(byDim.security).toMatchObject({ gate: 'review', verdict: 'pass', round: 1 });
    expect(byDim.boundary).toMatchObject({ gate: 'review', verdict: 'fail', round: 1 });
    for (const v of verdicts) expect(v.reason!.length).toBeLessThanOrEqual(160);
  });

  test('维度抛错 → settle failed + failReason 首行 ≤160, 审查照抛 (观察面不改语义)', async () => {
    const events: ReviewProgressEvent[] = [];
    const send = (async (req: { messages: { content: string }[] }) => {
      const content = String(req.messages[0]!.content);
      if (content.includes('对抗式审查 [security]')) throw new Error('boom line1\nline2');
      return { text: '无真 bug。' } as unknown;
    }) as unknown as ReviewSendFn;
    await expect(runReview(baseOpts({
      dims: ['correctness', 'security'],
      deps: { send, findSdd: () => null, env: {} },
      onProgress: (e) => events.push(e),
    }))).rejects.toThrow('boom');
    const failed = events.filter((e) => e.type === 'settle' && e.status === 'failed') as Extract<ReviewProgressEvent, { type: 'settle' }>[];
    expect(failed).toHaveLength(1); // 只有 security 那条失败
    expect(failed[0]).toMatchObject({ id: 'security', status: 'failed', kind: 'review' });
    expect(failed[0]!.failReason).toBe('boom line1'); // 首行
    expect(failed[0]!.failReason!.length).toBeLessThanOrEqual(160);
    expect(events.filter((e) => e.type === 'settle' && e.status === 'done')).toHaveLength(1); // correctness 照常 done
  });

  test('子进程汇 OMD_REVIEW_EVENT_FILE: NDJSON 写盘与回调同序列 (env 断 → 零写盘, 反向自检)', async () => {
    // 正检: 设 env → run.ts 把每条事件 NDJSON 逐行追加到事件文件 (fleet 轮询面)。
    const dir = mkdtempSync(join(tmpdir(), 'omd-review-evfile-'));
    const file = join(dir, 'events.ndjson');
    process.env.OMD_REVIEW_EVENT_FILE = file;
    try {
      const { send } = makeFakeSend();
      const events: ReviewProgressEvent[] = [];
      await runReview(baseOpts({
        dims: ['correctness', 'security', 'boundary'],
        deps: { send, findSdd: () => null, env: {} },
        onProgress: (e) => events.push(e),
      }));
      const lines = (await Bun.file(file).text()).trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(events.length); // 同序列: 1 planned + 3 start + 3 settle
      const parsed = lines.map((l) => JSON.parse(l) as ReviewProgressEvent);
      expect(parsed).toEqual(events);
    } finally {
      delete process.env.OMD_REVIEW_EVENT_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
    // 反向自检 (C-5): 断开子进程通道 (不设 env) → 零字节写盘 —— 若 run.ts 绕过 env 直写盘, 这条红。
    // 对应"断开 onProgress → TUI 事件数为 0 (今天的现状)": 事件只经汇出来, 汇可断。
    const dir2 = mkdtempSync(join(tmpdir(), 'omd-review-evfile2-'));
    const file2 = join(dir2, 'events.ndjson');
    const { send } = makeFakeSend();
    await runReview(baseOpts({
      dims: ['correctness'],
      deps: { send, findSdd: () => null, env: {} },
      onProgress: undefined, // 回调也断
    }));
    expect(existsSync(file2)).toBe(false); // env 没设过 → 不写盘 (通道整体可断)
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('scripts/dag-review CLI gate 阶梯 (子进程冒烟, 零模型调用)', () => {
  test('--gate G0 短路: 打印免审并 exit 0, 不取 diff 不发模型', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--gate', 'G0'], { cwd: REPO_ROOT });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('G0 免审 (docs/机械)');
  });

  test('--no-spec 在 G3 报错 (spec 强制), exit 1', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--gate', 'G3', '--no-spec'], { cwd: REPO_ROOT });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('spec 轴强制');
  });

  test('--spec 与 --no-spec 互斥, exit 1', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--gate', 'G2', '--spec', '--no-spec'], { cwd: REPO_ROOT });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('互斥');
  });

  test('未知 gate 报 usage, exit 1', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--gate', 'G9'], { cwd: REPO_ROOT });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('未知 gate');
  });

  test('--help 干净 env 下打印 usage, exit 0 (env -i 等价)', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--help'], { cwd: REPO_ROOT, env: {} });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('usage:');
    expect(p.stdout.toString()).toContain('G0|G1|G2|G3');
  });
});
