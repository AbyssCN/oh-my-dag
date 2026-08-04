/**
 * omd-bench 判据的**反向自检**(仓规:每条闸都要证明它真的会红)。
 *
 * 这套 bench 的地基是 `judgeContract` 与 `scoreCandidate` 两个判据。
 * **一条永远判「合格/通过」的判据比没有判据更坏** —— 它让整条链看起来已被验证
 * (本仓 G4 虚判据的教训)。所以每一格都摆一个已知样本,并断言各格互不相同。
 */
import { describe, expect, test } from 'bun:test';
import {
  judgeContract,
  scoreCandidate,
  tallyTrials,
  parseBunTestSummary,
  redDidExecute,
  passAtK,
  passHatK,
  type BenchTask,
  type RunObservation,
} from './task';

const CMD = 'bun test src/harness/map-concurrency.test.ts';

/** 一次**真断言失败**的 bun 输出尾部(测试跑起来了)。 */
const REAL_FAIL_TAIL = '\n 3 pass\n 2 fail\n 12 expect() calls\nRan 5 tests across 1 file.';
/** 一次**加载失败**的尾部(实测样本:拿"新增功能"的 commit 建题时父提交上就长这样)。 */
const LOAD_ERROR_TAIL =
  "# Unhandled error between tests\nSyntaxError: Export named 'judgeScaleInvariance' not found in module 'plan-shape.ts'.\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file.";

const obs = (exitCode: number, command = CMD, tail = exitCode === 0 ? '\n 5 pass\n 0 fail\n' : REAL_FAIL_TAIL): RunObservation =>
  ({ command, exitCode, durationMs: 10, tail });

const TASK: BenchTask = {
  id: 'f2149667-map-concurrency',
  fixSha: 'f2149667',
  baseSha: 'deadbeef',
  title: 'fix(r1): map 内层泵 worker 上界一次算死',
  statement: '…',
  implPaths: ['src/harness/executor-dag.ts'],
  testPaths: ['src/harness/map-concurrency.test.ts'],
  command: CMD,
};

describe('validation contract —— 三条,任一不成立就拒', () => {
  test('合格:RED 失败 + GREEN 通过 + 同一条命令', () => {
    const v = judgeContract({ red: obs(1), green: obs(0) });
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
  });

  test('拒:打补丁前测试没红 —— 那是个永远绿的摆设(SWE-bench 7-8% 虚高的根子)', () => {
    const v = judgeContract({ red: obs(0), green: obs(0) });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('red-not-failing');
  });

  test('拒:打补丁后测试没绿', () => {
    const v = judgeContract({ red: obs(1), green: obs(1) });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('green-not-passing');
  });

  test('拒:前后不是同一条命令 —— 排除不了「换条更宽松的命令放它过去」', () => {
    const v = judgeContract({ red: obs(1), green: obs(0, 'bun test --bail') });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('command-mismatch');
  });

  /**
   * ⚠ 这一条是 2026-08-05 **跑出真读数之后补的**:头一版合约只看退出码,
   * 于是把「新增功能」的 commit 收成了合格考题 —— 父提交上的 RED 是
   * `SyntaxError: Export named 'X' not found`(0 pass / 1 fail / **1 error**),
   * 退出码非 0 但**测试压根没跑起来**。那种题只证明"当时还没这个符号",
   * 不证明"这测试抓得住这个缺陷", 正是 SWE-bench 7–8% 虚高的同一机制。
   */
  test('⚠ 拒:RED 是「加载失败」而不是「断言失败」', () => {
    const v = judgeContract({ red: obs(1, CMD, LOAD_ERROR_TAIL), green: obs(0) });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('red-did-not-execute');
  });

  test('收:RED 是真断言失败(测试跑起来了, 0 error)', () => {
    expect(judgeContract({ red: obs(1, CMD, REAL_FAIL_TAIL), green: obs(0) }).ok).toBe(true);
  });

  test('fail-closed:RED 尾部解析不出来 → 不收(证不出是真失败就别收)', () => {
    const v = judgeContract({ red: obs(1, CMD, '一段谁也认不出的输出'), green: obs(0) });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('red-did-not-execute');
  });

  test('多条同时不成立时全部列出, 不止报第一条', () => {
    const v = judgeContract({ red: obs(0), green: obs(3, 'other') });
    expect(v.failures.sort()).toEqual(['command-mismatch', 'green-not-passing', 'red-not-failing']);
  });

  test('red-not-failing 与 red-did-not-execute 互斥(没红就不追问红得对不对)', () => {
    const v = judgeContract({ red: obs(0), green: obs(0) });
    expect(v.failures).toContain('red-not-failing');
    expect(v.failures).not.toContain('red-did-not-execute');
  });

  test('反向自检: 判据不是常函数(合格与不合格都到得了)', () => {
    const seen = new Set([
      judgeContract({ red: obs(1), green: obs(0) }).ok,
      judgeContract({ red: obs(0), green: obs(0) }).ok,
    ]);
    expect(seen).toEqual(new Set([true, false]));
  });

  test('拒的时候必须说清楚拒在哪条(判词不许空)', () => {
    const v = judgeContract({ red: obs(0), green: obs(0) });
    expect(v.reason.length).toBeGreaterThan(20);
    expect(v.reason).toContain('永远绿');
  });
});

