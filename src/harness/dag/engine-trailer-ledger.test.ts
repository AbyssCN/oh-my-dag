/**
 * P3 S3 —— 尾块差集闸在引擎里的接线 (INV-5 / INV-6 / INV-16)。
 *
 *   · 平铺图: 每个 agent 节点都过尾块审计 → `claimCheck.trailer` 在场, selfReport 三态落到 LeafResult;
 *   · 谎报 (acceptance_ran=true 而 run_acceptance 一次没调) → findings>0 + `unsupported-claim` 观察带 [report-trailer];
 *   · 诚实尾块 → findings=0, selfReport.self_report='leaf';
 *   · 没尾块 → 不红, selfReport 合成且 self_report='missing';
 *   · 散文正则那两道原样保留 (claimCheck.conductor / flat 仍在)。
 *
 * 证伪方式: 把 engine.ts 平铺路那段 `trailerChecked++` 去掉 → ① 红 (trailer 缺席);
 * 把 auditTrailer 的 acceptance-ran 判红改成 notice → ② 红。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { AgentLeafInput, AgentLeafResult } from '../leaf-runners';

const SPEC = { command: 'exit 3', expect_exit: 0 } as const;
const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 0, out: 0 } });
const mkCfg = (runner: (input: AgentLeafInput) => Promise<AgentLeafResult>): ExecutorDagConfig => ({
  conductorModel: 't:cond',
  leafModel: 't:leaf',
  agentLeafModel: 't:leaf',
  generate,
  maxPlanRetries: 0,
  agentRunner: runner,
});
const plan = (): ConductorPlan => ({ name: 'trailer-ledger', nodes: { a: { executor: 'agent', goal: '带判据', self_check: { ...SPEC } } } });

const trailer = (fields: Record<string, string>) =>
  '```omd-report\n' +
  Object.entries({ changed: '[]', acceptance_ran: 'false', acceptance_exit: 'null', not_verified: '[]', stuck: 'false', next: 'done', ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') +
  '\n```';

const runner = (text: string, acceptance: AgentLeafResult['acceptance']) => async (_input: AgentLeafInput): Promise<AgentLeafResult> => ({
  text,
  usage: { in: 1, out: 1 },
  filesTouched: [],
  ...(acceptance !== undefined ? { acceptance } : {}),
});

describe('P3 S3 · 尾块差集闸接线', () => {
  test('★ ① 诚实尾块 → trailer 账在场且 findings=0; selfReport.self_report=leaf; 散文两道账仍在', async () => {
    const r = await runExecutorDagWithPlan(plan(), mkCfg(runner(`改完了。\n${trailer({ acceptance_ran: 'true', acceptance_exit: '0' })}`, { ran: true, rounds: 1, last: { kind: 'exited', verdict: 'green', command: 'exit 3', ran: 'exit 3', exitCode: 0, expectExit: 0, tail: '', failSet: [] } })));
    expect(r.claimCheck?.trailer).toEqual({ nodes: 1, findings: 0 });
    expect(r.claimCheck?.conductor).toBeDefined();
    expect(r.claimCheck?.flat).toBeDefined();
    expect(r.results.a!.selfReport?.self_report).toBe('leaf');
    expect((r.observations ?? []).filter((o) => o.kind === 'unsupported-claim')).toHaveLength(0);
  });

  test('★ ② 谎报 acceptance_ran=true 而 run_acceptance 没调 → findings=1, 观察带 [report-trailer]', async () => {
    const r = await runExecutorDagWithPlan(plan(), mkCfg(runner(`测试全部通过。\n${trailer({ acceptance_ran: 'true', acceptance_exit: '0' })}`, { ran: false, rounds: 0, last: null })));
    expect(r.claimCheck?.trailer).toEqual({ nodes: 1, findings: 1 });
    // 覆盖对账 (gate-registry 片 5c) 认的是整串判词, 不是关键词共现。
    const obs = (r.observations ?? []).filter((o) => o.kind === 'unsupported-claim' && o.message.startsWith('[omd/executor-dag][report-trailer]'));
    expect(obs).toHaveLength(1);
    expect(obs[0]!.nodes).toEqual(['a']);
  });

  test('★ ③ 没尾块 → 不红 (INV-5), selfReport 合成且 self_report=missing, 用记录填 acceptance_ran', async () => {
    const r = await runExecutorDagWithPlan(plan(), mkCfg(runner('只有散文, 测试全部通过。', { ran: true, rounds: 1, last: null })));
    expect(r.claimCheck?.trailer).toEqual({ nodes: 1, findings: 0 });
    expect(r.results.a!.selfReport).toEqual({ changed: [], acceptance_ran: true, acceptance_exit: null, not_verified: [], stuck: false, next: '', self_report: 'missing' });
    expect(r.results.a!.status).toBe('done');
  });

  test('④ 解析失败 → selfReport=null (与缺席分得开), 不红', async () => {
    const r = await runExecutorDagWithPlan(plan(), mkCfg(runner('```omd-report\n乱写\n```', { ran: false, rounds: 0, last: null })));
    expect(r.results.a!.selfReport).toBeNull();
    expect(r.claimCheck?.trailer?.findings).toBe(0);
  });

  test('⑤ 记录面缺 acceptance (老 runner 没报) → notice 不判红 (D-24)', async () => {
    const r = await runExecutorDagWithPlan(plan(), mkCfg(runner(trailer({ acceptance_ran: 'true', acceptance_exit: '0' }), undefined)));
    expect(r.claimCheck?.trailer).toEqual({ nodes: 1, findings: 0 });
  });
});
