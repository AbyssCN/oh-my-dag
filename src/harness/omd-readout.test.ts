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
import { readout, type ReadoutResult } from '../../scripts/omd-readout';

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
    expect(r.entry_distribution).toEqual([
      { entry: 'dag_goal', runs: 1, attempts: 2 }, // run-A 的两段合成一次 goal
      { entry: 'dag_resume', runs: 1, attempts: 2 }, // run-B 的两条 resume 链
      { entry: '未记', runs: 2, attempts: 2 }, // run-C (没传 entry) + 老行 —— 各自成 run, 不互相合并
      { entry: 'dag_run', runs: 1, attempts: 1 }, // run-D (闸拒 → blocked); 顺序 = 首次出现 (created_at)
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
    expect(cs.map((x) => x.entry)).toEqual(['dag_goal', 'dag_resume', '未记', 'dag_run']);
    const goal = cs[0]!;
    expect(goal).toEqual({
      entry: 'dag_goal',
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
      entry: 'dag_run',
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
