import { describe, expect, test } from 'bun:test';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';

// ready-set 依赖驱动调度 (取代逐层 barrier) 的行为证明 — fake generate, 不碰 live 模型/PG。
// 关键: 旧逐层 barrier 下, 一个节点必须等"同层"所有节点 (含与它无关的慢节点) 才能进下一层;
//       ready-set 下, 节点只等它**真正的 dep**。本测试用确定性时序证明 barrier 已拆。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// slow(root, 120ms) + fast(root, 5ms) + dep(依赖 fast, 5ms)。
// topoLevels = [[slow, fast], [dep]] → 旧 barrier: dep 等 level0 全完 (含 slow 120ms) 才跑。
// ready-set: dep 只依赖 fast → fast 完即跑, 与 slow 并行无关。
const PLAN = JSON.stringify({
  name: 'readyset',
  nodes: {
    slow: { agent: 'x', goal: 'SLOW root' },
    fast: { agent: 'x', goal: 'FAST root' },
    dep: { agent: 'x', goal: 'DEP of fast', depends_on: ['fast'] },
  },
});

describe('executor-dag ready-set 调度 (依赖驱动, 无层 barrier)', () => {
  test('dep 只等真 dep(fast), 不等无关慢节点(slow) — barrier 下此序不可能', async () => {
    const delays: Record<string, number> = { slow: 120, fast: 5, dep: 5 };
    const events: string[] = [];
    const promptOf: Record<string, string> = {};
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: PLAN, usage: { in: 1, out: 1 } };
      const prompt = messages.map((m) => m.content).join('\n');
      const id = prompt.match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
      promptOf[id] = prompt;
      events.push(`${id}:start`);
      await sleep(delays[id] ?? 1);
      events.push(`${id}:end`);
      return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
    };

    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });

    // 全 done
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);

    const i = (e: string): number => events.indexOf(e);
    // 正确性: dep 仅在其真 dep(fast) 完成后才开始 (依赖序不破)
    expect(i('dep:start')).toBeGreaterThan(i('fast:end'));
    // 效率 (ready-set 核心): dep 完成早于无关的 slow — 逐层 barrier 下 dep 必排在 slow 之后, 故此序即"barrier 已拆"的判定
    expect(i('dep:end')).toBeLessThan(i('slow:end'));
    // fan-in 正确: dep 收到 fast 的输出
    expect(promptOf['dep']).toContain('OUT:fast');
  });

  test('maxFanout=1: 串行化仍尊重依赖序 (ready-set 退化为合法拓扑序)', async () => {
    const order: string[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: PLAN, usage: { in: 1, out: 1 } };
      const id = messages.map((m) => m.content).join('\n').match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
      order.push(id);
      return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxFanout: 1 });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    // fast 必在 dep 之前 (依赖序), slow 无约束
    expect(order.indexOf('fast')).toBeLessThan(order.indexOf('dep'));
  });
});
