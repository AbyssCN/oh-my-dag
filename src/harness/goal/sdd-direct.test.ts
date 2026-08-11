/**
 * solve 直通入口 (SDD 2026-08-10-solve-sdd-direct-entry) —— 装载件 + runGoal 接线。
 *
 * 钉两件事:
 *  ① fail-loud (G-2/G-5): 缺契约/分解段的文档**起跑即拒**, 错误指名缺段 —— 静默降级回全程
 *     goal 比不支持更坏 (调用方以为省了 224.5k 转录税, 实际付了全价)。
 *  ② 零转录 (G-1): sddPath 给了 → _runDag 只见 goal-execute 一张图 (契约段零展开),
 *     specPath = sddPath, SDD 全文原样进 execute 任务文本 (含并行波形)。
 *
 * 反向自检 (实跑过): 把 run-goal.ts 里 `if (sdd)` 那个分支临时改成 `if (false)` →
 * 本文件「只展开 goal-execute」当场红 (契约图出现)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSddContract, parseBreakdown } from './sdd-direct';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const SDD_OK = [
  '# 测试契约',
  '## 目标 (Destination)',
  '一句话。',
  '## 契约 (Contracts)',
  '- G-1 Given/When/Then。',
  '## 分解 (Breakdown)',
  '并行波形:{1,2} → {3}',
].join('\n');

const tmpSdd = (text: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'omd-sdd-')), 'x.md');
  writeFileSync(p, text);
  return p;
};

describe('loadSddContract (fail-loud, G-2)', () => {
  test('六段齐的 SDD 装载成功, 原文逐字保留', () => {
    const p = tmpSdd(SDD_OK);
    const c = loadSddContract(p);
    expect(c.path).toBe(p);
    expect(c.text).toBe(SDD_OK);
  });

  test('缺契约段 → 拒, 错误指名缺段', () => {
    const p = tmpSdd('# 散文\n## 分解 (Breakdown)\n1. 做事');
    expect(() => loadSddContract(p)).toThrow(/契约/);
  });

  test('缺分解段 → 拒', () => {
    const p = tmpSdd('# 散文\n## 契约 (Contracts)\n- G-1');
    expect(() => loadSddContract(p)).toThrow(/分解/);
  });

  test('文件不存在 → 拒 (不静默)', () => {
    expect(() => loadSddContract('/nonexistent/x.md')).toThrow(/读不到/);
  });

  test('英文段名 (Contracts/Breakdown) 同样合法', () => {
    const p = tmpSdd('# t\n## Contracts\n- G-1\n## Breakdown\nwave: {1}');
    expect(() => loadSddContract(p)).not.toThrow();
  });
});

describe('runGoal 直通接线 (G-1 零转录)', () => {
  const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
  const classify = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

  const execOk = (): ExecutorDagResult =>
    ({
      plan: { name: 'goal-execute', nodes: {} },
      results: {
        accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 } },
        execute: { id: 'execute', status: 'done', kind: 'conductor', output: '[ok]', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
      },
      reusedNodes: [],
    }) as unknown as ExecutorDagResult;

  const run = async (sddPath: string) => {
    const seenPlans: ConductorPlan[] = [];
    const seenTexts: string[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-direct-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        seenTexts.push(JSON.stringify(plan));
        return execOk();
      }) as never,
      sddPath,
    };
    const r = await runGoal('按 SDD 执行', config);
    return { r, seenPlans, seenTexts };
  };

  test('只展开 goal-execute —— 契约段子图零展开 (G-1 台账无 goal-contract)', async () => {
    const { seenPlans } = await run(tmpSdd(SDD_OK));
    expect(seenPlans.length).toBe(1);
    expect(seenPlans[0]!.name).toBe('goal-execute');
  });

  test('specPath = sddPath, SDD 全文 (含波形) 进 execute 任务文本', async () => {
    const p = tmpSdd(SDD_OK);
    const { r, seenTexts } = await run(p);
    expect(r.specPath).toBe(p);
    expect(seenTexts[0]).toContain('并行波形');
    // G-6 探针回归: 基座 specPath 不得进 execute 文本 (leaf 会拿它当仓根写出隔离树);
    // 改念执行根。证伪: 还原 run-goal 那个三元分支 → 本断言当场红。
    expect(seenTexts[0]).toContain('执行根');
    expect(seenTexts[0]).not.toContain(p);
    expect(r.stages.some((s) => s.summary.includes('SDD 直通'))).toBe(true);
  });

  test('坏 SDD → runGoal 起跑即抛, 一张图都不展开 (G-2)', async () => {
    const seenPlans: ConductorPlan[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-direct-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        return execOk();
      }) as never,
      sddPath: tmpSdd('# 散文而已'),
    };
    await expect(runGoal('g', config)).rejects.toThrow(/缺段/);
    expect(seenPlans.length).toBe(0);
  });
});

// ── 内环 v2 切片 1: Breakdown 表解析器 (SDD 2026-08-11-inner-loop-v2, D-1 / G-1 前半 / G-6) ──
//
// 反向自检的统一形状 (本仓惯例, 同 delta-compare.test): 每条闸都配一份**已知违规样本**,
// 断言它 throw 且判词指名问题所在。证伪方式逐条写在各 test 注释里 —— 把闸拆掉 (或把 throw
// 改成静默跳过), 该条当场绿→红, 证明它不是恒绿的纸闸。
//
// 阴性对照 (「闸不是恒红」): 真实 SDD 那条 + 合法最小样本那条都必须 **不** throw。

/** 最小合法表 (列序同 /omd-contract 规范: 切片 | 写集 | 依赖(带理由) | verify)。 */
const table = (rows: string[], wave?: string): string =>
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖(带理由) | verify |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(wave ? [`并行波形:${wave}`] : []),
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

