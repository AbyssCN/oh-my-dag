/**
 * 运行期不变量登记表 —— 机制自测 + **逐条反向自检**。
 *
 * 反向自检的惯例同 `src/eval/**.test.ts`。这里分两层, 别混:
 *
 * **闸不是恒真式** —— 直接喂违约值给在册的 `check`, 断言它返出**带定位信息的证据**;
 *   同时喂合法值断言它返 `null`。只判 `check` 自己。
 *
 * **闸真的接在生产路径上** —— 这一层 `check` 层测不出来 (`check` 返了证据 ≠ 有人在调它)。
 *   判法只有一个: **把实装改回违约的写法, 看正向用例是不是当场红**。每个 describe 里都写死了
 *   那一行怎么改 —— 照着改一次就是一次证伪, 改完还原。
 *   ⚠ 三条在册不变量今天都是**构造保证**成立的, 走公开入口造不出违约值 —— 所以这一层
 *   只能靠"改实装", 不能靠"喂坏输入"。这不是测试写偷懒, 是这类不变量的形状决定的。
 */
import { describe, expect, test } from 'bun:test';
import { InvariantViolationError, listInvariants, registerInvariant } from './invariants';
import { expandMapNode } from './plan/map-expand';
import { runDiscoveryLoop } from './plan/discovery';

describe('登记表机制', () => {
  test('注册 → 求值: 成立返 undefined, 违反抛且消息带得上归属', () => {
    const inv = registerInvariant<number>({
      id: 'INV-TEST-1',
      module: 'harness/invariants.test',
      why: '自测用',
      check: (n) => (n > 0 ? null : `n=${n} 不为正`),
    });
    expect(inv.assert(1)).toBeUndefined();
    expect(() => inv.assert(-3)).toThrow(InvariantViolationError);
    // 归属 (module + id) 必须在消息面上 —— 「按包归属报错」是登记这一步的全部理由。
    expect(() => inv.assert(-3)).toThrow(/harness\/invariants\.test · INV-TEST-1/);
    // 证据 (具体值) 与 why 都要在 —— 读消息的人不必回来读源码。
    expect(() => inv.assert(-3)).toThrow(/n=-3 不为正/);
    expect(() => inv.assert(-3)).toThrow(/自测用/);
  });

  test('同一 module::id 重复登记 → 加载期响亮失败', () => {
    const spec = {
      id: 'INV-TEST-DUP',
      module: 'harness/invariants.test',
      why: '自测用',
      check: () => null,
    };
    registerInvariant(spec);
    expect(() => registerInvariant(spec)).toThrow(/重复登记/);
  });

  test('在册清单可枚举, 且三条生产不变量都在表上', () => {
    const on = listInvariants().map((s) => `${s.module}::${s.id}`);
    expect(on).toContain('plan/map-expand::INV-U2');
    expect(on).toContain('plan/map-expand::INV-U8');
    expect(on).toContain('plan/discovery::INV-D3');
  });
});

describe('INV-U2 (plan/map-expand · 子 id 唯一 + `${mapNodeId}::` 前缀)', () => {
  const tmpl = { executor: 'agent', goal: 'do ${it.a}', output_type: 'file', output_path: 'out/audit.md' };

  test('正向: 逐字节相同的重复元素也各拿一个不同 id (回归锚)', () => {
    // 修前实况 (2026-09-02 实测): 3 个相同元素只展开出 **2** 个不同 id ——
    // 消歧尾巴取的是元素内容 hash, 而元素内容相同 ⇒ 尾巴也相同。
    // 落到 engine 就是 `plan.nodes[child.id] = ...` 后一个静默覆盖前一个。
    const r = expandMapNode(
      'm',
      { over: 'items', itemVar: 'it', template: tmpl },
      { items: [{ a: 1 }, { a: 1 }, { a: 1 }] },
    );
    expect(r.status).toBe('ok');
    expect(r.children).toHaveLength(3);
    expect(new Set(r.children.map((c) => c.id)).size).toBe(3);
    expect(new Set(r.children.map((c) => (c.node as { output_path: string }).output_path)).size).toBe(3);
    for (const c of r.children) expect(c.id.startsWith('m::')).toBe(true);
  });

  test('正向: lister 输出重排不改子集 (相同元素的序号消歧与顺序无关)', () => {
    const ids = (items: unknown[]) =>
      expandMapNode('m', { over: 'items', itemVar: 'it', template: tmpl }, { items })
        .children.map((c) => c.id)
        .sort();
    expect(ids([{ a: 1 }, { a: 1 }, { a: 2 }])).toEqual(ids([{ a: 2 }, { a: 1 }, { a: 1 }]));
  });

  // ⚠ 「闸真接上了」的证伪配方 (照做一次, 改完还原):
  //   把 map-expand.ts 的消歧那一格改回单尾巴 `if (n > 0) k.key = `${k.key}-${fnv1a(...).slice(0,6)}`;`
  //   → 上面「逐字节相同的重复元素」那条正向用例当场红, 且红在 `INV_U2.assert` 抛的
  //     InvariantViolationError 上 (不是红在 expect 上) —— 那就是闸真的接在生产路径上的证据。
  test('闸不是恒真式: id 撞车 → check 返带定位的证据', () => {
    const inv = listInvariants().find((s) => s.module === 'plan/map-expand' && s.id === 'INV-U2')!;
    const dup = [
      { id: 'm::a', key: 'a', item: 1, node: {} },
      { id: 'm::a', key: 'a', item: 1, node: {} },
    ];
    expect(inv.check({ mapNodeId: 'm', children: dup })).toMatch(/"m::a" 出现两次/);
    expect(inv.check({ mapNodeId: 'm', children: [dup[0]] })).toBeNull(); // 闸不是恒真式
  });

  test('闸不是恒真式: 前缀不对 → check 返带定位的证据 (下游毒集/子树作废全押在这个形状上)', () => {
    const inv = listInvariants().find((s) => s.module === 'plan/map-expand' && s.id === 'INV-U2')!;
    const bad = [{ id: 'other::a', key: 'a', item: 1, node: {} }];
    expect(inv.check({ mapNodeId: 'm', children: bad })).toMatch(/不以 "m::" 开头/);
  });
});

