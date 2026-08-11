/**
 * src/mcp/tools/fleet.test —— D-4 review 观察面 (SDD 2026-08-11-dag-观察面与审核跟踪升级, C-5)。
 *
 * 全 fake spawn (内存注入, 永不真调 Bun.spawn / 模型): 子进程把 run.ts 的进度 NDJSON 追加到
 * 事件文件, 本模块轮询翻成标准 DagNodeEvent 灌 onNodeEvent (合成 runId, 维度 = 节点)。
 * 反向自检 (C-5): 断开子进程 onProgress (不写 NDJSON) → onNodeEvent 收到 0 事件 = 今天的现状。
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import type { DagNodeEvent } from '../../harness/dag/types';
import type { ReviewProgressEvent } from '../../harness/review/run';
import { RunRegistry } from '../run-registry';
import { createFleetTools, toDagNodeEvent, type SpawnFn } from './fleet';

/** C-5 序列样本: planned(3 维度) → 每维 start/settle → 证伪 verdict (gate:'review')。 */
const PROGRESS: ReviewProgressEvent[] = [
  { type: 'planned', nodes: [
    { id: 'correctness', kind: 'review' },
    { id: 'security', kind: 'review' },
    { id: 'boundary', kind: 'review' },
  ] },
  { type: 'start', id: 'correctness', kind: 'review' },
  { type: 'settle', id: 'correctness', status: 'done', kind: 'review', model: 'm' },
  { type: 'start', id: 'security', kind: 'review' },
  { type: 'settle', id: 'security', status: 'done', kind: 'review' },
  { type: 'start', id: 'boundary', kind: 'review' },
  { type: 'settle', id: 'boundary', status: 'done', kind: 'review' },
  { type: 'verdict', id: 'correctness', gate: 'review', verdict: 'fail', round: 1, reason: '缺权限守卫 (a.ts:3)' },
];

/** 把 review 进度序列当子进程事件汇, 逐行 NDJSON 追加到事件文件 (与 run.ts 的 emit 同写形态)。 */
function writeEventFile(file: string): void {
  appendFileSync(file, `${PROGRESS.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

describe('toDagNodeEvent 翻面 (D-4)', () => {
  test('四种 review 进度事件 → 标准 DagNodeEvent; verdict gate 恒 review', () => {
    expect(toDagNodeEvent({ type: 'planned', nodes: [{ id: 'correctness', kind: 'review' }] }))
      .toEqual({ type: 'planned', nodes: [{ id: 'correctness', kind: 'review' }] });
    expect(toDagNodeEvent({ type: 'start', id: 'correctness', kind: 'review' }))
      .toEqual({ type: 'start', id: 'correctness', kind: 'review' });
    expect(toDagNodeEvent({ type: 'settle', id: 'correctness', status: 'done', kind: 'review', model: 'm', durationMs: 12 }))
      .toEqual({ type: 'settle', id: 'correctness', status: 'done', kind: 'review', model: 'm', durationMs: 12 });
    expect(toDagNodeEvent({ type: 'verdict', id: 'correctness', gate: 'review', verdict: 'fail', round: 1, reason: 'r' }))
      .toEqual({ type: 'verdict', id: 'correctness', gate: 'review', verdict: 'fail', round: 1, reason: 'r' });
  });
});

describe('dag_review 观察面 (C-5)', () => {
  test('子进程 NDJSON 事件文件 → 轮询翻成标准事件灌 onNodeEvent (同序列 + 合成 runId)', async () => {
    const spawnCalls: { env?: Record<string, string> }[] = [];
    const spawn: SpawnFn = async (_cmd, opts) => {
      spawnCalls.push({ env: opts.env });
      // 模拟子进程 run.ts 的事件汇 (脚本不改: env 由 fleet 注入, run.ts 自己追加)。
      const file = opts.env?.OMD_REVIEW_EVENT_FILE;
      if (!file) throw new Error('dag_review 没传 OMD_REVIEW_EVENT_FILE');
      writeEventFile(file);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };
    const seen: { runId: string; e: DagNodeEvent }[] = [];
    const tools = createFleetTools({
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
      spawn,
      onNodeEvent: (runId, e) => seen.push({ runId, e }),
    });
    const res = await tools.find((x) => x.name === 'dag_review')!.handler({} as never, {} as never);
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    const runId = text.match(/runId: ([0-9a-f-]+)/)![1]!;
    await Bun.sleep(350); // 轮询间隔 200ms — 给足一拍 (子进程已退出, 终排也会收走)

    expect(spawnCalls[0]!.env!.OMD_REVIEW_EVENT_FILE).toBeTruthy(); // 事件文件通道确实经 env 传给子进程
    expect(seen.length).toBe(PROGRESS.length);
    expect(seen.every((s) => s.runId === runId)).toBe(true); // 合成 runId 一致 (不进 dag_runs 列表, D-11)
    expect(seen.map((s) => s.e.type)).toEqual(PROGRESS.map((e) => e.type));
    const verdict = seen.find((s) => s.e.type === 'verdict')!.e;
    expect(verdict).toMatchObject({ type: 'verdict', gate: 'review', verdict: 'fail', round: 1, reason: '缺权限守卫 (a.ts:3)' });
  });

  test('反向自检 (C-5): 断开子进程 onProgress (不写事件文件) → 事件数为 0 (今天现状)', async () => {
    const spawn: SpawnFn = async (_cmd, _opts) => ({ exitCode: 0, stdout: 'ok', stderr: '' }); // 不写 NDJSON
    const seen: DagNodeEvent[] = [];
    const tools = createFleetTools({
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
      spawn,
      onNodeEvent: (_runId, e) => seen.push(e),
    });
    await tools.find((x) => x.name === 'dag_review')!.handler({} as never, {} as never);
    await Bun.sleep(350);
    expect(seen).toHaveLength(0);
    // 证伪方式: 若 fleet 凭空造事件 / 从 stdout 偷 events (绕过 run.ts 的汇) → 这条必须红。
    // 0 = "事件只经子进程的 onProgress 汇出来"的可测证据 (断开 = 今天的现状)。
  });

  test('无 onNodeEvent 订阅者 → 不建事件文件通道 (观察面省略 = 不转, 零开销)', async () => {
    const spawnCalls: { env?: Record<string, string> }[] = [];
    const spawn: SpawnFn = async (_cmd, opts) => {
      spawnCalls.push({ env: opts.env });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };
    const tools = createFleetTools({ runRegistry: new RunRegistry(), cwd: '/tmp', spawn }); // 不传 onNodeEvent
    await tools.find((x) => x.name === 'dag_review')!.handler({} as never, {} as never);
    expect(spawnCalls[0]!.env?.OMD_REVIEW_EVENT_FILE).toBeUndefined();
  });
});
