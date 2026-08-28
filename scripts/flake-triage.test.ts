/**
 * flake-triage 的判据自证(T-5,2026-08-28)。
 *
 * 被测的是两个**纯函数**:归属(`attributeFailures`)与分桶(`triage`)。
 * 单跑那一步注入替身 —— 真去跑 `bun test` 的话这组测试自己就要几分钟,
 * 而且它要证的事(分桶对不对)与「bun 跑得快不快」无关。
 *
 * ## 反向自检(真跑过)
 * · 把 `FAIL_LINE` 的耗时后缀去掉(不剥 `[12ms]`)→ ★② 红(用例名带上耗时, 与单跑对不上)。
 * · 把「单跑也红但红的是别的用例」并进 `flaky` → ★⑤ 红(拿「我没看见」冒充「没事」)。
 * · 把 `file === null` 那一格并进 `flaky` → ★④ 红(同上一条的另一面)。
 */
import { describe, expect, test } from 'bun:test';
import { attributeFailures, declaredBadCount, triage } from './flake-triage';

/**
 * 加载期错误的真实形状(2026-08-28 从一次真跑里逐字抄来)。
 * 它**不印 `(fail)` 行** —— 只认 `(fail)` 的解析器会把它整条漏掉。
 */
const WITH_LOAD_ERROR = [
  'src/a.test.ts:',
  '(fail) 甲 > 真的坏了 [12.34ms]',
  '',
  'src/broken.test.ts:',
  '',
  '# Unhandled error between tests',
  '-------------------------------',
  "SyntaxError: Export named 'fingerprintFile' not found in module '/x/staleness.ts'.",
  '-------------------------------',
  '',
  ' 8222 pass',
  ' 3 skip',
  ' 2 fail',
  ' 1 error',
].join('\n');

const FULL = [
  'bun test v1.3.14',
  '',
  'src/a.test.ts:',
  '(pass) 甲 > 没事 [1.00ms]',
  '(fail) 甲 > 真的坏了 [12.34ms]',
  '',
  'src/b.test.ts:',
  '[某个模块的日志] 无关噪声',
  '(fail) 乙 > 只在全量下红 [5.00ms]',
  '',
  ' 8200 pass',
  ' 2 fail',
].join('\n');

describe('flake-triage · 归属', () => {
  test('★① `(fail)` 归到最近一个文件头', () => {
    expect(attributeFailures(FULL)).toEqual([
      { file: 'src/a.test.ts', test: '甲 > 真的坏了' },
      { file: 'src/b.test.ts', test: '乙 > 只在全量下红' },
    ]);
  });

  test('★② 用例名剥掉末尾耗时 (不剥就与单跑的那一行对不上, 分桶全错)', () => {
    const one = attributeFailures('src/x.test.ts:\n(fail) 名字 [999.99ms]');
    expect(one[0]!.test).toBe('名字');
    // 秒级后缀也要剥 —— bun 对慢用例印的是 `[1.23s]`。
    expect(attributeFailures('src/x.test.ts:\n(fail) 名字 [1.23s]')[0]!.test).toBe('名字');
  });

  test('★③ 文件头之前就出现的红 → file 为 null (不许瞎认一个文件)', () => {
    expect(attributeFailures('(fail) 无主的红 [1ms]')).toEqual([{ file: null, test: '无主的红' }]);
  });
});

describe('flake-triage · 加载期错误 (第一次真跑撞出来的盲区)', () => {
  test('★⑧ `# Unhandled error between tests` 也算一条红, 并归到它自己的文件', () => {
    // 实账: 只认 `(fail)` 的首版在真树上报「全量 2 条红」而 bun 数出 3 条 ——
    // 一个把问题数说少了的工具比没有工具更坏。
    const got = attributeFailures(WITH_LOAD_ERROR);
    expect(got).toHaveLength(2);
    expect(got[1]!.file).toBe('src/broken.test.ts');
    expect(got[1]!.test).toContain('加载期错误');
    expect(got[1]!.test).toContain('fingerprintFile');
  });

  test('★⑨ 分母自检: bun 自己数出来的 `N fail` 拿得到 (它已含 error, 不许相加)', () => {
    // 解析到的条数与它对不上 = 解析器漏了一种形态, 报告不全。这个数必须报出来。
    // ⚠ `N fail` 已含 `N error`, 不许相加 —— fixture 里 1 条 (fail) + 1 个错误块 = 摘要的 `2 fail`。
    //   首版写成 fail+error 得 3, 分母自检恒报假警; 而恒报警的自检等于没有自检。
    expect(declaredBadCount(WITH_LOAD_ERROR)).toBe(2);
    expect(declaredBadCount(FULL)).toBe(2);
    expect(declaredBadCount('什么摘要都没有')).toBeNull(); // 取不到 ≠ 0
  });
});

describe('flake-triage · 分桶', () => {
  const failures = attributeFailures(FULL);

  test('★④ 三桶各归各: 单跑仍红 = stable, 单跑全绿 = flaky', () => {
    const r = triage(failures, (f) =>
      f === 'src/a.test.ts'
        ? 'src/a.test.ts:\n(fail) 甲 > 真的坏了 [11.00ms]' // 单跑仍红
        : 'src/b.test.ts:\n 3 pass\n 0 fail', // 单跑全绿
    );
    expect(r.stable.map((x) => x.test)).toEqual(['甲 > 真的坏了']);
    expect(r.flaky.map((x) => x.test)).toEqual(['乙 > 只在全量下红']);
    expect(r.unattributed).toEqual([]);
  });

  test('★⑤ 单跑也红、但红的是**别的**用例 → 归属存疑, 不许当成「它绿了」', () => {
    // 这一格是本文件最要紧的: 把它并进 flaky, 就是拿「我没看见」冒充「我看过了没事」。
    const r = triage(failures, (f) =>
      f === 'src/a.test.ts'
        ? 'src/a.test.ts:\n(fail) 甲 > 另一条完全不同的用例 [11.00ms]'
        : 'src/b.test.ts:\n 3 pass\n 0 fail',
    );
    expect(r.stable).toEqual([]);
    expect(r.unattributed.map((x) => x.test)).toEqual(['甲 > 真的坏了']);
  });

  test('★⑥ 归不了属的 (file 为 null) 直接进 unattributed, 不去跑任何东西', () => {
    let calls = 0;
    const r = triage([{ file: null, test: '无主的红' }], () => {
      calls++;
      return '';
    });
    expect(r.unattributed.map((x) => x.test)).toEqual(['无主的红']);
    expect(calls).toBe(0);
  });

  test('★⑦ 同一文件的多条红只单跑一次 (复核的钱不按红的条数付)', () => {
    const many = attributeFailures('src/a.test.ts:\n(fail) 一 [1ms]\n(fail) 二 [1ms]\n(fail) 三 [1ms]');
    let calls = 0;
    triage(many, () => {
      calls++;
      return 'src/a.test.ts:\n 9 pass\n 0 fail';
    });
    expect(calls).toBe(1);
  });
});
