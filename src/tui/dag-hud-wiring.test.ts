/**
 * **A3 的中间那一跳**:`assembleOmdMcpTools({onNodeEvent}) → backend.pushDagEvent → DagHud`。
 *
 * ## 为什么单独有这一条
 *
 * S11 落地时两端各有闸:引擎侧 `node-event-bypass.test.ts`(真 `createDagTools` + 真 `HudMirror`)、
 * UI 侧 `dag-hud.test.ts` + PTY(fixture 造的事件)。**中间那一跳没人量过** ——
 * 装配层的 `onNodeEvent` 到底有没有接到 backend 上、backend 发出来的 `dag` 事件形状
 * 与 `DagHud.apply` 认的是不是同一个。两端都绿而中间断掉,症状是"HUD 永远空着",
 * 而两边的测试都不会红。收尾读数里我把 A3 标了 ⚠️,这条就是来消掉它的。
 *
 * ## 不花钱:引擎走注入的假引擎
 *
 * `assembleOmdMcpTools` 收 `engine` 注入。于是这条链上**除了模型**全是真的:
 * 真装配、真 `createDagTools`、真旁路、真 backend、真 `DagHud`。
 * 真模型那一层是 L4(`scripts/tui-l4-smoke.ts`),默认不跑。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdSessionStore } from '../harness/chat/session-store';
import type { ConductorPlan } from '../harness/conductor-plan';
import type { DagNodeEvent, ExecutorDagConfig, ExecutorDagResult } from '../harness/dag/types';
import { assembleOmdMcpTools } from '../mcp/assemble';
import { createEmbeddedBackend } from './backend-embedded';
import { DagHud } from './components/dag-hud';
import { createTheme } from './theme';

// S2 进程化 (SDD 2026-08-10): dag_run 用例走**进程内执行体** (见 mcp-dag-tools.test.ts 同款注)。
beforeEach(() => { process.env.OMD_DAG_EXEC_CHILD = '1'; });
afterEach(() => { delete process.env.OMD_DAG_EXEC_CHILD; });

const EMPTY = { answer: 'ok', nodes: [], usage: { in: 0, out: 0 } } as unknown as ExecutorDagResult;

const EVENTS: DagNodeEvent[] = [
  { type: 'planned', nodes: [{ id: 'leaf-a', kind: 'agent' }, { id: 'gate-b', kind: 'judge' }] },
  { type: 'start', id: 'leaf-a', kind: 'agent' },
  { type: 'settle', id: 'leaf-a', status: 'done', kind: 'agent', model: 'fake:leaf' },
];

const PLAN = { name: 'p', description: 'd', nodes: { 'leaf-a': { goal: 'g', executor: 'leaf' } } } as unknown as ConductorPlan;

/** 把整条链装起来:真装配 → 真 backend → 真 HUD,只有引擎是假的。 */
function wireEverything() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-a3-'));
  const theme = createTheme({ color: false });
  const hud = new DagHud(theme, () => 'fake:conductor');

  let sink: { pushDagEvent(runId: string, e: unknown): void } | null = null;
  const tools = assembleOmdMcpTools({
    cwd,
    // 假引擎:立刻发一串节点事件再返回。除它之外这条链上全是真的。
    engine: {
      runExecutorDag: (async (_t: string, c: ExecutorDagConfig) => {
        for (const e of EVENTS) c.onNodeEvent?.(e);
        return EMPTY;
      }) as never,
      runExecutorDagWithPlan: (async (_p: ConductorPlan, c: ExecutorDagConfig) => {
        for (const e of EVENTS) c.onNodeEvent?.(e);
        return EMPTY;
      }) as never,
    },
    env: { ...process.env, OMD_CONDUCTOR_MODEL: 'fake:conductor', OMD_LEAF_MODEL: 'fake:leaf' },
    onNodeEvent: (runId, e) => sink?.pushDagEvent(runId, e),
  });

  const backend: ReturnType<typeof createEmbeddedBackend> = createEmbeddedBackend({
    cwd,
    store: createOmdSessionStore(cwd),
    tools: () => [],
    resolveModel: () => 'fake:conductor',
    runTurn: (async () => ({ session: { messages: [] }, reply: '', newMessages: [], compactions: 0, usage: { in: 0, out: 0 }, pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 0, windowTokens: 0, ratio: null } })) as never,
  });
  sink = backend; // createEmbeddedBackend 的返回类型含 DagEventSink

  // UI 侧订阅 —— 与 `tui.ts` 里那段同形状(换 run 清空 + 逐个 apply)。
  backend.onEvent = (ev) => {
    if (ev.event !== 'dag') return;
    const p = ev.payload as { runId?: string; node?: { type?: string } };
    if (p.node?.type === 'planned' && p.runId) hud.beginRun(p.runId);
    if (p.node) hud.apply(p.node as DagNodeEvent);
  };

  return { tools, hud, cwd };
}

describe('★ A3 中间那一跳: 装配层事件真的走到 HUD 上', () => {
  // 反向自检 (2026-08-07 实跑): 把 assemble 那行 `onNodeEvent` 去掉 → 两条全红
  // (HUD 恒空)。那正是"两端都绿而中间断掉"的样子。
  test('dag_run_plan 跑完 → HUD 上有那两个节点, 状态与模型都对', async () => {
    const { tools, hud } = wireEverything();
    const t = tools.find((x) => x.name === 'dag_run_plan');
    await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never);
    await Bun.sleep(20);

    expect(hud.active).toBe(true);
    const out = hud.render(100).join('\n');
    expect(out).toContain('leaf-a');
    expect(out).toContain('gate-b');
    expect(out).toContain('fake:leaf'); // settle 带的模型名走完了全程
    expect(out).toContain('ok'); // leaf-a 已定局
  });

  test('★ 角色关系行数对了 —— kind 从引擎一路带到视图(裁决 ③)', async () => {
    const { tools, hud } = wireEverything();
    const t = tools.find((x) => x.name === 'dag_run');
    await t?.handler({ task: '把活干了' } as never, {} as never);
    await Bun.sleep(20);
    expect(hud.render(100).join('\n')).toMatch(/leaf 1 -> verifier 1/);
  });

  test('★ 事件形状对得上 —— backend 发的 `dag` payload 正是 DagHud.apply 认的那个', async () => {
    // 这条是前两条的因: 形状对不上时 apply 会静默什么都不做, HUD 空着而没有任何报错。
    const { tools, hud } = wireEverything();
    const t = tools.find((x) => x.name === 'dag_run_plan');
    await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never);
    await Bun.sleep(20);
    expect(hud.size).toBe(2); // planned 的两个都进了图
  });
});
