import { describe, expect, test } from 'bun:test';
import { DagScheduler, type DagSchedulerOpts, type SchedKind } from './dag-scheduler';
import type { ConductorPlan } from '../conductor-plan';

// 调度语义的**穷举表征测试**: 纯同步、零 mock、零 async、零 LLM。
// 这些规则以前只能连着真跑一张图 (fake generate + 定时器) 才验得到, 抽出调度器后可以直接断言。

type NodeSpec = { executor?: string; model?: string; depends_on?: string[]; requires?: 'all' | 'any' | number };

const mkPlan = (nodes: Record<string, NodeSpec>): ConductorPlan =>
  ({ name: 'sched-test', nodes } as unknown as ConductorPlan);

/** executor-dag 里 schedKind 的同一条规则 (command→command / agent→agent / 其余→inproc)。 */
const kindOfPlan =
  (nodes: Record<string, NodeSpec>) =>
  (id: string): SchedKind => {
    const e = nodes[id]?.executor;
    if (e === 'command') return 'command';
    if (e === 'agent') return 'agent';
    return 'inproc';
  };

/** executor-dag 里 schedChannel 的同一条规则 (command→null, 其余取 model 的 `:` 前缀)。 */
const channelOfPlan =
  (nodes: Record<string, NodeSpec>, leafModel = 'deep:flash') =>
  (id: string): string | null => {
    const n = nodes[id];
    if (n?.executor === 'command') return null;
    const model = n?.model ?? leafModel;
    const sep = model.indexOf(':');
    return sep >= 0 ? model.slice(0, sep) : model;
  };

/** 建一个调度器 + 一张可变的 status 表 (模拟 executor-dag 的 results)。 */
const mk = (
  nodes: Record<string, NodeSpec>,
  extra: Partial<DagSchedulerOpts> = {},
): { sched: DagScheduler; status: Record<string, string> } => {
  const status: Record<string, string> = {};
  const plan = mkPlan(nodes);
  const sched = new DagScheduler(plan, {
    kindOf: kindOfPlan(nodes),
    channelOf: channelOfPlan(nodes),
    statusOf: (id) => status[id],
    ...extra,
  });
  return { sched, status };
};

/** 反复 takeRunnable 直到 null, 收派发顺序 (不 release → 观察闸)。 */
const drainRunnable = (sched: DagScheduler): string[] => {
  const out: string[] = [];
  for (;;) {
    const id = sched.takeRunnable();
    if (id == null) return out;
    out.push(id);
  }
};

describe('DagScheduler 拓扑推进', () => {
  test('链 a→b→c: 初始只有 a 就绪, advance 逐段释放', () => {
    const { sched } = mk({
      a: {},
      b: { depends_on: ['a'] },
      c: { depends_on: ['b'] },
    });
    expect(sched.size).toBe(3);
    expect(sched.readyCount).toBe(1);
    expect(sched.takeRunnable()).toBe('a');
    expect(sched.advance('a')).toEqual(['b']);
    expect(sched.advance('b')).toEqual(['c']);
    expect(sched.advance('c')).toEqual([]);
  });

  test('多 dep: indeg 只在减到 0 时入 ready (半数依赖完成不放行)', () => {
    const { sched } = mk({ a: {}, b: {}, sink: { depends_on: ['a', 'b'] } });
    expect(sched.readyCount).toBe(2);
    expect(sched.advance('a')).toEqual([]); // sink 还欠 b
    expect(sched.readyCount).toBe(2); // a/b 都没被摘 (advance 不动 ready 里的既有项)
    expect(sched.advance('b')).toEqual(['sink']);
  });

  test('dependentsOf 给出直接下游 (fan-in 摘要数 consumer 用)', () => {
    const { sched } = mk({ a: {}, x: { depends_on: ['a'] }, y: { depends_on: ['a'] }, z: {} });
    expect([...sched.dependentsOf('a')].sort()).toEqual(['x', 'y']);
    expect(sched.dependentsOf('z')).toEqual([]);
  });

  test('幻象 dep (指向不存在的 id) 视为已满足 → 立即就绪', () => {
    const { sched } = mk({ a: { depends_on: ['nobody'] }, b: { depends_on: ['a', 'ghost'] } });
    expect(sched.readyCount).toBe(1); // a 就绪 (幻象 dep 不计 indeg), b 只欠真 dep a
    expect(sched.takeRunnable()).toBe('a');
    expect(sched.advance('a')).toEqual(['b']);
  });
});

