/**
 * D-B 内容寻址子节点 id + D-D 禁嵌套 (P3 批次 3, 2026-07-29) —— 纯展开逻辑的契约测试。
 *
 * 要钉的核心是一句话: **id 由内容决定, 不由名字决定**。conductor 每次重画都可能给同一件活换个名,
 * 而 per-node checkpoint 是按 id 存的 —— 名字入 id 就会两头出错:
 *   ① 同一件活换了名 → resume 拿不到本该命中的绿 (白跑)
 *   ② 同一个名换了活 → resume 把上次的产物当这次的绿 (**张冠李戴**, 更坏)
 */
import { describe, expect, test } from 'bun:test';
import { expandConductorNode, subgraphLintView, DEFAULT_MAX_CHILDREN } from './conductor-expand';
import { staticLintPlan } from './static-lint';
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

describe('按调用禁单 (执行段禁调研的纯逻辑那一半)', () => {
  /** 执行段的禁单, 与 engine 的 EXECUTE_SEGMENT_FORBIDDEN_EXECUTORS 同形 (接线由 engine.test.ts 钉)。 */
  const forbidResearch = new Map([['research', '执行段禁调研 —— 已结晶 SDD 的 research 已付费']]);

  test('传了禁单: 子节点 executor:research → forbidden, 且错误可教 (带理由原文)', () => {
    const r = expandConductorNode('P', plan({ dig: { goal: '查一下别人怎么做', executor: 'research' } }), {
      forbidExecutors: forbidResearch,
    });
    expect(r.status).toBe('forbidden');
    expect(r.children).toEqual([]);
    expect(r.error).toContain('research');
    expect(r.error).toContain('执行段禁调研'); // 理由逐字带出来, 不是"不允许"三个字
  });

  test('**阴性对照**: 不传禁单 → 同一份子图照旧 ok (契约段的 research 是正当的)', () => {
    // 反向自检: 把上面那条的 `forbidExecutors` 删掉 → 上面那条立刻绿不了 (status 变 'ok');
    // 把闸写成"全局禁 research" → 本条立刻红 (status 变 'forbidden')。两条互为证伪。
    const r = expandConductorNode('P', plan({ dig: { goal: '查一下别人怎么做', executor: 'research' } }));
    expect(r.status).toBe('ok');
    expect(r.children).toHaveLength(1);
  });

  test('一个 research 拒**整份**子图 (fail-closed, 同 D-D)', () => {
    const r = expandConductorNode(
      'P',
      plan({ impl: { goal: '实装', executor: 'agent' }, dig: { goal: '查', executor: 'research' } }),
      { forbidExecutors: forbidResearch },
    );
    expect(r.status).toBe('forbidden');
    expect(r.children).toEqual([]);
  });

  test('禁单不误伤别的 executor (只禁进单子的那些)', () => {
    const r = expandConductorNode('P', chain(), { forbidExecutors: forbidResearch });
    expect(r.status).toBe('ok');
    expect(r.children).toHaveLength(3);
  });

  test('全局禁单先判: 禁单里同时有 conductor 也照旧报 nested (结构禁令不被上下文禁令顶掉)', () => {
    const r = expandConductorNode('P', plan({ a: { goal: 'A', executor: 'conductor' } }), {
      forbidExecutors: new Map([['conductor', '执行段的理由']]),
    });
    expect(r.status).toBe('nested');
    expect(r.error).toContain('D-D');
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

/**
 * `subgraphLintView` —— 键与边同体系 (issue #25, 2026-08-14)。
 *
 * 起因是一次对照实验: 调用方 (engine.ts 的 A4 静态闸) 此前就地拼这张 plan, 键取 `originalId`
 * 而边已被重写成内容寻址 id。同一张子图 —— 展开前 lint 得 0 条, 展开后按老口径 lint 得
 * `write-race[b,a]`, 而 b 明明 depends_on a。也就是「有依赖 = 有序 = 不是竞争」那条豁免
 * **从来没在子图上生效过**。
 *
 * **反向自检 (2026-08-14 实跑)**: 把 `subgraphLintView` 里的 `readable.get(d) ?? d` 改成 `d`
 * (逐字退回老口径) → 29 pass 变 26 pass 3 fail: 假写竞争回来, 可读名那条与截断那条一起塌。
 */
describe('subgraphLintView — 键与边同一个体系', () => {
  test('★ 有依赖的两个同写者不再被报成写竞争 (对照: 展开前后判词一致)', () => {
    const sub = plan({
      a: { goal: 'A', executor: 'agent', output_path: 'src/x.ts' },
      b: { goal: 'B', executor: 'agent', output_path: 'src/x.ts', depends_on: ['a'] },
    });
    const exp = expandConductorNode('P', sub);
    expect(exp.status).toBe('ok');
    expect(staticLintPlan(sub)).toHaveLength(0);                       // 展开前
    expect(staticLintPlan(subgraphLintView(exp.children))).toHaveLength(0); // 展开后, 同一个答案
  });

  test('真写竞争 (无依赖边) 照报 —— 证明上面不是靠"什么都不报"过的', () => {
    const exp = expandConductorNode('P', plan({
      a: { goal: 'A', executor: 'agent', output_path: 'src/x.ts' },
      b: { goal: 'B', executor: 'agent', output_path: 'src/x.ts' },
    }));
    const f = staticLintPlan(subgraphLintView(exp.children));
    expect(f.map((x) => x.kind)).toEqual(['write-race']);
  });

  test('键是可读名, 边也是可读名 (判词的读者是下一轮 conductor, 它只认自己起的名)', () => {
    const exp = expandConductorNode('P', chain(['contract', 'impl', 'verify']));
    const view = subgraphLintView(exp.children);
    expect(Object.keys(view.nodes).sort()).toEqual(['contract', 'impl', 'verify']);
    expect(view.nodes['impl']!.depends_on).toEqual(['contract']);
    expect(view.nodes['verify']!.depends_on).toEqual(['impl']);
  });

  test('指向子图外的引用原样保留 (由调用方的 knownExternal 判它合不合法)', () => {
    const exp = expandConductorNode('P', plan({ a: { goal: 'A', depends_on: ['outer-node'] } }));
    expect(subgraphLintView(exp.children).nodes['a']!.depends_on).toEqual(['outer-node']);
  });

  /**
   * 三步链 + 上限 2 → 一个节点被截断, 其余两个留下 (展开序按指纹字典序, 确定)。
   *
   * 哪个节点具体被截断 = 指纹排序的派生结论, **不是**被测契约。本用例锁的是
   * 「`truncatedNames` 持有真被截断的那个 id」, 供下游 `subgraphLintView` 的
   * 「截断 = 悬空引用, 但**不是**真正的手误」分类闸消费 —— 那个分类 (lint 报
   * `truncated-dependency` 而非 `dangling-dependency`) 才是不变量。
   *
   * (P1 D-3 / 2026-08-21: `nodeFieldsKey` 加 `self_check` 后, 这条三步链的具体
   * 截断对象从 ['a'] 移到 ['b']; 该变化仅反映 fingerprint hash 的输出序列,
   * 分类闸的行为仍一致。)
   */
  /**
   * 手工构造「一个子节点被截断、保留者仍依赖它」的状态。
   *
   * 此前这里跑 `expandConductorNode(..., { maxNodes: 2 })` 再断言截断对象是哪一个 ——
   * 而截断对象由**指纹序**决定, 指纹序又随 `nodeFieldsKey` 的字段集变。于是每加一个 schema 字段
   * 这条用例就红一次: 加 `self_check` 那次截断对象从 a 移到 b, 加 `expect_output` 这次移到 c,
   * 而移到 c 之后链尾被截、根本不再产生悬空引用 —— 用例悄悄退化成什么都没测。
   *
   * 本用例的不变量只有一条: **自报名字的截断引用被分类成 truncated 而不是 dangling**。
   * 那与「谁被截断」无关, 所以这里直接构造状态, 不再借 expand 的指纹序。
   * expand 真的会截断, 由本文件另一条用例负责。
   */
  const truncatedChain = () => {
    const child = (name: string, deps: string[] = []) => ({
      id: `P::${name}`,
      originalId: name,
      fingerprint: name,
      node: { goal: name.toUpperCase(), ...(deps.length ? { depends_on: deps } : {}) },
    });
    // 保留 a、b;b 依赖已被截断的 c —— 无论指纹序如何,这个形状恒定。
    return { children: [child('a'), child('b', ['P::c'])], truncatedNames: ['P::c'] };
  };

  test('★ 截断产生的悬空引用: 生产者自报名字 → lint 报成 truncated 而非 dangling', () => {
    const exp = truncatedChain();
    const kinds = staticLintPlan(subgraphLintView(exp.children), { truncatedIds: new Set(exp.truncatedNames) })
      .map((f) => f.kind);
    expect(kinds).toContain('truncated-dependency');
    expect(kinds).not.toContain('dangling-dependency');
  });

  test('不给 truncatedIds → 同一张图报成 dangling (证明上一条真是靠自报分开的, 不是碰巧)', () => {
    const kinds = staticLintPlan(subgraphLintView(truncatedChain().children)).map((f) => f.kind);
    expect(kinds).toContain('dangling-dependency');
    expect(kinds).not.toContain('truncated-dependency');
  });

  test('truncatedNames 与 truncated 计数一致 (不许一个报数一个报名)', () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`n${i}`, { goal: `N${i}` }]));
    const exp = expandConductorNode('P', plan(many), { maxNodes: 2 });
    expect(exp.truncatedNames).toHaveLength(exp.truncated);
    expect(exp.truncated).toBe(3);
  });
});
