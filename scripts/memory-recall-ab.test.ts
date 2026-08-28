/**
 * A/B 装置的 **oracle 判别力自证** —— `templates/packs/EVAL-PROTOCOL.md` §3 列为**必做**:
 * 「种缺陷世界上 fixture 自测绿、隐藏 oracle 红。两条缺一,整个 eval 白设。」
 *
 * 这里的等价形态:每道题喂**对答案**该绿、喂**错答案**该红。任何一道两边同色 = 那道题
 * 量不出东西,而它会以"召回没用"的形态混进读数 —— 那是最贵的一种假读数。
 *
 * 顺带钉住 cold 题的真值(用脚本先算过:工作日 32 · 十二进制 24353),不是心算的。
 * 真值写错的话 cold 臂会恒 0%,读起来像"召回把答案带偏了",而其实是我算错了。
 */
import { describe, expect, test } from 'bun:test';
import { CORPUS, TASK_VALIDITY, VERDICT, judge } from './memory-recall-ab';

/** 每道题的"对答案"与"错答案"。错答案要**像模像样**,不能是空串糊弄过去。 */
const SAMPLES: Record<string, { good: string; bad: string }> = {
  // a1/a2 是**成对反偏置**:两道题的"对答案"正好相反。只会选反常答案的臂在 a2 上会红。
  'a1-flat-graph-stalled': {
    good: '{"action":"inspect_slice_nodes","resumeSameRunId":true}',
    bad: '{"action":"add_max_rounds","resumeSameRunId":true}', // 系统的通用处方 —— 对平铺图是错的
  },
  'a2-nested-graph-stalled': {
    good: '{"action":"add_max_rounds","resumeSameRunId":true}',
    bad: '{"action":"inspect_slice_nodes","resumeSameRunId":true}',
  },
  'a3-spec-contract-on-disk': {
    good: '{"nodes":{"spec":{"output_type":"file","goal":"写契约"},"execute":{"depends_on":["spec"],"goal":"实现"}}}',
    bad: '{"nodes":{"spec":{"output_type":"text","goal":"写契约"},"execute":{"depends_on":["spec"],"goal":"照上游正文实现"}}}',
  },
  // 真值都用脚本先算过(工作日 32 / 十二进制 24353),不是我心算的 —— 真值写错的话
  // cold 臂会恒 0%,读起来像"召回把答案带偏了",而其实是我算错了。
  'c1-workdays-between': { good: '{"workdays":32}', bad: '{"workdays":35}' },
  'c2-base-convert': { good: '{"base12":"24353"}', bad: '{"base12":"BEEF"}' },
  'c3-regex-boundary': { good: '{"re":"a\\\\d{1,3}b"}', bad: '{"re":"a\\\\d+b"}' },
};