describe('INV-U8 (plan/map-expand · file 类子节点 output_path 不撞)', () => {
  // ⚠ 证伪配方同 INV-U2 (同一格消歧): 改回单尾巴 → 三个相同元素拿到两个相同 output_path,
  //   `INV_U8.assert` 当场抛。
  test('闸不是恒真式: 两个 file 子节点写同一路径 → check 返带定位的证据', () => {
    const inv = listInvariants().find((s) => s.module === 'plan/map-expand' && s.id === 'INV-U8')!;
    const clash = [
      { id: 'm::a', key: 'a', item: 1, node: { output_type: 'file', output_path: 'out/x.md' } },
      { id: 'm::b', key: 'b', item: 2, node: { output_type: 'file', output_path: 'out/x.md' } },
    ];
    expect(inv.check({ children: clash })).toMatch(/m::a 与 m::b 都写 "out\/x\.md"/);
  });

  test('闸不是恒真式: 非 file 类 / 路径不同 一律放行', () => {
    const inv = listInvariants().find((s) => s.module === 'plan/map-expand' && s.id === 'INV-U8')!;
    // 同路径但不是 file 类 → 不管 (output_path 对非 file 节点无产物语义)。
    expect(
      inv.check({
        children: [
          { id: 'm::a', key: 'a', item: 1, node: { output_type: 'inline', output_path: 'out/x.md' } },
          { id: 'm::b', key: 'b', item: 2, node: { output_type: 'inline', output_path: 'out/x.md' } },
        ],
      }),
    ).toBeNull();
    expect(
      inv.check({
        children: [
          { id: 'm::a', key: 'a', item: 1, node: { output_type: 'file', output_path: 'out/a.md' } },
          { id: 'm::b', key: 'b', item: 2, node: { output_type: 'file', output_path: 'out/b.md' } },
        ],
      }),
    ).toBeNull();
  });
});

describe('INV-D3 (plan/discovery · converged 只能来自真 dry)', () => {
  test('正向: 连续 dryThreshold 轮零新增 → converged, 且 assert 不挡', async () => {
    let n = 0;
    const r = await runDiscoveryLoop<string>({
      input: 'x',
      maxRounds: 5,
      dryThreshold: 2,
      keyOf: (s) => s,
      roundRunner: async () => (++n === 1 ? ['a'] : []),
    });
    expect(r.status).toBe('dry');
    expect(r.converged).toBe(true);
    expect(r.rounds.at(-1)!.dryStreak).toBe(2);
  });

  test('正向: 触顶仍在出新 → exhausted 且 converged=false (绝不假报)', async () => {
    let n = 0;
    const r = await runDiscoveryLoop<string>({
      input: 'x',
      maxRounds: 3,
      dryThreshold: 2,
      keyOf: (s) => s,
      roundRunner: async () => [`item-${++n}`],
    });
    expect(r.status).toBe('exhausted');
    expect(r.converged).toBe(false);
  });

  // ⚠ 「闸真接上了」的证伪配方 (照做一次, 改完还原):
  //   把 discovery.ts 里 `status: 'exhausted', converged: false` 那一处改成 `converged: true`
  //   → 上面「触顶仍在出新」那条正向用例当场红在 `INV_D3.assert` 抛的 InvariantViolationError 上。
  //   摘掉 `finish` 里的 `INV_D3.assert(...)` 之后再改, 它就不红了 —— 那正是"只有注释在守"的样子。
  test('闸不是恒真式: 三种假 converged 各返带定位的证据', () => {
    const inv = listInvariants().find((s) => s.module === 'plan/discovery' && s.id === 'INV-D3')!;
    // ① converged 与 status 对不上 (exhausted 冒充收敛)
    expect(inv.check({ status: 'exhausted', converged: true, rounds: [{ dryStreak: 9 }], dryThreshold: 2 })).toMatch(
      /converged=true 而 status=exhausted/,
    );
    // ② dry 却不认 converged (反方向, 同一条 ⟺ 的另一半)
    expect(inv.check({ status: 'dry', converged: false, rounds: [{ dryStreak: 2 }], dryThreshold: 2 })).toMatch(
      /converged=false 而 status=dry/,
    );
    // ③ 声称收敛, 而 journal 里末轮 dryStreak 根本没到阈值 (账与断言互相拆台)
    expect(inv.check({ status: 'dry', converged: true, rounds: [{ dryStreak: 1 }], dryThreshold: 2 })).toMatch(
      /末轮 dryStreak=1 < 阈值 2/,
    );
    // 闸不是恒真式: 合法组合放行
    expect(inv.check({ status: 'dry', converged: true, rounds: [{ dryStreak: 2 }], dryThreshold: 2 })).toBeNull();
    expect(inv.check({ status: 'budget_halt', converged: false, rounds: [{ dryStreak: 0 }], dryThreshold: 2 })).toBeNull();
  });
});
