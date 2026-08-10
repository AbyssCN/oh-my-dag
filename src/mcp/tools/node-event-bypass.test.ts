/**
 * **进程内节点事件旁路**的接线(TUI SDD §6,切片 S11)。
 *
 * 两条判据,第二条是 goal §4 点名的:
 *  ① 旁路真的转到了订阅者手上,**两个入口都转**;
 *  ② **`HudMirror` 仍在写 `.omd/hud/dag.json`** —— 加 TUI 不许把 statusline 断掉。
 *
 * ⚠ `dag_run`(conductor 路径)与 `dag_run_plan`(预构造 plan 路径)是**两个各自组 config
 * 的函数**,只接一处的症状与完全没接一模一样(`run-record-wiring.test.ts` 的注释记过这个坑;
 * 本片第一版差点原样再踩一次 —— 先只改了 `launchPlanRun` 那处)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../../harness/conductor-plan';
import type { DagNodeEvent, ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types';
import { HudMirror } from '../../hud/mirror';
import { RunRegistry } from '../run-registry';
import { type DagEngine, createDagTools } from './dag-tools';

// S2 进程化 (SDD 2026-08-10): dag_run 用例走**进程内执行体** (生产里只在 dag-exec 子进程跑)。
beforeEach(() => { process.env.OMD_DAG_EXEC_CHILD = '1'; });
afterEach(() => { delete process.env.OMD_DAG_EXEC_CHILD; });

const EMPTY: ExecutorDagResult = {
  answer: 'ok', nodes: [], usage: { in: 0, out: 0 },
} as unknown as ExecutorDagResult;

/** 假引擎:立刻发一串节点事件,再返回。 */
function engineEmitting(events: DagNodeEvent[]): DagEngine {
  const run = async (_x: unknown, config: ExecutorDagConfig) => {
    for (const e of events) config.onNodeEvent?.(e);
    return EMPTY;
  };
  return {
    runExecutorDag: run as DagEngine['runExecutorDag'],
    runExecutorDagWithPlan: run as DagEngine['runExecutorDagWithPlan'],
  };
}

const EVENTS: DagNodeEvent[] = [
  { type: 'planned', nodes: [{ id: 'n1', kind: 'agent' }] },
  { type: 'start', id: 'n1', kind: 'agent' },
  { type: 'settle', id: 'n1', status: 'done', kind: 'agent', model: 'm' },
];

// ⚠ dag_run_plan 收的是 **JSON 字符串**不是对象 (第一版传对象 → 'not JSON' 当场红)。
// nodes 是 **record 不是数组** (第二版又撞一次: 'expected record, received array')。
// (`kind` 只在 'primitive' 那一档存在 —— 第三版又撞一次。普通 leaf 节点用 goal + executor。)
const PLAN = { name: 'p', description: 'd', nodes: { n1: { goal: 'g', executor: 'leaf' } } } as unknown as ConductorPlan;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'omd-bypass-'));
  const seen: { runId: string; e: DagNodeEvent }[] = [];
  const tools = createDagTools({
    engine: engineEmitting(EVENTS),
    runRegistry: new RunRegistry(),
    defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
    hudMirror: new HudMirror(root),
    onNodeEvent: (runId, e) => seen.push({ runId, e }),
  });
  return { root, seen, tools };
}

describe('★ 旁路两个入口都接', () => {
  test('dag_run_plan(预构造 plan 路径)转发全部事件', async () => {
    const { seen, tools } = setup();
    const t = tools.find((x) => x.name === 'dag_run_plan');
    await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never);
    await Bun.sleep(10);
    expect(seen.map((s) => s.e.type)).toEqual(['planned', 'start', 'settle']);
    expect(new Set(seen.map((s) => s.runId)).size).toBe(1); // 同一个 run 的事件带同一个 runId
  });

  test('★ dag_run(conductor 路径)也转发 —— 只接一处与完全没接读数一样', async () => {
    const { seen, tools } = setup();
    const t = tools.find((x) => x.name === 'dag_run');
    await t?.handler({ task: '把活干了' } as never, {} as never);
    await Bun.sleep(10);
    expect(seen.map((s) => s.e.type)).toEqual(['planned', 'start', 'settle']);
  });
});

describe('★ statusline 没被断掉', () => {
  // 反向自检 (2026-08-07 实跑): 把 dag-tools 里 `hudMirror?.write(...)` 那两行注释掉
  // → 这两条当场红。加 TUI 的旁路**不许**顺手把 statusline 的数据源换掉。
  test('dag_run_plan 之后 .omd/hud/dag.json 仍被写出来, 且内容是真的', async () => {
    const { root, tools } = setup();
    const t = tools.find((x) => x.name === 'dag_run_plan');
    await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never);
    await Bun.sleep(10);
    const f = join(root, '.omd', 'hud', 'dag.json');
    expect(existsSync(f)).toBe(true);
    const snap = JSON.parse(readFileSync(f, 'utf-8')) as { settled: { id: string }[]; planned: { id: string }[] };
    expect(snap.planned.map((n) => n.id)).toContain('n1');
    expect(snap.settled.map((n) => n.id)).toContain('n1');
  });

  test('dag_run 之后同样写出来', async () => {
    const { root, tools } = setup();
    const t = tools.find((x) => x.name === 'dag_run');
    await t?.handler({ task: 'x' } as never, {} as never);
    await Bun.sleep(10);
    expect(existsSync(join(root, '.omd', 'hud', 'dag.json'))).toBe(true);
  });
});

describe('订阅者不许拖垮执行', () => {
  test('★ 订阅者抛错 → 吞掉不打断, 且 statusline 照写(fail-open 但不吞证据: 有日志)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-bypass-throw-'));
    const tools = createDagTools({
      engine: engineEmitting(EVENTS),
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      hudMirror: new HudMirror(root),
      onNodeEvent: () => {
        throw new Error('UI 炸了');
      },
    });
    const t = tools.find((x) => x.name === 'dag_run_plan');
    const out = (await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never)) as { isError?: boolean };
    await Bun.sleep(10);
    expect(out.isError).toBeUndefined();
    expect(existsSync(join(root, '.omd', 'hud', 'dag.json'))).toBe(true);
  });

  test('不给订阅者时行为与从前一致(省略 = 不转)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-bypass-none-'));
    const tools = createDagTools({
      engine: engineEmitting(EVENTS),
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      hudMirror: new HudMirror(root),
    });
    const t = tools.find((x) => x.name === 'dag_run_plan');
    expect(((await t?.handler({ plan: JSON.stringify(PLAN) } as never, {} as never)) as { isError?: boolean }).isError).toBeUndefined();
  });
});
