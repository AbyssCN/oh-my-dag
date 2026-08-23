/**
 * `dag_run` 续跑恢复入参的**接线闸** (2026-08-23)。
 *
 * 8e6a2f0e 把点火留档 + 续跑恢复做进了 `run-ignition.ts` 并接上 `dag_goal`,
 * 但 `RECOVERABLE.dag_run` 那一行**没有任何调用方** —— 机制在、`run` 这条路上读不出来。
 * 本文件钉的就是那根线: 恢复集 (conductorModel / leafModel / maxFanout) 必须
 * 经母进程解析后进 spec, 子进程照 spec 跑。
 *
 * 判据不是「能不能恢复」, 是「**改了它还是不是同一个 run**」: 换掉执行它的那两个模型,
 * 续的就不是同一个 run 了 ⇒ 恢复。`branchStrategy` 刻意不在这套里 (由 prepareRunWorktree
 * 按盘上有没有那棵树判), `task` 同理不在 (它是本次要干的活)。
 *
 * 反向自检 (2026-08-23 各跑过一遍):
 * - 拆掉 handler 里 `resolveResumeArgs` 那段 (spec 直接用本次入参) ⇒ ① 红。
 * - 把 `saveIgnitionArgs` 的 `{ ifAbsent: true }` 拆掉 ⇒ ② 的第三跳红 (续跑那次的值
 *   把首跑的盖了, 档案从「首跑是什么」退化成「上次是什么」)。
 * - 把留档从 spawn 之后挪到之前 ⇒ ③ 红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagTools, type DagEngine } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import { loadIgnitionArgs } from '../../harness/run-ignition';
import type { OmdMcpTool } from '../server';

/** spawn 路径不该碰引擎 (引擎在子进程里) —— 碰了当场炸, 免得测试测的是别的东西。 */
const neverEngine: DagEngine = {
  runExecutorDag: async () => {
    throw new Error('spawn 路径不该调引擎');
  },
  runExecutorDagWithPlan: async () => {
    throw new Error('spawn 路径不该调引擎');
  },
};

type Spec = { tool: string; runId: string; cwd: string; args: Record<string, unknown> };

function makeRunTool(root: string, specs: Spec[], opts: { spawnOk?: boolean } = {}): OmdMcpTool {
  return createDagTools({
    engine: neverEngine,
    runRegistry: new RunRegistry(),
    defaultConfig: { conductorModel: 'seat:default-c', leafModel: 'seat:default-l' },
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    spawnDagExec: (spec) => {
      specs.push(spec as Spec);
      return opts.spawnOk === false
        ? { ok: false as const, error: 'spawn 起不来 (夹具)' }
        : { ok: true as const, pid: 4242, logPath: '/tmp/fake-exec.log' };
    },
  }).find((t) => t.name === 'dag_run')!;
}

const call = (tool: OmdMcpTool, args: Record<string, unknown>) =>
  (tool.handler as (a: Record<string, unknown>, e?: unknown) => unknown)(args, {}) as Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'omd-run-ign-'));

describe('dag_run 续跑恢复入参 (接线)', () => {
  test('★ 首跑留档 → 续跑一位没给 ⇒ 三位都从档案回来, 且回执念出恢复了哪几位', async () => {
    const root = tmpRoot();
    const specs: Spec[] = [];
    const tool = makeRunTool(root, specs);

    await call(tool, { task: '把活干了', conductorModel: 'c:首跑', leafModel: 'l:首跑', maxFanout: 3 });
    const runId = specs[0]!.runId;
    expect(loadIgnitionArgs(root, runId)?.args).toEqual({ conductorModel: 'c:首跑', leafModel: 'l:首跑', maxFanout: 3 });

    const out = await call(tool, { task: '接着干', resume: runId });
    // 恢复的值必须**进 spec** —— 子进程只认 spec, 不认档案。
    expect(specs[1]!.args).toEqual({
      task: '接着干',
      conductorModel: 'c:首跑',
      leafModel: 'l:首跑',
      maxFanout: 3,
      resume: runId,
    });
    // 判词: 只写 logger 等于生产读不出来。
    expect(out.content[0]!.text).toContain('续跑恢复自点火档案');
    expect(out.content[0]!.text).toContain('conductorModel');
    rmSync(root, { recursive: true, force: true });
  });

  test('本次给了的以本次为准, 且**档案不被续跑改写** (记的是「首跑是什么」)', async () => {
    const root = tmpRoot();
    const specs: Spec[] = [];
    const tool = makeRunTool(root, specs);

    await call(tool, { task: 't', conductorModel: 'c:首跑', leafModel: 'l:首跑' });
    const runId = specs[0]!.runId;

    // 第二跳: 换 conductor 续跑 —— 本次显式给的永远赢 (换模型重试是 resume 的正当用法)。
    const out = await call(tool, { task: 't', resume: runId, conductorModel: 'c:本次' });
    expect(specs[1]!.args.conductorModel).toBe('c:本次');
    expect(specs[1]!.args.leafModel).toBe('l:首跑'); // 没给的那位照样恢复
    expect(out.content[0]!.text).toContain('leafModel');

    // 第三跳: 又一次一位没给 —— 拿回来的必须还是**首跑**那次的值, 不是第二跳的。
    await call(tool, { task: 't', resume: runId });
    expect(specs[2]!.args.conductorModel).toBe('c:首跑');
    rmSync(root, { recursive: true, force: true });
  });

  test('spawn 起不来 ⇒ 不留档 (没跑起来的 run 不该在盘上留一份没人会续的档案)', async () => {
    const root = tmpRoot();
    const specs: Spec[] = [];
    const out = await call(makeRunTool(root, specs, { spawnOk: false }), {
      task: 't',
      conductorModel: 'c:x',
      leafModel: 'l:x',
    });
    expect(out.isError).toBe(true);
    expect(loadIgnitionArgs(root, specs[0]!.runId)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test('续跑但盘上没档案 (本模块之前的老 run) ⇒ 照跑, spec 里就是没那几位, 不编值', async () => {
    const root = tmpRoot();
    const specs: Spec[] = [];
    const out = await call(makeRunTool(root, specs), { task: 't', resume: 'r-老run' });
    expect(out.isError).toBeUndefined();
    // 「没档案」不许被编成缺省值塞进 spec —— 缺省由子进程按座位表解析 (仓规 §静默坑 1)。
    expect(specs[0]!.args).toEqual({ task: 't', resume: 'r-老run' });
    expect(out.content[0]!.text).not.toContain('续跑恢复自点火档案');
    rmSync(root, { recursive: true, force: true });
  });
});