describe('DagScheduler 并发闸', () => {
  test('maxFanout=1 串行化: 第二个必须等 release', () => {
    const { sched } = mk({ a: {}, b: {}, c: {} }, { maxFanout: 1 });
    expect(sched.takeRunnable()).toBe('a');
    expect(sched.runningCount).toBe(1);
    expect(sched.takeRunnable()).toBeNull();
    sched.release('a');
    expect(sched.runningCount).toBe(0);
    expect(sched.takeRunnable()).toBe('b');
  });

  test('maxFanout 缺省 = 图宽 (不是无穷, 也不是 1)', () => {
    const { sched } = mk({ a: {}, b: {}, c: {} });
    expect(drainRunnable(sched)).toEqual(['a', 'b', 'c']);
    expect(sched.runningCount).toBe(3);
  });

  test('maxFanout ≤0 视为未配 (退回图宽)', () => {
    const { sched } = mk({ a: {}, b: {} }, { maxFanout: 0 });
    expect(drainRunnable(sched)).toEqual(['a', 'b']);
  });

  test('per-kind 闸: agent=1 卡住 agent, inproc 不受连累', () => {
    const nodes: Record<string, NodeSpec> = {
      a0: { executor: 'agent' },
      a1: { executor: 'agent' },
      p0: { executor: 'leaf' },
      p1: { executor: 'leaf' },
    };
    const { sched } = mk(nodes, { kindFanout: { agent: 1 } });
    expect(drainRunnable(sched)).toEqual(['a0', 'p0', 'p1']); // a1 被 agent 闸挡在 ready 里
    expect(sched.readyCount).toBe(1);
    sched.release('a0');
    expect(sched.takeRunnable()).toBe('a1');
  });

  test('per-kind 闸缺省 +∞: 未配 kindFanout → 全宽 (零回归)', () => {
    const nodes: Record<string, NodeSpec> = {
      a0: { executor: 'agent' },
      a1: { executor: 'agent' },
      c0: { executor: 'command' },
      c1: { executor: 'command' },
    };
    const { sched } = mk(nodes);
    expect(drainRunnable(sched)).toEqual(['a0', 'a1', 'c0', 'c1']);
  });

  test('per-kind 闸只锁本 kind: command=1 不影响 agent', () => {
    const nodes: Record<string, NodeSpec> = {
      c0: { executor: 'command' },
      c1: { executor: 'command' },
      a0: { executor: 'agent' },
    };
    const { sched } = mk(nodes, { kindFanout: { command: 1 } });
    expect(drainRunnable(sched)).toEqual(['c0', 'a0']);
  });

  test('per-channel 闸: 同 provider 前缀共享闸, 别的渠道照跑', () => {
    const nodes: Record<string, NodeSpec> = {
      x0: { model: 'x:big' },
      x1: { model: 'x:small' }, // 同渠道 x (前缀相同, 型号不同)
      y0: { model: 'y:big' },
    };
    const { sched } = mk(nodes, { channelFanout: { x: 1 } });
    expect(drainRunnable(sched)).toEqual(['x0', 'y0']);
    sched.release('x0');
    expect(sched.takeRunnable()).toBe('x1');
  });

  test('per-channel 闸: 未配 channelFanout → 恒不挡 (零回归)', () => {
    const nodes: Record<string, NodeSpec> = { x0: { model: 'x:a' }, x1: { model: 'x:b' }, x2: { model: 'x:c' } };
    const { sched } = mk(nodes);
    expect(drainRunnable(sched)).toEqual(['x0', 'x1', 'x2']);
  });

  test('per-channel 闸: 配了但没这一格 → 该渠道不限', () => {
    const nodes: Record<string, NodeSpec> = { x0: { model: 'x:a' }, x1: { model: 'x:b' } };
    const { sched } = mk(nodes, { channelFanout: { y: 1 } });
    expect(drainRunnable(sched)).toEqual(['x0', 'x1']);
  });

  test('command 节点不入渠道闸 (无模型)', () => {
    const nodes: Record<string, NodeSpec> = {
      c0: { executor: 'command' },
      c1: { executor: 'command' },
      x0: { model: 'x:a' },
      x1: { model: 'x:b' },
    };
    const { sched } = mk(nodes, { channelFanout: { x: 1 } });
    expect(drainRunnable(sched)).toEqual(['c0', 'c1', 'x0']); // command 全放行, x 渠道只过 1 个
  });

  test('节点无 model → 落到 leafModel 的渠道 (缺省值由调用方传进来)', () => {
    const nodes: Record<string, NodeSpec> = { n0: {}, n1: {} }; // channelOfPlan 的 leafModel = 'deep:flash'
    const { sched } = mk(nodes, { channelFanout: { deep: 1 } });
    expect(drainRunnable(sched)).toEqual(['n0']);
  });

  test('双闸叠加: kind 与 channel 各自独立生效, 谁先满谁挡', () => {
    const nodes: Record<string, NodeSpec> = {
      a0: { executor: 'agent', model: 'x:m' },
      a1: { executor: 'agent', model: 'y:m' }, // 被 agent 闸挡
      p0: { executor: 'leaf', model: 'x:m' }, // 被 x 渠道闸挡
      p1: { executor: 'leaf', model: 'y:m' }, // 两闸都过
    };
    const { sched } = mk(nodes, { kindFanout: { agent: 1 }, channelFanout: { x: 1 } });
    expect(drainRunnable(sched)).toEqual(['a0', 'p1']);
    sched.release('a0'); // 同时松开 agent 闸和 x 渠道闸
    expect(drainRunnable(sched)).toEqual(['a1', 'p0']);
  });

  test('非严格 FIFO: 被闸挡住的节点让位给后面能跑的', () => {
    const nodes: Record<string, NodeSpec> = {
      a0: { executor: 'agent' },
      a1: { executor: 'agent' },
      p0: { executor: 'leaf' },
    };
    const { sched } = mk(nodes, { kindFanout: { agent: 1 } });
    expect(sched.takeRunnable()).toBe('a0');
    expect(sched.takeRunnable()).toBe('p0'); // 越过队首的 a1 (若是严格 shift 这里会是 null)
    expect(sched.readyCount).toBe(1);
  });

  test('release 与 takeRunnable 配对: 重复 release 不把计数做负', () => {
    const { sched } = mk({ a: {}, b: {} }, { maxFanout: 1 });
    expect(sched.takeRunnable()).toBe('a');
    sched.release('a');
    sched.release('a'); // 第二次是空操作
    expect(sched.runningCount).toBe(0);
    expect(sched.takeRunnable()).toBe('b');
    expect(sched.runningCount).toBe(1);
  });
});

