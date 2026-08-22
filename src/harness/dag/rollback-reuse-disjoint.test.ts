/**
 * SDD 2026-08-22 C-1/C-2: 回滚集 ∩ 复用集 = ∅。
 *
 * 现场 (run c4edb14f): 一整片产出凭空消失, 5 个节点全判绿。同一个节点 `s1` 既被毒集回滚
 * (跟踪文件已还原到轮基线) 又被 D-21 复用命中 (跨轮语义指纹匹配) —— 回滚是破坏性已发生,
 * 复用只是省钱优化, 冲突时绿节点配的是一张空盘, 而**没有任何一道闸报告「产出没了」**。
 *
 * 两处都按 merkle 指纹算、按理应当一致, 实测不一致 —— 本片不查根因, 先按 id 对账兜住整族。
 * 承重铁律 (反向自检表): 把 engine.ts 里 `if (rolledBackIds.has(id)) reuse.delete(id);`
 * 那行换成 `if (false) reuse.delete(id);` ⇒ 第一条 GWT 当场红 (s1 又被复用)。
 *
 * 写法照既有 harness (engine.test.ts 的 D-21 块 + poison-rollback.test.ts 的 CheckpointManager
 * 模式), 收判词经 `setCoreLogger` (全局状态, 收尾必须还原)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { GenerateFn, ExecutorDagConfig, LeafResult } from './types';
import { logger, setCoreLogger, type CoreLogger } from '../logger';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';
const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'rr-disjoint', nodes });

/** 收 warn: 全局 logger 是状态, 收尾必须还原 (afterEach 里做)。 */
let capturedWarns: Array<{ obj: unknown; msg?: string }> = [];
const captureLogger: CoreLogger = {
  debug: () => {},
  info: () => {},
  warn: (obj, msg) => { capturedWarns.push({ obj, msg }); },
  error: (obj, msg) => { capturedWarns.push({ obj, msg }); },
};

/** 单节点图, fingerprint 在 prior 与 current 完全一致 → 跨轮复用成立, 除非被踢出。 */
const PLAN_S1: ConductorPlan = plan({ s1: { goal: '甲' } });

/** 构造让 s1 同时落进「回滚集」与「复用集」的世界:
 *  - checkpoint 自己存下来的 fingerprint = `POISONED_FP` (人为写, 与当前 plan 算出的指纹无关)
 *  - prior.poisoned = { `POISONED_FP` }
 *  - prior.plan 与 current plan 字节相同 → 当前 fingerprint `A` 不在 poisoned, computeReuse 见 match
 *  ⇒ dropPoisonedGreens 走「通道⑤-b」(cp.fingerprint 命中毒集) 丢 s1, computeReuse 仍把 s1 放进
 *  复用集 —— 两条机制各按各自的真源说话, 交集就是 s1。
 */
const POISONED_FP = 'poisoned-fp-X';

function buildPrior(): {
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  poisoned: ReadonlySet<string>;
} {
  return {
    plan: PLAN_S1,
    results: {
      s1: {
        id: 's1', status: 'done', kind: 'inproc', output: 'out:s1', deps: [],
        usage: { in: 1, out: 1 },
      },
    } as Record<string, LeafResult>,
    poisoned: new Set([POISONED_FP]),
  };
}

/** 在 temp 树下预存 s1 的 checkpoint —— fingerprint 字段人为写 POISONED_FP。 */
function preseedS1Checkpoint(mgr: CheckpointManager, runId: string): void {
  mgr.saveCheckpoint(runId, {
    nodeId: 's1',
    leafKind: 'inproc',
    status: 'done',
    outputPaths: [],
    artifactHashes: {},
    tokenUsage: { in: 1, out: 1 },
    summary: 'out:s1',
    durationMs: 1,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    fingerprint: POISONED_FP, // ← 关键: cp.fingerprint 命中毒集, 但 plan 指纹 `A` 不在毒集
  });
}

function makeConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    ...extra,
  };
}

