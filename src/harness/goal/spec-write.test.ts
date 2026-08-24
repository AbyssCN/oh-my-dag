/**
 * spec-write —— 「契约段有没有产出 spec 文件」这一位的**当时记账** (#209, 2026-08-19)。
 *
 * 这一位为什么不能事后量: 隔离档跑完 worktree 就被清, 分支合进 main 之后
 * `main..omd/run/<id>` 的新增也归零 —— 两个信号同时消失; 而扫基座树数到的是它**本来就有的**
 * 145 份 `docs/plan/*.md`。为裁 #177 量这一位时连错三次, 最后只有 n=2 可量。
 *
 * 本文件钉三件事, 每件都能红:
 *  ① **三值不是布尔**: 有 spec / 无 spec / 该档不跑契约段, 第四格 (列 NULL = 没记) 由账本表达。
 *     把 `missing` 与 `not-needed` 合成一个假值 → 用例红。
 *  ② **反向自检 (判据 ③a)**: 契约段跑了但没产出文件 → `missing`, 不是 `wrote` 也不是缺席。
 *  ③ **时机就是判据 (判据 ③b)**: 记账发生在 execute 段**之前**, 且判定原料是执行期事实 ——
 *     盘上文件在记账那一刻已经不存在 (worktree 被清的模拟), 账本照样记 `wrote`。
 *     把写入点挪到整趟收尾之后 / 改成 `existsSync` 扫盘 → 那两条当场红。
 *
 * 账本侧 (列迁移 / entry 归属 / 坏 JSON / 回填) 与 dag-record.acceptance-probe.test.ts 同一套姿势:
 * 注入 `new Database(':memory:')`, 生产路径写, 原始 SQL 只用来验持久化值与手工造坏行。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagRecorder, recordDagRun } from '../dag/dag-record';
import type { ExecutorDagResult, ExecutorDagConfig } from '../dag/types';
import type { AgentLeafRunner } from '../leaf-runners';
import { runGoal, type RunGoalConfig } from './run-goal';
import { classifySpecWrite, isSpecWrite, type SpecWrite } from './spec-write';

// ── 纯核 ────────────────────────────────────────────────────────────────────────

describe('classifySpecWrite —— 三值矩阵', () => {
  test('契约段跑了: 有 path → wrote (带 path); 无 path → missing', () => {
    expect(classifySpecWrite('contract', '/tmp/a.md')).toEqual({ kind: 'wrote', source: 'contract', path: '/tmp/a.md' });
    expect(classifySpecWrite('contract', undefined)).toEqual({ kind: 'missing', source: 'contract' });
  });

  test('不跑契约段的两条路 → not-needed, 且**即使**传了 path 也不记 wrote (它不是这一跑产的)', () => {
    expect(classifySpecWrite('tier-simple', undefined)).toEqual({ kind: 'not-needed', source: 'tier-simple' });
    expect(classifySpecWrite('no-agent-runner', '/tmp/a.md')).toEqual({ kind: 'not-needed', source: 'no-agent-runner' });
  });

  test('missing ≠ not-needed —— 下一步相反 (前者要人看一眼契约段为什么空手而归)', () => {
    expect(classifySpecWrite('contract', undefined).kind).not.toBe(classifySpecWrite('tier-simple', undefined).kind);
  });

  test('isSpecWrite: 词表外 kind / 缺 path / 非对象 → 假 (账本据此按"没记"读)', () => {
    expect(isSpecWrite({ kind: 'wrote', source: 'contract', path: 'p' })).toBe(true);
    expect(isSpecWrite({ kind: 'wrote', source: 'contract' })).toBe(false); // wrote 必须带 path
    expect(isSpecWrite({ kind: 'unknown', source: 'contract' })).toBe(false); // 'unknown' 这一格不存在
    expect(isSpecWrite({ kind: 'not-needed', source: 'contract' })).toBe(false); // not-needed 只有两条来源
    expect(isSpecWrite(null)).toBe(false);
    expect(isSpecWrite('wrote')).toBe(false);
  });
});

// ── run-goal 侧: 谁在什么时候产出这一位 ──────────────────────────────────────────

/** 执行段的假图 (内环判收敛) —— 与 acceptance-probe.test.ts 同款。 */
const fakeExecuteDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      execute: { id: 'execute', status: 'done', kind: 'conductor', output: '[conductor 子图]', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 契约段的假图: `filesTouched` 就是判 wrote 的**执行期事实** (给 [] = 跑了但空手而归)。 */
const fakeContractDag = (filesTouched: string[]): ExecutorDagResult =>
  ({
    plan: { name: 'goal-contract', nodes: {} },
    results: {
      contract: { id: 'contract', status: 'done', kind: 'agent', output: '契约正文', deps: [], usage: { in: 1, out: 1 }, filesTouched },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 契约段任务文本里的 spec 路径占位句式 — 从图上抓 path, 不抄 goalSlug 的实现。 */
const specPathFromPlan = (plan: { nodes: Record<string, { goal?: string }> }): string =>
  /存盘到 (.+?)。/.exec(plan.nodes.contract?.goal ?? '')?.[1] ?? '';

const noopAgentRunner = (async () => ({ text: '', usage: { in: 0, out: 0 }, filesTouched: [] })) as unknown as AgentLeafRunner;

const baseCfg = (over: Partial<ExecutorDagConfig> = {}): Pick<RunGoalConfig, 'cwd' | 'dag' | '_today' | '_classify'> => ({
  cwd: mkdtempSync(join(tmpdir(), 'omd-specwrite-')),
  dag: { conductorModel: 'c:m', ...over } as ExecutorDagConfig,
  _today: () => '2026-08-19',
  _classify: async () => ({ tier: 'complex' as const, acceptance: { kind: 'exploratory' as const, learningGoal: 'x', affordableLoss: 'y' }, acceptanceProbe: { kind: 'exploratory' as const } }),
});

describe('runGoal — onContract 每条路都恰好调一次', () => {
  test('simple 档 → not-needed/tier-simple (压根没有契约段)', async () => {
    const seen: SpecWrite[] = [];
    await runGoal('g', { ...baseCfg(), tier: 'simple', _runDag: async () => fakeExecuteDag(), onContract: (s) => seen.push(s) });
    expect(seen).toEqual([{ kind: 'not-needed', source: 'tier-simple' }]);
  });

  test('complex 档缺 agentRunner → not-needed/no-agent-runner (缺件, 与"不需要"分得开)', async () => {
    const seen: SpecWrite[] = [];
    await runGoal('g', { ...baseCfg(), tier: 'complex', _runDag: async () => fakeExecuteDag(), onContract: (s) => seen.push(s) });
    expect(seen).toEqual([{ kind: 'not-needed', source: 'no-agent-runner' }]);
    // 两条 not-needed 的 source 不同 —— 合并成一个字面量 'not-needed' 就分不出"补配置"与"什么都不用做"。
    expect(seen[0]!.source).not.toBe('tier-simple');
  });

  test('契约段真产出文件 → wrote, path = 契约段任务文本里那一份 (不是猜的)', async () => {
    const seen: SpecWrite[] = [];
    let planPath = '';
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      _runDag: async (plan) => {
        if (plan.name !== 'goal-contract') return fakeExecuteDag();
        planPath = specPathFromPlan(plan as unknown as { nodes: Record<string, { goal?: string }> });
        return fakeContractDag([planPath]);
      },
      onContract: (s) => seen.push(s),
    });
    expect(planPath).toEndWith('.md');
    expect(seen).toEqual([{ kind: 'wrote', source: 'contract', path: planPath }]);
  });

  test('★ 反向自检 (判据 ③a): 契约段跑了但一个文件都没碰 → missing, 不是 wrote 也不是缺席', async () => {
    const seen: SpecWrite[] = [];
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      _runDag: async (plan) => (plan.name === 'goal-contract' ? fakeContractDag([]) : fakeExecuteDag()),
      onContract: (s) => seen.push(s),
    });
    expect(seen).toEqual([{ kind: 'missing', source: 'contract' }]);
  });

  test('契约段抛错 → missing/contract-error (引擎出事 ≠ 跑了空手而归)', async () => {
    const seen: SpecWrite[] = [];
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      _runDag: async (plan) => {
        if (plan.name === 'goal-contract') throw new Error('契约段炸了');
        return fakeExecuteDag();
      },
      onContract: (s) => seen.push(s),
    });
    expect(seen).toEqual([{ kind: 'missing', source: 'contract-error' }]);
  });

  test('★ 时机 (判据 ③b): 回调在 execute 段**之前**发 —— 挪到整趟收尾之后这条红', async () => {
    const order: string[] = [];
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      _runDag: async (plan) => {
        order.push(plan.name === 'goal-contract' ? 'contract-dag' : 'execute-dag');
        return plan.name === 'goal-contract' ? fakeContractDag(['/gone/2026-08-19-x.md']) : fakeExecuteDag();
      },
      onContract: () => order.push('onContract'),
    });
    expect(order).toEqual(['contract-dag', 'onContract', 'execute-dag']);
  });

  test('★ 时机 (判据 ③b): 记账那一刻盘上文件已经不在 (worktree 被清) → 照样 wrote', async () => {
    const seen: SpecWrite[] = [];
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      // 假图只报 filesTouched, **不真写盘** —— 等价于"worktree 已经被清"的那一刻。
      _runDag: async (plan) => (plan.name === 'goal-contract' ? fakeContractDag([specPathFromPlan(plan as unknown as { nodes: Record<string, { goal?: string }> })]) : fakeExecuteDag()),
      onContract: (s) => seen.push(s),
    });
    const w = seen[0] as Extract<SpecWrite, { kind: 'wrote' }>;
    expect(w.kind).toBe('wrote'); // 判定原料是执行期事实, 不是盘上现状
    expect(existsSync(w.path)).toBe(false); // 而盘上确实没有这个文件 —— 改成 existsSync 扫盘就会读成 missing
  });

  test('回调抛错只留痕不掀桌: goal 照常跑完 (记账挂了不该让整趟陪葬)', async () => {
    const r = await runGoal('g', {
      ...baseCfg(),
      tier: 'simple',
      _runDag: async () => fakeExecuteDag(),
      onContract: () => {
        throw new Error('账本挂了');
      },
    });
    expect(r.converged).toBe(true);
  });

  test('不给回调 = 闸缺席: 一行不多跑, 结果逐位照旧', async () => {
    const cfg = { ...baseCfg(), tier: 'simple' as const, _runDag: async () => fakeExecuteDag() };
    const withCb = await runGoal('g', { ...cfg, onContract: () => {} });
    const without = await runGoal('g', cfg);
    expect(without.converged).toBe(withCb.converged);
    expect(without.stages.map((s) => s.stage)).toEqual(withCb.stages.map((s) => s.stage));
  });

  test('SDD 直通 → wrote/sdd-direct (spec 在盘上, 但不是契约段这一跑产的)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-sdd-'));
    const sddPath = join(dir, 'sdd.md');
    writeFileSync(sddPath, '# 契约\n\n## 契约\n做这件事。\n\n## 分解\n1. 做 → verify: `bun test`\n');
    const seen: SpecWrite[] = [];
    await runGoal('写一份契约', {
      ...baseCfg({ agentRunner: noopAgentRunner }),
      tier: 'complex',
      sddPath,
      _runDag: async () => fakeExecuteDag(),
      onContract: (s) => seen.push(s),
    });
    expect(seen).toEqual([{ kind: 'wrote', source: 'sdd-direct', path: sddPath }]);
  });
});

