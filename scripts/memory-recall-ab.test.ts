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
  'a3-spec-not-on-disk-fix': {
    good: '{"fix":"spec_writes_file"}',
    bad: '{"fix":"execute_reads_upstream_text"}', // 库里记着这条正是失败现场
  },
  // ⚠ 真值全部**用脚本算过**。首版我心算了三个, 两个是错的(r 计数 18→20, 模链 96→191)。
  // 真值写错的后果不是"这题没意义", 是 cold 臂恒 0% —— 读起来像"召回把答案带偏了"。
  'c1-char-count': { good: '{"count":20}', bad: '{"count":18}' },
  'c2-modular-chain': { good: '{"x12":191}', bad: '{"x12":96}' },
  'c3-bracket-depth': { good: '{"depth":4}', bad: '{"depth":5}' },
  't1-stalled-runbook': { good: '{"action":"inspect_slice_nodes"}', bad: '{"action":"add_max_rounds"}' },
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
    // T-D (2026-08-28): tooEasy 只拦**正向**结论 —— 天花板不影响下降的可测性。
    // 旧断言把 A=0.9→B=0.5 (−0.4) 判成「校准失败」, 正是上一跑吞掉 cold −0.22 的那道闸。
    const v = agg([row('cold', 'A-no-recall', 0.9, 100), row('cold', 'B-recall', 0.5, 105)]);
    expect(v[1]).toContain('**有害**');
    // 到顶且**没降** → 仍是校准失败 (增益量不出来), 闸的本职不变。
    const vCeil = agg([row('cold', 'A-no-recall', 0.9, 100), row('cold', 'B-recall', 0.9, 105)]);
    expect(vCeil[1]).toContain('任务校准失败');
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

describe('cold 真值自证 —— 常量必须与现算的一致', () => {
  test('★ 三个 cold 真值当场算一遍(心算过两次错两次, 所以钉死)', () => {
    const s = 'strawberry-raspberry-rhubarb-ररr-rrarrbrr-berry-rrr';
    expect([...s].filter((c) => c === 'r').length).toBe(20);

    let x = 7;
    for (let i = 0; i < 12; i++) x = (x * 31 + 17) % 1000;
    expect(x).toBe(191);

    const t = '(a[b(c{d(e)f}g)h]i(j(k(l)m)n)o)';
    let d = 0;
    let m = 0;
    for (const ch of t) {
      if (ch === '(') m = Math.max(m, ++d);
      else if (ch === ')') d--;
    }
    expect(m).toBe(4);
  });
});

describe('带工具的任务类别', () => {
  test('★ 有 search 钩子的题才走循环 —— 且钩子对相关 query 真的返资料', () => {
    const t1 = CORPUS.find((x) => x.id === 't1-stalled-runbook')!;
    expect(typeof t1.search).toBe('function');
    expect(t1.search!('平铺图 stalled')).toContain('加 maxRounds 无意义');
    expect(t1.search!('毫不相干的词')).toContain('无匹配');
    // 单发题不许带钩子(带了会静默改变它的计费口径)
    for (const t of CORPUS.filter((x) => x.id.startsWith('c'))) expect(t.search).toBeUndefined();
  });
});
