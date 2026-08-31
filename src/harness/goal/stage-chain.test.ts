/**
 * src/harness/goal/stage-chain.test —— GWT-1 / GWT-2 / GWT-3 / GWT-5 冻结判据
 *
 * 每条 GWT 配一条已知样本。闸摘掉 → test 当场由绿转红 (反向自检)。
 *
 *   GWT-1 (INV-1) 编译产物序列化文本含 "executor":"map" + map 的 depends_on 含
 *               verify 节点 id + parsePlan 校验通过
 *   GWT-2 (INV-2) primitive(parallel) params 引用上游 listFrom → 编译失败, 错误文本含 'map'
 *   GWT-3 (INV-3) word='distill' → 拒, 错误文本含全部 8 词
 *   GWT-5 (INV-5) 首阶段带 listFrom → 拒, 错误文本含「首阶段」
 */
import { describe, test, expect } from 'bun:test';
import { compileChain, validateChain, STAGE_WORDS } from './stage-chain';
import type { StageChain, Stage, StageWord } from './stage-chain';
import { parsePlan } from '../conductor-plan';

// ── helpers ────────────────────────────────────────────────────────────────

/** SQL 迁移 fixture 链 (GWT-1): research → verify → map → judge → synthesize */
function sqlMigrationChain(): StageChain {
  const stages: Stage[] = [
    { id: 'research_migration', word: 'research', goal: '调研 SQL 迁移工具与最佳实践' },
    { id: 'verify_baseline', word: 'verify', goal: '核对当前 schema 与目标 schema 差异' },
    {
      id: 'migrate_per_table',
      word: 'map',
      listFrom: { stage: 'verify_baseline', extractor: 'bun -e "console.log(JSON.stringify({items:process.argv.slice(1)}))" --' },
      perItem: '写迁移脚本给 ${item}',
    },
    { id: 'judge_outputs', word: 'judge', goal: '评审各表迁移产物是否一致' },
    { id: 'synthesize_report', word: 'synthesize', goal: '汇总迁移报告 + 风险清单' },
  ];
  return { stages };
}

// ── GWT-1 (INV-1): 编译产物拓扑 + parsePlan 通过 ───────────────────────────

