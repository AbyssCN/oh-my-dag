/**
 * omd-readout 的**可执行契约** —— 承 execute::1a3v8nvdfasqs 的统一契约草案 (§3/§4), 以**本仓留痕层
 * 真实数据模型**为准。草案是未过审计的草稿, 与本仓实况冲突处按下述三条以实况为准 (草案自己也
 * 声明「不符则以本契约为目标改造」—— 本测试就是那份改造后的契约):
 *
 * ① 风险级词表用本仓 `CommandRiskTier` (read_only / scoped_write / approval_required / never),
 *    不用草案里猜的 R1/R2/R3 —— 后者在本仓不存在, 编一套映射等于给价表编坐标。
 * ② usage 用本仓五字段 (conductorIn/conductorOut/leavesIn/leavesOut/leavesCacheHit),
 *    不用草案里的 cpu_ms/mem_kb —— 留痕层从不记那两个数, 也没有 duration。
 * ③ 「DAG 全量节点集」(草案 T6/T8 的「含 DAG 全量」) 取自每条记录的 `levels`
 *    (topoLevels 的全 plan 节点 id)—— :memory: 夹具没有 repo 可扫, levels 是留痕层唯一全量拓扑。
 *
 * ⚠ **实现前置① (实现节点的活, 不是本测试的)**: four_grid / two_grid_risk / reuse_rate 都建立在
 * 「能认出**哪些**节点被复用」之上, 而 dag-record 今天只存复用**计数** (`reused` 列)。实现节点须让
 * 留痕层持久化 reused 节点 id 列表 (一条新列, JSON 数组), 否则 not_executed 无从归属风险级 ——
 * 这正是草案 T7「not_executed 只含记录为 reused 的节点」的数据前提。
 * ⚠ **实现前置②**: `scripts/omd-readout.ts` 须导出纯函数 `readout(opts)` 并加 `import.meta.main`
 * 守卫 (先例 scripts/omd-path.ts), 否则本测试 import 它就会执行 CLI 顶层逻辑去读真库。
 *
 * 本测试只碰 :memory: 库 (createDagRecorder({db}): 两个独立 :memory: 连接互不相通, readout 必须
 * 与留痕器共用同一连接才看得见夹具)。契约要求 readout **只读不写** (原任务约束) —— 不靠自报,
 * 「读后状态断言」(排序/limit 那条末尾) 钉的是真证据: readout 之后行数与 schema 原样。
 * ⚠ **spec-first 已知态** (前置② 落地前): scripts/omd-readout.ts 目前是纯 CLI —— 无 import.meta.main
 *   守卫、未导出 readout/ReadoutResult, 本测试 import 它会执行 CLI 顶层 (真读 .omd/dag-runs.db)。
 *   这是**已知且有意**的状态: 本测试就是那份冻结契约, 实现节点落地前置② + readout 后它才转绿;
 *   在此之前本文件 tsc 红、import 会碰真库 —— 别把它当"现在的实况", 它是"实现后的判据"。
 * 零新依赖 (bun:test + bun:sqlite + 仓内模块)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDagRecorder } from './dag-record';
import type { ExecutorDagResult } from './executor-dag-types';
import { CLAIM_CHECK_MIN_NODES, LOOP_NO_MOVE_MIN_N, faceSufficiency, readout, type ReadoutResult } from '../../scripts/omd-readout';

interface FakeNode {
  goal: string;
  executor?: 'command' | 'agent' | 'inproc';
  command?: string;
}
interface FakeOpts {
  planName: string;
  plan: Record<string, FakeNode>;
  done?: string[];
  failed?: { id: string; failureKind: string }[];
  /** 缺席 = 这条链没报复用 → 留痕落 NULL (没记, 不是 0)。 */
  reused?: string[];
  usage?: { conductorIn?: number; conductorOut?: number; leavesIn?: number; leavesOut?: number; leavesCacheHit?: number };
}

const nodeKind = (n: FakeNode | undefined): string => n?.executor ?? 'inproc';

/** 最小可记的一张图结果 (只填 record 真读的那几个字段; 同 dag-record.test.ts 的 fakeResult)。 */
const fakeResult = (o: FakeOpts): ExecutorDagResult => {
  const results: Record<string, unknown> = {};
  for (const id of o.done ?? []) {
    results[id] = { id, kind: nodeKind(o.plan[id]), status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } };
  }
  for (const f of o.failed ?? []) {
    results[f.id] = { id: f.id, kind: nodeKind(o.plan[f.id]), status: 'failed', failureKind: f.failureKind, deps: [], output: '', usage: { in: 0, out: 0 } };
  }
  return {
    plan: { name: o.planName, nodes: o.plan },
    levels: [Object.keys(o.plan)],
    results,
    ...(o.reused ? { reusedNodes: o.reused } : {}),
    usage: {
      conductor: { in: o.usage?.conductorIn ?? 0, out: o.usage?.conductorOut ?? 0 },
      leavesIn: o.usage?.leavesIn ?? 0,
      leavesOut: o.usage?.leavesOut ?? 0,
      leavesCacheHit: o.usage?.leavesCacheHit ?? 0,
    },
  } as unknown as ExecutorDagResult;
};

/**
 * 夹具 (最小但完整): 五个 run, 七条记录。
 *
 *  · run-A (dag_goal): 契约段 + 执行段两条、**同一节点集** (真实 goal 两段跑同一张图,
 *    dag-record.test.ts 先例) —— 并集归并 / usage 求和 / 成功只计一次的主语; 收尾时回填
 *    criteria {judge:true, oracle:false} (判据轴, 见 dag-record.ts:updateCriteria)。
 *  · run-B (dag_resume): resume 链两条 —— 第二段**复用**第一段执行过的 x (跨记录归属风险级),
 *    z 在 plan 里但从未执行也从未复用 → 缺席 (四格「未记」)。
 *  · run-C: entry 没传 (→ NULL) + reusedNodes 缺席 (→ NULL) + usage 记了全 0。
 *  · run-D (dag_run): gate-rejected → run 级 blocked —— N5 词表里与 not-converged 相邻但
 *    下一步相反的那一格, 不许被塌成 failure。
 *  · old-1: 逐字模拟 2026-07-31 之前的老行 (就地补列后 outcome/criteria/entry/reused 全 NULL,
 *    run_id 也是 NULL —— 与补列前的实况一致)。
 */
