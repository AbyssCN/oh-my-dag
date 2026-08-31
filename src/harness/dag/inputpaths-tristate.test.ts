/**
 * src/harness/dag/inputpaths-tristate.test.ts —— G3 刀B 契约闸: `NodeCheckpoint.inputPaths`
 * **三态** (2026-08-31)。
 *
 * 锚串: `INPUTPATHS_TRISTATE`
 *
 * 三态语义 (真源 = `src/harness/continuity/types.ts` 的 `inputPaths` 注释):
 *
 *   1. `inputPaths === []`        = 该跑经**工具面**零文件读 (agent leaf 跑过了, 但没 read/hashline_read 任何东西)
 *   2. `inputPaths === ['a',…]`  = 读了这些 (相对 repo root 的相对化路径)
 *   3. `inputPaths === undefined` = **缺席** = inproc/command 节点 (不适用) 或老记录 (向前兼容)
 *
 * | GWT | 钉的是什么 |
 * |-----|---|
 * | GWT-1 | agent leaf 工具面零文件读 → `inputPaths === []` (空数组字面, **不**是 `undefined`) |
 * | GWT-2 | agent leaf 经 read 读了 2 个文件 → `inputPaths === ['a','b']` (相对化路径) |
 * | GWT-3 | command 节点 → checkpoint 上 `inputPaths` 字段**缺席** (`'inputPaths' in cp === false`) |
 * | GWT-4 | 持久化层 byte-for-byte: `saveCheckpoint → loadCheckpoint` 对 inputPaths: [] 保真 (反咬 `?.length` 谓词) |
 *
 * ⚠ 怎么让它红 (反向自检, 必须真跑一次才认闸活着):
 *   · GWT-1: 把 done 出口 `src/harness/dag/engine.ts:1807` 的 `!== undefined` 退回 `?.length`
 *            → 空数组被塌成缺席 → toBeUndefined 通过但 `'inputPaths' in cp === false` 判红。
 *   · GWT-2: 把 done 出口的 `.map(rel)` 改成 `.map((p) => p.toUpperCase())` → 路径大小写错位红。
 *   · GWT-3: 在 failed/done 出口 (engine.ts:1807/5506) 误把 command 节点也按"defined 即写"挂上
 *            `inputPaths` → toBeUndefined 失败 (`'inputPaths' in cp === true`)。
 *   · GWT-4: saveCheckpoint 的 JSON 序列化前手动 `delete cp.inputPaths` → loadCheckpoint 读不到该键
 *            → `'inputPaths' in cp === false` 判红。
 *
 * 不变项 (INV-5): 现有全部测试零改动即绿 (本片只动**采集边界注释**与三态测试)。
 *
 * ⚠ **失败 agent leaf 的空数组语义**: 契约字面要求失败出口同样按三态写 (`failed 的 agent leaf
 *   filesRead 已定义 → inputPaths 同样在`), 但 engine.ts:4473/4484 等上游 LeafResult 构造点
 *   仍用 `filesRead.length` 谓词丢空数组, 导致 settled.filesRead 是 undefined 而非 []。这条
 *   **链上游**的修法不属本片写集 (本片写集只两份: 此测试文件 + continuity/types.ts 注释), 它
 *   完整修需要再开一片动 engine.ts 的 slice —— 留作下游切片观察, 不在本片伪造绿。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { NodeCheckpoint } from '../continuity/types';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

let root: string;
let mgr: CheckpointManager;
const runId = 'r-inputpaths-tristate';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-inputpaths-tristate-'));
  delete process.env.OMD_DATA_HOME;
  mgr = new CheckpointManager(root);
  const runDir = join(root, '.omd', 'continuity', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '_dag.json'),
    JSON.stringify({
      runId,
      goal: 'inputpaths-tristate fixture',
      specSlug: 'inputpaths-tristate-fixture',
      nodeIds: ['L1'],
      deps: { L1: [] },
      plan: { name: 'inputpaths-tristate-fixture', nodes: { L1: { goal: 'fixture' } } },
      createdAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 最小 ExecutorDagConfig: 叶子层不接 conductor, 与 usage-attribution.test.ts 同款。 */
function makeConfig(extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 0, out: 0 } });
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentLeafModel: 'test:agent',
    generate,
    agentTemplates: new Map(),
    continuity: { manager: mgr, runId, repoRoot: root },
    ...extra,
  };
}