describe('候选判分 —— 先判作弊再判对错', () => {
  const base = { task: TASK, protectedPathsTouched: [], regressionGreen: true as boolean | null };

  test('通过:命令绿 + 没动测试 + 回归绿', () => {
    expect(scoreCandidate({ ...base, run: obs(0) }).verdict).toBe('pass');
  });

  test('失败:命令红', () => {
    expect(scoreCandidate({ ...base, run: obs(1) }).verdict).toBe('fail');
  });

  test('⚠ invalid(不是 fail):候选把受保护的测试改了 —— Berkeley 那个攻击的本质', () => {
    const r = scoreCandidate({ ...base, run: obs(0), protectedPathsTouched: TASK.testPaths });
    expect(r.verdict).toBe('invalid');
    expect(r.reason).toContain('受保护');
  });

  test('⚠ 顺序: 改了测试且命令绿 —— 必须判 invalid, 不许判 pass', () => {
    // 若把「命令绿」判在前面, 这个作弊候选会拿到 pass。
    const r = scoreCandidate({ ...base, run: obs(0), protectedPathsTouched: ['src/harness/map-concurrency.test.ts'] });
    expect(r.verdict).not.toBe('pass');
  });

  test('invalid:候选跑了别的命令', () => {
    expect(scoreCandidate({ ...base, run: obs(0, 'bun test --bail') }).verdict).toBe('invalid');
  });

  test('失败:任务命令绿但全量回归红 —— 修 A 坏 B 不算修好', () => {
    const r = scoreCandidate({ ...base, run: obs(0), regressionGreen: false });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain('回归');
  });

  test('回归没跑 = null:仍判 pass, 但判词必须说明「只证明了局部」(NULL ≠ 通过)', () => {
    const r = scoreCandidate({ ...base, run: obs(0), regressionGreen: null });
    expect(r.verdict).toBe('pass');
    expect(r.reason).toContain('未跑');
    // 且与「跑了且绿」的判词不同 —— 两种状态在报告里必须分得开
    expect(r.reason).not.toBe(scoreCandidate({ ...base, run: obs(0), regressionGreen: true }).reason);
  });

  test('反向自检: 三格都到得了', () => {
    const seen = new Set([
      scoreCandidate({ ...base, run: obs(0) }).verdict,
      scoreCandidate({ ...base, run: obs(1) }).verdict,
      scoreCandidate({ ...base, run: obs(0), protectedPathsTouched: ['x'] }).verdict,
    ]);
    expect(seen).toEqual(new Set(['pass', 'fail', 'invalid']));
  });
});

describe('pass@k / pass^k —— gap 才是最值钱的读数', () => {
  const mk = (p: number, f: number, i = 0): ReturnType<typeof tallyTrials> =>
    tallyTrials([
      ...Array.from({ length: p }, () => ({ verdict: 'pass' as const, reason: '' })),
      ...Array.from({ length: f }, () => ({ verdict: 'fail' as const, reason: '' })),
      ...Array.from({ length: i }, () => ({ verdict: 'invalid' as const, reason: '' })),
    ]);

  test('3 次里 1 次成: pass@k=1 而 pass^k=0(gap 最大 = 靠运气)', () => {
    const t = mk(1, 2);
    expect(passAtK(t)).toBe(1);
    expect(passHatK(t)).toBe(0);
  });

  test('3 次全成: 两者都是 1(gap=0 = 路径稳定收敛)', () => {
    const t = mk(3, 0);
    expect(passAtK(t)).toBe(1);
    expect(passHatK(t)).toBe(1);
  });

  test('3 次全败: 两者都是 0', () => {
    const t = mk(0, 3);
    expect(passAtK(t)).toBe(0);
    expect(passHatK(t)).toBe(0);
  });

  test('⚠ invalid 不进分母 —— 否则作弊率会消失在通过率里', () => {
    const t = mk(2, 0, 5);
    expect(t.invalid).toBe(5);
    expect(passHatK(t)).toBe(1); // 2/2 有效试次全成
  });

  test('零有效试次返回 NaN, 不返回 0(没跑 ≠ 全败)', () => {
    expect(Number.isNaN(passAtK(mk(0, 0, 3)))).toBe(true);
    expect(Number.isNaN(passHatK(mk(0, 0, 0)))).toBe(true);
  });
});

describe('parseBunTestSummary —— error 与 fail 是两件事', () => {
  test('真断言失败: 有 fail 无 error', () => {
    const s = parseBunTestSummary('\n 3 pass\n 2 fail\n 12 expect() calls\n');
    expect(s).toMatchObject({ pass: 3, fail: 2, errors: 0, parsed: true });
    expect(redDidExecute('\n 3 pass\n 2 fail\n')).toBe(true);
  });

  test('加载失败: 有 error → 不算真执行过', () => {
    const s = parseBunTestSummary("# Unhandled error\nSyntaxError: x\n 0 pass\n 1 fail\n 1 error\n");
    expect(s.errors).toBe(1);
    expect(redDidExecute("# Unhandled error\nSyntaxError: x\n 0 pass\n 1 fail\n 1 error\n")).toBe(false);
  });

  test('没有显式 error 行但输出里有 SyntaxError → 仍算 error(bun 版本差异兜底)', () => {
    expect(redDidExecute("SyntaxError: boom\n 0 pass\n 1 fail\n")).toBe(false);
  });

  test('全绿不算"执行过并失败"', () => {
    expect(redDidExecute('\n 5 pass\n 0 fail\n')).toBe(false);
  });

  test('解析不出来 → parsed:false 且 redDidExecute 返回 null(不是 false, NULL≠假)', () => {
    expect(parseBunTestSummary('乱码').parsed).toBe(false);
    expect(redDidExecute('乱码')).toBeNull();
  });
});