describe('DagScheduler quorum 判定 (D-7v2)', () => {
  test('零依赖节点永不 skip', () => {
    const { sched } = mk({ a: {}, b: {} });
    expect(sched.takeSkippable()).toBeNull();
  });

  test("缺省启发: 单依赖 = 'all' (依赖 failed → skip)", () => {
    const { sched, status } = mk({ a: {}, b: { depends_on: ['a'] } });
    sched.takeRunnable();
    status['a'] = 'failed';
    sched.advance('a');
    const sk = sched.takeSkippable();
    expect(sk?.id).toBe('b');
    expect(sk?.verdict).toEqual({ requires: 'all', done: 0, deps: ['a'], bad: ['a(failed)'] });
    expect(sched.readyCount).toBe(0); // 已从 ready 摘掉
  });

  test("缺省启发: 多依赖 = 'any' (一个 done 就够)", () => {
    const { sched, status } = mk({ a: {}, b: {}, sink: { depends_on: ['a', 'b'] } });
    status['a'] = 'done';
    status['b'] = 'failed';
    sched.advance('a');
    sched.advance('b');
    expect(sched.takeSkippable()).toBeNull(); // any 达标
  });

  test("'any' 全挂 → skip, bad 列出每个依赖的状态", () => {
    const { sched, status } = mk({ a: {}, b: {}, sink: { depends_on: ['a', 'b'] } });
    status['a'] = 'failed';
    status['b'] = 'skipped';
    sched.advance('a');
    sched.advance('b');
    const sk = sched.takeSkippable();
    expect(sk?.id).toBe('sink');
    expect(sk?.verdict).toEqual({ requires: 'any', done: 0, deps: ['a', 'b'], bad: ['a(failed)', 'b(skipped)'] });
  });

  test("显式 'all': 多依赖里挂一个就 skip", () => {
    const { sched, status } = mk({ a: {}, b: {}, sink: { depends_on: ['a', 'b'], requires: 'all' } });
    status['a'] = 'done';
    status['b'] = 'failed';
    sched.advance('a');
    sched.advance('b');
    const sk = sched.takeSkippable();
    expect(sk?.verdict.requires).toBe('all');
    expect(sk?.verdict.done).toBe(1);
    expect(sk?.verdict.bad).toEqual(['b(failed)']);
  });

  test('数字 K: done ≥ K 才放行 (best-of-N 至少 K 候选)', () => {
    const nodes: Record<string, NodeSpec> = {
      a: {},
      b: {},
      c: {},
      judge: { depends_on: ['a', 'b', 'c'], requires: 2 },
    };
    const { sched, status } = mk(nodes);
    status['a'] = 'done';
    status['b'] = 'failed';
    status['c'] = 'failed';
    sched.advance('a');
    sched.advance('b');
    sched.advance('c');
    const sk = sched.takeSkippable();
    expect(sk?.verdict).toEqual({ requires: 2, done: 1, deps: ['a', 'b', 'c'], bad: ['b(failed)', 'c(failed)'] });

    // 再来一张同图, 这次 2 个 done → 恰好达标, 不 skip
    const two = mk(nodes);
    two.status['a'] = 'done';
    two.status['b'] = 'done';
    two.status['c'] = 'failed';
    two.sched.advance('a');
    two.sched.advance('b');
    two.sched.advance('c');
    expect(two.sched.takeSkippable()).toBeNull();
  });

  test('还没结果的依赖记作 `?` (未 done)', () => {
    const { sched, status } = mk({ a: {}, b: {}, sink: { depends_on: ['a', 'b'], requires: 'all' } });
    status['a'] = 'done';
    sched.advance('a');
    sched.advance('b'); // b 没写 status → statusOf 返 undefined
    const sk = sched.takeSkippable();
    expect(sk?.verdict.bad).toEqual(['b(?)']);
  });

  test('幻象 dep 不进 quorum 分母', () => {
    const { sched, status } = mk({ a: {}, b: { depends_on: ['a', 'ghost'], requires: 'all' } });
    status['a'] = 'done';
    sched.advance('a');
    expect(sched.takeSkippable()).toBeNull(); // deps 只算 a, all 已达标
  });

  test('takeSkippable 不记账 (skip 不占 worker 槽)', () => {
    const { sched, status } = mk({ a: {}, b: { depends_on: ['a'] } });
    status['a'] = 'failed';
    sched.advance('a');
    sched.takeSkippable();
    expect(sched.runningCount).toBe(0);
  });

  test('skip 链级联: 每次 take 一个, 配合 advance 把整条链摘干净', () => {
    const { sched, status } = mk({
      a: {},
      b: { depends_on: ['a'] },
      c: { depends_on: ['b'] },
    });
    expect(sched.takeRunnable()).toBe('a'); // a 真跑了一发
    sched.release('a');
    status['a'] = 'failed';
    sched.advance('a');
    const s1 = sched.takeSkippable()!;
    expect(s1.id).toBe('b');
    status['b'] = 'skipped';
    sched.advance('b');
    const s2 = sched.takeSkippable()!;
    expect(s2.id).toBe('c');
    status['c'] = 'skipped';
    sched.advance('c');
    expect(sched.takeSkippable()).toBeNull();
    expect(sched.isDrained()).toBe(true);
  });
});

