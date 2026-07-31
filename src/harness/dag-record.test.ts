/**
 * dag-record 的 `runId` 归组面 (2026-08-02)。
 *
 * 为什么要这一条: 留痕器写好之后**只挂在 TUI 侧的 `/cg` `/audit` `/iterate` 上**, MCP 生产路径
 * (dag_run / dag_goal) 从来没接过 —— `.omd/dag-runs.db` 在真跑上恒空。接线时才发现主键不够用:
 * `dag_goal` 一次跑**两张图** (契约段 + 执行段), 各落一条记录; 想回答「这次 goal 花了多少」
 * 就必须能把这两条认回同一次运行, 而主键按定义是每条都不同的。
 *
 * 于是加 `run_id` 列。这里钉三件事: ① 归组真的能用 ② 老库 (无该列) 不许炸 ③ 主键仍是每条独立。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDagRecorder, recordDagRun } from './dag-record';
import type { ExecutorDagResult } from './executor-dag-types';

/** 最小可记的一张图结果 (只填 record 真读的那几个字段)。 */
const fakeResult = (planName: string, usage?: { leavesIn?: number; cacheHit?: number }): ExecutorDagResult =>
  ({
    plan: { name: planName, nodes: { a: { goal: 'x' } } },
    levels: [['a']],
    results: { a: { id: 'a', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
    reusedNodes: [],
    usage: {
      conductor: { in: 10, out: 20 },
      leavesIn: usage?.leavesIn ?? 100,
      leavesOut: 50,
      leavesCacheHit: usage?.cacheHit ?? 0,
    },
  }) as unknown as ExecutorDagResult;

describe('dag-record 的 runId 归组', () => {
  test('同一个 runId 的两条 (goal 两段) 归得回一组, 主键各自独立', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id1 = rec.record(fakeResult('goal-contract', { leavesIn: 300, cacheHit: 120 }), { runId: 'run-A', question: '干点活' });
    const id2 = rec.record(fakeResult('goal-execute', { leavesIn: 700, cacheHit: 400 }), { runId: 'run-A', question: '干点活' });
    rec.record(fakeResult('别人的图'), { runId: 'run-B' });

    expect(id1).not.toBe(id2); // 主键每条不同 —— 归组不能靠它
    const group = rec.listByRun('run-A');
    expect(group.map((r) => r.planName)).toEqual(['goal-contract', 'goal-execute']); // 时间序
    // 「这次 goal 花了多少 / 吃到多少缓存」= 组内相加, 这正是 G3 与前缀缓存两个问题的数据源。
    expect(group.reduce((s, r) => s + r.usage.leavesIn, 0)).toBe(1000);
    expect(group.reduce((s, r) => s + r.usage.leavesCacheHit, 0)).toBe(520);
    expect(rec.listByRun('run-B')).toHaveLength(1);
    expect(rec.listByRun('不存在')).toEqual([]);
    rec.close();
  });

  test('runId 省略 → null (图外调用方照旧能记, 只是归不了组)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('/audit'));
    expect(rec.get(id)!.runId).toBeNull();
    rec.close();
  });

  test('老库 (建于加列之前) 就地补列, 不炸; 老行 runId = null', () => {
    // 逐字重建 2026-08-02 之前的表结构 —— `CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不改,
    // 所以少了这个 ALTER, 任何早建过库的机器都会在第一次 INSERT 上崩。
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL
      )
    `);
    db.run(
      `INSERT INTO omd_dag_runs VALUES ('old-1', 1, '老图', 1, null, '[]', '[]', '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}')`,
    );

    const rec = createDagRecorder({ db });
    expect(rec.get('old-1')!.runId).toBeNull(); // 老行读得出来, 归组位为空
    const fresh = rec.record(fakeResult('新图'), { runId: 'run-C' }); // 新行照常写
    expect(rec.get(fresh)!.runId).toBe('run-C');
    rec.close();
  });
});

/**
 * R1 / §8.5 的两条派生面: 命令原文 与 效果指标计数。
 *
 * 两者共用同一条纪律 —— **留痕存原料, 不存派生值**。风险级的定义以后会改, 命令不会;
 * 所以存 `command` 让读数板现算级别, 而不是把当时算出来的级别写进历史记录。
 */
describe('留痕的派生面 — 命令原文 + 效果指标计数', () => {
  const withNodes = (nodes: Record<string, unknown>, results: Record<string, unknown>): ExecutorDagResult =>
    ({
      plan: { name: '图', nodes },
      levels: [Object.keys(nodes)],
      results,
      reusedNodes: [],
      usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    }) as unknown as ExecutorDagResult;

  test('command 节点的命令原文进留痕 (读数板据它现算风险级)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { v: { goal: 'x', executor: 'command', command: 'bun test' }, a: { goal: 'y' } },
        {
          v: { id: 'v', kind: 'command', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-cmd' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'v')!.command).toBe('bun test');
    // 非 command 节点不该凭空多一个字段。
    expect(nodes.find((n) => n.id === 'a')!.command).toBeUndefined();
    rec.close();
  });

  test('writeCounts 原样进留痕; **缺席与 [0,0] 不许被抹平**', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { w: { goal: 'x' }, z: { goal: 'y' }, o: { goal: 'z' } },
        {
          // 写了 3 次, 其中 2 次 no-op
          w: { id: 'w', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, writeCounts: [3, 2] },
          // 跑了但一次没写 —— 这是一个**真实读数**, 不是"没记"
          z: { id: 'z', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, writeCounts: [0, 0] },
          // 这条链上没人报 (旧 runner / inproc) —— 与上面那条必须分得开
          o: { id: 'o', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-eff' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'w')!.writeCounts).toEqual([3, 2]);
    expect(nodes.find((n) => n.id === 'z')!.writeCounts).toEqual([0, 0]); // 存在且为零
    expect(nodes.find((n) => n.id === 'o')!.writeCounts).toBeUndefined(); // 缺席
    // 这条断言是本用例的全部意义: 两者若被抹成同一个东西, 读数板就会把「没记」念成「跑了但没写」。
    expect(nodes.find((n) => n.id === 'z')!.writeCounts).not.toBeUndefined();
    rec.close();
  });

  test('plan 里没有对应 id 的节点 (map 动态扇出的子节点) 不编命令', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { parent: { goal: 'x' } },
        { 'parent#1': { id: 'parent#1', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      ),
      { runId: 'run-map' },
    );
    expect(rec.get(id)!.nodes[0]!.command).toBeUndefined();
    rec.close();
  });
});

describe('recordDagRun (onComplete 钩子工厂)', () => {
  test('记一条并带上 runId/question', async () => {
    const rec = createDagRecorder({ path: ':memory:' });
    await recordDagRun(rec, { runId: 'run-D', question: '问题' })(fakeResult('图'));
    const [row] = rec.listByRun('run-D');
    expect(row!.question).toBe('问题');
    rec.close();
  });

  test('**不吃掉调用方自己的 onComplete**', async () => {
    // 留痕是搭车的, 不是抢座的。基座今天没有 onComplete, 但以后加的那个不该被这里静默吞掉 ——
    // 与 `dag_goal` 的节点事件从 P1 漏到 07-30 是同一个形态 (接线时顺手覆盖了别人的钩子)。
    const rec = createDagRecorder({ path: ':memory:' });
    const order: string[] = [];
    const hook = recordDagRun(rec, { runId: 'run-E' }, async () => {
      order.push('prev');
    });
    await hook(fakeResult('图'));
    order.push('recorded');
    expect(order).toEqual(['prev', 'recorded']);
    expect(rec.listByRun('run-E')).toHaveLength(1);
    rec.close();
  });
});

/**
 * N9 的两位新数据源 (2026-07-31)。
 *
 * 加它们是 N9 「在读数板上把 score 四条轴试出来」时当场撞到的:**判据轴与效率轴没有数据源**。
 * `verification` 缺了,「judge 说没收敛而验收其实过了」那一格就永远看不见;模型坐标缺了,
 * `computeCost` 查不到价 —— `$/goal` 不是没做, 是算不出来。
 *
 * 钉的重点与 `writeCounts` 那条一样, 是**三态不许被抹平**: 没记 / 记了且为假 / 记了且为真,
 * 三者的结论互不相同, 合并任意两个都会让读数板念出一句错话。
 */
describe('N9 · verification / reused / model 的三态', () => {
  const withVerif = (v: { pass: boolean; reason?: string } | undefined, reused?: string[]) =>
    ({
      plan: { name: 'p', nodes: { a: { goal: 'x' } } },
      levels: [['a']],
      results: { a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 }, model: 'deepseek:deepseek-v4-flash' } },
      ...(reused ? { reusedNodes: reused } : {}),
      ...(v ? { verification: v } : {}),
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 2 },
    }) as unknown as ExecutorDagResult;

  test('验收过了 / 没过 / 压根没验 —— 三态各自可辨', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const pass = rec.get(rec.record(withVerif({ pass: true })))!;
    const fail = rec.get(rec.record(withVerif({ pass: false, reason: '退出码 1' })))!;
    const none = rec.get(rec.record(withVerif(undefined)))!;
    expect(pass.verification).toEqual({ pass: true });
    expect(fail.verification).toEqual({ pass: false, reason: '退出码 1' });
    // ★ 没验 ≠ 没过。编一个 `pass:false` 会让读数板把「这次没跑验收」念成「判据没通过」。
    expect(none.verification).toBeUndefined();
    rec.close();
  });

  test('reused: 0 是「记了且一个没复用」, 缺席是「没记」—— 不许合并', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const zero = rec.get(rec.record(withVerif(undefined, [])))!;
    const two = rec.get(rec.record(withVerif(undefined, ['a', 'b'])))!;
    const unrecorded = rec.get(rec.record(withVerif(undefined)))!;
    expect(zero.reused).toBe(0);
    expect(two.reused).toBe(2);
    expect(unrecorded.reused).toBeUndefined();
    rec.close();
  });

  test('模型坐标原样进留痕 —— 存坐标不存算好的钱 (价表会改, 坐标不会)', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const r = rec.get(rec.record(withVerif({ pass: true })))!;
    expect(r.nodes[0]!.model).toBe('deepseek:deepseek-v4-flash');
    // 没打模型的节点 (command 叶) 不编一个坐标出来。
    const noModel = {
      plan: { name: 'p', nodes: { c: { goal: 'x', command: 'ls' } } },
      levels: [['c']],
      results: { c: { id: 'c', kind: 'command', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    } as unknown as ExecutorDagResult;
    expect(rec.get(rec.record(noModel))!.nodes[0]!.model).toBeUndefined();
    rec.close();
  });

  test('老库 (无这三列) 就地补列不炸, 老行读回来是「没记」而不是假值', () => {
    const db = new Database(':memory:');
    // 造一张 2026-07-31 之前形状的表 (无 verification / reused)。
    db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
            node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    db.run(`INSERT INTO omd_dag_runs VALUES ('old', 1, 'p', 1, NULL, NULL, '[]', '[]', '{}')`);
    const rec = createDagRecorder({ db });
    const old = rec.get('old')!;
    expect(old.verification).toBeUndefined();
    expect(old.reused).toBeUndefined();
    // 补列之后新记录照常写得进去。
    expect(rec.get(rec.record(withVerif({ pass: true }, ['a'])))!.verification).toEqual({ pass: true });
    rec.close();
  });
});