describe('GWT-1 INV-1 SQL 迁移 fixture 链 → 合法 ConductorPlan + parsePlan 通过', () => {
  test('产物序列化文本包含 "executor":"map"', () => {
    const plan = compileChain(sqlMigrationChain());
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain('"executor":"map"');
  });

  test('map 节点 depends_on 包含 verify 阶段的节点 id', () => {
    const plan = compileChain(sqlMigrationChain());
    const mapNode = plan.nodes['migrate_per_table'];
    expect(mapNode).toBeDefined();
    const deps = mapNode?.depends_on ?? [];
    expect(deps).toContain('verify_baseline');
  });

  test('parsePlan 校验通过 (INV-1 原样过闸)', () => {
    const plan = compileChain(sqlMigrationChain());
    const result = parsePlan(JSON.stringify(plan), { knownServers: new Set<string>() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error); // 类型窄化
    expect(result.plan.nodes['migrate_per_table']?.executor).toBe('map');
  });

  test('线性文本绑定: 每个非首阶段 depends_on 含前一阶段 id', () => {
    const plan = compileChain(sqlMigrationChain());
    expect(plan.nodes['research_migration']?.depends_on ?? []).toEqual([]);
    expect(plan.nodes['verify_baseline']?.depends_on ?? []).toContain('research_migration');
    // map 阶段同时依赖前一阶段 (verify_baseline) 与 listFrom.source (verify_baseline, 同),
    // 去重后只剩一个。
    expect(plan.nodes['migrate_per_table']?.depends_on ?? []).toEqual(['verify_baseline']);
    expect(plan.nodes['judge_outputs']?.depends_on ?? []).toContain('migrate_per_table');
    expect(plan.nodes['synthesize_report']?.depends_on ?? []).toContain('judge_outputs');
  });
});

// ── GWT-2 (INV-2): primitive(parallel) 静态槽禁接上游清单绑定 ──────────────

describe('GWT-2 INV-2 primitive(parallel) params 引用上游 listFrom → 拒, 错误文本含 map', () => {
  test('编译失败且错误文本含 map', () => {
    const chain: StageChain = {
      stages: [
        { id: 'research_x', word: 'research', goal: '调研' },
        {
          id: 'extract_list',
          word: 'map',
          listFrom: { stage: 'research_x', extractor: 'echo []' },
          perItem: '处理 ${item}',
        },
        {
          id: 'parallel_bad',
          word: 'primitive',
          primitive: {
            id: 'parallel',
            // 引用了上游有 listFrom 的阶段 id —— 触发 INV-2 闸。
            params: { inputs: 'extract_list', workers: 4 },
          },
        },
      ],
    };
    expect(() => compileChain(chain)).toThrow(/map/);
  });

  test('pipeline 同样禁接上游 listFrom', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        {
          id: 's1_list',
          word: 'map',
          listFrom: { stage: 's0', extractor: 'echo []' },
          perItem: 'x ${item}',
        },
        {
          id: 's2_pipe',
          word: 'primitive',
          primitive: { id: 'pipeline', params: { source: 's1_list' } },
        },
      ],
    };
    expect(() => compileChain(chain)).toThrow(/map/);
  });

  test('parallel 不引用上游 listFrom 时不触发 INV-2 (正例, 防闸过宽)', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        {
          id: 's1',
          word: 'primitive',
          primitive: {
            id: 'parallel',
            params: { workers: 4, items: ['a', 'b', 'c'] }, // 静态数组, 非上游引用
          },
        },
      ],
    };
    expect(() => compileChain(chain)).not.toThrow();
  });

  test('非 parallel/pipeline 原语不触发 INV-2 (分支覆盖)', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        {
          id: 's1_list',
          word: 'map',
          listFrom: { stage: 's0', extractor: 'echo []' },
          perItem: 'x ${item}',
        },
        {
          id: 's2_iter',
          word: 'primitive',
          primitive: { id: 'iterate', params: { source: 's1_list' } }, // iterate 不在禁列
        },
      ],
    };
    expect(() => compileChain(chain)).not.toThrow();
  });
});

// ── GWT-3 (INV-3): 词表封闭 ───────────────────────────────────────────────

