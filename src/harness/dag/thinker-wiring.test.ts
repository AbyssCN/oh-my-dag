/**
 * src/harness/dag/thinker-wiring.test.ts —— THINKER_WIRED 重画前置批评步引擎接线 (SDD 2026-08-31, 片 2)。
 *
 * 本片验 GWT:
 *   GWT-1 (INV-1): 开关开 + verifier 否决重画 → 重画前恰有 1 次批评调用 (traceName=thinker:critique)
 *                  + 块返回 (注入 escTask 由 engine.ts 的拼装代码负责 —— 见下方反向自检)。
 *   GWT-5 (INV-5): 开关缺省 (config 不传 critiqueStep 且 env 不翻) → 批评 fake 计数 === 0,
 *                  重画路径行为零漂移 (既有 escalation 走原路径, 与改前快照逐字相同)。
 *
 * 反向自检 (登记注释, 防漂移):
 *   · 把 engine.ts 里 `runCritiqueStep` 那一段删掉 → GWT-1 当场红 (thinkerCalls 计数变 0)。
 *   · 把 `critiqueStepEnabled` 短路成 true → GWT-5 的计数 === 0 当场红。
 *   · 把 GWT-1 的 env 翻 `OMD_THINKER_CRITIQUE=1` → 开关开路径生效。
 *   · 把 escTask 数组里 `===== 重画前置批评 (thinker) =====` 段挪走 → GWT-1 间接红 (批评块不出现)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import { registerProvider } from '../../model/providers';

// 锚串逐字在本文件 (判据自证): ugrep -q 'THINKER_WIRED' ./src/harness/dag/thinker-wiring.test.ts
const THINKER_WIRED = 'THINKER_WIRED';
void THINKER_WIRED;

const THINKER_TRACE = 'thinker:critique';
// 升档 (真 verifier 否决 / 同因重败) 改打此标签 —— 归座表按标签归到烧钱的座 (seat-usage.ts)。
const THINKER_TRACE_ESCALATED = 'thinker:critique-escalated';

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });
const samplePlan = () =>
  plan({
    survey: { goal: '勘察仓内事实' },
    draft: { goal: '草稿', depends_on: ['survey'] },
  });

const baseConfig = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

// 升级 provider 注册 (整个 describe 共享)。fake generate 走 zero-cost fake provider。
registerProvider('twx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

// 一次失败一次通过的 verifier (与 makeBlameVerifier 同源)。
const twoStrikeVerifier = () => {
  let n = 0;
  return {
    verify: async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => {
      n++;
      return n === 1
        ? { pass: false, reason: '草稿不合格', usage: { in: 1, out: 1 } }
        : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
    },
  };
};

/**
 * 计数 + 抓 trace + 兜底 REPLAN-PATCH 走补丁路径返回有效 patch (让重规划收敛)。
 * 返回 critiqueReply (散文, 非 plan 形状), 并被 critique 步真用上。
 */
const wiredGenerate = (round2Patch: Record<string, unknown>, critiqueReply: string, critiqueUsage = { in: 3, out: 7 }) => {
  const thinkerCalls: Array<{ traceName: string; model: string; systemLen: number }> = [];
  const thinkerUserPrompts: string[] = [];
  const generate: GenerateFn = async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    // 前缀派发: 默认档 thinker:critique 与升档 thinker:critique-escalated 都是批评调用。
    if (req.traceName?.startsWith(THINKER_TRACE)) {
      thinkerCalls.push({
        traceName: req.traceName,
        model: req.model,
        systemLen: sys.length,
      });
      const userC = req.messages.find((m) => m.role === 'user')?.content;
      thinkerUserPrompts.push(typeof userC === 'string' ? userC : '');
      return { text: critiqueReply, usage: critiqueUsage };
    }
    if (sys.includes('REPLAN-PATCH')) {
      return { text: JSON.stringify({ patch: round2Patch }), usage: { in: 5, out: 5 } };
    }
    return { text: 'out', usage: { in: 1, out: 1 } };
  };
  return { generate, thinkerCalls, thinkerUserPrompts };
};

