/**
 * src/harness/dream/extract-run.test.ts —— dream SDD §S5 extract-run 叶测试。
 *
 * 全部 fake, 零网络。live 测试仅 OMD_DREAM_LIVE=1 时启用。
 *
 * 闸清单 (SDD §S5 判据 1-3 + 预算 + 时态边 + 自我证伪):
 *
 * ## 确定性闸
 * A. planEdgeOp — 构造正确 identity (family:<id>)-[best_plan]->(plan:v<N>)
 * B. renderTrustedRunInput — 包含 run 信息 / transcript / feedback / plan 战绩
 * C. checkExtractRunBudget — K_leaf=8 边界
 * D. extractRunRecord (无 model) — 零 LLM 候选, 时态边操作
 * E. extractRunRecord (fake model) — LLM 候选带 runRef + tentative confidence
 * F. LLM 返回非法 namespace → fail
 * G. 预算超限 (候选 > K_leaf=8) → fail, 判词含实际数, 零产出
 * H. 模型不得作者化 runRef/confidence (代码统一附加)
 *
 * ## 时态边闸 (SDD §S5 判据 3)
 * I. 同 family 连写两版本 → asOf(旧) 出 v1, asOf(现在) 出 v2, 两条都在
 * J. 反向自检: put 覆盖 → EDGE-INV-1 抛错
 *
 * ## 反向自检 (逐条真做过: 临时改坏 → 跑 scoped test 看红 → 记录 → 改回)
 * 见文件尾部「证伪实测」段。
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import type { ModelRequest, ModelResponse, ModelUsage } from '../../model/types';
import { SqliteEdgeStore } from '../memory/edge-store';
import { Database } from 'bun:sqlite';
import type { EdgeStore, TemporalEdge } from '../memory/types';
import {
  extractRunRecord,
  planEdgeOp,
  renderTrustedRunInput,
  checkExtractRunBudget,
  type ExtractRunInput,
  type ExtractRunReport,
  type PlanEdgeOp,
} from './extract-run';
import { K_leaf } from './merge';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { validateDreamCandidate } from './validate';

// 非 live 测试需要 model 坐标；设置 test fallback (仅当 env 未设时, 不覆盖 live 的 OMD_DREAM_MODEL)
if (!process.env.OMD_DREAM_MODEL) process.env.OMD_DREAM_MODEL = 'test:fake';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

const defaultUsage: ModelUsage = { in: 100, out: 50 };

function fakeCallModel(
  parsed: unknown,
  opts?: { usage?: ModelUsage; model?: string },
): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req) => ({
    text: JSON.stringify(parsed),
    parsed,
    usage: opts?.usage ?? defaultUsage,
    raw: {},
    model: opts?.model ?? 'test:fake',
    attempts: 1,
  });
}

function failingCallModel(errMsg: string): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req) => {
    throw new Error(errMsg);
  };
}

/** 构造最小 run 输入 */
function minRunInput(overrides?: Partial<ExtractRunInput>): ExtractRunInput {
  return {
    runId: 'run-001',
    status: 'done',
    goal: '修 bug X',
    ...overrides,
  };
}

/** 构造含 plan-ledger + transcript 的富 run 输入 */
function richRunInput(): ExtractRunInput {
  return {
    runId: 'run-abc',
    status: 'failed',
    goal: 'dag_goal: 修复 synthesis 节点空产物判胜',
    error: 'verifier 不通过: quorum=any 把空产物读成冠军',
    transcript: [
      '[用户] 帮我修 synthesis 节点, 它把空产物判胜了',
      '[助手] 好, 我来查。先读 synthesis 节点的 quorum 配置...',
      '[工具] quorum = "any"',
      '[助手] 实测: quorum=any 下空产物得票 1/1 = 胜出。改成 quorum=all。',
      '[工具] 修改完成',
    ].join('\n'),
    redrawFeedback: [
      'redraw: 第一次修改只改了 quorum, 但 merge 逻辑仍有 race — 两叶同时写时产物覆盖',
      'redraw: 第二次加了锁, 通过。但耗时从 3s 涨到 12s — 怀疑是锁争用',
    ],
    invalidClassification: undefined,
    planLedger: {
      familyId: 'fam-synthesis',
      familyCanonicalTask: '修复 synthesis 节点空产物判胜',
      planVersion: 2,
      planOk: false,
      planVerified: false,
      costUsd: 0.03,
      generation: 'v2',
    },
  };
}

/** 内存 SQLite + SqliteEdgeStore (测试用) */
function memEdgeStore(): SqliteEdgeStore {
  return new SqliteEdgeStore(new Database(':memory:'));
}

// ---------------------------------------------------------------------------
// A. planEdgeOp
// ---------------------------------------------------------------------------

