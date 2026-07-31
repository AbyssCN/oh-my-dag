/**
 * P1 节点状态词表细化 (2026-08-05) 的行为网。
 *
 * 证的**不是**"我加的那个字段传对了" —— 那是旋钮测试, 本仓上一轮刚为它栽过 (18 条网全绿而产物
 * 落错了树)。这里钉的是那个真正要紧的性质:
 *
 *   **两个后续动作相反的失败, 在结果上必须分得开。**
 *
 * 所以每条用例都成对/成组读: 闸拒 vs 断言没成立 (再试有没有用) · 心跳停摆 vs 产物闸判空
 * (换池 vs 重跑) · 「没记」vs「归不了类」(老数据 vs 缺陷)。
 * 外加两条结构性守卫: ① 零回归 (status 三态词表没变) ② 归一化闸恒成立。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';
import type { AgentLeafInput } from '../../src/harness/leaf-runners';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { createDagRecorder } from '../../src/harness/dag-record';
import { FAILURE_KIND_INFO, FAILURE_KIND_ORDER, withFailureKind } from '../../src/harness/node-failure';

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';
const gen =
  (plan: string): GenerateFn =>
  async ({ model }) =>
    model === CONDUCTOR ? { text: plan, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };

const cmdPlan = (command: string, expectExit?: number) =>
  JSON.stringify({
    name: 's',
    nodes: { n1: { goal: '跑一条命令', executor: 'command', command, ...(expectExit === undefined ? {} : { expect_exit: expectExit }) } },
  });

describe('P1 · 闸拒 vs 断言没成立 (整个词表的原型格)', () => {
  test('退出码 <0 → gate-rejected (BLOCKED: 再试也没用)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(cmdPlan('rm -rf /')),
      // -1 = command-leaf 的闸拒返回值 (命令根本没执行), 不是被执行命令的退出码。
      commandRunner: async () => ({ text: '[闸拒]', usage: { in: 0, out: 0 }, exitCode: -1 }),
    });
    const r = res.results['n1']!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('gate-rejected');
    expect(FAILURE_KIND_INFO['gate-rejected'].retryable).toBe(false); // 后续动作: 别重试
  });

  test('退出码 ≥0 但 ≠ expect → assert-failed (STALLED: 再试一轮可能就好)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(cmdPlan('grep -qx "3000" out.txt')),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }),
    });
    const r = res.results['n1']!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('assert-failed');
    expect(FAILURE_KIND_INFO['assert-failed'].retryable).toBe(true);
  });

  test('★ 两者在旧词表上一模一样 —— 靠 status 分不开, 靠 failureKind 分得开', async () => {
    const run = async (exitCode: number) => {
      const res = await runExecutorDag('t', {
        conductorModel: CONDUCTOR,
        leafModel: LEAF,
        generate: gen(cmdPlan('cmd')),
        commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode }),
      });
      return res.results['n1']!;
    };
    const blocked = await run(-1);
    const asserted = await run(1);
    expect(blocked.status).toBe(asserted.status); // ← 此前唯一能读到的那一位: 相同
    expect(blocked.failureKind).not.toBe(asserted.failureKind); // ← 细化买到的东西
    // 而两者的下一步是**相反**的, 这才是它值得存在的理由
    expect(FAILURE_KIND_INFO[blocked.failureKind!].retryable).toBe(false);
    expect(FAILURE_KIND_INFO[asserted.failureKind!].retryable).toBe(true);
  });

  test('expect_exit 命中 → done, 不带 failureKind (归一化闸只管没过的)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(cmdPlan('test-red', 1)),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }),
    });
    expect(res.results['n1']!.status).toBe('done');
    expect(res.results['n1']!.failureKind).toBeUndefined();
  });

  test('负码恒 gate-rejected, expect_exit 不许把闸拒翻译成别的格', async () => {
    // 「让 expect_exit 把一次安全拒绝翻译成 done」有两层闸: schema 的 min(0) 挡住 conductor 写 -1,
    // 运行期的 `exitCode < 0` 恒 failed 挡住预构造 plan。这里走第二层 —— 期望非 0 而实得负码时,
    // 归的仍是 gate-rejected 而不是 assert-failed (拿到 -1 的下一步是升 owner, 不是再试一轮)。
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(cmdPlan('rm -rf /', 2)),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: -1 }),
    });
    expect(res.results['n1']!.status).toBe('failed');
    expect(res.results['n1']!.failureKind).toBe('gate-rejected');
  });
});

describe('P1 · 心跳停摆 vs 产物闸判空 (换池 vs 重跑该节点)', () => {
  const AGENT_PLAN = JSON.stringify({ name: 's', nodes: { n1: { goal: '干活', executor: 'agent' } } });
  const WRITE_PLAN = JSON.stringify({
    name: 's',
    nodes: { n1: { goal: '写文件', executor: 'agent', output_type: 'file', output_path: 'notes/a.md' } },
  });

  test('心跳闸 stalled → stall (ERROR: 该换池, 不是该改 prompt)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(AGENT_PLAN),
      agentRunner: async (_i: AgentLeafInput) => ({ text: 'x', usage: { in: 1, out: 1 }, filesTouched: [], stalled: true }),
    });
    const r = res.results['n1']!;
    expect(r.failureKind).toBe('stall');
    expect(FAILURE_KIND_INFO.stall.loopState).toBe('ERROR');
  });

  test('产物闸: filesTouched 空 → empty-artifact (自报完成而盘上没东西)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(WRITE_PLAN),
      agentRunner: async (_i: AgentLeafInput) => ({ text: '我写完了', usage: { in: 1, out: 1 }, filesTouched: [] }),
    });
    const r = res.results['n1']!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('empty-artifact');
  });

  test('产物闸: 声称的产物不在盘上 → 同样 empty-artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-artifact-'));
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(WRITE_PLAN),
      agentRunner: async (_i: AgentLeafInput) => ({
        text: 'done',
        usage: { in: 1, out: 1 },
        filesTouched: ['notes/a.md'], // 声称碰了, 但根下不存在
        cwd: dir,
      }),
    });
    expect(res.results['n1']!.failureKind).toBe('empty-artifact');
  });

  test('真写了文件 → done, 不进任何失败格', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-artifact-ok-'));
    writeFileSync(join(dir, 'a.md'), 'hi');
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '写', executor: 'agent', output_type: 'file', output_path: 'a.md' } } })),
      agentRunner: async (_i: AgentLeafInput) => ({ text: 'ok', usage: { in: 1, out: 1 }, filesTouched: ['a.md'], cwd: dir }),
    });
    expect(res.results['n1']!.status).toBe('done');
    expect(res.results['n1']!.failureKind).toBeUndefined();
  });
});

describe('P1 · 其余各格各有自己的直接判据', () => {
  test('research 零来源 → no-sources (不是通用 failed)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '查', executor: 'research' } } })),
      researchRunner: async () => ({ text: '一份看起来很像样的报告', usage: { in: 1, out: 1 }, sources: [] }),
    });
    expect(res.results['n1']!.failureKind).toBe('no-sources');
  });

  test('缺 researchRunner → missing-capability (缺的是能力不是运气 → 别重试)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '查', executor: 'research' } } })),
    });
    expect(res.results['n1']!.failureKind).toBe('missing-capability');
    expect(FAILURE_KIND_INFO['missing-capability'].retryable).toBe(false);
  });

  test('写文件节点无 agentRunner → missing-capability', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '写', executor: 'agent', output_type: 'file', output_path: 'x.md' } } })),
    });
    expect(res.results['n1']!.failureKind).toBe('missing-capability');
  });

  test('节点抛错 → infra-error (ERROR), 且败因消息仍保留 (issue #4 不回归)', async () => {
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '干活', executor: 'agent' } } })),
      agentRunner: async (): Promise<never> => {
        throw new Error('provider 挂了');
      },
    });
    const r = res.results['n1']!;
    expect(r.failureKind).toBe('infra-error');
    expect(r.output).toContain('provider 挂了');
  });

  test('依赖未达 quorum 级联 → dep-skip, 且 status 仍是 skipped (零回归)', async () => {
    const plan = JSON.stringify({
      name: 's',
      nodes: {
        a: { goal: '会失败的上游', executor: 'command', command: 'false' },
        b: { goal: '下游', executor: 'leaf', depends_on: ['a'], requires: 'all' },
      },
    });
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(plan),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }),
    });
    expect(res.results['a']!.failureKind).toBe('assert-failed'); // 上游: 断言没成立
    expect(res.results['b']!.status).toBe('skipped'); // 下游: 粗态没变
    expect(res.results['b']!.failureKind).toBe('dep-skip'); // 它自己没毛病, 看上游
  });
});

describe('P1 · 「不知道」是独立的一格, 不并进任何一侧', () => {
  test('归一化闸: 没标成因的失败显式补 unclassified, 而不是让字段缺席', () => {
    expect(withFailureKind({ status: 'failed' }).failureKind).toBe('unclassified');
    expect(withFailureKind({ status: 'skipped' }).failureKind).toBe('unclassified');
  });

  test('已标的不许被覆写 (归一化是补位, 不是重判)', () => {
    expect(withFailureKind({ status: 'failed', failureKind: 'gate-rejected' as const }).failureKind).toBe('gate-rejected');
  });

  test('done 节点不进词表 —— 它没"没过"', () => {
    expect(withFailureKind({ status: 'done' }).failureKind).toBeUndefined();
  });

  test('unclassified 的 retryable 是 null 而不是 false —— 不知道就别替 heal 回路做决定', () => {
    expect(FAILURE_KIND_INFO.unclassified.retryable).toBeNull();
    // 对照: 其余每一格都表了态
    for (const k of FAILURE_KIND_ORDER) {
      if (k === 'unclassified') continue;
      expect(typeof FAILURE_KIND_INFO[k].retryable).toBe('boolean');
    }
  });
});

describe('P1 · 读数板按新词表出分布 (细化值不值的唯一证据面)', () => {
  /** 造一库混合样本: 归了类的若干格 + 一条 unclassified + 一条老格式 (没过但无 failureKind)。 */
  const seed = (dbPath: string) => {
    const recorder = createDagRecorder({ path: dbPath });
    const leaf = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'command', deps: [], output: '', usage: { in: 0, out: 0 }, ...extra });
    recorder.record(
      {
        plan: { name: 'p', nodes: { a: { command: 'rm -rf /' }, b: { command: 'grep -qx "3000" o.txt' } } },
        sessionId: 's',
        levels: [['a', 'b', 'c', 'd', 'e']],
        results: {
          a: leaf('a', { status: 'failed', failureKind: 'gate-rejected', exitCode: -1 }),
          b: leaf('b', { status: 'failed', failureKind: 'assert-failed', exitCode: 1 }),
          c: leaf('c', { status: 'failed', failureKind: 'unclassified' }),
          d: leaf('d', { status: 'failed' }), // 老格式: 没记
          e: leaf('e', { status: 'done' }),
        },
        usage: { conductor: { in: 1, out: 1 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 0 },
      } as unknown as Parameters<typeof recorder.record>[0],
      { runId: 'r1' },
    );
    recorder.close();
  };

  test('--json 把三种"没过"分开数: 各格 / unclassified / 压根没记', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'p1-readout-')), 'runs.db');
    seed(dbPath);
    const p = Bun.spawn(['bun', 'run', 'scripts/omd-readout.ts', '--db', dbPath, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const out = JSON.parse(await new Response(p.stdout).text());
    expect(await p.exited).toBe(0);
    expect(out.notDoneNodes).toBe(4); // done 的那个不算
    expect(out.failureKindCount['gate-rejected']).toBe(1);
    expect(out.failureKindCount['assert-failed']).toBe(1); // ← 与上一行分得开, 这就是细化买到的东西
    // ★ 两个都是"不知道", 但结论相反 → 两个计数器, 不许并起来
    expect(out.failureKindCount.unclassified).toBe(1); // 引擎里有条没交代的失败路径 = 缺陷
    expect(out.failureKindUnrecorded).toBe(1); // 早于本次改动的记录 = 老数据
  });

  test('文本板把每格的**下一步**一起印出来 (分类不落到动作上就白分)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'p1-readout-txt-')), 'runs.db');
    seed(dbPath);
    const p = Bun.spawn(['bun', 'run', 'scripts/omd-readout.ts', '--db', dbPath], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(text).toContain('gate-rejected');
    expect(text).toContain('白名单不会因为重试而放行'); // BLOCKED 的下一步
    expect(text).toContain('再试一轮可能就好'); // STALLED 的下一步
    expect(text).toContain('别并起来数'); // 老数据那条诚实边界
  });
});

describe('P1 · 成因要能出得了图 (留痕 + checkpoint 两条链)', () => {
  test('留痕层记下 failureKind —— 事后算不回来的东西必须当场记', async () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(cmdPlan('rm -rf /')),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: -1 }),
    });
    const id = recorder.record(res, { runId: 'run-p1' });
    const rec = recorder.get(id)!;
    expect(rec.nodes.find((n) => n.id === 'n1')!.failureKind).toBe('gate-rejected');
    recorder.close();
  });

  test('checkpoint 抄结果上那一位, 不再当场重新推断一遍', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-cp-'));
    const manager = new CheckpointManager(dir);
    await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(JSON.stringify({ name: 's', nodes: { n1: { goal: '查', executor: 'research' } } })),
      researchRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 }, sources: [] }),
      continuity: { manager, runId: 'run-cp-p1', repoRoot: dir, resume: false },
    });
    const cp = manager.loadCheckpoint('run-cp-p1', 'n1')!;
    // 旧逻辑这里会写 'failed' (三选一里的兜底), 新逻辑给出真正的成因
    expect(cp.failureKind).toBe('no-sources');
    expect(cp.status).toBe('failed'); // 粗态零回归
  });
});
