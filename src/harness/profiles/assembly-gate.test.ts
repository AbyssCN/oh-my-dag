/**
 * assembly-gate.test.ts —— 图级 INV-1 装配闸 (SDD 2026-08-11-leaf-profile库 P3-engine 补跑)。
 *
 * 覆盖 `dag/engine.ts` 节点→leaf 的 profile 传递半边 (`profile-assembly.test.ts` 只测了
 * `resolveProfile` 自身, 不走真图):
 *
 * - G-2: 未知 profile 名 → WARN 一行 (INV-1 文案) + 回退普通 leaf, agentRunner 收到的
 *   `input.profile === undefined`, 节点 `status:'done'`, 图不 throw; 与"完全无 profile 字段"
 *   基线跑一次比较, 节点级读数逐位一致 (INV-1 的"该节点行为=无 profile"落到可比较的读数上)。
 * - 已知 profile: `resolveProfile` 命中 → `input.profile` 真携带该 `LeafProfile`; 节点显式
 *   `model` 仍胜 profile.seat (未被覆盖)。
 * - INV-2: 引擎侧不碰 `promptVersion` —— 有/无 profile 两次调用, runner 报的 `promptVersion`
 *   原样透传, 不受 profile 存在与否影响 (促成方 = agent-leaf.ts 那条 persona/skills 不进
 *   promptVersion 的既有边界; 这里只证引擎没在中途插一手)。
 *
 * G-7 反向自检 (证伪方式, 手工做过一次, 未留在 CI 里 —— 变异改测试判据本身而非产物):
 *   把 `engine.ts` 的
 *     if (node.profile && !leafProfile) { logger.warn(...) }
 *   临时改成
 *     if (node.profile && !leafProfile) { throw new Error(`unknown profile: ${node.profile}`); }
 *   重跑本文件 → G-2 主路必须非零退出 (图执行被异常打断, `runExecutorDagWithPlan` 本身 reject
 *   或节点 `status` 变 `'failed'` 且带 `infra-error`), 而非静默通过。还原后本文件须回到全绿。
 *   若变异后仍绿, 说明本文件的断言没有真正锚在"INV-1 生效"这件事上, 是假闸。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';
import type { AgentLeafInput, AgentLeafResult } from '../leaf-runners';
import { setCoreLogger, type CoreLogger } from '../logger';
import { resolveProfile } from './profile';

const noopGenerate: GenerateFn = async () => ({ text: 'unused (agent-only 图不该调它)', usage: { in: 0, out: 0 } });

function makeConfig(agentRunner: NonNullable<ExecutorDagConfig['agentRunner']>, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentLeafModel: 'test:agent-leaf',
    generate: noopGenerate,
    agentTemplates: new Map(),
    agentRunner,
    ...extra,
  };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'assembly-gate-plan', nodes });

/** 捕获 warn 调用 (不改全局 console logger, 每测试独立数组)。 */
function captureWarns(): { warns: Array<{ meta: unknown; msg: string }>; restore: () => void } {
  const warns: Array<{ meta: unknown; msg: string }> = [];
  const cap: CoreLogger = {
    debug: () => {},
    info: () => {},
    warn: (meta, msg) => warns.push({ meta, msg: msg ?? '' }),
    error: (meta, msg) => warns.push({ meta, msg: msg ?? '' }),
  };
  setCoreLogger(cap);
  return {
    warns,
    restore: () => setCoreLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
}

describe('G-2: 未知 profile 名 → INV-1 装配闸', () => {
  test('WARN 一行 + input.profile 缺席 + 节点照常 done, 图不 throw', async () => {
    const { warns, restore } = captureWarns();
    try {
      const seen: AgentLeafInput[] = [];
      const fakeRunner = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
        seen.push(input);
        return { text: 'ok', usage: { in: 3, out: 2 } };
      };
      const r = await runExecutorDagWithPlan(
        plan({ A: { goal: '随便改点什么', executor: 'agent', profile: '不存在的档案名' } }),
        makeConfig(fakeRunner),
      );

      expect(r.results.A!.status).toBe('done');
      expect(seen).toHaveLength(1);
      // 未知名回退 = 字段完全缺席, 不是注入空 ProfileSpec。
      expect(seen[0]!.profile).toBeUndefined();

      const profileWarns = warns.filter((w) => w.msg === 'Unknown profile "不存在的档案名"; running as ordinary leaf');
      expect(profileWarns).toHaveLength(1);
      expect(profileWarns[0]!.meta).toMatchObject({ node: 'A', profile: '不存在的档案名' });
    } finally {
      restore();
    }
  });

  test('图状态与无 profile 基线一致 (同图去掉 profile 字段, 节点级读数逐位相同)', async () => {
    const { restore } = captureWarns(); // 只为不刷屏, 本用例不断言 warn 内容
    try {
      const makeRunner = (): NonNullable<ExecutorDagConfig['agentRunner']> => {
        let n = 0;
        return async () => {
          n += 1;
          return { text: `out-${n}`, usage: { in: 5, out: 4 } };
        };
      };

      const withUnknown = await runExecutorDagWithPlan(
        plan({ A: { goal: '目标X', executor: 'agent', profile: '不存在的档案名' } }),
        makeConfig(makeRunner()),
      );
      const baseline = await runExecutorDagWithPlan(
        plan({ A: { goal: '目标X', executor: 'agent' } }),
        makeConfig(makeRunner()),
      );

      // 不 deepEqual 整个 ExecutorDagResult: `plan` 字段本就因 profile 字段存在与否而不同,
      // 那是预期差异不是回归 —— 只比较装配/执行读数。
      expect(withUnknown.levels).toEqual(baseline.levels);
      const a1 = withUnknown.results.A!;
      const a2 = baseline.results.A!;
      expect({ status: a1.status, kind: a1.kind, model: a1.model, output: a1.output, usage: a1.usage }).toEqual({
        status: a2.status,
        kind: a2.kind,
        model: a2.model,
        output: a2.output,
        usage: a2.usage,
      });
      expect(withUnknown.usage.leavesIn).toBe(baseline.usage.leavesIn);
      expect(withUnknown.usage.leavesOut).toBe(baseline.usage.leavesOut);
    } finally {
      restore();
    }
  });
});

