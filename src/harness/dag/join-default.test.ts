/**
 * S3 片 3 / 契约 INV-7 — join 多依赖缺省 = `all` (JOIN_ALL_DONE_DEFAULT)
 *
 * 起因 (2026-08-27, SDD §8 S3 单一变量行): 多依赖 join 的缺省从「一个 done 就够」(`any`)
 * 翻成「全部 done」(`all`)。合成节点 (synth) 必须看见全部输入, 把「宽扇出」的偏好塞进
 * 缺省会让所有合成节点静默吞失败 —— 翻缺省正是为了把这个代价挪给**显式** `requires: 'any'`。
 *
 * 三条 GWT 直接来自契约:
 *  - 多依赖 + 缺省 → 1 done / 2 failed → 摘成 skipped, runner 不被调
 *  - 多依赖 + 显式 `requires: 'any'` → 同上输入 → 照跑, runner 调 1 次 (逃生门必须还在)
 *  - 单依赖 + 缺省 → 行为与本片实装前逐字相同 (依赖 failed → skipped, failureKind dep-skip)
 *
 * ⚠ 锚串 `JOIN_ALL_DONE_DEFAULT` 必须逐字出现在本测试文件 (反作弊条款 EMPTY MATCH 那条);
 * 删掉它 = 闸空转 = 反向自检 4 咬不出来。
 */
import { describe, expect, test } from 'bun:test';
import { DagScheduler, type DagSchedulerOpts, type SchedKind } from './dag-scheduler';
import type { ConductorPlan } from '../conductor-plan';

type NodeSpec = { executor?: string; model?: string; depends_on?: string[]; requires?: 'all' | 'any' | number };

const mkPlan = (nodes: Record<string, NodeSpec>): ConductorPlan =>
  ({ name: 'join-default-test', nodes } as unknown as ConductorPlan);

const kindOfPlan =
  (nodes: Record<string, NodeSpec>) =>
  (id: string): SchedKind => {
    const e = nodes[id]?.executor;
    if (e === 'command') return 'command';
    if (e === 'agent') return 'agent';
    return 'inproc';
  };

const channelOfPlan =
  (nodes: Record<string, NodeSpec>, leafModel = 'deep:flash') =>
  (id: string): string | null => {
    const n = nodes[id];
    if (n?.executor === 'command') return null;
    const model = n?.model ?? leafModel;
    const sep = model.indexOf(':');
    return sep >= 0 ? model.slice(0, sep) : model;
  };

/** 建调度器 + 可变 status 表。 */
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

/**
 * 模拟真引擎轮: 每轮派发 ready → settle + release + advance → 再派发 → 直到 ready 空。
 * 返回 sink 是否被起跑过 (多次轮里只要起跑过就算), sink 是否被摘出。
 */
const runUntilSettle = (
  sched: DagScheduler,
  sinkId: string,
): { sinkRan: boolean; sinkSkipped: boolean } => {
  let sinkRan = false;
  let sinkSkipped = false;
  for (;;) {
    // 先摘可摘的 (quorum 不达标的)
    const sk = sched.takeSkippable();
    if (sk?.id === sinkId) {
      sinkSkipped = true;
      return { sinkRan, sinkSkipped };
    }
    // 派发所有 ready
    const taken: string[] = [];
    for (;;) {
      const id = sched.takeRunnable();
      if (id == null) break;
      taken.push(id);
      if (id === sinkId) sinkRan = true;
    }
    if (taken.length === 0) break; // 既没摘出也没派发, ready 空, 退出
    for (const id of taken) {
      sched.release(id);
      sched.advance(id);
    }
  }
  // 最后再扫一次 takeSkippable (advance 后可能有新就绪且不达标的)
  const sk2 = sched.takeSkippable();
  if (sk2?.id === sinkId) sinkSkipped = true;
  return { sinkRan, sinkSkipped };
};