describe('INPUTPATHS_TRISTATE: 节点级 inputPaths 三态', () => {
  test('GWT-1: agent leaf 工具面零文件读 → inputPaths === [] (空数组字面, 不是 undefined)', async () => {
    // 切片 1 把 done 出口 (engine.ts:1807) 的 `?.length` 谓词改成 `!== undefined` —— 之前的
    // 实现把空数组塌成"没读" / "没记", 是 NULL≠0≠不适用塌陷的同一种病灶。本断言钉死
    // 「空数组能保真落盘」这件事。
    const agentRunner = async () => ({
      text: 'agent done, 没读任何文件',
      usage: { in: 1, out: 1 },
      filesRead: [] as string[],
    });
    const plan: ConductorPlan = {
      name: 'inputpaths-tristate-empty',
      nodes: { L1: { goal: '零文件读 agent', executor: 'agent' } },
    };

    const r = await runExecutorDagWithPlan(plan, makeConfig({ agentRunner }));
    expect(r.results.L1!.status).toBe('done');

    const cp = mgr.loadCheckpoint(runId, 'L1');
    expect(cp).not.toBeNull();
    // 关键判据: inputPaths **字段在** 且 **是字面空数组**。
    expect('inputPaths' in (cp as NodeCheckpoint)).toBe(true);
    expect(cp!.inputPaths).toBeDefined();
    expect(cp!.inputPaths).toEqual([]);
    // 反向判据: 它绝不能被读成 undefined (那正是塌成"没读"的那条原 bug)。
    expect(cp!.inputPaths).not.toBeUndefined();
  });

  test('GWT-2: agent leaf 经 read 读了 2 个文件 → inputPaths 含两条相对化路径', async () => {
    // 经 read 工具读到的路径以 repo root 相对化形式落到 checkpoint (engine.ts:1807 `.map(rel)`)。
    // 读一个绝对路径, 验证 `rel` 把它剥成相对; 读一个已经是相对的, 验证它**不**被二次剥。
    const readPaths = ['src/foo.ts', `${root}/bar/baz.ts`];
    const agentRunner = async () => ({
      text: 'agent done, 读了两个文件',
      usage: { in: 2, out: 2 },
      filesRead: readPaths,
    });
    const plan: ConductorPlan = {
      name: 'inputpaths-tristate-two',
      nodes: { L1: { goal: '两文件读 agent', executor: 'agent' } },
    };

    const r = await runExecutorDagWithPlan(plan, makeConfig({ agentRunner }));
    expect(r.results.L1!.status).toBe('done');

    const cp = mgr.loadCheckpoint(runId, 'L1');
    expect(cp).not.toBeNull();
    expect(cp!.inputPaths).toBeDefined();
    expect(cp!.inputPaths).toHaveLength(2);
    // 相对路径原样, 绝对路径被剥成相对。
    expect(cp!.inputPaths).toContain('src/foo.ts');
    expect(cp!.inputPaths).toContain('bar/baz.ts');
    // 既不多记也不少记。
    expect(new Set(cp!.inputPaths)).toEqual(
      new Set(readPaths.map((p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p))),
    );
  });

  test('GWT-3: command 节点 → inputPaths 字段缺席 (inproc/command 不适用, 不许写空数组伪装)', async () => {
    // command leaf 不经文件读工具面 (FILE_READ_TOOLS 在 agent-leaf.ts:1716 与 command 不相干),
    // settled.filesRead 是 undefined → engine done/failed 出口的 `!== undefined` 三元不挂
    // inputPaths 字段。这正是"不适用"语义, 不能拿空数组伪装成"跑了但没读"。
    //
    // commandRunner 必须返齐 CommandLeafResult 四字段 (text/usage/exitCode/timedOut/signal),
    // 缺一会被下游当成"命令过程中抛错"判 failed (engine.ts:3852)。
    const commandRunner = async () => ({
      text: 'command done',
      usage: { in: 0, out: 0 },
      exitCode: 0,
      timedOut: false,
      signal: null,
    });
    const plan: ConductorPlan = {
      name: 'inputpaths-tristate-command',
      nodes: { L1: { goal: '纯命令节点', executor: 'command', command: 'echo trivial' } },
    };

    const r = await runExecutorDagWithPlan(plan, makeConfig({ commandRunner }));
    expect(r.results.L1!.status).toBe('done');

    const cp = mgr.loadCheckpoint(runId, 'L1');
    expect(cp).not.toBeNull();
    // 关键判据: inputPaths **字段不在** checkpoint 上, 是 undefined, 不是空数组。
    expect('inputPaths' in (cp as NodeCheckpoint)).toBe(false);
    expect(cp!.inputPaths).toBeUndefined();
  });

  test('GWT-4 (持久化层 byte-for-byte): saveCheckpoint → loadCheckpoint 对 inputPaths: [] 保真', async () => {
    // 直击 CheckpointManager 持久化边界: 引擎侧改完了, 如果序列化层 (JSON.stringify → 读回
    // → 反序列化) 任何一处丢字段, 这条都红。所以**这条**钉的是 INV-4 的字面保真, 与引擎
    // 上游那些 `?.length` 谓词无关 —— 切片 2 真正能担保的就是这一面。
    const base: NodeCheckpoint = {
      nodeId: 'L1',
      leafKind: 'agent',
      status: 'done',
      outputPaths: [],
      artifactHashes: {},
      tokenUsage: { in: 1, out: 1 },
      summary: '持久化层 fixture',
      durationMs: 1,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    // 三个 case 一次过: 显式写空数组、显式写非空数组、字段缺席。
    mgr.saveCheckpoint(runId, { ...base, nodeId: 'empty', inputPaths: [] });
    mgr.saveCheckpoint(runId, { ...base, nodeId: 'two', inputPaths: ['src/a.ts', 'src/b.ts'] });
    mgr.saveCheckpoint(runId, { ...base, nodeId: 'absent' }); // 不传 inputPaths

    const empty = mgr.loadCheckpoint(runId, 'empty');
    const two = mgr.loadCheckpoint(runId, 'two');
    const absent = mgr.loadCheckpoint(runId, 'absent');

    expect(empty).not.toBeNull();
    expect('inputPaths' in empty!).toBe(true);
    expect(empty!.inputPaths).toEqual([]); // 字面空数组, 不是 undefined

    expect(two).not.toBeNull();
    expect(two!.inputPaths).toEqual(['src/a.ts', 'src/b.ts']);

    expect(absent).not.toBeNull();
    expect('inputPaths' in absent!).toBe(false);
    expect(absent!.inputPaths).toBeUndefined();
  });
});