let root: string;
let mgr: CheckpointManager;

beforeEach(() => {
  capturedWarns = [];
  setCoreLogger(captureLogger);
  root = mkdtempSync(join(tmpdir(), 'omd-rr-disjoint-'));
  mgr = new CheckpointManager(root);
});

afterEach(() => {
  // setCoreLogger 是全局状态 — 不还原会污染下一个测试文件。
  setCoreLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('回滚集 ∩ 复用集 = ∅ (SDD 2026-08-22)', () => {
  test('★ 同一节点既被回滚又被复用 → 强制重跑, 且判词 payload 带 nodes', async () => {
    const runId = 'gwt-1';
    preseedS1Checkpoint(mgr, runId);

    const generateCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      generateCalls.push(id);
      await sleep(1);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };

    const prior = buildPrior();
    const r = await runExecutorDagWithPlan(
      PLAN_S1,
      makeConfig(generate, {
        continuity: { manager: mgr, runId, repoRoot: root, resume: true },
      }),
      prior,
    );

    // 1) s1 必须真跑 (不在复用集里) —— 没有 fix 时 generateCalls 为空 (被复用跳过)。
    expect(generateCalls).toEqual(['s1']);
    // 2) 结果面 reusedNodes 不含 s1。
    expect(r.reusedNodes ?? []).not.toContain('s1');
    // 3) s1 仍然是 done (重跑后正常完成)。
    expect(r.results.s1!.status).toBe('done');
    // 4) 相交判词必带 nodes, 且 payload 真实 (SDD D-3 / INV-4: 不许吞证据)。
    const warn = capturedWarns.find((w) => w.msg?.includes('回滚集∩复用集非空'));
    expect(warn).toBeDefined();
    const obj = warn!.obj as { nodes: string[]; count: number };
    expect(obj.nodes).toEqual(['s1']);
    expect(obj.count).toBe(1);
  });

  test('回滚集为空 → 行为逐字同旧 (零噪声, 不打判词)', async () => {
    const runId = 'gwt-2';
    preseedS1Checkpoint(mgr, runId);

    const generateCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      generateCalls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };

    // poisoned 空 → dropPoisonedGreens 早返 [] → 复用集不变 → s1 真复用。
    const prior: { plan: ConductorPlan; results: Record<string, LeafResult>; poisoned?: ReadonlySet<string> } = {
      plan: PLAN_S1,
      results: {
        s1: { id: 's1', status: 'done', kind: 'inproc', output: 'out:s1', deps: [], usage: { in: 1, out: 1 } },
      } as Record<string, LeafResult>,
    };

    const r = await runExecutorDagWithPlan(
      PLAN_S1,
      makeConfig(generate, {
        continuity: { manager: mgr, runId, repoRoot: root, resume: true },
      }),
      prior,
    );

    // s1 真复用 → generate 没被叫
    expect(generateCalls).toEqual([]);
    expect(r.reusedNodes ?? []).toContain('s1');
    // 无相交 → 无判词 (INV-5: 常态零噪声)
    const intersectWarn = capturedWarns.find((w) => w.msg?.includes('回滚集∩复用集非空'));
    expect(intersectWarn).toBeUndefined();
  });

  test('无 continuity → 一个字节都不变 (零回归那一半, INV-6)', async () => {
    const generateCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const id = leafId(contentText(req.messages.find((m) => m.role === 'user')?.content));
      generateCalls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };

    // 即使 prior.poisoned 非空, 没 continuity 就走不到 dropPoisonedGreens → 一切同旧。
    const prior = buildPrior();
    const r = await runExecutorDagWithPlan(PLAN_S1, makeConfig(generate, {}), prior);

    expect(generateCalls).toEqual([]); // 复用命中, 不调 generate
    expect(r.reusedNodes ?? []).toContain('s1');
    const intersectWarn = capturedWarns.find((w) => w.msg?.includes('回滚集∩复用集非空'));
    expect(intersectWarn).toBeUndefined();
  });
});