describe('JOIN_ALL_DONE_DEFAULT — S3 片 3 / 契约 INV-7', () => {
  test('多依赖 + 缺省 + 1 done / 2 failed → sink 被摘成 skipped, 不被起跑', () => {
    // D-6: 多依赖 join 缺省 = 'all' (全部 done 才放行)
    const { sched, status } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'] }, // 不写 requires → 走缺省
    });
    status['a'] = 'done';
    status['b'] = 'failed';
    status['c'] = 'failed';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkRan, '缺省 all 下 sink 不该被起跑').toBe(false);
    expect(sinkSkipped, '缺省 all 下 sink 必须被摘出').toBe(true);
    // 再确认 verdict 形状: 缺省 = all, done=1, bad 列出 failed deps
    // (takeSkippable 已被 runOnce 消费, 重建一次单独验 verdict)
    const { sched: s2, status: st2 } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'] },
    });
    st2['a'] = 'done';
    st2['b'] = 'failed';
    st2['c'] = 'failed';
    s2.advance('a');
    s2.advance('b');
    s2.advance('c');
    const sk = s2.takeSkippable();
    expect(sk).not.toBeNull();
    expect(sk?.verdict.requires).toBe('all');
    expect(sk?.verdict.done).toBe(1);
    expect(sk?.verdict.bad).toEqual(['b(failed)', 'c(failed)']);
  });

  test('多依赖 + 显式 requires:"any" + 1 done / 2 failed → sink 照跑, 逃生门必须还在', () => {
    // 翻缺省不毁逃生门: 显式 any 仍走老路
    const { sched, status } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'], requires: 'any' },
    });
    status['a'] = 'done';
    status['b'] = 'failed';
    status['c'] = 'failed';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkSkipped, 'requires:"any" 下 sink 不该被摘出 (1 done 达标)').toBe(false);
    expect(sinkRan, 'requires:"any" 下 sink 必须被起跑 (1 次)').toBe(true);
  });

  test('单依赖 + 缺省 + 依赖 failed → sink 被摘成 skipped (行为与本片实装前逐字相同)', () => {
    // 翻多依赖缺省不动单依赖路径: 单依赖缺省一直是 'all'
    const { sched, status } = mk({
      a: {},
      sink: { depends_on: ['a'] }, // 不写 requires → 走缺省
    });
    status['a'] = 'failed';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkRan).toBe(false);
    expect(sinkSkipped).toBe(true);
    // 验 verdict
    const { sched: s2, status: st2 } = mk({
      a: {},
      sink: { depends_on: ['a'] },
    });
    st2['a'] = 'failed';
    s2.advance('a');
    const sk = s2.takeSkippable();
    expect(sk).not.toBeNull();
    expect(sk?.verdict.requires).toBe('all');
    expect(sk?.verdict.done).toBe(0);
    expect(sk?.verdict.bad).toEqual(['a(failed)']);
  });

  test('多依赖 + 缺省 + 全 done → sink 照跑 (不缺省 all 不该误伤达标路径)', () => {
    const { sched, status } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'] },
    });
    status['a'] = 'done';
    status['b'] = 'done';
    status['c'] = 'done';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkSkipped).toBe(false);
    expect(sinkRan).toBe(true);
  });

  test('多依赖 + 缺省 + 0 done → sink 被摘成 skipped, verdict.requires = "all"', () => {
    // 反证: 0 done 在 any 下也不达标 (都 skip), 关键区别 = verdict.requires 是否为 'all'
    const { sched, status } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'] },
    });
    status['a'] = 'failed';
    status['b'] = 'failed';
    status['c'] = 'failed';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkRan).toBe(false);
    expect(sinkSkipped).toBe(true);
    // verdict 验证
    const { sched: s2, status: st2 } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'] },
    });
    st2['a'] = 'failed';
    st2['b'] = 'failed';
    st2['c'] = 'failed';
    s2.advance('a');
    s2.advance('b');
    s2.advance('c');
    const sk = s2.takeSkippable();
    expect(sk?.verdict.requires).toBe('all');
    expect(sk?.verdict.done).toBe(0);
  });

  test('多依赖 + 数字 K=2 + 1 done / 2 failed → sink 被摘成 skipped (1 < K)', () => {
    // 数字 K 与缺省的关系: 显式 requires 不走缺省; 但仍要核 K=2 + 1 done 时是否被摘
    const { sched, status } = mk({
      a: {},
      b: {},
      c: {},
      sink: { depends_on: ['a', 'b', 'c'], requires: 2 },
    });
    status['a'] = 'done';
    status['b'] = 'failed';
    status['c'] = 'failed';
    const { sinkRan, sinkSkipped } = runUntilSettle(sched, "sink");
    expect(sinkRan).toBe(false);
    expect(sinkSkipped).toBe(true);
  });
});