describe('GWT-3 INV-3 word="distill" → 拒, 错误文本含全部 8 合法词', () => {
  test('词表外 word 拒绝且错误文本包含全部 8 词', () => {
    const chain: StageChain = {
      stages: [{ id: 's0', word: 'distill' as never, goal: 'g' }],
    };
    let caught: Error | undefined;
    try {
      compileChain(chain);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const msg = caught!.message;
    for (const w of STAGE_WORDS) {
      expect(msg).toContain(w);
    }
  });

  test('词表内 word 不触发 INV-3 (8 词各自过一遍, 防闸误伤)', () => {
    const baseStages: Stage[] = [
      { id: 'r', word: 'research', goal: 'g' },
      { id: 'a', word: 'agent', goal: 'g' },
    ];
    const cases: Array<[StageWord, Stage[]]> = [
      ['command', [...baseStages, { id: 'c', word: 'command', command: 'true' }]],
      [
        'map',
        [
          { id: 'r', word: 'research', goal: 'g' },
          { id: 'm', word: 'map', listFrom: { stage: 'r', extractor: 'echo []' }, perItem: 'x' },
        ],
      ],
      ['verify', [...baseStages, { id: 'v', word: 'verify', goal: 'g' }]],
      ['judge', [...baseStages, { id: 'j', word: 'judge', goal: 'g' }]],
      ['synthesize', [...baseStages, { id: 's', word: 'synthesize', goal: 'g' }]],
      [
        'primitive',
        [...baseStages, { id: 'p', word: 'primitive', primitive: { id: 'parallel', params: {} } }],
      ],
    ];
    for (const [word, stages] of cases) {
      expect(() => compileChain({ stages })).not.toThrow(new RegExp(`不在 v1 词表`));
      // 字面再确认没误触其它闸: word 本身不在 STAGE_WORDS 时才会触发这条
      expect(STAGE_WORDS).toContain(word);
    }
  });
});

// ── GWT-5 (INV-5): 首阶段禁带 listFrom ───────────────────────────────────

describe('GWT-5 INV-5 stages[0] 带 listFrom → 拒, 错误文本含「首阶段」', () => {
  test('首阶段带 listFrom 拒绝, 错误文本含「首阶段」', () => {
    const chain: StageChain = {
      stages: [
        {
          id: 's0',
          word: 'map',
          listFrom: { stage: 's0', extractor: 'echo []' }, // 自引用且首阶段, 双违例
          perItem: 'x',
        },
      ],
    };
    let caught: Error | undefined;
    try {
      compileChain(chain);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('首阶段');
  });

  test('非首阶段带 listFrom 不触发 INV-5 (闸不误伤, GWT-1 即此形态)', () => {
    // GWT-1 的 SQL 链 = map 在阶段 #3, 不在 #0 → 不该触发 INV-5。
    expect(() => compileChain(sqlMigrationChain())).not.toThrow(/首阶段/);
  });
});

// ── 边角判据 (形态闸, 不是 GWT 直接覆盖, 闸摘掉任一会红) ──────────────────

describe('形态闸与链结构兜底', () => {
  test('空链拒', () => {
    expect(() => compileChain({ stages: [] })).toThrow(/空/);
  });

  test('id 重复拒', () => {
    const chain: StageChain = {
      stages: [
        { id: 'dup', word: 'research', goal: 'g' },
        { id: 'dup', word: 'agent', goal: 'g' },
      ],
    };
    expect(() => compileChain(chain)).toThrow(/重复/);
  });

  test('word=map 但缺 listFrom 拒 (形态闸)', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        { id: 's1', word: 'map', perItem: 'x' }, // 缺 listFrom
      ],
    };
    expect(() => compileChain(chain)).toThrow(/listFrom/);
  });

  test('word=command 但缺 command 槽拒', () => {
    const chain: StageChain = {
      stages: [{ id: 's0', word: 'command', goal: 'g' }],
    };
    expect(() => compileChain(chain)).toThrow(/command/);
  });

  test('listFrom.stage 指向未来阶段拒 (环/未来引用防护)', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        {
          id: 's1',
          word: 'map',
          listFrom: { stage: 's2', extractor: 'echo []' }, // s2 在 s1 之后
          perItem: 'x',
        },
        { id: 's2', word: 'agent', goal: 'g' },
      ],
    };
    expect(() => compileChain(chain)).toThrow(/早于/);
  });

  test('listFrom.stage 不在链内拒', () => {
    const chain: StageChain = {
      stages: [
        { id: 's0', word: 'research', goal: 'g' },
        {
          id: 's1',
          word: 'map',
          listFrom: { stage: 'phantom', extractor: 'echo []' },
          perItem: 'x',
        },
      ],
    };
    expect(() => compileChain(chain)).toThrow(/不在链内/);
  });
});

// ── validateChain 直访 (切片 2 路由器也调它, 不能只走 compileChain) ─────────

describe('validateChain 公共入口', () => {
  test('合法链不抛', () => {
    expect(() => validateChain(sqlMigrationChain())).not.toThrow();
  });

  test('非法链抛与 compileChain 同源错误 (INV-3 例)', () => {
    expect(() => validateChain({ stages: [{ id: 's0', word: 'distill' as never, goal: 'g' }] }))
      .toThrow();
  });
});
