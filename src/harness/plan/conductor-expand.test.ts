/**
 * D-B 内容寻址子节点 id + D-D 禁嵌套 (P3 批次 3, 2026-07-29) —— 纯展开逻辑的契约测试。
 *
 * 要钉的核心是一句话: **id 由内容决定, 不由名字决定**。conductor 每次重画都可能给同一件活换个名,
 * 而 per-node checkpoint 是按 id 存的 —— 名字入 id 就会两头出错:
 *   ① 同一件活换了名 → resume 拿不到本该命中的绿 (白跑)
 *   ② 同一个名换了活 → resume 把上次的产物当这次的绿 (**张冠李戴**, 更坏)
 */
import { describe, expect, test } from 'bun:test';
import { expandConductorNode, DEFAULT_MAX_CHILDREN } from './conductor-expand';
import type { ConductorPlan } from '../conductor-plan';

const plan = (nodes: Record<string, unknown>): ConductorPlan =>
  ({ name: 'sub', nodes }) as unknown as ConductorPlan;

/** 三步链: 定契约 → 实装 → 验证。conductor 用自己起的名。 */
const chain = (names: [string, string, string] = ['contract', 'impl', 'verify']): ConductorPlan =>
  plan({
    [names[0]]: { goal: '定契约' },
    [names[1]]: { goal: '实装', executor: 'agent', depends_on: [names[0]] },
    [names[2]]: { goal: '跑闸', executor: 'command', command: 'bun test', depends_on: [names[1]] },
  });