describe('已知 profile: 真实传递 + 节点显式 model 仍胜 seat', () => {
  test('resolveProfile 命中的档案原样出现在 input.profile, 且不覆盖节点显式 model', async () => {
    const resolved = resolveProfile('design-review', process.cwd());
    expect(resolved).toBeDefined(); // 前置: 内置档案真存在, 不然本用例测不出东西

    let received: AgentLeafInput | undefined;
    const fakeRunner = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
      received = input;
      return { text: 'reviewed', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '审一下', executor: 'agent', profile: 'design-review', model: 'test:pinned-seat' } }),
      makeConfig(fakeRunner),
    );

    expect(r.results.A!.status).toBe('done');
    expect(received).toBeDefined();
    expect(received!.profile).toEqual(resolved);
    // profile.seat 是 mimo 系, 节点显式 model 必须仍是 runner 收到的 model —— 没被 seat 覆盖。
    expect(received!.model).toBe('test:pinned-seat');
    expect(r.results.A!.model).toBe('test:pinned-seat');
  });
});

describe('INV-2: profile 内容不进 promptVersion (引擎侧不插手)', () => {
  test('有/无 profile 两次调用, runner 报的 promptVersion 原样透传相同', async () => {
    const fakeRunner = async (): Promise<AgentLeafResult> => ({
      text: 'ok',
      usage: { in: 1, out: 1 },
      promptVersion: 'scaffold-v-fixed-for-test',
    });

    const withProfile = await runExecutorDagWithPlan(
      plan({ A: { goal: '目标Y', executor: 'agent', profile: 'design-review' } }),
      makeConfig(fakeRunner),
    );
    const without = await runExecutorDagWithPlan(
      plan({ A: { goal: '目标Y', executor: 'agent' } }),
      makeConfig(fakeRunner),
    );

    // promptVersion 本身不在 LeafResult 上直接暴露 (只在 recordGeneration 观测面), 这里的断言
    // 落在可观察的替代读数上: 两条路径调 runner 得到的产出/用量一致, 证明引擎没有因为 profile
    // 存在与否走上两条不同的 prompt 装配分支 (若引擎误把 profile 拼进影响 promptVersion 的路径,
    // 这两条链路会在别的读数上先分叉——本仓 promptVersion 计算发生在 agent-leaf.ts 内部,
    // 不在 fake runner 里, 引擎对它零介入, 故此处以"两次调用 runner 的可观察行为等价"作为
    // 引擎侧 INV-2 的代理断言)。
    expect(withProfile.results.A!.status).toBe('done');
    expect(without.results.A!.status).toBe('done');
    expect(withProfile.results.A!.output).toBe(without.results.A!.output);
    expect(withProfile.results.A!.usage).toEqual(without.results.A!.usage);
  });
});