describe('A/B 语料 — oracle 判别力(协议 §3 必做)', () => {
  test('每道题都有配套样本(新加题忘了写样本 = 它没被自证过)', () => {
    expect(CORPUS.map((t) => t.id).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  for (const t of CORPUS) {
    test(`★ ${t.id}: 对答案绿 / 错答案红`, () => {
      const s = SAMPLES[t.id]!;
      expect(t.oracle(s.good)).toBe(true);
      expect(t.oracle(s.bad)).toBe(false);
    });
  }

  test('抠不出 JSON 一律不算命中(不是"判据放宽"的理由)', () => {
    for (const t of CORPUS) expect(t.oracle('抱歉,我需要更多信息。')).toBe(false);
  });

  test('两类语料都在 —— 只跑 anchored 是选择性取样', () => {
    expect(CORPUS.filter((t) => t.klass === 'anchored').length).toBeGreaterThan(0);
    expect(CORPUS.filter((t) => t.klass === 'cold').length).toBeGreaterThan(0);
  });
});

describe('判词函数 — 三种结局都说得出口', () => {
  const row = (klass: 'anchored' | 'cold', arm: 'A-no-recall' | 'B-recall', oracleRate: number, tokens: number) =>
    ({ taskId: `t-${klass}`, klass, arm, tokens, oracleRate, wallMs: 1, cacheHit: 0, hits: null }) as never;

  /** 只取按类聚合那几行 —— 逐题行以两个空格 + `·` 开头(§6 分层写)。 */
  const agg = (rows: never[]): string[] => judge(rows).filter((l) => !l.startsWith('  · '));

  test('★ 任务太易 → 任务校准失败, 判词不许当能力结论(协议 §4)', () => {
    const v = agg([row('anchored', 'A-no-recall', 0.9, 100), row('anchored', 'B-recall', 1.0, 110)]);
    expect(v[0]).toContain('任务校准失败');
    expect(v[0]).not.toContain('**有用**');
  });

  test('有区分度 + 提升够 + 成本够低 → 有用', () => {
    const v = agg([row('anchored', 'A-no-recall', 0.2, 100), row('anchored', 'B-recall', 0.8, 110)]);
    expect(v[0]).toContain('**有用**');
    expect(v[0]).not.toContain('灰带');
  });

  test('灰带(A 落在 0.6–0.8)→ 结论降级为方向性', () => {
    const v = agg([row('anchored', 'A-no-recall', 0.7, 100), row('anchored', 'B-recall', 1.0, 110)]);
    expect(v[0]).toContain('灰带');
  });

  test('★ cold 类命中率**降** → 有害(这一条单独成立就足以否掉常开召回)', () => {
    const v = agg([row('cold', 'A-no-recall', 0.9, 100), row('cold', 'B-recall', 0.5, 105)]);
    // cold 的 A=0.9 ≥ tooEasy ⇒ 先被校准闸拦下, 这正是协议要的顺序。
    expect(v[1]).toContain('任务校准失败');
    const v2 = agg([row('cold', 'A-no-recall', 0.5, 100), row('cold', 'B-recall', 0.1, 105)]);
    expect(v2[1]).toContain('**有害**');
  });

  test('成本否决压过提升 —— 再有用也付不起', () => {
    const v = agg([row('anchored', 'A-no-recall', 0.2, 100), row('anchored', 'B-recall', 1.0, 200)]);
    expect(v[0]).toContain('成本否决');
  });

  test('无读数 → NULL, 不是 0', () => {
    expect(agg([])[0]).toContain('NULL');
  });

  test('判别式常量是导出的(判据要能被别处引用与核对, 不许藏在函数里)', () => {
    expect(VERDICT.MIN_ORACLE_LIFT).toBeGreaterThan(0);
    expect(TASK_VALIDITY.discriminating).toBeLessThan(TASK_VALIDITY.tooEasy);
  });
});

describe('分层写 — 天花板题不许伪装成"没有增益"', () => {
  const row = (id: string, arm: 'A-no-recall' | 'B-recall', oracleRate: number, tokens: number) =>
    ({ taskId: id, klass: 'anchored' as const, arm, tokens, oracleRate, wallMs: 1, cacheHit: 0, hits: null }) as never;

  test('★ 对照臂到顶的题要被点名 —— 否则它会把真信号平均掉', () => {
    const lines = judge([
      row('real-signal', 'A-no-recall', 0, 100),
      row('real-signal', 'B-recall', 0.67, 160),
      row('ceilinged', 'A-no-recall', 1, 100),
      row('ceilinged', 'B-recall', 1, 160),
    ]);
    const perTask = lines.filter((l) => l.startsWith('  · '));
    expect(perTask.length).toBe(2);
    expect(perTask.find((l) => l.includes('ceilinged'))).toContain('对照臂到顶');
    // 有真增益的那题不许被贴"到顶"
    expect(perTask.find((l) => l.includes('real-signal'))).not.toContain('对照臂到顶');
    // 逐题行要带绝对 token 增量 —— 比例会被小基线放大, 绝对值才是能外推的那个数
    expect(perTask[0]).toMatch(/\(\+\d+\)/);
  });
});

describe('反偏置 — a1/a2 必须成对', () => {
  test('★ 两道题的"对答案"正好相反 —— 只会选反常答案的臂拿不到满分', () => {
    const a1 = CORPUS.find((t) => t.id === 'a1-flat-graph-stalled')!;
    const a2 = CORPUS.find((t) => t.id === 'a2-nested-graph-stalled')!;
    const inspect = '{"action":"inspect_slice_nodes","resumeSameRunId":true}';
    const addRounds = '{"action":"add_max_rounds","resumeSameRunId":true}';
    // 一律选 inspect(反常答案)→ a1 绿 a2 红
    expect(a1.oracle(inspect)).toBe(true);
    expect(a2.oracle(inspect)).toBe(false);
    // 一律选 add_max_rounds(默认处方)→ a1 红 a2 绿
    expect(a1.oracle(addRounds)).toBe(false);
    expect(a2.oracle(addRounds)).toBe(true);
    // ⇒ 想两道都绿, 必须真的按图形态分叉 —— 那才是库里那条 fact 的内容
  });
});
