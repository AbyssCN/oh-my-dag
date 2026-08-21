/**
 * S1 引擎事件面 (SDD 2026-08-11-dag-观察面与审核跟踪升级)。
 * 覆盖 GWT 验收点 C-2 (leaf 进度可见) / C-3 (判决与重规划成事件) / C-4 (耗时与死因)。
 * 全部经 runExecutorDagWithPlan (预构造 plan, 跳过 conductor) + 注入 fake generate / fake
 * agentRunner — 零真实 LLM。每条新闸按本仓反向自检惯例: 先在老实现上当场证伪一次, 证伪方式
 * 写在本用例的注释里 (断开接线 → 必须红)。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { ContentPart } from '../../model/gateway';
import { registerProvider } from '../../model/providers';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** content → 文本 (D-14v2 后 content 可为 ContentPart[]; fake 断言用 text parts 拼接)。 */
const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id (`[omd leaf: <id>]` 行)。 */
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

/** fake generate: goal 含 "FAIL" 的节点抛错 (→ failedFromThrow 隔离); delayMs 让墙钟可量。 */
function makeGenerate(opts: { delayMs?: number } = {}): GenerateFn {
  return async (req) => {
    const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(prompt);
    if (opts.delayMs) await sleep(opts.delayMs);
    // 失败原文刻意 >160 字符 (单行): C-4 的「首行 + 截断 ≤160」只有在这种形状下才证伪得了
    // (短错误消息下, 不截断的实现也恰好 ≤160, 那条闸形同虚设)。
    if (prompt.includes('FAIL')) throw new Error(`节点 ${id} 注入失败: ${'长'.repeat(200)}`);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
}

function makeConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return { conductorModel: 'test:conductor', leafModel: 'test:leaf', generate, agentTemplates: new Map(), ...extra };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

const toolStart = (toolName: string, args: unknown): AgentEvent =>
  ({ type: 'tool_execution_start', toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, args }) as unknown as AgentEvent;

describe('C-2 leaf 进度可见 (D-2/D-8/D-10)', () => {
  test('agent leaf ≥3 次工具调用 → ≥1 条 progress; tool 为真实工具名; 节流上界 = 调用数; text_delta 不进 DAG 事件', async () => {
    const events: DagNodeEvent[] = [];
    let fired = 0;
    const fakeRunner: NonNullable<ExecutorDagConfig['agentRunner']> = async (input) => {
      // D-10: text_delta 是正文流, 不进 DAG 事件 —— 先放一条, 若被转发成 progress 则 tool 缺席, 下面断言红。
      input.onEvent?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '正在写' },
      } as unknown as AgentEvent);
      // 三次工具起跑全部落在同一毫秒窗 (< 500ms 节流窗) → 节流后只该出 1 条 (首条不节流)。
      input.onEvent?.(toolStart('read', { path: 'src/a.ts' }));
      input.onEvent?.(toolStart('edit', { path: 'src/a.ts' }));
      input.onEvent?.(toolStart('bash', { command: 'bun test' }));
      fired = 3;
      return { text: '改好了', usage: { in: 10, out: 5 }, toolCalls: 3 };
    };
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '改文件', executor: 'agent' } }),
      makeConfig(makeGenerate(), { agentRunner: fakeRunner, onNodeEvent: (e) => events.push(e) }),
    );
    expect(r.results.A!.status).toBe('done');
    expect(fired).toBe(3);
    const progresses = events.filter(
      (e): e is Extract<DagNodeEvent, { type: 'progress' }> => e.type === 'progress' && e.id === 'A',
    );
    expect(progresses.length).toBeGreaterThanOrEqual(1); // ≥3 调用 → 至少 1 条
    expect(progresses.length).toBeLessThanOrEqual(3); // 节流上界: 条数 ≤ 工具调用数
    expect(progresses[0]!.tool).toBe('read'); // 首条不节流, tool = 真实工具名
    expect(progresses[0]!.calls).toBe(1); // calls = **发射时刻**的累计调用数: 首条在第一次工具调用时发 → 1
    //   (后两次调用落在同一 500ms 节流窗内被吞, 计数不随被吞的事件补发 —— 生产端节流, D-10)。
    expect(progresses[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(progresses.every((p) => typeof p.tool === 'string')).toBe(true); // text_delta 没混进来
    // 反向自检 (实跑过): ① 断开引擎侧 onEvent 传参 (agentRunner 调用不挂 leafProgress) → 当场红
    //   (2 pass 1 fail, 本用例 fail), 复原后回绿; ② 把 leafProgress 里的 `type !== 'tool_execution_start'`
    //   过滤删掉 → text_delta 也会出 progress (tool 缺席), 上面 `every(tool)` 断言红。
  });
});

