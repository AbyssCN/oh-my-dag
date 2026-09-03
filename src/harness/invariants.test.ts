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
 *   ⚠ 在册项**大多**今天是**构造保证**成立的, 走公开入口造不出违约值 —— 所以这一层
 *   只能靠"改实装", 不能靠"喂坏输入"。这不是测试写偷懒, 是这类不变量的形状决定的。
 *   例外是 `memory/store::INV-8`: 它守的那份状态住在**磁盘库**里 (多前端共开 + 迁移尾巴),
 *   本进程的写路径管不着, 所以那一条能直接灌一份真的坏库状态进去。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InvariantViolationError, listInvariants, registerInvariant, type InvariantSpec } from './invariants';
import { expandMapNode } from './plan/map-expand';
import { runDiscoveryLoop } from './plan/discovery';
import { runExecutorDagWithPlan } from './dag/engine';
import { PLAN_BOUNDARY, type ConductorPlan } from './conductor-plan';
import type { ContentPart } from '../model/gateway';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './dag/types';
import { OmdMemory } from './memory/store';
import { computeWaste } from './waste/report';
import type { DagRunRecord } from './dag/dag-record';

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

  test('在册清单可枚举, 且每一条生产不变量都在表上', () => {
    const on = listInvariants().map((s) => `${s.module}::${s.id}`);
    expect(on).toContain('plan/map-expand::INV-U2');
    expect(on).toContain('plan/map-expand::INV-U8');
    expect(on).toContain('plan/discovery::INV-D3');
    // 第二批 (2026-09-02)
    expect(on).toContain('memory/store::INV-8');
    expect(on).toContain('waste/report::INV-5');
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

// ─────────────────────────────────────────────────────────────────────────────
// 第二批 (2026-09-02)。同上分两层: ① 闸不是恒真式 (直接喂 check) ② 闸真接在生产路径上。
// ⚠ 第二批与首批有一处不同: `memory/store` 那条**走得通公开入口 + 一次真的坏库状态**,
//   不必靠改实装 —— 库是磁盘文件, 多前端共开, 「此刻组内几条 live」不由本进程构造保证。
// ─────────────────────────────────────────────────────────────────────────────

describe('INV-8 (memory/store · 回滚一次自我进化后组内 live 恰好一条)', () => {
  /** 同一 identity 的一条 omd.pattern —— outcome 不同即触发 supersede。 */
  const pattern = (outcome: 'worked' | 'failed', eventId: string) => ({
    namespace: 'omd.pattern',
    situation: 'leaf 判据反复红',
    approach: '先读判据本身再改产物',
    outcome,
    source_event_id: eventId,
    confidence: { level: 'agent_tentative', source_event_ids: [eventId], created_at: new Date() },
  });

  const seeded = async (): Promise<{ db: Database; mem: OmdMemory; first: string; second: string }> => {
    const db = new Database(':memory:');
    const mem = new OmdMemory({ db });
    const a = await mem.writeFact(pattern('failed', 'ev-1'));
    const b = await mem.writeFact(pattern('worked', 'ev-2'));
    if (a.status !== 'written' || b.status !== 'written') throw new Error(`seed 失败: ${JSON.stringify([a, b])}`);
    return { db, mem, first: a.id, second: b.id };
  };

  const liveCount = (db: Database): number =>
    (db.query(`SELECT count(*) AS n FROM facts WHERE deleted_at IS NULL`).get() as { n: number }).n;

  test('正向: 正常链上的回滚过闸, 且组内仍恰好一条 live', async () => {
    const { db, mem, first } = await seeded();
    expect(mem.revertSupersession(first)).toBe(true);
    expect(liveCount(db)).toBe(1);
  });

  // ⚠ 「闸真接上了」的证伪配方: 摘掉 store.ts 里 `INV_MEM_8.assert({...})` 那一格
  //   → 下面这条用例当场红 —— 它不再抛, `revertSupersession` 返 true 并把库留在**两条
  //   live 同 identity** 的状态上, 而这正是"只有注释在守"时它的真实行为。
  //   ⚠ 坏库状态是**灌进去的真状态**, 不是改实装造出来的: 这个库是磁盘文件, 多前端共开
  //   (各自可注入不同 safeguard), 还带一条 `ADD COLUMN superseded_by` 的迁移尾巴。
  //   「本进程写路径构造保证组内至多一条 live」为真, 「库里此刻至多一条」不为真。
  test('反向 (真坏库状态): 组内已存在另一条外来 live → 回滚抛 InvariantViolationError 且整事务回滚', async () => {
    const { db, mem, first, second } = await seeded();
    // 另一个写者 (别的前端 / 别的进程) 在同一组里塞了一条 live —— 本进程的写路径不经手。
    const row = db.query(`SELECT namespace, identity_key, text, payload, embedding, created_at FROM facts WHERE id = ?`)
      .get(second) as { namespace: string; identity_key: string; text: string; payload: string; embedding: Uint8Array; created_at: number };
    db.run(
      `INSERT INTO facts (id, namespace, identity_key, text, payload, embedding, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ['foreign-live', row.namespace, row.identity_key, row.text, row.payload, row.embedding, row.created_at],
    );
    expect(liveCount(db)).toBe(2); // 起点: second + foreign-live

    expect(() => mem.revertSupersession(first)).toThrow(InvariantViolationError);
    expect(() => mem.revertSupersession(first)).toThrow(/memory\/store · INV-8/);
    expect(() => mem.revertSupersession(first)).toThrow(/组内 live = \[.*\] \(2 条\)/);

    // fail-closed 的另一半: 事务整体回滚, 库停在抛之前 —— first 仍是墓碑, second 仍活着。
    // (拿不准链完不完整的时候, 正确动作是**别复活**, 不是复活一半。)
    expect(mem.epitaph(first)).not.toBeNull();
    expect(mem.epitaph(second)).toBeNull();
    expect(liveCount(db)).toBe(2);
  });
});

describe('INV-5 (waste/report · 每一跑恰好进 n 或 unknownRuns 之一)', () => {
  const inv = (): InvariantSpec<{
    runCount: number;
    missingColumns: readonly string[];
    metrics: readonly { name: string; needs: readonly string[]; n: number; unknownRuns: number }[];
  }> => listInvariants().find((s) => s.module === 'waste/report' && s.id === 'INV-5')! as never;

  test('闸不是恒真式: 跑丢了 / 缺列却仍记数, 各返带定位的证据', () => {
    const c = inv().check;
    // ① 一跑两边都没记 —— 更小的样本量伪装成更干净的样本量
    expect(
      c({ runCount: 3, missingColumns: [], metrics: [{ name: 'waveWidth', needs: [], n: 1, unknownRuns: 1 }] }),
    ).toMatch(/waveWidth: n=1 \+ unknownRuns=1 ≠ 总跑数 3 \(差 1 跑两边都没记\)/);
    // ② 缺列却仍记了 n —— 代理判据顶替真列的回潮 (上一轮 verifier 打回的那条)
    expect(
      c({
        runCount: 2,
        missingColumns: ['overriddenBy'],
        metrics: [{ name: 'nodeWasteTokens', needs: ['dagRound', 'overriddenBy'], n: 2, unknownRuns: 0 }],
      }),
    ).toMatch(/缺列 \[overriddenBy\] 却仍记了 n=2 跑/);
    // 闸不是恒真式: 守恒且缺列时整体退 unknown → 放行
    expect(
      c({
        runCount: 2,
        missingColumns: ['overriddenBy'],
        metrics: [{ name: 'nodeWasteTokens', needs: ['dagRound', 'overriddenBy'], n: 0, unknownRuns: 2 }],
      }),
    ).toBeNull();
    // 闸不是恒真式: 零跑的空库放行 (0 + 0 === 0), 不许把"没跑"读成"跑丢了"
    expect(c({ runCount: 0, missingColumns: [], metrics: [{ name: 'waveWidth', needs: [], n: 0, unknownRuns: 0 }] })).toBeNull();
  });

  // ⚠ 「闸真接上了」的证伪配方 (照做一次, 改完还原): 把 report.ts 的 waveWidth 那格
  //   `if (levels.length === 0) { levelsUnknown += 1; continue; }` 里的 `levelsUnknown += 1;`
  //   删掉 → 下面这条正向用例当场红在 `INV_WASTE_5.assert` 抛的 InvariantViolationError 上
  //   (`waveWidth: n=1 + unknownRuns=0 ≠ 总跑数 2`), 不是红在 expect 上。
  test('正向 (生产路径): 混合库 (一跑有数据 / 一跑整跑没记) 上四个指标的账都对得上', () => {
    const rec = (levels: string[][], nodes: unknown[]): DagRunRecord =>
      ({ levels, nodes } as unknown as DagRunRecord);
    const r = computeWaste([
      // 有数据的一跑: 四列俱全。
      rec(
        [['n1', 'n2']],
        [
          { id: 'n1', kind: 'leaf', status: 'done', deps: [], tokensIn: 100, dagRound: 1, overriddenBy: 1, injectedTokens: 10, cacheHitTokens: 5 },
          { id: 'n2', kind: 'leaf', status: 'done', deps: [], tokensIn: 100, dagRound: 2, injectedTokens: 0, cacheHitTokens: 0 },
        ],
      ),
      // 整跑没记的一跑: 零节点零 levels —— 「没记」, 不是 0 浪费。
      rec([], []),
    ]);
    // 四个指标逐个对账: n + unknownRuns === 2。
    for (const m of [r.nodeWasteTokens, r.handoffTax, r.cacheHitRate, r.waveWidth])
      expect(m.n + m.unknownRuns).toBe(2);
    // 第二跑必须落在 unknown 那一格 (而不是悄悄消失, 也不是被编成 0)。
    expect(r.waveWidth.unknownRuns).toBe(1);
    expect(r.waveWidth.n).toBe(1);
    expect(r.nodeWasteTokens.value).toBe(0.5); // 200 里被覆盖 100
    expect(r.missingColumns).toEqual([]);
  });

  // ⚠ 第二半 (缺列却仍记数) 的证伪配方, 与守恒那半**是两格**, 各证一次:
  //   把 report.ts 的 `if (!hasDagRound || !hasOverriddenBy) { tokensUnknown = perRun.length; }`
  //   收窄成 `if (!hasDagRound)` —— 那正是"拿剩下那一列当代理"的回潮写法。下面这条用例当场红在
  //   `INV_WASTE_5.assert` 抛的 `nodeWasteTokens: 缺列 [overriddenBy] 却仍记了 n=1 跑` 上。
  //   ⚠ 这一格必须单独证: 收窄之后守恒仍然成立 (每跑照样恰好进一格), 只证守恒那半发现不了它。
  test('正向 (生产路径): 老库形状 (overriddenBy 整列缺席) → 该指标整体退 unknown, 不拿剩下那列当代理', () => {
    const r = computeWaste([
      {
        levels: [['n1']],
        nodes: [
          // dagRound 有、overriddenBy 整列没有 —— `ALTER TABLE` 之前那一代行的真实形状。
          { id: 'n1', kind: 'leaf', status: 'done', deps: [], tokensIn: 100, dagRound: 1, injectedTokens: 10, cacheHitTokens: 5 },
        ],
      } as unknown as DagRunRecord,
    ]);
    expect(r.missingColumns).toEqual(['overriddenBy']);
    expect(r.nodeWasteTokens.n).toBe(0); // 整体退 unknown
    expect(r.nodeWasteTokens.unknownRuns).toBe(1);
    expect(r.nodeWasteTokens.value).toBeNull(); // 「没记」, 不是 0 浪费
    // 不缺列的两个指标照常出数 —— 缺列的退让是**逐指标**的, 不牵连别人。
    expect(r.handoffTax.n).toBe(1);
    expect(r.cacheHitRate.n).toBe(1);
  });
});