const makeFixture = () => {
  const db = new Database(':memory:');
  const rec = createDagRecorder({ db });
  rec.record(
    fakeResult({
      planName: 'goal-contract',
      plan: { g1: { goal: 'x', executor: 'command', command: 'ls' }, g2: { goal: 'y', executor: 'agent' } },
      done: ['g1', 'g2'],
      reused: [],
      usage: { conductorIn: 10, conductorOut: 20, leavesIn: 300, leavesOut: 50, leavesCacheHit: 120 },
    }),
    { runId: 'run-A', entry: 'dag_goal', now: 1000 },
  );
  rec.record(
    fakeResult({
      planName: 'goal-execute',
      plan: { g1: { goal: 'x', executor: 'command', command: 'ls' }, g2: { goal: 'y', executor: 'agent' } },
      done: ['g1', 'g2'],
      reused: [],
      usage: { conductorIn: 10, conductorOut: 20, leavesIn: 700, leavesOut: 150, leavesCacheHit: 400 },
    }),
    { runId: 'run-A', entry: 'dag_goal', now: 2000 },
  );
  // 判据轴 (N9): 冻结判据在整趟 goal 收尾时才回填, 两条记录写同一份 (dag-record.ts:updateCriteria)。
  rec.updateCriteria('run-A', { judge: true, oracle: false });
  rec.record(
    fakeResult({
      planName: 'resume-1',
      plan: { x: { goal: 'a', executor: 'command', command: 'ls' }, y: { goal: 'b', executor: 'command', command: 'bun test' } },
      done: ['x', 'y'],
      reused: [],
      usage: { leavesIn: 100, leavesOut: 30 },
    }),
    { runId: 'run-B', entry: 'dag_resume', now: 3000 },
  );
  rec.record(
    fakeResult({
      planName: 'resume-2',
      plan: {
        x: { goal: 'a', executor: 'command', command: 'ls' },
        y: { goal: 'b', executor: 'command', command: 'bun test' },
        z: { goal: 'c', executor: 'command', command: 'codegraph' },
      },
      done: ['y'],
      reused: ['x'],
      usage: { leavesIn: 50, leavesOut: 10 },
    }),
    { runId: 'run-B', entry: 'dag_resume', now: 4000 },
  );
  rec.record(
    fakeResult({
      planName: '图C',
      plan: { f1: { goal: 'x', executor: 'command', command: 'ls' } },
      failed: [{ id: 'f1', failureKind: 'assert-failed' }],
      usage: { leavesIn: 0, leavesOut: 0 },
    }),
    { runId: 'run-C', now: 5000 }, // entry 缺席 → NULL (调用方没接入口轴)
  );
  rec.record(
    fakeResult({
      planName: '图D',
      plan: { d1: { goal: 'x', executor: 'command', command: 'ls' } },
      failed: [{ id: 'd1', failureKind: 'gate-rejected' }],
      usage: { leavesIn: 0, leavesOut: 0 },
    }),
    { runId: 'run-D', entry: 'dag_run', now: 5500 },
  );
  // 老行: 建表后逐列 ALTER 出来的 NULL, 逐字复刻迁移后实况 (nodes 形状同 recorder 写的)。
  db.run(
    `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
     VALUES ('old-1', 6000, '老图', 1, NULL, NULL, NULL, '[[\"old1\"]]', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    [
      JSON.stringify([{ id: 'old1', kind: 'command', status: 'done', deps: [], command: 'ls' }]),
      JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }),
    ],
  );
  return { db, readoutNow: (): ReadoutResult => readout({ db }) };
};

describe('omd-readout · runId 归并 (草案 §4)', () => {
  test('契约段 + 执行段: usage 各字段独立求和, attempts=2, 一条 run 而非两条', () => {
    const { readoutNow } = makeFixture();
    const a = readoutNow().runs.find((x) => x.run_id === 'run-A')!;
    expect(a.attempts).toBe(2);
    expect(a.first_at).toBe(1000);
    expect(a.last_at).toBe(2000);
    expect(a.status).toBe('success');
    expect(a.usage).toEqual({ conductorIn: 20, conductorOut: 40, leavesIn: 1000, leavesOut: 200, leavesCacheHit: 520 });
    expect(a.usage_unmeasured_attempts).toBe(0); // 留痕层恒写 usage, 夹具里没有 NULL usage
    expect(a.reused).toBe(0); // 两段都记了 0 复用 → 求和仍是 0, 不是 null
  });

  test('成功分母只计一次: 两段都成功的 run-A 在 outcome_distribution 里只占一个 success', () => {
    const { readoutNow } = makeFixture();
    expect(readoutNow().outcome_distribution).toEqual({
      success: 2, 'not-converged': 1, 'oracle-failed': 0, blocked: 1, 'budget-exhausted': 0,
      cancelled: 0, 'infra-error': 0, 'missing-capability': 0, 'not-needed': 0, 'empty-result': 0,
      unclassified: 0, 未记: 1, total: 5,
    });
    // 词表 = RunOutcomeKind 全量 (run-outcome.ts:RUN_OUTCOME_ORDER), 不许塌成 success/failure 两桶;
    // total = 去重后的 run_id 数 (5), 不是记录数 (7) —— 一次 goal 两段不数成两次。
  });
});

describe('omd-readout · NULL/缺席 ≠ 0, 已记录的 0 仍是 0 (草案 §5)', () => {
  test('reused: 没记 → null, 记了 0 → 0, 两段相加 → 和', () => {
    const { readoutNow } = makeFixture();
    const runs = readoutNow().runs;
    const byId = (id: string) => runs.find((x) => x.run_id === id)!;
    expect(byId('run-A').reused).toBe(0); // 记了且零复用
    expect(byId('run-B').reused).toBe(1); // 0 + 1 求和
    expect(byId('run-C').reused).toBeNull(); // reusedNodes 缺席 → 没记, 不许编 0
    expect(byId('run-D').reused).toBeNull(); // 同上
    expect(byId('(no-runid):old-1').reused).toBeNull();
  });

  test('outcome 缺席 → 状态「未记」; usage 记的 0 保持 0 且 usage 不为 null', () => {
    const { readoutNow } = makeFixture();
    const runs = readoutNow().runs;
    const old = runs.find((x) => x.run_id === '(no-runid):old-1')!;
    expect(old.status).toBe('未记'); // outcome NULL 不是 failure, 也不是 success
    expect(old.usage).toEqual({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 });
    const c = runs.find((x) => x.run_id === 'run-C')!;
    expect(c.status).toBe('not-converged'); // assert-failed → not-converged (run-outcome.ts), 词表原样不塌成 failure
    expect(c.usage).not.toBeNull();
    expect(c.usage!.leavesIn).toBe(0); // 记的 0, 不是 null
    const d = runs.find((x) => x.run_id === 'run-D')!;
    expect(d.status).toBe('blocked'); // gate-rejected → blocked —— 与 not-converged 分得开 (停止轴)
  });
});

describe('omd-readout · entry 分组 (2026-08-02 入口轴)', () => {
  test('不同 entry 完全分组, 缺席 entry 单列「未记」', () => {
    const { readoutNow } = makeFixture();
    const r = readoutNow();
    // fixture 写的是**旧词** (dag_goal/dag_run) —— 断言新词 (solve/run) 正是在钉读侧归一合并 (t7)。
    expect(r.entry_distribution).toEqual([
      { entry: 'solve', runs: 1, attempts: 2 }, // run-A 的两段合成一次 goal (旧词 dag_goal 归一)
      { entry: 'dag_resume', runs: 1, attempts: 2 }, // run-B 的两条 resume 链 (表外, 原样)
      { entry: '未记', runs: 2, attempts: 2 }, // run-C (没传 entry) + 老行 —— 各自成 run, 不互相合并
      { entry: 'run', runs: 1, attempts: 1 }, // run-D (闸拒 → blocked); 顺序 = 首次出现 (created_at)
    ]);
    // runs[] 里每个 run 也带 entry; 没记 entry 的用「未记」, 不编一个 'unknown'。
    expect(r.runs.filter((x) => x.entry === '未记').map((x) => x.run_id)).toEqual(['run-C', '(no-runid):old-1']);
  });
});

describe('omd-readout · criteria 四格 (草案 T6)', () => {
  test('四格互相独立, 和 = DAG 节点总数 (含缺席); reused 优先于 executed 归类', () => {
    const { readoutNow } = makeFixture();
    const g = readoutNow().criteria_grid.four_grid;
    expect(g).toEqual({ executed_success: 4, executed_failure: 2, reused_success: 1, 未记: 1 });
    // 节点全集: g1,g2,x,y,z,f1,d1,old1 = 8 —— 同 id 跨记录只算一格 (并集, 不按记录求和):
    //   g1/g2 在 run-A 两段都执行、y 在 run-B 两段都执行 → 各只算一格; x 复用优先
    //   (seg2 复用, seg1 执行过也归 reused); z 缺席进「未记」; f1/d1 失败。
    expect(g.executed_success + g.executed_failure + g.reused_success + g.未记).toBe(8);
  });
});

describe('omd-readout · 两个风险格 (草案 T7)', () => {
  test('每级一行 executed/not_executed; not_executed 只含记录为 reused 的节点', () => {
    const { readoutNow } = makeFixture();
    expect(readoutNow().criteria_grid.two_grid_risk).toEqual([
      { risk_level: 'read_only', executed: 4, not_executed: 1 }, // g1, f1, d1, old1 执行 · x 复用 (级从 run-B 第一段解析)
      { risk_level: 'scoped_write', executed: 1, not_executed: 0 }, // y
      { risk_level: 'approval_required', executed: 0, not_executed: 0 },
      { risk_level: 'never', executed: 0, not_executed: 0 },
    ]);
    // ⚠ 口径 (审查 F3, 与现有 CLI 一致): 风险级 = commandRiskTier(command) 的纯函数 →
    //   风险格**只统计带 command 的节点**; agent/inproc (g2) 不入格, 但它们在 four_grid 里照数,
    //   不许静默丢。z 缺席 → 归四格「未记」, 不许混进 not_executed (T7)。
  });
});

describe('omd-readout · 判据一致性: {judge, oracle} 四格 (原任务 ③)', () => {
  test('按 runId 去重数, 缺席单列 unrecorded; 不一致的两格单独标', () => {
    const { readoutNow } = makeFixture();
    const r = readoutNow();
    expect(r.criteria_consistency).toEqual({
      agree: 0, oracleFailed: 1, wastedRounds: 0, agreeFail: 0, unrecorded: 4, recorded: 1,
    });
    // run-A (goal): 回填 {judge:true, oracle:false} → judge 说成了而验收命令没过 =
    //   「判据说了不算」(judge 太松)。两条记录同一份 → 按 runId 去重只数 1, 不许按行数数成 2。
    // 其余 4 个 run (dag_resume / dag_run / 没接 entry / 老行) 没有两条判据 → unrecorded,
    //   不编 false/false (三态纪律, 同 dag-record.test.ts)。
    expect(r.runs.find((x) => x.run_id === 'run-A')!.criteria).toEqual({ judge: true, oracle: false });
    expect(r.runs.find((x) => x.run_id === '(no-runid):old-1')!.criteria).toBeNull();
  });
});

describe('omd-readout · 复用率 (草案 T8)', () => {
  test('分子 = 记录为 reused 的节点, 分母 = DAG 全量节点 (含未记); 空世界 rate = null', () => {
    const { readoutNow } = makeFixture();
    expect(readoutNow().reuse_rate).toEqual({ reused_nodes: 1, total_nodes: 8, rate: 1 / 8 });
    // 空世界: 建了表但一条记录都没有 → 分母 0, rate 是 null 不是 0 (草案 T14 的空世界是成功)。
    const emptyDb = new Database(':memory:');
    createDagRecorder({ db: emptyDb });
    const empty = readout({ db: emptyDb });
    expect(empty.runs).toEqual([]);
    expect(empty.outcome_distribution).toEqual({
      success: 0, 'not-converged': 0, 'oracle-failed': 0, blocked: 0, 'budget-exhausted': 0,
      cancelled: 0, 'infra-error': 0, 'missing-capability': 0, 'not-needed': 0, 'empty-result': 0,
      unclassified: 0, 未记: 0, total: 0,
    });
    expect(empty.entry_distribution).toEqual([]);
    expect(empty.criteria_grid.four_grid).toEqual({ executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 });
    expect(empty.criteria_consistency).toEqual({ agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 });
    expect(empty.criteria_grid.two_grid_risk).toEqual([
      { risk_level: 'read_only', executed: 0, not_executed: 0 },
      { risk_level: 'scoped_write', executed: 0, not_executed: 0 },
      { risk_level: 'approval_required', executed: 0, not_executed: 0 },
      { risk_level: 'never', executed: 0, not_executed: 0 },
    ]);
    expect(empty.reuse_rate).toEqual({ reused_nodes: 0, total_nodes: 0, rate: null });
  });
});

describe('omd-readout · cost-per-success (原任务 ①, 2026-08-02 补)', () => {
  test('按 entry 分层, 分母按 run 去重: run-A 两条记录 = 1 个 success, usage 求和后除', () => {
    const { readoutNow } = makeFixture();
    const cs = readoutNow().cost_per_success;
    // 顺序与 entry_distribution 一致 (首次出现序)。
    expect(cs.map((x) => x.entry)).toEqual(['solve', 'dag_resume', '未记', 'run']); // 旧词已归一 (t7)
    const goal = cs[0]!;
    expect(goal).toEqual({
      entry: 'solve',
      runs: 1,
      success_runs: 1, // 两条记录、一个 success run —— 分母是 run 数不是行数
      unmeasured_runs: 0,
      tokens: { conductorIn: 20, conductorOut: 40, leavesIn: 1000, leavesOut: 200, leavesCacheHit: 520 },
      tokens_per_success: 1260, // 20+40+1000+200; cacheHit 是折扣标记不进分子
    });
  });

  test('0 个 success → tokens_per_success 是 null (算不出), 不是 0; 记了 0 的 usage 仍进和', () => {
    const { readoutNow } = makeFixture();
    const noSuccess = readoutNow().cost_per_success.find((x) => x.entry === '未记')!;
    expect(noSuccess.runs).toBe(2); // run-C + old-1
    expect(noSuccess.success_runs).toBe(0);
    expect(noSuccess.tokens_per_success).toBeNull();
    expect(noSuccess.unmeasured_runs).toBe(0); // 两跑都记了 usage (全 0) —— 记了 0 ≠ 没记
  });

  test('usage 记坏 (按没记处理) 的 run 进 unmeasured_runs, 不被当 0 加进 tokens', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      fakeResult({ planName: 'm', plan: { p1: { goal: 'x' } }, done: ['p1'], usage: { leavesIn: 100, leavesOut: 10 } }),
      { runId: 'm1', entry: 'dag_run', now: 100 },
    );
    // usage 形状坏掉的行 (列恒 NOT NULL, 但记坏了按没记处理 —— readout 的既有防御路径)。
    db.run(
      `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
       VALUES ('m2r', 200, '坏usage', 1, NULL, 'm2', 'dag_run', '[["q1"]]', ?, '{"oops":1}', NULL, 'success', NULL, NULL, NULL)`,
      [JSON.stringify([{ id: 'q1', kind: 'inproc', status: 'done', deps: [] }])],
    );
    const cs = readout({ db }).cost_per_success;
    expect(cs).toHaveLength(1);
    expect(cs[0]).toEqual({
      entry: 'run',
      runs: 2,
      success_runs: 2,
      unmeasured_runs: 1, // m2 的 usage 坏了 → 没记, 不是 0
      tokens: { conductorIn: 0, conductorOut: 0, leavesIn: 100, leavesOut: 10, leavesCacheHit: 0 },
      tokens_per_success: 55, // 110 ÷ 2 —— 分子只含已记的 m1
    });
  });
});

describe('omd-readout · 排序与 limit (草案 §2/§4)', () => {
  test('runs 按 first_at 升序; limit 截断; meta 恒定', () => {
    const { db, readoutNow } = makeFixture();
    expect(readoutNow().runs.map((x) => x.run_id)).toEqual(['run-A', 'run-B', 'run-C', 'run-D', '(no-runid):old-1']);
    const r = readoutNow();
    expect(r.meta.readonly).toBe(true);
    expect(r.meta.limit).toBe(20);
    expect(readout({ db, limit: 2 }).runs.map((x) => x.run_id)).toEqual(['run-A', 'run-B']);
  });

  test('只读不写: readout 之后行数与 schema 原样 (meta.readonly 只是自报, 这里才是真证据)', () => {
    const { db, readoutNow } = makeFixture();
    const count = () => (db.query('SELECT COUNT(*) AS n FROM omd_dag_runs').get() as { n: number }).n;
    const tables = () =>
      (db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    expect(count()).toBe(7); // 五 run 七条记录
    const before = { count: count(), tables: tables() };
    readoutNow();
    readoutNow();
    expect(count()).toBe(before.count); // 没插行
    expect(tables()).toEqual(before.tables); // 没建表
  });
});

describe('闸的分母不搭展示窗口的车 (2026-08-03)', () => {
  /**
   * 上线闸里 G3 要「20 次 live」、G4 要「采样 ≥10 次」, 而 run 表按冻结契约只显示**最早 limit 个**。
   * 两者一旦搭在一起: 历史 run 超过 limit 之后, **以后每跑一次都落在窗口外**, 闸的分母永远停在
   * 同一个数 —— 而板上看不出它停了。2026-08-03 连跑三次 live, `--limit 20` 下 entry 分布一动不动。
   *
   * 这条闸钉的就是「展示归展示, 判据归判据」: 把 limit 收到比 run 数还小, 闸的分母**不许跟着缩**。
   */
  test('limit 缩到 1, G3/G4 分母仍是全量 (窗口只截 runs 表)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    for (let i = 0; i < 4; i++) {
      rec.record(fakeResult({ planName: `图${i}`, plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
        runId: `gr-${i}`,
        entry: 'dag_goal',
        now: 1000 + i,
      });
    }
    const wide = readout({ db, limit: 20 });
    const narrow = readout({ db, limit: 1 });
    expect(narrow.runs.length).toBe(1); // 展示窗口确实缩了
    expect(wide.runs.length).toBe(4);
    // …但闸的分母一个都不许少。
    expect(narrow.gate_denominators.g3LiveRuns).toBe(4);
    expect(narrow.gate_denominators.g3LiveRuns).toBe(wide.gate_denominators.g3LiveRuns);
    expect(narrow.g4_sampling.denominator).toBe(wide.g4_sampling.denominator);
    rec.close();
  });

  test('反向自检: 窗口真的会截 runs 表 (闸不是恒真式)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    for (let i = 0; i < 3; i++) {
      rec.record(fakeResult({ planName: `图${i}`, plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
        runId: `x-${i}`,
        entry: 'dag_run',
        now: 1000 + i,
      });
    }
    expect(readout({ db, limit: 1 }).runs.length).toBe(1);
    expect(readout({ db, limit: 9 }).runs.length).toBe(3);
    rec.close();
  });

  test('ledgerGap: 注入夹具没有盘上兄弟库 → null (不知道), 不编 0', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(fakeResult({ planName: '图', plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
      runId: 'r',
      entry: 'dag_goal',
      now: 1000,
    });
    // 编 0 会把"没查成"说成"没有" —— 本仓 S-12 那条纪律明确禁止。
    expect(readout({ db }).gate_denominators.ledgerGap).toBeNull();
    rec.close();
  });
});

// ── S-1 片d: 建议接受率聚合 (2026-08-04) ─────────────────────────────────────

import { aggregateSuggestionAcceptance } from '../../scripts/omd-readout';
import { renderMapMarkdown as renderForSugg } from './pathfinder/map-store';
import { mkdtempSync as mkdtempSugg, mkdirSync as mkdirSugg, writeFileSync as writeSugg, rmSync as rmSugg } from 'node:fs';
import { tmpdir as tmpdirSugg } from 'node:os';
import { join as joinSugg } from 'node:path';

describe('omd-readout · 建议接受率 (S-1 片d)', () => {
  test('聚合多图 suggestionsLog: rate=(accepted+edited)/decided, deduped 单列; 无处置史 → null', () => {
    const cwd = mkdtempSugg(joinSugg(tmpdirSugg(), 'sugg-acc-'));
    const dir = joinSugg(cwd, 'docs', 'plan', 'pathfinder');
    mkdirSugg(dir, { recursive: true });
    writeSugg(joinSugg(dir, 'a.md'), renderForSugg({
      destination: 'A', slug: 'a', tickets: [], decisionsLog: [],
      suggestionsLog: [
        { ticketId: 's1', outcome: 'accepted', at: 't', runId: 'r1' },
        { ticketId: 's2', outcome: 'edited', at: 't', runId: 'r1' },
        { ticketId: 's3', outcome: 'rejected', at: 't', runId: 'r1' },
        { ticketId: 't0', outcome: 'deduped', at: 't', runId: 'r1' },
      ],
    }));
    writeSugg(joinSugg(dir, 'b.md'), renderForSugg({
      destination: 'B', slug: 'b', tickets: [], decisionsLog: [],
      suggestionsLog: [{ ticketId: 's1', outcome: 'rejected', at: 't', runId: 'r2' }],
    }));
    const sa = aggregateSuggestionAcceptance(cwd)!;
    // t3: pending=0 (fixture 图上无 suggested 存量); dedupe_rate = 1/(1+4+0) = 0.2
    expect(sa).toEqual({ decided: 4, accepted: 1, edited: 1, rejected: 2, deduped: 1, pending: 0, rate: 0.5, dedupe_rate: 0.2 });
    rmSugg(cwd, { recursive: true, force: true });
  });

  test('图目录不存在 / 有图无台账 → null (「没数据」≠ 0%)', () => {
    const cwd = mkdtempSugg(joinSugg(tmpdirSugg(), 'sugg-acc-'));
    expect(aggregateSuggestionAcceptance(cwd)).toBeNull();
    const dir = joinSugg(cwd, 'docs', 'plan', 'pathfinder');
    mkdirSugg(dir, { recursive: true });
    writeSugg(joinSugg(dir, 'a.md'), renderForSugg({ destination: 'A', slug: 'a', tickets: [], decisionsLog: [] }));
    expect(aggregateSuggestionAcceptance(cwd)).toBeNull();
    rmSugg(cwd, { recursive: true, force: true });
  });
});

/**
 * ⑧.5 「声称 vs 引擎记录」检出器的活体读数(2026-08-05)。
 *
 * 这一段的口径**已经错过一次**:交接文里原本写「`observations: []` = 记了零检出,可进分母」——
 * 而 `dag_run` 那条路整张图可以一个 conductor 节点都没有,判据结构上够不着,账本记出来一模一样。
 * 按 entry 数约一半流量因此进错分母,基率会被算低近一倍。所以这里钉的是**分母怎么数**。
 */
describe('omd-readout · ⑧.5 检出器活体读数的分母', () => {
  const withCC = (
    runId: string,
    claimCheck: { conductor: { rounds: number; nodes: number; findings: number }; flat: { nodes: number; findings: number } } | undefined,
    observations?: { kind: string; nodes: string[]; message?: string }[],
  ) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(claimCheck ? { claimCheck } : {}),
        ...(observations ? { observations } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).claim_check;
  };

  test('★ 没记这一位 → 进 unrecorded, **不进分母**(不是零检出)', () => {
    const cc = withCC('r1', undefined);
    expect(cc.recordedRuns).toBe(0);
    expect(cc.unrecordedRuns).toBe(1);
    expect(cc.conductor.rate).toBeNull(); // 算不出 ≠ 0%
    expect(cc.flat.rate).toBeNull();
  });

  test('记了且零检出 → 进分母, 比例是**真的 0%**(与上一条分得开)', () => {
    const cc = withCC('r2', { conductor: { rounds: 1, nodes: 4, findings: 0 }, flat: { nodes: 2, findings: 0 } });
    expect(cc.recordedRuns).toBe(1);
    expect(cc.unrecordedRuns).toBe(0);
    expect(cc.conductor.rate).toBe(0);
    expect(cc.flat.rate).toBe(0);
  });

  test('★ 两面各算各的比例 —— 宽度不同, **不许相加**', () => {
    const cc = withCC('r3', { conductor: { rounds: 2, nodes: 4, findings: 1 }, flat: { nodes: 10, findings: 1 } });
    expect(cc.conductor.rate).toBeCloseTo(0.25, 5);
    expect(cc.flat.rate).toBeCloseTo(0.1, 5);
    // 合并口径 (2/14 ≈ 0.143) 两边都不是 —— 它没有意义, 所以读数板压根不提供这个数。
    expect(cc.conductor.rate).not.toBeCloseTo(2 / 14, 5);
  });

  test('★ 检出原句捞得出来(拨闸靠逐条读它判是不是误伤)', () => {
    const cc = withCC(
      'r4',
      { conductor: { rounds: 1, nodes: 1, findings: 1 }, flat: { nodes: 0, findings: 0 } },
      [{ kind: 'unsupported-claim', nodes: ['n1'], message: '[引擎记录核对 · 只报不拦] n1 有 1 处「本次已由引擎实测通过」' }],
    );
    expect(cc.samples).toHaveLength(1);
    expect(cc.samples[0]!.message).toContain('实测通过');
    expect(cc.samples[0]!.runId).toBe('r4');
  });

  test('别的 kind 的观察不进这段样本(它问的是这一条判据)', () => {
    const cc = withCC(
      'r5',
      { conductor: { rounds: 1, nodes: 1, findings: 0 }, flat: { nodes: 0, findings: 0 } },
      [{ kind: 'loop-no-artifact-change', nodes: ['n1'], message: '盘上没位移' }],
    );
    expect(cc.samples).toEqual([]);
  });

  // ── 样本量门槛 (2026-08-05, **在数据到达之前**钉的) ────────────────────────────
  //
  // 上面那组钉的是「分母怎么数」, 这一组钉的是「分母多大才够下结论」。缺了后者, 读数板在
  // N=2 个节点时也会印出一个 0.0% —— 而等数攒起来再定"多少算够"就是事后编判据 (§五 第 1 条)。
  // 证伪: 把 CLAIM_CHECK_MIN_NODES 改成 0 → 「不足」那两条当场红 (short/enough 全翻)。

  test('★ 样本不足时 enough=false, 且**自己算出还差多少**(不靠人心算)', () => {
    const cc = withCC('r6', { conductor: { rounds: 1, nodes: 4, findings: 0 }, flat: { nodes: 2, findings: 0 } });
    expect(cc.sufficiency.conductor).toEqual({ nodes: 4, short: CLAIM_CHECK_MIN_NODES - 4, enough: false });
    expect(cc.sufficiency.flat).toEqual({ nodes: 2, short: CLAIM_CHECK_MIN_NODES - 2, enough: false });
    // ⚠ 比例照常算得出 —— 「算得出」与「够得着结论」是两件事, 不许把前者当后者。
    expect(cc.flat.rate).toBe(0);
  });

  test('★ 两面**各自**判够不够 —— 一面够了不代表另一面够了', () => {
    const cc = withCC('r7', {
      conductor: { rounds: 1, nodes: CLAIM_CHECK_MIN_NODES, findings: 0 },
      flat: { nodes: 1, findings: 0 },
    });
    expect(cc.sufficiency.conductor.enough).toBe(true);
    expect(cc.sufficiency.conductor.short).toBe(0);
    expect(cc.sufficiency.flat.enough).toBe(false);
  });

  test('边界: 恰好等于门槛就算够 (>=, 不是 >)', () => {
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES).enough).toBe(true);
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES - 1).enough).toBe(false);
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES - 1).short).toBe(1);
  });

  test('没记这一位的跑 → 两面都是 0 节点, 即「不足」而不是「够了且零检出」', () => {
    const cc = withCC('r8', undefined);
    expect(cc.sufficiency.flat).toEqual({ nodes: 0, short: CLAIM_CHECK_MIN_NODES, enough: false });
  });
});

/**
 * ⑧ 段「产物没变」判据的**分母**(2026-08-06)。
 *
 * 与上一段是同一条纪律的第二个实例,而这次错得更久:⑧ 段一直只有分子。判词写着
 * 「长期 0 次 → 别再加检测器」,而"长期"被默读成了**运行次数** —— 可这条判据住在 conductor
 * 内环,一次比较要同时有上一轮 + 两轮都有产物信号。单轮档的 `dag_run` 与首轮即绿的 goal
 * 一次机会都没有,于是 53 跑 0 命中是「够不着」而不是「查过零检出」。
 *
 * 同表其他 kind 有数**不能反证它够得着**:`undeclared-artifact-dep`/`write-race` 是跑前静态判死,
 * `leaf-spin` 在 leaf 自己的工具循环里 —— 三条没有一条经过跨轮那条路。
 */
describe('omd-readout · ⑧ 「产物没变」判据的分母 (2026-08-06)', () => {
  const withAM = (runId: string, artifactMove: { transitions: number; unobserved: number; findings: number } | undefined) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(artifactMove ? { artifactMove } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).artifact_move;
  };

  test('★ 没记这一位 → 进 unrecorded, rate=null(**算不出 ≠ 0%**)', () => {
    const am = withAM('m1', undefined);
    expect(am.recordedRuns).toBe(0);
    expect(am.unrecordedRuns).toBe(1);
    expect(am.rate).toBeNull();
  });

  test('★ 记了但一次跨轮都没发生 → recorded=1 而 comparable=0, rate 仍是 null', () => {
    // 这一格与上一格在旧读数板里长得一模一样 (都只表现为"0 次命中"), 而下一步相反:
    // 上一格要跑一次新的才有数, 这一格已经在说话了 —— 它说的是"这条判据够不着"。
    const am = withAM('m2', { transitions: 0, unobserved: 0, findings: 0 });
    expect(am.recordedRuns).toBe(1);
    expect(am.comparable).toBe(0);
    expect(am.rate).toBeNull();
  });

  test('★ 基率分母是 comparable, **不是** transitions —— 判不了的那些不许充数', () => {
    const am = withAM('m3', { transitions: 10, unobserved: 6, findings: 1 });
    expect(am.comparable).toBe(4);
    expect(am.rate).toBeCloseTo(0.25, 5); // 1/4, 不是 1/10
    expect(am.rate).not.toBeCloseTo(0.1, 5);
  });

  test('★ 三个槽各自判够不够 —— 三个 0 的下一步相反, 不许合成一句「样本不足」', () => {
    // 证伪: 把 LOOP_NO_MOVE_MIN_N 改成 0 → 「不足」那两条当场红 (enough 全翻)。
    const am = withAM('m4', { transitions: LOOP_NO_MOVE_MIN_N, unobserved: LOOP_NO_MOVE_MIN_N, findings: 0 });
    expect(am.sufficiency.transitions.enough).toBe(true); // 轮转够了: population 闸吃掉多少可以判了
    expect(am.sufficiency.comparable.enough).toBe(false); // 但一次都没判得了 → 基率仍不许读
    expect(am.sufficiency.comparable.short).toBe(LOOP_NO_MOVE_MIN_N);
    expect(am.sufficiency.runs.enough).toBe(false); // 才 1 跑
  });

  test('边界: 恰好等于门槛就算够 (>=, 不是 >), 且门槛与 ⑧.5 那个是两个常量', () => {
    expect(faceSufficiency(LOOP_NO_MOVE_MIN_N, LOOP_NO_MOVE_MIN_N).enough).toBe(true);
    expect(faceSufficiency(LOOP_NO_MOVE_MIN_N - 1, LOOP_NO_MOVE_MIN_N).short).toBe(1);
    // 今天两处同数 (同一套比价), 但**各写一个常量** —— 以后其中一个该改时不该拖着另一个。
    expect(faceSufficiency(5, LOOP_NO_MOVE_MIN_N).short).toBe(LOOP_NO_MOVE_MIN_N - 5);
  });
});

/**
 * ⑧.6 运行时写竞争 —— 这条通道 2026-08-06 之前**根本不存在**。
 *
 * 台账把「leaf 级写竞争频率」标成「等读数」,而 ⑧ 段那 4 次 `write-race` 出自 `static-lint`
 * (跑之前按 `output_path` 声明判死的坏 plan)。**同名不同义**,而两者的下一步相反 ——
 * 交接 30 §五 第 2 条。再等也不会有数,因为没有一行代码写它。
 */
describe('omd-readout · ⑧.6 运行时写竞争的分母 (2026-08-06)', () => {
  const withWR = (
    runId: string,
    writeRace:
      | { overlaps: number; pairs: number; findings: number; pairsInferred?: number; findingsInferred?: number }
      | undefined,
  ) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(writeRace ? { writeRace } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).write_race;
  };

  test('★ 没记 → 进 unrecorded, rate=null', () => {
    const wr = withWR('w1', undefined);
    expect(wr.recordedRuns).toBe(0);
    expect(wr.unrecordedRuns).toBe(1);
    expect(wr.rate).toBeNull();
  });

  test('★ 记了但没并发 (overlaps:0) → recorded=1 而 rate 仍是 null —— 与上一格分得开', () => {
    const wr = withWR('w2', { overlaps: 0, pairs: 0, findings: 0 });
    expect(wr.recordedRuns).toBe(1);
    expect(wr.overlaps).toBe(0);
    expect(wr.rate).toBeNull();
  });

  test('★ 撞车基率的分母是 pairs, **不是** overlaps —— 看不见的那部分不许充数', () => {
    const wr = withWR('w3', { overlaps: 10, pairs: 4, findings: 1 });
    expect(wr.rate).toBeCloseTo(0.25, 5); // 1/4, 不是 1/10
    expect(wr.rate).not.toBeCloseTo(0.1, 5);
  });

  test('★ 两个槽各自判 —— 「有并发但看不见谁写了什么」与「有机会但没撞上」下一步不同', () => {
    const wr = withWR('w4', { overlaps: LOOP_NO_MOVE_MIN_N, pairs: 0, findings: 0 });
    expect(wr.sufficiency.overlaps.enough).toBe(true); // 并发这件事本身可以判了
    expect(wr.sufficiency.pairs.enough).toBe(false); // 但一次机会都没有 → 基率仍不许读
  });

  /**
   * **推断口径**(2026-08-06 补:写的可见性)。
   *
   * `filesTouched` 只认受控写工具,于是 command 节点那一路从不填、agent 的 bash 写也隐形 ——
   * 「看不见的那部分」里混着一大块其实**认得出**的写。补上之后两档必须**分得开**:
   * 推断那一档的证据更弱(`a && b > x` 里 a 失败时 x 并没有被写),而升不升闸恰恰要看这个分野。
   */
  test('★ 老行没记推断口径 → null(**没记 ≠ 0**),严格那两个照常读得出', () => {
    const wr = withWR('w5', { overlaps: 5, pairs: 2, findings: 1 });
    expect(wr.pairs).toBe(2);
    expect(wr.pairsInferred).toBeNull();
    expect(wr.findingsInferred).toBeNull();
    expect(wr.rateInferred).toBeNull();
  });

  test('★ 两档分开算 —— 推断口径更宽,而严格那两个**一个字都不许变**', () => {
    // 证伪: 让 readout 把 pairsInferred 累加进 pairs → 这条第一行当场红。
    const wr = withWR('w6', { overlaps: 10, pairs: 2, findings: 0, pairsInferred: 8, findingsInferred: 3 });
    expect(wr.pairs).toBe(2); // 严格: command/bash 那侧看不见
    expect(wr.findings).toBe(0);
    expect(wr.rate).toBe(0); // 严格口径查过零检出
    expect(wr.pairsInferred).toBe(8); // 推断: 把认得出的写并进来
    expect(wr.findingsInferred).toBe(3);
    expect(wr.rateInferred).toBeCloseTo(3 / 8, 5);
    // 这一行是本用例的全部意义: 「只有推断才看得见」的那一块单独有大小, 不许被合并掉
    expect(wr.pairsInferred! - wr.pairs).toBe(6);
  });

  test('★ 记了推断口径且为 0 → 是 0 不是 null(与"老行没记"分得开)', () => {
    const wr = withWR('w7', { overlaps: 3, pairs: 0, findings: 0, pairsInferred: 0, findingsInferred: 0 });
    expect(wr.pairsInferred).toBe(0); // 记了, 只是一次机会都没有
    expect(wr.rateInferred).toBeNull(); // 分母 0 → 算不出
    expect(wr.pairsInferred).not.toBeNull(); // ← 与上面 w5 那条相反, 两格不许被抹平
  });

  test('推断机会也有自己的门槛槽 —— 三个 0 的下一步各不相同', () => {
    const wr = withWR('w8', {
      overlaps: LOOP_NO_MOVE_MIN_N, pairs: 0, findings: 0, pairsInferred: LOOP_NO_MOVE_MIN_N, findingsInferred: 0,
    });
    expect(wr.sufficiency.overlaps.enough).toBe(true);
    expect(wr.sufficiency.pairs.enough).toBe(false); // 严格口径仍不够
    expect(wr.sufficiency.pairsInferred.enough).toBe(true); // 推断口径够了 → 那一档的基率可以读
  });
});

/**
 * ⑧.1 内环的形状(2026-08-06)—— 「⑧ 那个 0 为什么是 0」的分母。
 *
 * ⑧ 段补上分母之后判词说「轮转次数 ≈ 0 → 瓶颈是环只转一圈」,而那句话把**四件下一步不同
 * 的事**并成了一个括号:① 图里没有 conductor(判据不适用)② `max_rounds` 缺省 1(结构上
 * 没机会)③ 多轮档首轮收敛(检测器没有付费对象)④ 转了却提前退环(该查别处)。
 *
 * 本段每条钉的都是**某两格不许互相冒充**。整段的反向自检在 `dag-record.test.ts` 那四条上:
 * 留痕层一旦拿 `?? 1` 把「不知道」补成「单轮档」,这里的 ② 与「没记」就永久分不开了。
 */
describe('omd-readout · ⑧.1 内环的形状 (2026-08-06)', () => {
  /** 一个只含指定 conductor 形状的最小世界。`c` 缺席 = plan 里没有这个 id(map 动态扇出)。 */
  const world = (
    nodes: { id: string; kind: string; rounds?: number; inPlan?: { max_rounds?: number } }[],
  ): ReadoutResult['loop_shape'] => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const plan: Record<string, unknown> = {};
    const results: Record<string, unknown> = {};
    for (const n of nodes) {
      if (n.inPlan) plan[n.id] = { goal: 'x', ...n.inPlan };
      results[n.id] = {
        id: n.id, kind: n.kind, status: 'done', deps: [], output: '', usage: { in: 0, out: 0 },
        ...(n.rounds === undefined ? {} : { rounds: n.rounds }),
      };
    }
    rec.record(
      {
        plan: { name: 'p', nodes: plan },
        levels: [nodes.map((n) => n.id)],
        results,
        reusedNodes: [],
        usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      } as unknown as ExecutorDagResult,
      { runId: 'ls', entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).loop_shape;
  };

  test('★ ① 图里没有 conductor → 这一跑进 runsWithoutConductor, **不进任何一格分母**', () => {
    // 这一格是四格里唯一**可回溯**的 (只看 kind) —— 2026-08-06 实测 54 跑里 33 跑是它。
    const ls = world([{ id: 'a', kind: 'agent', inPlan: {} }]);
    expect(ls.runsWithoutConductor).toBe(1);
    expect(ls.runsWithConductor).toBe(0);
    expect(ls.conductorNodes).toBe(0);
  });

  test('★ ② max_rounds=1 (缺省) → singleRound。**结构上**没有跨轮比较的机会', () => {
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 1, inPlan: {} }]);
    expect(ls.singleRound).toBe(1);
    expect(ls.firstRoundConverged).toBe(0);
    expect(ls.turned).toBe(0);
    expect(ls.unrecordedNodes).toBe(0);
  });

  test('★ ③ 多轮档而首轮就收敛 → firstRoundConverged, **不是** singleRound', () => {
    // 这两格的下一步相反: ② 是"缺省值掐死了判据", ③ 是"判据没有付费对象"的正面证据。
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 1, inPlan: { max_rounds: 3 } }]);
    expect(ls.firstRoundConverged).toBe(1);
    expect(ls.singleRound).toBe(0);
  });

  test('★ ④ 真转了第二圈 → turned。⑧ 的机会只可能出自这一格', () => {
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 2, inPlan: { max_rounds: 4 } }]);
    expect(ls.turned).toBe(1);
    expect(ls.firstRoundConverged).toBe(0);
  });

  test('★ 「没记」不许被念成「单轮档」—— 缺任一位就进 unrecordedNodes', () => {
    // 本段最重要的一条。老行 (2026-08-06 之前) 与 conductor 异常退出都落这一格, 而它与 ②
    // 在旧读数板里长得一模一样: 都表现为"⑧ 一次机会都没有"。下一步却相反 ——
    // 「没记」要跑一次新的, 「单轮档」已经在说话了。
    const ls = world([
      { id: 'c1', kind: 'conductor', inPlan: { max_rounds: 2 } }, // 没报 rounds (异常退出)
      { id: 'c2', kind: 'conductor', rounds: 1 }, // plan 里没有它 → 上限不知道
    ]);
    expect(ls.unrecordedNodes).toBe(2);
    expect(ls.singleRound).toBe(0);
    expect(ls.firstRoundConverged).toBe(0);
    expect(ls.turned).toBe(0);
  });

  test('四格之和 = conductorNodes (不重不漏 —— 一个节点只落一格)', () => {
    const ls = world([
      { id: 'a', kind: 'agent', inPlan: {} },
      { id: 'c1', kind: 'conductor', rounds: 1, inPlan: {} },
      { id: 'c2', kind: 'conductor', rounds: 1, inPlan: { max_rounds: 3 } },
      { id: 'c3', kind: 'conductor', rounds: 3, inPlan: { max_rounds: 3 } },
      { id: 'c4', kind: 'conductor', inPlan: { max_rounds: 3 } },
    ]);
    expect(ls.conductorNodes).toBe(4);
    expect(ls.singleRound + ls.firstRoundConverged + ls.turned + ls.unrecordedNodes).toBe(ls.conductorNodes);
    expect([ls.singleRound, ls.firstRoundConverged, ls.turned, ls.unrecordedNodes]).toEqual([1, 1, 1, 1]);
  });
});

describe('omd-readout · 消耗口径分桶 (LoopX 对照, 2026-08-05)', () => {
  /** 一个只含指定 outcome 的最小世界 (每 run 一条记录, 一个节点)。 */
  const world = (runs: { runId: string; failureKind?: string; tokens: number | null }[]): ReadoutResult => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    let now = 1000;
    for (const r of runs) {
      now += 100;
      if (r.tokens === null) {
        // usage 列恒 NOT NULL, 「没记」在本仓的实况是**记坏了** —— 走 readout 既有的那条防御路径
        // (先例: 上面「usage 记坏」那条)。这一格量的是"分不出成本的 run", 不是 0 成本的 run。
        db.run(
          `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
           VALUES (?, ?, '图-null', 1, NULL, ?, 'dag_run', '[["n1"]]', ?, '{"oops":1}', NULL, 'success', NULL, NULL, NULL)`,
          [r.runId, now, r.runId, JSON.stringify([{ id: 'n1', kind: 'command', status: 'done', deps: [], command: 'ls' }])],
        );
        continue;
      }
      rec.record(
        fakeResult({
          planName: `图-${r.runId}`,
          plan: { n1: { goal: 'x', executor: 'command', command: 'ls' } },
          ...(r.failureKind ? { failed: [{ id: 'n1', failureKind: r.failureKind }] } : { done: ['n1'] }),
          usage: { leavesIn: r.tokens },
        }),
        { runId: r.runId, entry: 'dag_run', now },
      );
    }
    return readout({ db });
  };

  test('分桶只从 RUN_OUTCOME_INFO 读; 「未记」单列第五桶, 不并进 unclassified', () => {
    const { readoutNow } = makeFixture();
    const b = readoutNow().spend_discipline.buckets;
    // run-A/run-B success + run-C not-converged → delivery 3 run; run-D blocked; old-1 outcome 列 NULL → 未记。
    expect(b.delivery).toEqual({ runs: 3, tokens: 1450, unmeasured_runs: 0 });
    expect(b.blocked).toEqual({ runs: 1, tokens: 0, unmeasured_runs: 0 });
    expect(b['未记'].runs).toBe(1);
    // 「这条记录没有这个字段」不是「引擎没交代」—— 编成同一桶就再也分不开。
    expect(b.unclassified.runs).toBe(0);
  });

  test('两个口径并排: overhead 的钱不进新分子, 差额 = overhead tokens', () => {
    const sd = world([
      { runId: 'ok', tokens: 100 },
      { runId: 'boom', failureKind: 'stall', tokens: 900 }, // stall → infra-error → overhead
    ]).spend_discipline;
    expect(sd.buckets.delivery.tokens).toBe(100);
    expect(sd.buckets.overhead.tokens).toBe(900);
    expect(sd.success_runs).toBe(1);
    expect(sd.tokens_per_success_all).toBe(1000);      // 老口径: 一次 429 让"每次成功"贵了 10 倍
    expect(sd.tokens_per_success_delivery).toBe(100);  // 新口径: 引擎效率本身
    expect(sd.overhead_share).toBe(0.9);
    expect(sd.blocked_share).toBe(0);
  });

  test('反向自检: 分桶失效则两口径必然重合 —— 没有 overhead 的世界里它们相等', () => {
    // 上一条断言"两数不等"只有在这一条成立时才有意义: 它证明差额是**分桶造出来的**,
    // 不是一个恒不等的式子。分桶要是塌了 (全归 delivery), 上一条会红而这一条照绿。
    const sd = world([
      { runId: 'ok1', tokens: 100 },
      { runId: 'ok2', tokens: 300 },
    ]).spend_discipline;
    expect(sd.buckets.overhead.tokens).toBe(0);
    expect(sd.tokens_per_success_all).toBe(sd.tokens_per_success_delivery);
  });

  test('usage 没记的 run 进 unmeasured_runs, 不被当 0 加进 tokens', () => {
    const sd = world([
      { runId: 'ok', tokens: 200 },
      { runId: 'nousage', tokens: null },
    ]).spend_discipline;
    expect(sd.buckets.delivery).toEqual({ runs: 2, tokens: 200, unmeasured_runs: 1 });
  });

  test('0 success → 两个每-success 都是 null (算不出 ≠ 0); 空世界三个比率全 null', () => {
    const sd = world([{ runId: 'boom', failureKind: 'stall', tokens: 900 }]).spend_discipline;
    expect(sd.success_runs).toBe(0);
    expect(sd.tokens_per_success_all).toBeNull();
    expect(sd.tokens_per_success_delivery).toBeNull();
    expect(sd.overhead_share).toBe(1); // 分母非 0, 这个数算得出来

    const empty = world([]).spend_discipline;
    expect(empty.total_tokens).toBe(0);
    expect(empty.overhead_share).toBeNull();
    expect(empty.blocked_share).toBeNull();
  });
});

describe('omd-readout · 注意力轴 (LoopX 对照, 2026-08-05)', () => {
  test('踢回率来自 outcome 分布; 没给 mapsCwd → 票的三个数是 null (不知道), 不编 0', () => {
    const { readoutNow } = makeFixture();
    const aa = readoutNow().attention_axis;
    // 夹具 5 跑里 run-D 是 blocked —— 环把球踢回给 owner 的那一格。
    expect(aa.blocked_runs).toBe(1);
    expect(aa.total_runs).toBe(5);
    expect(aa.handback_rate).toBe(0.2);
    // 没给 mapsCwd = 没看图, 不是"图上没有票"。
    expect(aa.pending_tickets).toBeNull();
    expect(aa.decided_tickets).toBeNull();
    expect(aa.wasted_review_share).toBeNull();
  });

  test('空世界: 踢回率 null (算不出 ≠ 0%) —— 0 次踢回与没量过不是一回事', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const aa = readout({ db }).attention_axis;
    expect(aa.total_runs).toBe(0);
    expect(aa.handback_rate).toBeNull();
  });
});