describe('C-3 判决与重规划成事件 (D-3/D-9)', () => {
  // 升级闸要求 provider 已注册 (escalationProviderReady) → 注册假 provider (fake generate, 零真调用)。
  registerProvider('evtx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  test('verifier 拒一次 → 升级重规划: 按序 verdict{verdict:fail, round:1, reason≠""} → replan{poisoned>0}', async () => {
    const events: DagNodeEvent[] = [];
    let n = 0;
    // D-1 (SDD 2026-08-10-blame-scoped-node-retry): 判词带 ```blame 围栏点名 b → 失效闭包 = {b}。
    const verifier: NonNullable<ExecutorDagConfig['verifier']> = async () => {
      n++;
      return n === 1
        ? { pass: false, reason: '乙不合格。\n```blame\n[{"node": "b", "reason": "b 输出不合格"}]\n```\n', usage: { in: 1, out: 1 } }
        : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
    };
    const generate: GenerateFn = async (req) => {
      const sysC = req.messages.find((m) => m.role === 'system')?.content;
      const sys = typeof sysC === 'string' ? sysC : '';
      if (sys.includes('REPLAN-PATCH')) {
        return { text: '{"patch": {"b": {"goal": "修好的乙"}}}', usage: { in: 5, out: 5 } };
      }
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] } }),
      makeConfig(generate, { verifier, conductorEscalationModel: 'evtx:strong', onNodeEvent: (e) => events.push(e) }),
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    const verdicts = events.filter(
      (e): e is Extract<DagNodeEvent, { type: 'verdict' }> => e.type === 'verdict' && e.gate === 'verifier',
    );
    expect(verdicts).toHaveLength(2); // 拒一次 (round 1) + 升级后 pass (round 2)
    expect(verdicts[0]).toMatchObject({ type: 'verdict', gate: 'verifier', verdict: 'fail', round: 1 });
    expect((verdicts[0]!.reason ?? '').length).toBeGreaterThan(0);
    expect(verdicts[1]).toMatchObject({ type: 'verdict', gate: 'verifier', verdict: 'pass', round: 2 });
    const replans = events.filter((e): e is Extract<DagNodeEvent, { type: 'replan' }> => e.type === 'replan');
    expect(replans).toHaveLength(1);
    expect(replans[0]!.poisoned.length).toBeGreaterThan(0); // 闭包 {b} 进毒集
    expect(replans[0]!.round).toBe(1);
    expect(events.indexOf(verdicts[0]!)).toBeLessThan(events.indexOf(replans[0]!)); // 按序: fail → replan
    // 反向自检 (实跑过): 只发 verdict 不发 replan —— 删掉升级路径里 emitRunEvent replan 那行 → 当场红
    //   (2 pass 1 fail, 本用例 fail), 复原后回绿 (这正是 SDD 的 C-3 反向自检原句)。
  });
});