describe('parseBreakdown — 表解析 (切片 1)', () => {
  test('真实样例: 本 SDD 自己的 Breakdown 表 (5 切片 + 波形) 全解析', () => {
    // 这份 SDD 就是解析器的真实输入形状 (✅ 标记 · backtick 路径 · 「—(理由)」空依赖 ·
    // 「N、M(理由)」多依赖 · 「+ test」简写)。断言只钉**结构**不钉文案 —— 切片名会随
    // 交付进度改写 (加 ✅/commit 号), 钉文案的测试会在无关改动上假红。
    const sdd = loadSddContract(
      join(import.meta.dir, '../../../docs/plan/2026-08-11-inner-loop-v2-control-inversion.md'),
    );
    const bd = parseBreakdown(sdd.text);
    expect(bd.slices.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
    expect(bd.waves).toEqual([[1, 3, 4], [2], [5]]);
    // 依赖列: 「—(消费 blame.ts)」的括号是给人读的, 只取 id → 空; 「2、3(...)」→ [2,3]。
    expect(bd.slices.map((s) => s.deps)).toEqual([[], [1], [], [], [2, 3]]);
    // ✅ 与 markdown 强调标记不进结构 (它们是进度装饰, 不是切片身份)。
    const s3 = bd.slices.find((s) => s.id === 3)!;
    expect(s3.name).not.toContain('✅');
    expect(s3.name).not.toContain('**');
    // 写集: backtick/「(新)」注解剥掉, 「+ test」展开成同名 .test.ts 兄弟。
    expect(bd.slices.find((s) => s.id === 2)!.writeSet).toEqual([
      'src/harness/goal/sdd-compile.ts',
      'src/harness/goal/sdd-compile.test.ts',
    ]);
    expect(bd.slices.find((s) => s.id === 5)!.writeSet).toEqual(['src/harness/goal/run-goal.ts']);
    expect(bd.slices.find((s) => s.id === 1)!.verify).toBe('G-1 前半、G-6');
  });

  test('最小表: id/名称/写集/依赖/verify 各列到位', () => {
    const bd = parseBreakdown(
      table([
        '| 1 解析器 | src/a.ts | — | bun test src/a.test.ts |',
        '| 2 编译器 | `src/b.ts`(新) + test | 1(消费 1 的结构) | bun test src/b.test.ts |',
      ]),
    );
    expect(bd.slices).toEqual([
      { id: 1, name: '解析器', writeSet: ['src/a.ts'], deps: [], verify: 'bun test src/a.test.ts' },
      {
        id: 2,
        name: '编译器',
        writeSet: ['src/b.ts', 'src/b.test.ts'],
        deps: [1],
        verify: 'bun test src/b.test.ts',
      },
    ]);
    expect(bd.waves).toBeUndefined();
  });

  test('波形行: `{1,3} → {2}` 解析成层序数组', () => {
    const bd = parseBreakdown(
      table(
        [
          '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
          '| 2 b | src/b.ts | 1(消费) | bun test src/b.test.ts |',
          '| 3 c | src/c.ts | — | bun test src/c.test.ts |',
        ],
        '`{1,3} → {2}`',
      ),
    );
    expect(bd.waves).toEqual([[1, 3], [2]]);
  });

  test('无波形行 → waves undefined (刻意不从依赖列反推)', () => {
    // 证伪: 若实现改成"从依赖列推层序", 本断言当场红。反推的层序没有第二个独立来源,
    // 而它唯一的消费者 (sdd-compile 乱序闸) 正是拿它校对依赖列 —— 自己推自己 = 闸恒绿。
    const bd = parseBreakdown(table(['| 1 a | src/a.ts | — | bun test src/a.test.ts |']));
    expect(bd.waves).toBeUndefined();
  });

  test('闸: 表里一行数据都没有 → 拒 (fail-loud, 不返空表)', () => {
    // 证伪: 若实现返回 { slices: [] } → 下游编译器会照单产一张只有 accept 的空图,
    // 「什么都没干」被读成「跑完了」—— 静默降级正是 sdd-direct 全篇在挡的那一档。
    const empty = ['# t', '## 契约 (Contracts)', '- G-1', '## 分解 (Breakdown)', '散文没有表'].join('\n');
    expect(() => parseBreakdown(empty)).toThrow(/没有切片行|一行数据/);
  });

  test('闸: 分解段缺失 → 拒', () => {
    expect(() => parseBreakdown('# t\n## 契约 (Contracts)\n- G-1')).toThrow(/分解/);
  });

  test('闸: 切片 id 重复 → 拒, 判词指名重复的 id', () => {
    // 证伪: 若实现用 map 后写覆盖前写 → 两片悄悄并成一片, 少跑的那片没人发现。
    expect(() =>
      parseBreakdown(
        table([
          '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
          '| 1 b | src/b.ts | — | bun test src/b.test.ts |',
        ]),
      ),
    ).toThrow(/重复.*1|1.*重复/);
  });

  test('闸: 切片列不以编号开头 → 拒 (指名那一行)', () => {
    // 证伪: 若实现 silently skip 无法解析的行 → 整片切片凭空消失, 图少一个节点而无人知。
    expect(() =>
      parseBreakdown(table(['| 解析器 | src/a.ts | — | bun test src/a.test.ts |'])),
    ).toThrow(/编号/);
  });

  test('闸: 写集为空 → 拒 (写集是并行安全的机器判据, 不许留白)', () => {
    expect(() => parseBreakdown(table(['| 1 a | — | — | bun test src/a.test.ts |']))).toThrow(/写集/);
  });

  test('闸: 列数不足 4 → 拒', () => {
    expect(() => parseBreakdown(table(['| 1 a | src/a.ts | — |']))).toThrow(/四列|列/);
  });

  test('自依赖 → 拒 (自己等自己 = 永远跑不起来)', () => {
    expect(() =>
      parseBreakdown(table(['| 1 a | src/a.ts | 1(自己) | bun test src/a.test.ts |'])),
    ).toThrow(/自依赖|自己/);
  });

  test('阴性对照: 合法表不 throw (闸不是恒红)', () => {
    expect(() =>
      parseBreakdown(
        table(
          [
            '| 1 a | src/a.ts + test | — | bun test src/a.test.ts |',
            '| 2 b | src/b.ts | 1(消费 a) | bun test src/b.test.ts |',
          ],
          '{1} → {2}',
        ),
      ),
    ).not.toThrow();
  });
});

// ── 内环 v2 切片 5: 直通 v2 接线 (SDD 2026-08-11-inner-loop-v2, D-1/D-3 —— G-1/G-2 的接线面) ──
//
// 反向自检 (实跑过, 同文件头惯例): 把 run-goal.ts 直通 v2 那个 try 块整体禁掉 (恒走回落) →
// 「可编译分解表 → goal-execute-flat」当场红; 把回落 catch 改成 rethrow → 「编译不过 → 响亮
// 回落」当场红。两个方向各有一条测试钉着, 接线既不许静默失效、也不许把回落变拒跑。

describe('runGoal 直通 v2 (切片 5: 分解表可编译 → 零 conductor 平铺)', () => {
  const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
  const classify = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

  const SDD_FLAT = [
    '# t',
    '## 契约 (Contracts)',
    '- G-1 Given/When/Then。',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖(带理由) | verify |',
    '|---|---|---|---|',
    '| 1 解析器 | src/a.ts + test | — | `bun test src/a.test.ts` |',
    '| 2 编译器 | src/b.ts | 1(消费 1 的结构) | `bun test src/b.test.ts` |',
    '并行波形:{1} → {2}',
  ].join('\n');

  /** 平铺图的执行结果: 没有 execute 节点 —— accept 的退出码是唯一停止规则 (D-3)。 */
  const flatResult = (accept: 'done' | 'failed' | 'absent'): ExecutorDagResult =>
    ({
      plan: { name: 'goal-execute-flat', nodes: {} },
      results:
        accept === 'absent'
          ? {}
          : { accept: { id: 'accept', status: accept, kind: 'command', output: accept === 'done' ? '' : '[exit 1]', deps: [], usage: { in: 0, out: 0 } } },
      reusedNodes: [],
    }) as unknown as ExecutorDagResult;

  const run = async (text: string, accept: 'done' | 'failed' | 'absent' = 'done') => {
    const seenPlans: ConductorPlan[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-flat-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        // 回落路径给一份 conductor 形状的结果 (execute 节点在), 平铺路径给 accept-only。
        return plan.name === 'goal-execute-flat'
          ? flatResult(accept)
          : ({
              plan: { name: 'goal-execute', nodes: {} },
              results: {
                accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 } },
                execute: { id: 'execute', status: 'done', kind: 'conductor', output: '[ok]', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
              },
              reusedNodes: [],
            } as unknown as ExecutorDagResult);
      }) as never,
      sddPath: tmpSdd(text),
    };
    const r = await runGoal('按 SDD 执行', config);
    return { r, seenPlans };
  };

  test('可编译分解表 → goal-execute-flat: 7 节点 (2×3+accept)、零 conductor、accept = 冻结判据恰一次 (G-1/G-2 接线面)', async () => {
    const { r, seenPlans } = await run(SDD_FLAT);
    expect(seenPlans.length).toBe(1);
    const plan = seenPlans[0]!;
    expect(plan.name).toBe('goal-execute-flat');
    expect(Object.keys(plan.nodes).length).toBe(7);
    expect(Object.values(plan.nodes).some((n) => n.executor === 'conductor')).toBe(false);
    // G-2: 全量回归恰一次, 且就是冻结判据那条命令。**命令来自 verify 列** (2026-08-11 起,
    // 不再是分类器那条 `bun test`): 各片 verify 串联 + 末环去路径限定的全量版。
    const accept = 'bun test src/a.test.ts && bun test src/b.test.ts && bun test';
    expect(Object.values(plan.nodes).filter((n) => n.command === accept).length).toBe(1);
    expect(plan.nodes.accept!.command).toBe(accept);
    expect(r.acceptance.kind === 'executable' && r.acceptance.command).toBe(accept);
    expect(plan.nodes.accept!.expect_exit).toBe(0);
    expect(r.converged).toBe(true);
    expect(r.stages.some((s) => s.summary.includes('直通v2平铺'))).toBe(true);
  });

  test('切片实装节点: 契约上下文内联 (G-6 教训: 全文 + 执行根, 不引用基座路径) + write_set 进节点 (D-2)', async () => {
    const { seenPlans } = await run(SDD_FLAT);
    const s1 = seenPlans[0]!.nodes.s1!;
    expect(String(s1.goal)).toContain('执行根');
    expect(String(s1.goal)).toContain('并行波形'); // SDD 全文在节点里
    expect(String(s1.goal)).toContain('实施切片 1');
    expect(s1.write_set).toEqual(['src/a.ts', 'src/a.test.ts']);
    // RED/GREEN 是 command 节点, 不背 SDD 全文那份 token
    expect(String(seenPlans[0]!.nodes['s1-red']!.goal)).not.toContain('并行波形');
  });

  test('D-3 平铺收敛 := 冻结判据绿; 判据没过 → not-converged (平铺没有 judge, 不存在 oracle-failed 那种打架)', async () => {
    const ok = await run(SDD_FLAT, 'done');
    expect(ok.r.criteria).toEqual({ judge: true, oracle: true });
    const bad = await run(SDD_FLAT, 'failed');
    expect(bad.r.converged).toBe(false);
    expect(bad.r.outcome).toBe('not-converged');
    expect(bad.r.criteria).toEqual({ judge: false, oracle: false }); // judge 恒等 oracle (无票)
    const absent = await run(SDD_FLAT, 'absent');
    expect(absent.r.converged).toBe(false); // 没跑到 accept = 没被证明过 = 不算成 (fail-closed)
  });

  test('编译不过 (分解段无表) → 响亮回落 conductor (v1): plan 名照旧 + 摘要带回落注记, 不拒跑不静默', async () => {
    const noTable = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n并行波形:{1}';
    const { r, seenPlans } = await run(noTable);
    expect(seenPlans.length).toBe(1);
    expect(seenPlans[0]!.name).toBe('goal-execute');
    expect(seenPlans[0]!.nodes.execute!.executor).toBe('conductor');
    expect(r.converged).toBe(true); // v1 路径行为照旧 (judge ∧ oracle)
    expect(r.stages.some((s) => s.summary.includes('直通v2回落'))).toBe(true);
  });
});