describe('D-B — id 由内容决定, 不由名字决定', () => {
  test('conductor 改名不改内容 → id 逐字不变 (resume 照样命中)', () => {
    const a = expandConductorNode('P', chain(['contract', 'impl', 'verify']));
    const b = expandConductorNode('P', chain(['c1', 'write-endpoint', 'gate']));
    expect(a.status).toBe('ok');
    expect(a.children.map((c) => c.id).sort()).toEqual(b.children.map((c) => c.id).sort());
    // 原名只作审计, 确实被记下来了但不参与 id。
    expect(a.children.map((c) => c.originalId).sort()).not.toEqual(b.children.map((c) => c.originalId).sort());
  });

  test('同名换了活 → id 变 (拿不到旧 checkpoint, 这正是要的 —— 防张冠李戴)', () => {
    const before = expandConductorNode('P', plan({ impl: { goal: '实装 A', executor: 'agent' } }));
    const after = expandConductorNode('P', plan({ impl: { goal: '实装 B', executor: 'agent' } }));
    expect(before.children[0]!.id).not.toBe(after.children[0]!.id);
  });

  test('id 带父前缀 (子节点归属可见, 同 map 的 `parent::key`)', () => {
    for (const c of expandConductorNode('P', chain()).children) expect(c.id.startsWith('P::')).toBe(true);
  });

  test('**上游内容变了不该改 id** —— 那是 D-O inputHashes 的活, 不是 id 的活', () => {
    // 展开只吃子图规格, 压根不吃上游输出 —— 这条用签名保证 (函数没有第三个参数收上游),
    // 这里钉住"同一份子图规格恒等展开", 即展开是纯的。
    const a = expandConductorNode('P', chain());
    const b = expandConductorNode('P', chain());
    expect(a.children.map((c) => c.id)).toEqual(b.children.map((c) => c.id));
  });

  test('依赖被重写成内容寻址 id; 指向子图外的原样保留', () => {
    const r = expandConductorNode('P', plan({
      a: { goal: 'A' },
      b: { goal: 'B', depends_on: ['a', 'outer-upstream'] },
    }));
    const aId = r.children.find((c) => c.originalId === 'a')!.id;
    const b = r.children.find((c) => c.originalId === 'b')!;
    expect(b.node.depends_on).toContain(aId);
    expect(b.node.depends_on).toContain('outer-upstream'); // 外层上游不动
    expect(b.node.depends_on).not.toContain('a'); // 原名不残留
  });

  test('结构完全相同的孪生兄弟 → id 仍互不相同 (best-of-N 的 N 个同 goal 候选)', () => {
    const r = expandConductorNode('P', plan({
      cand1: { goal: '写一版方案' },
      cand2: { goal: '写一版方案' },
      cand3: { goal: '写一版方案' },
    }));
    const ids = r.children.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  test('孪生消歧是确定的 (同一输入两次展开, id 集合逐字相同)', () => {
    const mk = () => plan({ x: { goal: '同' }, y: { goal: '同' } });
    expect(expandConductorNode('P', mk()).children.map((c) => c.id).sort()).toEqual(
      expandConductorNode('P', mk()).children.map((c) => c.id).sort(),
    );
  });
});

describe('D-D — 禁嵌套 (照 INV-U5, D-10「无用例支撑先禁」)', () => {
  test('子节点 executor:conductor → 拒整份子图', () => {
    const r = expandConductorNode('P', plan({ a: { goal: 'A', executor: 'conductor' } }));
    expect(r.status).toBe('nested');
    expect(r.children).toEqual([]);
    expect(r.error).toContain('conductor');
  });

  test('子节点 executor:map → 同样拒 (它多余: conductor 展开时已经知道清单了)', () => {
    const r = expandConductorNode('P', plan({ a: { goal: 'A', executor: 'map' } }));
    expect(r.status).toBe('nested');
  });

  test('一个坏节点拒**整份**子图, 不是只丢那一个 (fail-closed)', () => {
    const r = expandConductorNode('P', plan({ ok: { goal: '正常' }, bad: { goal: 'B', executor: 'conductor' } }));
    expect(r.status).toBe('nested');
    expect(r.children).toEqual([]);
  });
});

describe('子图形状闸', () => {
  test('环 → 拒 (外层图有建图闸, 子图是模型现画的, 得自己查)', () => {
    const r = expandConductorNode('P', plan({
      a: { goal: 'A', depends_on: ['b'] },
      b: { goal: 'B', depends_on: ['a'] },
    }));
    expect(r.status).toBe('cycle');
    expect(r.error).toContain('环');
  });

  test('自环也算环', () => {
    expect(expandConductorNode('P', plan({ a: { goal: 'A', depends_on: ['a'] } })).status).toBe('cycle');
  });

  test('指向子图外的引用**不算**环边 (它们由外层调度保证已完成)', () => {
    const r = expandConductorNode('P', plan({ a: { goal: 'A', depends_on: ['某个外层节点'] } }));
    expect(r.status).toBe('ok');
  });

  test('空子图 → empty (不是失败: conductor 认为无事可做)', () => {
    expect(expandConductorNode('P', plan({})).status).toBe('empty');
  });

  test('超过 maxNodes → 截断并如实记 truncated (no-silent-caps)', () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) nodes[`n${i}`] = { goal: `活 ${i}` };
    const r = expandConductorNode('P', plan(nodes), { maxNodes: 4 });
    expect(r.children).toHaveLength(4);
    expect(r.truncated).toBe(6);
  });

  test('被截断的兄弟从依赖里消失后, 留下的引用退化成外层未知 dep (由执行器按幻象 dep 处理)', () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) nodes[`n${i}`] = { goal: `活 ${i}`, ...(i > 0 ? { depends_on: [`n${i - 1}`] } : {}) };
    const r = expandConductorNode('P', plan(nodes), { maxNodes: 2 });
    expect(r.children).toHaveLength(2);
    // 留下来的节点若引用了被截断的兄弟, 那个引用保持原名 —— 不会指向一个不存在的 `P::…` 假 id。
    for (const c of r.children) {
      for (const d of (c.node.depends_on ?? []) as string[]) {
        if (d.startsWith('P::')) expect(r.children.some((x) => x.id === d)).toBe(true);
      }
    }
  });

  test('默认硬顶 = 64, 与 map 的 DEFAULT_MAX_ITEMS 同一个数 (不是独立调过的)', () => {
    expect(DEFAULT_MAX_CHILDREN).toBe(64);
  });
});
