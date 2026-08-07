/**
 * S1 的**接线**: 产物内容真的进了 judge 视图吗 (2026-08-03)。
 *
 * `judge-artifacts.test.ts` 钉的是那个模块自己的诚实 (读不到就说读不到);这一条钉的是**它被接上了** ——
 * 本仓反复撞见的形态是"实现写好了、没有调用方", 症状是沉默的:视图里少一段, 读数上与"这个改动
 * 没用"一模一样。上一次是运行留痕(库在表在恒零行), 上上次是 `dag_goal` 一个节点事件都不发。
 *
 * 顺带钉住**缺省关**: 它改的是每一次判决的输入, 按本仓纪律要先有同语料 A/B 才翻默认。
 * 缺省被人顺手改成开, 生产判决行为就在没有读数的情况下变了。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 's1-run';
const BODY = '单次上限 100 条 · 支持 CSV 与 JSON';
let root: string;
let manager: CheckpointManager;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-s1-'));
  manager = new CheckpointManager(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';

/** 子图: 一个写文件的节点。 */
const SUB = JSON.stringify({
  name: 's',
  nodes: { write: { goal: '写一份摘要', executor: 'agent', output_type: 'file', output_path: 'summary.md' } },
});

const conductorPlan = (): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '写摘要', executor: 'conductor', max_rounds: 1, judge_final: true } } }) as ConductorPlan;

const generate: GenerateFn = async (req) => {
  const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  return leafId(text) ? { text: 'ok', usage: { in: 1, out: 1 } } : { text: SUB, usage: { in: 1, out: 1 } };
};

/** 真写一个文件并如实报 filesTouched —— 引擎据此去读盘。 */
const agentRunner = async () => {
  writeFileSync(join(root, 'summary.md'), BODY);
  // ⚠ 自述里**刻意不含**正文 —— 那正是 live 判词抱怨的"只有描述性文字"。视图里出现正文,
  //   只可能来自引擎读盘。
  return { text: '已写入摘要文件。', usage: { in: 1, out: 1 }, filesTouched: ['summary.md'], filesRead: [], cwd: root };
};

/** 跑一轮, 回收 judge 看到的那份视图。 */
const judgeViewOf = async (over: Partial<ExecutorDagConfig>): Promise<string> => {
  let seen = '';
  await runExecutorDagWithPlan(conductorPlan(), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    continuity: { manager, runId: RUN, repoRoot: root },
    generate,
    agentRunner,
    judgeSend: (async (req: { messages: { content: string }[] }) => {
      seen = String(req.messages[0]?.content ?? '');
      const v = { converged: true, score: 1, rejectedNodes: [] };
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never,
    ...over,
  } as ExecutorDagConfig);
  return seen;
};

describe('S1 产物内容进 judge 视图的接线', () => {
  test('**缺省开**: 正文出现在视图里 (而 leaf 自述里没有它 —— 只可能来自引擎读盘)', async () => {
    // 缺省 2026-08-03 从关翻到开, 依据是同语料 A/B: 假阴性 16/16 → 0/16, 假阳性 0/48 → 0/48。
    const view = await judgeViewOf({});
    expect(view).toContain('[产物内容 · 引擎读盘]');
    expect(view).toContain(BODY);
    expect(view).toContain('summary.md');
  });

  test('显式关 → 退回只有存在性 (对照臂要跑得起来, 否则 A/B 无从复现)', async () => {
    const view = await judgeViewOf({ judgeArtifacts: false });
    // ⚠ 断言面**收窄到"本轮执行结果"那一段** (2026-08-03): 证据词表默认开之后, 整条 prompt 里
    // 逐字提到 `[产物内容 · 引擎读盘]` 是**正常的** —— 词表要教 judge 认这个标记, 不提反而是缺陷。
    // 老断言拿整条 prompt 比, 于是把"词表提到了它"误报成"产物块进来了"。要守的一直是**视图**。
    const round = view.split('本轮执行结果:')[1] ?? '';
    expect(round).not.toContain('[产物内容 · 引擎读盘]');
    expect(round).not.toContain(BODY);
    // 存在性那一行照旧在 (S1 不动 `[引擎实测]`, 它是另一件事)。
    expect(view).toContain('写入文件: summary.md');
  });

  test('给预算对象 = 自定上限, 且真的被执行 (不是个被忽略的旋钮)', async () => {
    const view = await judgeViewOf({ judgeArtifacts: { perFile: 6, total: 6 } });
    expect(view).toContain('已截断');
    expect(view).not.toContain(BODY); // 全文没进去
  });
});