// ── 判据来源: SDD verify 列 > 分类器 (2026-08-11 run 7d50fda2 修) ─────────────────────
//
// 事故: 分类器只看得见 goal 文本, 看不见 SDD, 于是自己编了一条测试路径 (`src/harness/dag/
// run-board.test.ts`), 而 SDD verify 列写的是 `src/harness/board/…` —— 目录是幻觉。那条命令
// 同时是 accept 节点、freezeCriterion 与基线 delta 的那一条, 冻结判卷就此造在了幻觉路径上。
//
// 反向自检 (实跑过): 把 run-goal 里 `config.acceptance ?? sddAcceptance ?? classified.acceptance`
// 的中间那项去掉 → 本组两条当场红 (判据退回分类器的幻觉路径)。
describe('runGoal 直通档: 验收命令取自 SDD verify 列, 不用分类器编的', () => {
  const HALLUCINATED = 'bun test src/harness/dag/run-board.test.ts';
  const SDD_TABLE = [
    '# 测试契约',
    '## 契约 (Contracts)',
    '- G-1 Given/When/Then。',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 board 模块 | `src/harness/board/run-board.ts` + test | 无 | `bun test src/harness/board/run-board.test.ts` |',
    '| 2 点火预检 | `src/harness/goal/ignition-preflight.ts` + test | 1 | `bun test src/harness/goal/ignition-preflight.test.ts` |',
    '并行波形:{1} → {2}',
  ].join('\n');

  const runWith = async (sddPath: string) => {
    const seen: { plan: ConductorPlan; cfg: ExecutorDagConfig }[] = [];
    const r = await runGoal('按 SDD 执行', {
      cwd: mkdtempSync(join(tmpdir(), 'omd-direct-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: HALLUCINATED, expectExit: 0 },
      }),
      _runDag: (async (plan: ConductorPlan, cfg: ExecutorDagConfig) => {
        seen.push({ plan, cfg });
        return {
          plan,
          results: Object.fromEntries(
            Object.keys(plan.nodes).map((id) => [
              id,
              { id, status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 }, converged: true },
            ]),
          ),
          reusedNodes: [],
        } as unknown as ExecutorDagResult;
      }) as never,
      sddPath,
    } as RunGoalConfig);
    return { r, seen };
  };

  test('★ accept 节点 + freezeCriterion 都用 SDD 的路径, 分类器那条幻觉路径一处都不出现', async () => {
    const { r, seen } = await runWith(tmpSdd(SDD_TABLE));
    const accept = seen[0]!.plan.nodes['accept']!;
    expect(accept.command).toContain('src/harness/board/run-board.test.ts');
    expect(accept.command).not.toContain('src/harness/dag/run-board.test.ts');
    expect(seen[0]!.cfg.freezeCriterion?.command).toBe(accept.command as string);
    expect(r.acceptance).toEqual({ kind: 'executable', command: accept.command as string, expectExit: 0 });
    // 判据换了来源要在摘要上看得见 (事故当天它只活在图里, 摘要上什么都没写)。
    expect(r.stages.some((s) => s.summary.includes('判据取自 SDD verify 列'))).toBe(true);
  });

  test('verify 列写了白名单外的命令 → 回落分类器 (不拿一条注定被闸拒的命令当验收 = 假红)', async () => {
    const { r } = await runWith(
      tmpSdd(
        [
          '# t',
          '## 契约 (Contracts)',
          '- G-1',
          '## 分解 (Breakdown)',
          '| 切片 | 写集 | 依赖 | verify |',
          '|---|---|---|---|',
          '| 1 a | `src/a.py` | 无 | `pytest tests/test_a.py` |',
        ].join('\n'),
      ),
    );
    expect(r.acceptance).toEqual({ kind: 'executable', command: HALLUCINATED, expectExit: 0 });
  });

  test('分解段无表 (存量直通 SDD) → 回落分类器那条, 行为不变 (fail-open)', async () => {
    const { r, seen } = await runWith(tmpSdd(SDD_OK));
    expect(r.acceptance).toEqual({ kind: 'executable', command: HALLUCINATED, expectExit: 0 });
    expect(seen[0]!.plan.nodes['accept']!.command).toBe(HALLUCINATED);
    expect(r.stages.some((s) => s.summary.includes('判据取自 SDD verify 列'))).toBe(false);
  });
});