// ── 账本侧: 列迁移 / entry 归属 / 坏 JSON / 回填 ────────────────────────────────

const fakeResult = (planName: string): ExecutorDagResult =>
  ({
    plan: { name: planName, nodes: { a: { goal: 'x' } } },
    levels: [['a']],
    results: { a: { id: 'a', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
    reusedNodes: [],
    usage: { conductor: { in: 10, out: 20 }, leavesIn: 100, leavesOut: 50, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

const rawSpec = (db: Database, id: string): string | null =>
  (db.query(`SELECT spec_write FROM omd_dag_runs WHERE id = ?`).get(id) as { spec_write: string | null }).spec_write;

describe('账本 spec_write 列', () => {
  test('迁移: 老库无此列 → createDagRecorder 就地补, 老行读回「没记」(不是"没写入磁盘")', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL, node_count INTEGER NOT NULL,
      question TEXT, run_id TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL,
      observations TEXT, outcome TEXT, verification TEXT, reused INTEGER, criteria TEXT, entry TEXT, acceptance_probe TEXT)`);
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, run_id, entry, levels, nodes, usage)
            VALUES ('old', 1, '老图', 1, 'g-old', 'solve', '[]', '[]', '{}')`);
    const rec = createDagRecorder({ db });
    expect((db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name)).toContain('spec_write');
    expect(rec.get('old')!.specWrite).toBeUndefined(); // 没记 —— 不编一个 missing
    expect(rawSpec(db, 'old')).toBeNull();
    rec.close();
  });

  test('正向: entry=solve 经生产 recordDagRun 存盘, 三种 kind 逐字 round-trip, 紧凑 JSON 无双编码', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const all: SpecWrite[] = [
      { kind: 'wrote', source: 'contract', path: '/repo/docs/plan/2026-08-19-x.md' },
      { kind: 'missing', source: 'contract' },
      { kind: 'not-needed', source: 'tier-simple' },
    ];
    for (const [i, sw] of all.entries()) {
      await recordDagRun(rec, { runId: `r-${i}`, entry: 'solve', specWrite: sw })(fakeResult('goal-execute'));
      const [row] = rec.listByRun(`r-${i}`);
      expect(row!.specWrite).toEqual(sw);
      expect(rawSpec(db, row!.id)).toBe(JSON.stringify(sw));
    }
    rec.close();
  });

  test('★ 反向: 非 solve 入口即使误传也**不许**写入磁盘 (那一格是"不适用", 不是"没记")', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    await recordDagRun(rec, { runId: 'r-run', entry: 'run', specWrite: { kind: 'wrote', source: 'contract', path: '/x.md' } })(fakeResult('p'));
    const [row] = rec.listByRun('r-run');
    expect(row!.specWrite).toBeUndefined();
    expect(rawSpec(db, row!.id)).toBeNull(); // SQL 层真 NULL, 不是读侧过滤
    rec.close();
  });

  test('★ 反向: 绕过 recordDagRun 直接 record 也拦得住 —— 归属守卫在**两层**各有一道', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 上一条走 recordDagRun (外层守卫); 这一条直接调 record —— 少了它, 内层那道就是没测到的死守卫。
    const id = rec.record(fakeResult('p'), { runId: 'r-raw', entry: 'run', specWrite: { kind: 'missing', source: 'contract' } });
    expect(rawSpec(db, id)).toBeNull();
    expect(rec.get(id)!.specWrite).toBeUndefined();
    rec.close();
  });

  test('坏 JSON / 词表外形状 → 按 NULL 读 (一行写坏的记录不许让读数板崩或读出编造的分支)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 没有合法入口能写出这两行 —— 只能手工 INSERT (同 acceptance_probe 那条的姿势)。
    for (const [id, raw] of [['bad-json', '{不是 JSON'], ['bad-kind', '{"kind":"unknown","source":"contract"}']] as const) {
      db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, run_id, entry, levels, nodes, usage, spec_write)
              VALUES (?, 1, 'p', 1, ?, 'solve', '[]', '[]', '{}', ?)`, [id, id, raw]);
      expect(rec.get(id)!.specWrite).toBeUndefined();
    }
    rec.close();
  });

  test('updateSpecWrite 回填该 runId 的**全部**行 —— 契约段那行不留 NULL', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 生产时序: 契约段那张图先写入磁盘 (那时这一位还算不出来), 回调再回填。
    const contractId = rec.record(fakeResult('goal-contract'), { runId: 'g1', entry: 'solve', now: 1 });
    expect(rec.get(contractId)!.specWrite).toBeUndefined();
    const sw: SpecWrite = { kind: 'wrote', source: 'contract', path: '/repo/docs/plan/x.md' };
    rec.updateSpecWrite('g1', sw);
    // 执行段那张图之后才落, 走 meta (两条路一起才让两行同值)。
    await recordDagRun(rec, { runId: 'g1', entry: 'solve', specWrite: sw })(fakeResult('goal-execute'));
    const rows = rec.listByRun('g1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.specWrite)).toEqual([sw, sw]);
    rec.close();
  });
});