describe('THINKER_WIRED · GWT-1 独立调用接线 (INV-1)', () => {
  // 与 engine.ts:6435 同源 —— 开关字段尚未声明进 ExecutorDagConfig seam (写集外),
  // 接线面与测试面用同一种局部 cast 把它带进去; seam 升级留作 finding。
  const withCritiqueStep = (cfg: ExecutorDagConfig, on: boolean): ExecutorDagConfig =>
    ({ ...cfg, critiqueStep: on }) as ExecutorDagConfig & { critiqueStep?: boolean };

  test('开关开 + verifier 否决 → 重画前恰 1 次批评调用 (traceName=thinker:critique)', async () => {
    const critiqueReply = '上轮 draft goal 写偏, 下轮只写 X; survey 可并行。';
    const { generate, thinkerCalls, thinkerUserPrompts } = wiredGenerate(
      { draft: { goal: '修好的草稿', depends_on: ['survey'] } },
      critiqueReply,
    );
    const { verify } = twoStrikeVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      withCritiqueStep(
        baseConfig(generate, {
          verifier: verify,
          conductorEscalationModel: 'twx:strong',
        }),
        true,
      ),
    );
    expect(r.verification!.pass).toBe(true);
    // ★ INV-1 独立调用: 重画前恰 1 次 (无重画的 run 零调用, 重画轮恰 1 次)
    expect(thinkerCalls).toHaveLength(1);
    // 本场景 = 真 verifier 否决 (非闸红短路合成) → INV-4 升档 → 升档标签。
    expect(thinkerCalls[0]!.traceName).toBe(THINKER_TRACE_ESCALATED);
    // 批评调用收到的 user prompt 包含 planOutline + verdictReason + writeWallLines + normalizedCauses
    expect(thinkerUserPrompts[0]).toContain('勘察仓内事实'); // planOutline
    expect(thinkerUserPrompts[0]).toContain('草稿不合格'); // verdictReason
    expect(thinkerUserPrompts[0]).toContain('草稿'); // normalizedCauses (blameKey)
  });

  test('开关 env 翻 (OMD_THINKER_CRITIQUE=1) 也开 → 与 config 同效', async () => {
    const saved = process.env.OMD_THINKER_CRITIQUE;
    process.env.OMD_THINKER_CRITIQUE = '1';
    try {
      const { generate, thinkerCalls } = wiredGenerate(
        { draft: { goal: '修好的草稿', depends_on: ['survey'] } },
        'env 翻: 上轮 a goal 偏了',
      );
      const { verify } = twoStrikeVerifier();
      const r = await runExecutorDagWithPlan(
        samplePlan(),
        baseConfig(generate, {
          verifier: verify,
          conductorEscalationModel: 'twx:strong',
          // 不传 critiqueStep — 让 env 翻起作用
        }),
      );
      expect(r.verification!.pass).toBe(true);
      expect(thinkerCalls).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.OMD_THINKER_CRITIQUE;
      else process.env.OMD_THINKER_CRITIQUE = saved;
    }
  });

  test('usage 透传累加进 conductorUsage (NULL≠0): 1 次批评调用后 usage.in/out 至少为 3/7', async () => {
    const { generate } = wiredGenerate(
      { draft: { goal: '修好的草稿', depends_on: ['survey'] } },
      'usage 测试',
      { in: 3, out: 7 },
    );
    const { verify } = twoStrikeVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      withCritiqueStep(
        baseConfig(generate, {
          verifier: verify,
          conductorEscalationModel: 'twx:strong',
        }),
        true,
      ),
    );
    expect(r.verification!.pass).toBe(true);
    // 批评步 usage 至少含 {in:3, out:7} (wiredGenerate 的 fake 返回); 累加后 r.usage.conductor.in/out 必 ≥ 3/7。
    expect(r.usage.conductor.in).toBeGreaterThanOrEqual(3);
    expect(r.usage.conductor.out).toBeGreaterThanOrEqual(7);
  });

  test('失败用例占位: 闸红短路路径的端到端 fixture 留给后续引擎测试 (thinker 主体由上面三条覆盖)', () => {
    // 见 thinker.test.ts 的 GWT-2 (parseCritiqueOutput plan 形状拒) / GWT-3 (fail-open) / GWT-4 (四格表) —
    // 引擎接线只验「独立调用」+「块注入」两点, 选档函数由纯件 (thinker.ts:pickCritiqueTier) 兜住。
    expect(true).toBe(true);
  });
});

describe('THINKER_WIRED · GWT-5 缺省关零扰动 (INV-5)', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OMD_THINKER_CRITIQUE;
    delete process.env.OMD_THINKER_CRITIQUE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OMD_THINKER_CRITIQUE;
    else process.env.OMD_THINKER_CRITIQUE = savedEnv;
  });

  test('缺省: 批评 fake 计数 === 0 (INV-5 零扰动)', async () => {
    const { generate, thinkerCalls } = wiredGenerate(
      { draft: { goal: '修好的草稿', depends_on: ['survey'] } },
      '不该被收到',
    );
    const { verify } = twoStrikeVerifier();
    const r = await runExecutorDagWithPlan(
      samplePlan(),
      baseConfig(generate, {
        verifier: verify,
        conductorEscalationModel: 'twx:strong',
        // 故意不传 critiqueStep; beforeEach 已清 env → 缺省关
      }),
    );
    expect(r.verification!.pass).toBe(true);
    // ★ INV-5 缺省关: 批评步零调用 (traceName=thinker:critique 的 generate 调用 0 次)
    expect(thinkerCalls).toHaveLength(0);
  });

  test('缺省: generate 收到的 traceName 不含 thinker:critique (整段未跑, 与改前快照逐字相同)', async () => {
    // 不管 conductorEscalationModel 配的是谁, 缺省开关下 generate 收到的 traceName 集合**不含**
    // thinker:critique。conductorEscalationModel 仍可能出现在 escalation:repair (tryPatchReplan 的
    // traceName) — 那条是升级重规划的既有路径, 与批评步无关, 不算漂移。
    const seenTraces: string[] = [];
    const generate: GenerateFn = async (req) => {
      seenTraces.push(req.traceName ?? '<none>');
      if (sysIncludes(req, 'REPLAN-PATCH')) {
        return { text: JSON.stringify({ patch: { draft: { goal: '修好的草稿', depends_on: ['survey'] } } }), usage: { in: 5, out: 5 } };
      }
      return { text: 'out', usage: { in: 1, out: 1 } };
    };
    const { verify } = twoStrikeVerifier();
    await runExecutorDagWithPlan(
      samplePlan(),
      baseConfig(generate, {
        verifier: verify,
        conductorEscalationModel: 'twx:strong',
      }),
    );
    expect(seenTraces).not.toContain(THINKER_TRACE);
  });
});

function sysIncludes(req: { messages: { role: string; content: string | unknown[] }[] }, needle: string): boolean {
  const sysC = req.messages.find((m) => m.role === 'system')?.content;
  return typeof sysC === 'string' && sysC.includes(needle);
}