// ── O-6 vacuous 探针 (2026-08-11 二发教训: RED 对既有绿测试文件结构性失败) ──────────
// 反向自检 (实跑过): 把 run-goal.ts 平铺块里的探针 for 循环摘掉 → 「已绿 → 回落」当场红。

describe('runGoal 直通 v2 — O-6 vacuous 探针 (切片 verify 实装前已绿 → 不进平铺)', () => {
  const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
  const classify = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });
  const SDD_FLAT2 = [
    '# t',
    '## 契约 (Contracts)',
    '- G-1。',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 a | src/a.ts | — | `bun test src/a.test.ts` |',
  ].join('\n');

  const run = async (verifyExit: number) => {
    const seenPlans: ConductorPlan[] = [];
    const probed: string[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-vac-')),
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        // 探针与 D-1 基线共用这一个 runner: 切片 verify 回 verifyExit, 验收命令恒 0。
        commandRunner: (async ({ command }: { command: string }) => {
          probed.push(command);
          return { text: '', usage: { in: 0, out: 0 }, exitCode: command === 'bun test' ? 0 : verifyExit };
        }) as never,
      } as unknown as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        return {
          plan: { name: plan.name, nodes: {} },
          results: {
            accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 } },
            ...(plan.name === 'goal-execute'
              ? { execute: { id: 'execute', status: 'done', kind: 'conductor', output: '[ok]', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true } }
              : {}),
          },
          reusedNodes: [],
        } as unknown as ExecutorDagResult;
      }) as never,
      sddPath: tmpSdd(SDD_FLAT2),
    };
    const r = await runGoal('按 SDD 执行', config);
    return { r, seenPlans, probed };
  };

  test('切片 verify 实装前已绿 (探针得 0) → 响亮回落 v1, 注记含「实装前已绿」', async () => {
    const { r, seenPlans, probed } = await run(0);
    expect(probed).toContain('bun test src/a.test.ts'); // 真探过
    expect(seenPlans[0]!.name).toBe('goal-execute'); // 没进平铺
    expect(r.stages.some((s) => s.summary.includes('实装前已绿'))).toBe(true);
  });

  test('切片 verify 实装前红 (探针得 1) → 平铺照走 (探针不误伤真 TDD 输入)', async () => {
    const { seenPlans } = await run(1);
    expect(seenPlans[0]!.name).toBe('goal-execute-flat');
  });
});
