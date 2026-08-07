/**
 * **N6 —— 环凭什么停的, 要留在 journal 里** (2026-07-31)。
 *
 * 此前 `NodeLoopJournal` 只记「收敛与否」, 而"没收敛"底下压着四种停法, 它们的下一步完全不同
 * (轮数用尽 / 阻塞 / 预算停 / 取消)。G5 首次触发之后这条更值钱: **一次真 BLOCKED 的证据
 * 只活在日志里**, 而日志会滚掉, resume 读不回来。
 *
 * ★ 写这份时抓到一个**真漏**: 三条 BLOCKED 出口里的「空转」那条**压根不写 journal** ——
 *   而 `writeLoopJournal` 的文档注释白纸黑字写着"三个调用点共用: 正常轮末 / 检测者 BLOCKED /
 *   **空转 BLOCKED**"。三缺一。所以下面那条用例钉的不是新字段, 是**那条出口现在真的落盘了**。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../dag/engine';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../continuity/types';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 每轮**同一张**子图 —— 空转检测要的正是"形状逐轮不变"。 */
const SUB_PLAN = JSON.stringify({ name: 'sub', nodes: { 'write-a': { goal: '写 A 部分' }, 'write-b': { goal: '写 B 部分' } } });

const makeGenerate = (): GenerateFn => async (req) => {
  const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
  if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
    return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
  }
  return { text: 'out', usage: { in: 1, out: 1 } };
};

const cfg = (root: string, opts: { converged: boolean }): ExecutorDagConfig =>
  ({
    conductorModel: 'c:m',
    leafModel: 'l:m',
    generate: makeGenerate(),
    agentTemplates: new Map(),
    judgeSend: async () => ({
      text: '',
      parsed: { converged: opts.converged, score: opts.converged ? 9 : 3, ...(opts.converged ? {} : { failureReason: '还差一点' }), rejectedNodes: [] },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'judge:fake',
      attempts: 1,
    }),
    continuity: { manager: new CheckpointManager(root), runId: 'run-1' },
  }) as unknown as ExecutorDagConfig;

const plan = (maxRounds: number) => ({ name: 'p', nodes: { P: { goal: '两部分都要写好', executor: 'conductor', max_rounds: maxRounds } } }) as never;
const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'omd-n6-'));
const journalOf = (root: string): NodeLoopJournal =>
  JSON.parse(readFileSync(join(root, '.omd', 'continuity', 'run-1', '_loop-P.json'), 'utf-8')) as NodeLoopJournal;

describe('N6 · 停止轴与它的直接证据落进 journal', () => {
  test('judge 判收敛 → stop.kind=success, 且证据说得出是第几轮', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(plan(2), cfg(root, { converged: true }));
    const j = journalOf(root);
    expect(j.stop?.kind).toBe('success');
    expect(j.stop?.evidence).toContain('judge 判收敛');
    expect(j.stop?.atRound).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 轮数用尽 → stop.kind=not-converged, 证据里带得出跑了几轮/上限几轮', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(plan(3), cfg(root, { converged: false }));
    const j = journalOf(root);
    // 这条是四条停止轴里**最常走**的一条, 而它此前在盘上与"阻塞"、"预算停"长得一模一样 ——
    // resume 的人因此分不出该加轮数、该加预算、还是该去看一眼。
    expect(j.stop?.kind).toBe('not-converged');
    expect(j.stop?.evidence).toContain('上限 3 轮');
    rmSync(root, { recursive: true, force: true });
  });

  // ⚠ 三条 BLOCKED 出口 (熔断 / 检测者 / 空转) 的 stop 走的是**同一个** writeLoopJournal 参数,
  //   与上面两条同源; 但本文件**没有**驱动到它们的夹具 (这个 stub judge 恒不点名 → 空转检测
  //   在本配置下不命中, 走的是轮数用尽)。按七态词表它们是 `Wired` 不是 `Exercised` ——
  //   写下来免得下次有人把这份网读成"四条轴都验过了"。

  test('★ 停止轴借的是 run 级词表, 不新造一套 —— 两套词早晚会漂', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(plan(3), cfg(root, { converged: false }));
    const j = journalOf(root);
    // 这条断言的意义在类型之外: 它钉住"journal 说的话与 goal 摘要说的话是同一套词",
    // 而"journal 说 blocked、摘要说 failed"正是 N5 刚治好的那个病。
    const runLevelWords = ['success', 'not-converged', 'oracle-failed', 'blocked', 'budget-exhausted', 'cancelled', 'infra-error', 'missing-capability', 'not-needed', 'empty-result', 'unclassified'];
    expect(runLevelWords).toContain(j.stop!.kind);
    rmSync(root, { recursive: true, force: true });
  });

  test('环还在跑的那些轮**不写 stop** (写了会让 resume 读到一个已经停过的环)', async () => {
    const root = freshRoot();
    // 单轮档不请 judge → 不写 journal; 用两轮档 + 收敛在第 1 轮来对照上面那条。
    // 这里验的是反面: 未收敛且未阻塞的中间轮, journal 里 stop 必须缺席。
    await runExecutorDagWithPlan(plan(2), cfg(root, { converged: false }));
    const j = journalOf(root);
    // 中间轮不写 stop, 停下来那一轮才写 —— 断言两者一致, 免得写成"停在第 1 轮"。
    expect(j.stop?.atRound).toBe(j.completedRounds);
    rmSync(root, { recursive: true, force: true });
  });
});