describe('C-4 耗时与死因 (D-5)', () => {
  test('settle 带引擎侧 durationMs>0; failed 节点 failReason 非空、≤160、= 失败原文首行; 老字段不破', async () => {
    const events: DagNodeEvent[] = [];
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '慢根' },
        B: { goal: '会 FAIL 的叶', depends_on: ['A'] },
      }),
      makeConfig(makeGenerate({ delayMs: 8 }), { onNodeEvent: (e) => events.push(e) }),
    );
    expect(r.results.A!.status).toBe('done');
    expect(r.results.B!.status).toBe('failed');
    const settles = events.filter((e): e is Extract<DagNodeEvent, { type: 'settle' }> => e.type === 'settle');
    const sA = settles.find((e) => e.id === 'A')!;
    expect(sA.durationMs).toBeGreaterThan(0); // 引擎侧墙钟 (delayMs=8 → 至少 8ms), 不是事件到达间隔
    expect(sA.model).toBe('test:leaf'); // 老字段一字不动 (additive)
    expect(sA.usage).toEqual({ in: 1, out: 1 });
    const sB = settles.find((e) => e.id === 'B')!;
    expect(sB.failReason).toBeDefined();
    expect(sB.failReason!.length).toBeGreaterThan(0);
    expect(sB.failReason!.length).toBeLessThanOrEqual(160);
    expect(sB.failReason).toBe(r.results.B!.output.split('\n')[0]!.slice(0, 160)); // 失败原文首行
    // 反向自检 (实跑过): ① durationMs 若改由消费端量「事件到达间隔」→ 拿不到起跑时刻, 断言红;
    //   ② failReason 不截断 160 (把 settleEvent 的 slice(0,160) 删掉) → 超长输出下断言红 (已当场
    //   证伪: 2 pass 1 fail, 本用例 fail; 复原后回绿)。
  });

  /**
   * `failureKind` 随事件出去 (2026-08-21 加)。
   *
   * ## 它要杀死的失效形态
   *
   * 七个闸里**只有三类发 `verdict`**(judge / gate 谎报完成 / verifier)。心跳闸 `stall`、
   * 空转熔断 `spin-fused`、产物闸、`expect_exit` oracle、轮数耗尽 —— 全部只以 `settle{failed}`
   * 露面。而 `failureKind` 此前**不在事件字段里**(只进 checkpoint), 于是观测面画不出
   * 「是哪个闸拦的」, 只能画一句被截断 160 字符的错误原文。
   *
   * ⚠ 这条闸补的是**引擎那一半**。消费端那一半在 `src/tui/components/dag-tree.test.ts`;
   *   2026-08-21 实测: 只有消费端的测试时, 把 settleEvent 里那行删掉**整个 dag 目录 160 测全绿** ——
   *   「一条永远绿的闸不是闸」, 所以这一条必须在这里。
   *
   * 证伪方式: 删掉 `settleEvent` 里 `...(r.failureKind ? { failureKind: r.failureKind } : {})` → 本条红。
   */
  test('★ settle 带 failureKind (闸的分类); done 节点不带 —— 恒非空当且仅当没过', async () => {
    const events: DagNodeEvent[] = [];
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '会过的叶' }, B: { goal: '会 FAIL 的叶', depends_on: ['A'] } }),
      makeConfig(makeGenerate({ delayMs: 1 }), { onNodeEvent: (e) => events.push(e) }),
    );
    const settles = events.filter((e): e is Extract<DagNodeEvent, { type: 'settle' }> => e.type === 'settle');
    const sB = settles.find((e) => e.id === 'B')!;
    expect(sB.status).toBe('failed');
    // 归一化在 settle 出口 (`withFailureKind`), 没人标的显式记 'unclassified' —— 总之**非空**。
    expect(sB.failureKind).toBeDefined();
    expect(sB.failureKind).toBe(r.results.B!.failureKind);
    // done 的节点不带成因: 「恒非空当且仅当 status !== 'done'」(types.ts:640 的契约)。
    expect(settles.find((e) => e.id === 'A')!.failureKind).toBeUndefined();
  });
});