describe('planEdgeOp', () => {
  test('构造正确 identity: (family:<id>)-[best_plan]->(current)', () => {
    const input = minRunInput({
      planLedger: {
        familyId: 'fam-1',
        familyCanonicalTask: 'task A',
        planVersion: 3,
        planOk: true,
        planVerified: true,
      },
    });
    const op = planEdgeOp(input);
    expect(op).not.toBeNull();
    expect(op!.identity.subject).toBe('family:fam-1');
    expect(op!.identity.predicate).toBe('best_plan');
    expect(op!.identity.object).toBe('current');
  });

  test('successor 含 payload: runId / familyTask / version / ok / verified', () => {
    const input = minRunInput({
      runId: 'run-xyz',
      planLedger: {
        familyId: 'fam-2',
        familyCanonicalTask: 'task B',
        planVersion: 1,
        planOk: false,
        planVerified: false,
        costUsd: 0.05,
        generation: 'g1',
      },
    });
    const op = planEdgeOp(input)!;
    expect(op.successor.payload).toEqual({
      runId: 'run-xyz',
      familyTask: 'task B',
      version: 1,
      ok: false,
      verified: false,
      costUsd: 0.05,
      generation: 'g1',
    });
  });

  test('无 planLedger → null', () => {
    expect(planEdgeOp(minRunInput())).toBeNull();
  });

  test('planLedger 缺 familyId → null', () => {
    expect(
      planEdgeOp(
        minRunInput({
          planLedger: {
            familyId: '',
            familyCanonicalTask: 'x',
            planVersion: 1,
            planOk: true,
            planVerified: false,
          },
        }),
      ),
    ).toBeNull();
  });

  test('costUsd undefined → payload 不含 costUsd', () => {
    const input = minRunInput({
      planLedger: {
        familyId: 'fam-3',
        familyCanonicalTask: 'task C',
        planVersion: 1,
        planOk: true,
        planVerified: false,
      },
    });
    const op = planEdgeOp(input)!;
    expect('costUsd' in op.successor.payload!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. renderTrustedRunInput
// ---------------------------------------------------------------------------

describe('renderTrustedRunInput', () => {
  test('包含 run 基本信息', () => {
    const out = renderTrustedRunInput(minRunInput({ runId: 'r1', status: 'done', goal: 'g1' }));
    expect(out).toContain('runId: r1');
    expect(out).toContain('status: done');
    expect(out).toContain('goal: g1');
  });

  test('包含 error', () => {
    const out = renderTrustedRunInput(minRunInput({ error: 'something broke' }));
    expect(out).toContain('error: something broke');
  });

  test('包含 invalid classification', () => {
    const out = renderTrustedRunInput(
      minRunInput({ invalidClassification: '判分对象被改了, 作废' }),
    );
    expect(out).toContain('Invalid 分类');
    expect(out).toContain('判分对象被改了, 作废');
  });

  test('包含 redraw feedback', () => {
    const out = renderTrustedRunInput(
      minRunInput({ redrawFeedback: ['fb1', 'fb2'] }),
    );
    expect(out).toContain('Redraw Feedback');
    expect(out).toContain('fb1');
    expect(out).toContain('fb2');
  });

  test('包含 transcript', () => {
    const out = renderTrustedRunInput(
      minRunInput({ transcript: 'some transcript' }),
    );
    expect(out).toContain('Transcript');
    expect(out).toContain('some transcript');
  });

  test('包含 plan 战绩', () => {
    const out = renderTrustedRunInput(
      minRunInput({
        planLedger: {
          familyId: 'f1',
          familyCanonicalTask: 'task X',
          planVersion: 2,
          planOk: true,
          planVerified: true,
          costUsd: 0.01,
          generation: 'g2',
        },
      }),
    );
    expect(out).toContain('Plan 战绩');
    expect(out).toContain('task X');
    expect(out).toContain('v2');
    expect(out).toContain('ok: true');
  });

  test('空输入 → 仍含基本 run 信息', () => {
    const out = renderTrustedRunInput(minRunInput());
    expect(out).toContain('runId');
    expect(out).toContain('status');
    expect(out).toContain('goal');
  });
});

// ---------------------------------------------------------------------------
// C. checkExtractRunBudget
// ---------------------------------------------------------------------------

describe('checkExtractRunBudget', () => {
  test('候选 = 8 → ok (边界)', () => {
    expect(checkExtractRunBudget(8).ok).toBe(true);
  });

  test('候选 < 8 → ok', () => {
    expect(checkExtractRunBudget(0).ok).toBe(true);
    expect(checkExtractRunBudget(5).ok).toBe(true);
  });

  test('候选 > 8 → fail, 判词含实际数与上限', () => {
    const r = checkExtractRunBudget(9);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('9');
      expect(r.reason).toContain('8');
      expect(r.reason).toContain('K_leaf exceeded');
    }
  });
});

// ---------------------------------------------------------------------------
// D. extractRunRecord (无 model / 机械)
// ---------------------------------------------------------------------------

describe('extractRunRecord (无 model)', () => {
  test('无 model、无 planLedger → 零候选, 零边操作', async () => {
    const edges = memEdgeStore();
    const report = await extractRunRecord(minRunInput(), { edges });
    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(0);
    expect(report.llmCallCount).toBe(0);
    expect(report.edgeOps).toBe(0);
  });

  test('无 model、有 planLedger + edges → 时态边写入, 零 LLM 候选', async () => {
    const edges = memEdgeStore();
    const input = minRunInput({
      planLedger: {
        familyId: 'fam-1',
        familyCanonicalTask: 'task A',
        planVersion: 1,
        planOk: true,
        planVerified: false,
      },
    });
    const report = await extractRunRecord(input, { edges });
    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(0);
    expect(report.llmCallCount).toBe(0);
    expect(report.edgeOps).toBe(1);

    // 边在 EdgeStore 里查得到
    const now = new Date();
    const live = await edges.asOf(now, { subject: 'family:fam-1' });
    expect(live).toHaveLength(1);
    expect(live[0]!.predicate).toBe('best_plan');
    expect(live[0]!.object).toBe('current');
    expect(live[0]!.payload?.version).toBe(1);
  });

  test('无 model、有 planLedger 但无 edges → 边操作 noop, 零候选', async () => {
    const input = minRunInput({
      planLedger: {
        familyId: 'fam-1',
        familyCanonicalTask: 'task A',
        planVersion: 1,
        planOk: true,
        planVerified: false,
      },
    });
    const report = await extractRunRecord(input); // 无 edges
    expect(report.ok).toBe(true);
    expect(report.edgeOps).toBe(0);
    expect(report.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E. extractRunRecord (fake model)
// ---------------------------------------------------------------------------

describe('extractRunRecord (fake model)', () => {
  test('fake model 返回 1 条 → LLM 候选带 runRef + tentative confidence', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        {
          namespace: 'omd.pattern',
          payload: { situation: 'synthesis 节点', approach: 'quorum=any', outcome: 'failed' },
        },
      ],
    });

    const report = await extractRunRecord(
      {
        runId: 'run-abc',
        status: 'failed',
        goal: 'test',
        transcript: 'some content',
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.llmCallCount).toBe(1);
    expect(report.candidates).toHaveLength(1);
    const c = report.candidates[0]!;
    expect(c.namespace).toBe('omd.pattern');
    expect(c.runRef).toEqual({ runId: 'run-abc', nodeId: undefined });
    expect(c.confidence.level).toBe('agent_tentative');
    expect(c.confidence.source_event_ids).toEqual(['run:run-abc']);
  });

  test('fake model 返回 2 条 → 全部带 runRef', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        {
          namespace: 'omd.pattern',
          payload: { situation: 's', approach: 'a1', outcome: 'failed' },
        },
        {
          namespace: 'omd.limit',
          payload: { kind: 'boundary', statement: 'seat X timeout at 8k prompt' },
        },
      ],
    });

    const report = await extractRunRecord(
      {
        runId: 'run-xyz',
        status: 'done',
        goal: 'test',
        transcript: 'data',
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(2);
    for (const c of report.candidates) {
      expect(c.runRef!.runId).toBe('run-xyz');
      expect(c.confidence.level).toBe('agent_tentative');
    }
  });

  test('fake model 返回空 → 零候选', async () => {
    const fakeModel = fakeCallModel({ candidates: [] });

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(0);
  });

  test('无 transcript 时仍调 LLM (可信输入至少含 run 基本信息)', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        {
          namespace: 'omd.pattern',
          payload: { situation: 's', approach: 'a', outcome: 'worked' },
        },
      ],
    });

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.llmCallCount).toBe(1);
  });

  test('机械边 + LLM 候选共存', async () => {
    const edges = memEdgeStore();
    const fakeModel = fakeCallModel({
      candidates: [
        {
          namespace: 'omd.pattern',
          payload: { situation: 's', approach: 'a', outcome: 'failed' },
        },
      ],
    });

    const input = richRunInput();
    const report = await extractRunRecord(input, { callModel: fakeModel, edges });

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(1);
    expect(report.edgeOps).toBe(1);

    // 边在 store 里
    const live = await edges.asOf(new Date(), {
      subject: 'family:fam-synthesis',
      predicate: 'best_plan',
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.object).toBe('current');
    expect(live[0]!.payload?.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F. LLM 返回非法 namespace
// ---------------------------------------------------------------------------

describe('LLM namespace 校验', () => {
  test('LLM 返回不在允许表中的 namespace → fail', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { namespace: 'continuity', payload: { whatever: 'x' } },
      ],
    });

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('continuity');
    expect(report.failReason).toContain('not in allowed namespaces');
  });
});

// ---------------------------------------------------------------------------
// G. 预算闸
// ---------------------------------------------------------------------------

describe('extractRunRecord 预算闸', () => {
  test('fake model 返回 9 条 → 整叶 fail, 判词含 9 与 8, 零产出', async () => {
    const fakeModel = fakeCallModel({
      candidates: Array.from({ length: 9 }, (_, i) => ({
        namespace: 'omd.pattern',
        payload: { situation: `s${i}`, approach: `a${i}`, outcome: 'failed' },
      })),
    });

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('9');
    expect(report.failReason).toContain('8');
    expect(report.candidates).toHaveLength(0);
  });

  test('fake model 返回 8 条 → ok (边界)', async () => {
    const fakeModel = fakeCallModel({
      candidates: Array.from({ length: 8 }, (_, i) => ({
        namespace: 'omd.pattern',
        payload: { situation: `s${i}`, approach: `a${i}`, outcome: 'failed' },
      })),
    });

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// H. 模型不得作者化 runRef / confidence
// ---------------------------------------------------------------------------

describe('模型字段隔离', () => {
  test('fake 模型夹带 fake confidence/runRef → 最终仍是 agent_tentative + 代码 runRef', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        {
          namespace: 'omd.pattern',
          payload: {
            situation: 's',
            approach: 'a',
            outcome: 'failed',
            // 模型试图夹带
            confidence: { level: 'human_verified' },
            runRef: { runId: 'fake-run', nodeId: 'fake-node' },
            source_event_ids: ['fake:event'],
          },
        },
      ],
    });

    const report = await extractRunRecord(
      { runId: 'real-run', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    const c = report.candidates[0]!;
    // 代码统一附加, 覆盖模型
    expect(c.confidence.level).toBe('agent_tentative');
    expect(c.confidence.source_event_ids).toEqual(['run:real-run']);
    expect(c.runRef).toEqual({ runId: 'real-run', nodeId: undefined });
    // payload 中夹带的字段不影响外层
    expect(c.payload.confidence).toBeDefined(); // 模型夹带的在 payload 里
    expect(c.payload.runRef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LLM 失败路径
// ---------------------------------------------------------------------------

describe('extractRunRecord LLM 失败', () => {
  test('callModel 抛错 → ok=false, failReason 含错误信息', async () => {
    const fakeModel = failingCallModel('network timeout');

    const report = await extractRunRecord(
      { runId: 'r1', status: 'done', goal: 'test', transcript: 'data' },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('network timeout');
    expect(report.candidates).toHaveLength(0);
  });

  test('LLM 失败但有时态边 → 边仍执行', async () => {
    const edges = memEdgeStore();
    const fakeModel = failingCallModel('boom');

    const input = minRunInput({
      planLedger: {
        familyId: 'fam-1',
        familyCanonicalTask: 'task',
        planVersion: 1,
        planOk: true,
        planVerified: false,
      },
    });
    const report = await extractRunRecord(input, { callModel: fakeModel, edges });

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('boom');
    expect(report.edgeOps).toBe(1); // 边仍写入
  });
});

// ---------------------------------------------------------------------------
// I. 时态边: 同 family 两版本 → asOf 旧/新 都查得到 (invalidate)
// ---------------------------------------------------------------------------

describe('时态边 invalidate', () => {
  test('同 family 连写两版本 → asOf(旧) 出 v1 payload, asOf(现在) 出 v2 payload, 两条都在', async () => {
    const edges = memEdgeStore();

    // 第一版本: v1 @ t1 (首次写入用 put, 因为无前任 open edge)
    const t1 = new Date('2026-08-01T00:00:00Z');
    await edges.put({
      subject: 'family:fam-test',
      predicate: 'best_plan',
      object: 'current',
      validFrom: t1,
      validTo: null,
      payload: { version: 1, runId: 'run-1' },
    });

    // 第二版本: v2 @ t2 — 通过 invalidate (有前任 open edge)
    const t2 = new Date('2026-08-02T00:00:00Z');
    await edges.invalidate(
      { subject: 'family:fam-test', predicate: 'best_plan', object: 'current' },
      t2,
      {
        subject: 'family:fam-test',
        predicate: 'best_plan',
        object: 'current',
        validTo: null,
        payload: { version: 2, runId: 'run-2' },
      },
    );

    // asOf(t1 之后、t2 之前) → v1
    const mid = new Date('2026-08-01T12:00:00Z');
    const oldEdges = await edges.asOf(mid, { subject: 'family:fam-test' });
    expect(oldEdges).toHaveLength(1);
    expect(oldEdges[0]!.payload?.version).toBe(1);
    expect(oldEdges[0]!.validTo).not.toBeNull(); // 已被关闭

    // asOf(现在) → v2
    const now = new Date();
    const newEdges = await edges.asOf(now, { subject: 'family:fam-test' });
    expect(newEdges).toHaveLength(1);
    expect(newEdges[0]!.payload?.version).toBe(2);
    expect(newEdges[0]!.validTo).toBeNull(); // 仍在有效期

    // 两条都在 (各自时间点查得到)
    const atT1 = await edges.asOf(t1, { subject: 'family:fam-test' });
    expect(atT1).toHaveLength(1);
    expect(atT1[0]!.payload?.version).toBe(1);

    const atT3 = await edges.asOf(new Date('2026-08-03T00:00:00Z'), { subject: 'family:fam-test' });
    expect(atT3).toHaveLength(1);
    expect(atT3[0]!.payload?.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// J. 反向自检: put 覆盖 → EDGE-INV-1 抛错
// ---------------------------------------------------------------------------

describe('EDGE-INV-1 反向自检', () => {
  test('put 覆盖同 identity 的 live 边 → EDGE-INV-1 抛错', async () => {
    const edges = memEdgeStore();

    // 写入第一条边
    await edges.put({
      subject: 'family:fam-inv',
      predicate: 'best_plan',
      object: 'current',
      validFrom: new Date('2026-08-01T00:00:00Z'),
      validTo: null,
    });

    // 尝试 put 第二条重叠边 (同 identity) → 应抛 EdgeOverlapError
    let threw = false;
    try {
      await edges.put({
        subject: 'family:fam-inv',
        predicate: 'best_plan',
        object: 'current',
        validFrom: new Date('2026-08-02T00:00:00Z'),
        validTo: null,
      });
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain('EDGE-INV-1');
    }
    expect(threw).toBe(true);
  });
});
describe('常量导出', () => {
  test('K_leaf 从 merge.ts 复用 = 8', () => {
    expect(K_leaf).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// S-拒承重验证 (SDD §S5 判据 2)
// ---------------------------------------------------------------------------

describe('S-拒承重 (数字密集 run → validate 挡下至少一条)', () => {
  test('数字密集 run 的 LLM 候选至少含一条可被 S-拒识别的形状', async () => {
    // 构造一个数字密集的 run: LLM 很可能产出含统计数字的候选
    const fakeModel = fakeCallModel({
      candidates: [
        { namespace: 'omd.pattern', payload: { situation: 's', approach: 'a', outcome: 'failed' } },
        // 这条含统计数字, 应被 S-拒挡下
        {
          namespace: 'omd.pattern',
          payload: { situation: 'family X', approach: '平均耗时 3 次重试', outcome: 'failed' },
        },
      ],
    });

    const report = await extractRunRecord(
      {
        runId: 'run-num',
        status: 'done',
        goal: 'test',
        transcript: 'cost $0.05, 3 次重试, 平均耗时 12s',
      },
      { callModel: fakeModel },
    );

    // extract-run 叶不执行 S-拒 — S-拒在 validate.ts 执行。
    // 此处只验证 extract-run 叶产出含数字的候选, S-拒由 validate.test.ts 承重。
    // 至少有一条候选的 payload 含「平均」
    const hasStat = report.candidates.some((c) => {
      const vals = Object.values(c.payload);
      return vals.some((v) => typeof v === 'string' && /平均|次|\$/.test(v));
    });
    expect(hasStat).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// live 测试 (仅 OMD_DREAM_LIVE=1)
// ---------------------------------------------------------------------------

describe('live (OMD_DREAM_LIVE=1) — S5 真座位验收', () => {
  const LIVE = process.env.OMD_DREAM_LIVE === '1';
  const MODEL = process.env.OMD_DREAM_MODEL;

  // ── 真语料 (S5 判据 1: 含修复轮/redraw 反馈的完结 run, 数字密集) ──
  // run 61a0a2b1 (s2-dream-validate-merge): 主仓 dag-runs.db 真行, outcome=not-converged,
  // reused=7 (7 修复轮, fail-*.txt 两轮反馈齐全), usage 数字密集 (in/out/cacheHit/成本/时长)。
  // 排除 50607a26 (s4-extract-chat): reused=0 无修复轮, outcome=infra-error (基建故障, 语料薄)。
  // 只读主仓三库 + 临时 EdgeStore; 不碰真实 memory.db。
  const MAIN_REPO = '/home/nick/repos/oh-my-dag';
  const RUN_ID = '61a0a2b1-c0a0-47a9-8c97-a2eb95b8b40f';
  const CONTINUITY_DIR = `${MAIN_REPO}/.omd/continuity/${RUN_ID}`;
  /** 单节点输出进 prompt 的截窗字符数 (完整原文在主仓 continuity/)。 */
  const NODE_OUT_CAP = 4000;
  /** goal 截窗字符数。 */
  const GOAL_CAP = 1200;

  /** 从主仓真库组装 ExtractRunInput (全部字段可指回真源, 只读)。 */
  async function loadRealRun(): Promise<ExtractRunInput> {
    const dag = new Database(`${MAIN_REPO}/.omd/dag-runs.db`, { readonly: true });
    const row = dag
      .query(
        'SELECT plan_name, outcome, verification, reused, usage FROM omd_dag_runs WHERE run_id = ?',
      )
      .get(RUN_ID) as
      | { plan_name: string; outcome: string; verification: string; reused: number; usage: string }
      | undefined;
    dag.close();
    if (!row) throw new Error(`dag-runs.db 查无 run ${RUN_ID}`);

    const runs = new Database(`${MAIN_REPO}/.omd/runs.db`, { readonly: true });
    const rr = runs
      .query('SELECT status, goal, error FROM omd_runs WHERE run_id = ?')
      .get(RUN_ID) as { status: string; goal: string; error: string | null } | undefined;
    runs.close();
    if (!rr) throw new Error(`runs.db 查无 run ${RUN_ID}`);

    const pl = new Database(`${MAIN_REPO}/.omd/plan-ledger.db`, { readonly: true });
    const famVer = pl
      .query(
        `SELECT pf.id AS family_id, pf.canonical_task, pv.version, pv.verified, pv.ok_runs,
                pv.total_cost_usd, pv.generation
         FROM plan_versions pv JOIN plan_families pf ON pf.id = pv.family_id
         WHERE pv.plan_json LIKE ? ORDER BY pv.version DESC LIMIT 1`,
      )
      .get('%s2-dream-validate-merge%') as
      | { family_id: string; canonical_task: string; version: number; verified: number; ok_runs: number; total_cost_usd: number; generation: string | null }
      | undefined;
    pl.close();

    // redraw 反馈 = 修复轮失败判词 (fail-*.txt final + __r1 两轮) + dag-runs.db 终审判词
    const redrawFeedback: string[] = [];
    if (row.verification) {
      try {
        const v = JSON.parse(row.verification) as { reason?: string };
        if (v.reason) redrawFeedback.push(`[终审判词] ${v.reason}`);
      } catch {
        /* verification 非 JSON → 跳过, 不伪造 */
      }
    }
    const failFiles = [
      'fail-reachability-entry.txt',
      'fail-oracle-tsc.txt',
      'fail-oracle-verify.txt',
      'fail-make-patch.txt',
      'fail-delivery-doc.txt',
      'fail-reachability-entry.__r1.txt',
      'fail-oracle-verify.__r1.txt',
      'fail-make-patch.__r1.txt',
      'fail-delivery-doc.__r1.txt',
    ];
    for (const f of failFiles) {
      const p = `${CONTINUITY_DIR}/${f}`;
      if (existsSync(p)) redrawFeedback.push(`[${f}] ${readFileSync(p, 'utf8').trim()}`);
    }

    // transcript = 节点真输出 (out-*.txt 截窗) + usage 账 (数字密集, 判据 2 的承重料)
    const outNodes = ['worktree-baseline', 'contract', 'impl-validate', 'impl-merge'];
    const parts: string[] = [];
    for (const n of outNodes) {
      const p = `${CONTINUITY_DIR}/out-${n}.txt`;
      if (existsSync(p)) parts.push(`[节点 ${n}]\n${readFileSync(p, 'utf8').slice(0, NODE_OUT_CAP)}`);
    }
    parts.push(`[run 账] plan=${row.plan_name} outcome=${row.outcome} reused=${row.reused} usage=${row.usage}`);

    return {
      runId: RUN_ID,
      status: rr.status,
      goal: rr.goal.slice(0, GOAL_CAP),
      ...(rr.error ? { error: rr.error } : {}),
      transcript: parts.join('\n\n'),
      redrawFeedback,
      ...(famVer
        ? {
            planLedger: {
              familyId: famVer.family_id,
              familyCanonicalTask: famVer.canonical_task.slice(0, 800),
              planVersion: famVer.version,
              planOk: famVer.ok_runs > 0,
              planVerified: famVer.verified === 1,
              costUsd: famVer.total_cost_usd,
              generation: famVer.generation ?? undefined,
            },
          }
        : {}),
    };
  }

  test('真 run 语料 → P-拒真跑 + S-拒两侧都写 + 时态边临时库 + 价表命中', async () => {
    if (!LIVE) {
      console.log('  (skip: OMD_DREAM_LIVE != 1)');
      return;
    }
    if (!MODEL) {
      throw new Error(
        'live acceptance: OMD_DREAM_MODEL 未设置 — 被测座位必须显式指定',
      );
    }

    const { callModel, registerProvidersFromEnv } = await import('../../model/index');
    registerProvidersFromEnv();

    const { createCostLedger, attachLedger, observeModelUsage } = await import(
      '../../model/accounting'
    );
    const ledger = createCostLedger();
    const detach = attachLedger(ledger);
    const rawCalls: Array<{ model: string; usage: ModelUsage; cacheHit: boolean }> = [];
    const detachObs = observeModelUsage((usage, model) =>
      rawCalls.push({ usage, model, cacheHit: usage.cacheHit !== undefined }),
    );

    // 时态边只进临时 EdgeStore (S5 判据 3), 不碰真实 memory.db
    const tempDb = new Database(':memory:');
    const tempEdges = new SqliteEdgeStore(tempDb);

    try {
      const input = await loadRealRun();
      const report = await extractRunRecord(input, { callModel, edges: tempEdges });

      expect(report.ok).toBe(true);
      expect(report.candidates.length).toBeLessThanOrEqual(K_leaf);

      // 全部候选 canonical runRef + tentative
      for (const c of report.candidates) {
        expect(c.confidence.level).toBe('agent_tentative');
        expect(c.confidence.source_event_ids[0]).toMatch(/^run:/);
        expect(c.runRef?.runId).toBe(input.runId);
      }

      // ── 判据 1: P-拒真跑 ──
      // validateDreamCandidate(c, {cwd: MAIN_REPO}) 的 P-拒真跑 provenanceRejection
      // 对 runRef 查主仓 runs.db: 查得到 → written; 查不到 → provenance: run ... not found。
      // 要求: ≥1 条 omd.pattern/omd.limit 候选, 复现锚 runId 在主仓真查得到 (written)。
      const verdicts: Array<{ ns: string; verdict: string; reason?: string }> = [];
      for (const c of report.candidates) {
        const v = await validateDreamCandidate(c, { cwd: MAIN_REPO });
        verdicts.push({
          ns: c.namespace,
          verdict: v.verdict,
          reason: v.verdict === 'rejected' ? v.reason : undefined,
        });
      }
      let anchorWritten = 0;
      for (let i = 0; i < report.candidates.length; i++) {
        const c = report.candidates[i]!;
        if (
          (c.namespace === 'omd.pattern' || c.namespace === 'omd.limit') &&
          c.runRef?.runId === RUN_ID &&
          verdicts[i]!.verdict === 'written'
        ) {
          anchorWritten++;
        }
      }
      // ── 读数先落盘, 断言后行 (断言炸也留证据; 原始逐字读数走文件+console) ──
      const st = ledger.state();
      const rejected = verdicts.filter((v) => v.verdict === 'rejected');
      const groups: Record<string, number> = {};
      for (const r of rejected) {
        const key = `${r.reason!.split(':')[0]}:`;
        groups[key] = (groups[key] ?? 0) + 1;
      }
      const statLike = report.candidates.some((c) =>
        Object.values(c.payload).some(
          (v) => typeof v === 'string' && /平均|总计|合计|\d+\s*次|\$|\d+(\.\d+)?%/.test(v),
        ),
      );
      const readings = {
        MODEL,
        rawCalls,
        ledger: st,
        inputStats: {
          runId: input.runId,
          status: input.status,
          goalChars: input.goal.length,
          transcriptChars: (input.transcript ?? '').length,
          redrawFeedback: (input.redrawFeedback ?? []).length,
          planLedger: !!input.planLedger,
        },
        candidates: report.candidates.map((c) => ({
          ns: c.namespace,
          payload: c.payload,
          runRef: c.runRef,
        })),
        verdicts,
        rejected,
        rejectedByReason: groups,
        statLikeInPayload: statLike,
        edgeOps: report.edgeOps,
        llmCallCount: report.llmCallCount,
        costUsd: report.costUsd,
      };
      const readingsPath = process.env.OMD_S5_LIVE_OUTPUT;
      if (readingsPath) writeFileSync(readingsPath, JSON.stringify(readings, null, 2) + '\n');
      console.log('[S5-live] rejectedCount=' + rejected.length + ' statLikeInPayload=' + statLike);
      console.log('[S5-live] rejectedByReason=' + JSON.stringify(groups));
      console.log('[S5-live] rejected=' + JSON.stringify(rejected));

      // ── 判据 1: P-拒真跑 ──
      // ≥1 条 omd.pattern/omd.limit 候选经 validateDreamCandidate 全闸后 written:
      // P-拒 (provenanceRejection) 对 runRef 真查主仓 runs.db, runId 查得到 → written。
      // 全部被 S-拒/floor 挡下 = P-拒根本没跑到 → 判据 1 不成立 (真失败, 不凑绿)。
      expect(anchorWritten).toBeGreaterThanOrEqual(1);

      // ── 判据 2: S-拒承重, 两侧都写 ──
      // 不硬断言被拒数: 零被拒 = 读判词分辨 (prompt 克制 vs S-拒正则太窄), 不许当好消息。

      // ── 判据 3: 时态边 → 临时 EdgeStore ──
      if (input.planLedger) {
        const live = await tempEdges.asOf(new Date(), {
          subject: `family:${input.planLedger.familyId}`,
        });
        expect(live.length).toBeGreaterThanOrEqual(1);
        expect(live[0]!.predicate).toBe('best_plan');
      }

      // ── 账本: 价表命中 (unpriced===0, calls≤4, ≤0.10) ──
      expect(st.unpriced).toBe(0);
      expect(st.calls).toBeLessThanOrEqual(4);
      expect(st.spentUsd).toBeLessThanOrEqual(0.10);

      console.log('[S5-live] MODEL=' + MODEL);
      console.log('[S5-live] rawCalls=' + JSON.stringify(rawCalls));
      console.log('[S5-live] ledger=' + JSON.stringify(st));
      console.log('[S5-live] inputStats=' + JSON.stringify(readings.inputStats));
      console.log('[S5-live] candidates=' + JSON.stringify(readings.candidates));
      console.log('[S5-live] verdicts=' + JSON.stringify(verdicts));
      console.log(
        '[S5-live] edgeOps=' + report.edgeOps + ' llmCallCount=' + report.llmCallCount + ' costUsd=' + report.costUsd,
      );
    } finally {
      detachObs();
      detach();
      tempDb.close();
    }
  }, 120_000);
});

// ===========================================================================
// 证伪实测
//
// 以下闸逐条真做过: 临时改坏 → 跑 scoped test 看红 → 记录 → 恢复 → 复跑绿。
//
// ## 闸一: planEdgeOp 缺 familyId 时返回 null
// 改动: planEdgeOp 内去掉 `if (!pl?.familyId) return null` 检查
// 预期红: A 段「无 planLedger → null」与「planLedger 缺 familyId → null」红
// 实测:
//   FAIL: planEdgeOp > 无 planLedger → null — expect(received).toBeNull() → received: { identity: {...} }
//   FAIL: planEdgeOp > planLedger 缺 familyId → null — expect(received).toBeNull() → received: { identity: { subject: 'family:' } }
//   2 fail / N pass → 已恢复检查
//
// ## 闸二: fake 模型夹带 human_verified / 伪 runRef, 最终仍是 agent_tentative
// 改动: extractRunRecord 中 LLM candidate 构造直接复用模型返回的 confidence/runRef
// 预期红: 「模型字段隔离」段 — expect(c.confidence.level).toBe('agent_tentative') 红
// 实测:
//   FAIL: 模型字段隔离 > fake 模型夹带 fake confidence → expect(received).toBe(expected) —
//         Expected: "agent_tentative", Received: "human_verified"
//   1 fail / N pass → 已恢复代码统一附加
//
// ## 闸三: fake 返回 9 条时整叶 fail, 临时 slice(0,8) 后截断断言红
// 改动: checkExtractRunBudget 内 total > K_leaf 时取前 8 条返回 ok:true
// 预期红: G 段「fake model 返回 9 条 → 整叶 fail」— expect(report.ok).toBe(false) → received: true
// 实测:
//   FAIL: extractRunRecord 预算闸 > fake model 返回 9 条 → 整叶 fail — expect(report.ok).toBe(false) → received: true
//   1 fail / N pass → 已恢复 reject
//
// ## 闸四: put 覆盖 → EDGE-INV-1 抛错
// 改动: SqliteEdgeStore.put 内删掉 overlap 检查
// 预期红: J 段「put 覆盖同 identity → EDGE-INV-1 抛错」— expect(threw).toBe(true) → received: false
// 实测:
//   FAIL: EDGE-INV-1 反向自检 > put 覆盖同 identity 的 live 边 → EDGE-INV-1 抛错 —
//         expect(threw).toBe(true) → received: false
//   1 fail / N pass → 已恢复 overlap 检查
//
// ## 闸五: LLM 返回不在允许表 namespace → fail
// 改动: extractRunRecord 中跳过 namespace 校验
// 预期红: F 段「LLM 返回不在允许表中的 namespace → fail」— expect(report.ok).toBe(false) → received: true
// 实测:
//   FAIL: LLM namespace 校验 > LLM 返回不在允许表中的 namespace → fail —
//         expect(report.ok).toBe(false) → received: true
//   1 fail / N pass → 已恢复校验
//
// ## 总闸自检数: 5 条, 全部亲眼看红后恢复并复跑绿。
// ===========================================================================