describe('DagScheduler 收敛判据', () => {
  test('isDrained: ready 空 且 running 0 才算收敛', () => {
    const { sched } = mk({ a: {}, b: { depends_on: ['a'] } });
    expect(sched.isDrained()).toBe(false); // ready 有 a
    const id = sched.takeRunnable()!;
    expect(sched.isDrained()).toBe(false); // ready 空但 a 在飞
    sched.release(id);
    // ⚠ release 与 advance 之间是**瞬态**的"假收敛" (ready 空 + running 0)。真引擎里 settle→advance
    // 紧跟 release 同步发生, pump 观察不到这一刻 —— 这里显式钉住它, 免得日后有人把 advance 挪到 await 后。
    expect(sched.isDrained()).toBe(true);
    sched.advance('a');
    expect(sched.isDrained()).toBe(false); // b 入 ready
    const id2 = sched.takeRunnable()!;
    expect(id2).toBe('b');
    sched.release(id2);
    sched.advance('b');
    expect(sched.isDrained()).toBe(true);
  });

  test('被闸全挡住时不算收敛 (ready 非空)', () => {
    const { sched } = mk({ a: {}, b: {} }, { maxFanout: 1 });
    sched.takeRunnable();
    expect(sched.takeRunnable()).toBeNull();
    expect(sched.isDrained()).toBe(false);
  });
});

describe('DagScheduler 暖发挑节点', () => {
  test('挑第一个非 command 的就绪节点, 且不记账', () => {
    const nodes: Record<string, NodeSpec> = {
      c0: { executor: 'command' },
      c1: { executor: 'command' },
      p0: { executor: 'leaf' },
      a0: { executor: 'agent' },
    };
    const { sched } = mk(nodes);
    expect(sched.takeWarmStart()).toBe('p0'); // 跳过队首两个 command
    expect(sched.runningCount).toBe(0);
    expect(sched.readyCount).toBe(3); // 已摘出 ready
  });

  test('整层都是 command → 返 null (不暖, 也不摘任何节点)', () => {
    const nodes: Record<string, NodeSpec> = {
      c0: { executor: 'command' },
      c1: { executor: 'command' },
      later: { executor: 'leaf', depends_on: ['c0'] }, // 非 command 但没就绪 → 不算
    };
    const { sched } = mk(nodes);
    expect(sched.takeWarmStart()).toBeNull();
    expect(sched.readyCount).toBe(2);
  });

  test('agent 节点也算「真会打模型」(判据只排除 command)', () => {
    const { sched } = mk({ c0: { executor: 'command' }, a0: { executor: 'agent' } });
    expect(sched.takeWarmStart()).toBe('a0');
  });
});
