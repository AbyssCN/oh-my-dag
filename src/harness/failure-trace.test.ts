/**
 * 失败留痕两件器的闸(2026-08-06)。
 *
 * ⚠ **这份网最要紧的一条是"61/63 不许变"**:改动前失败 summary 是 `slice(0, 800)`,
 * 而盘上 63 份真失败里只有 2 份撞到上限。剩下 61 份的 summary 必须与改动前**逐字相同**,
 * 否则这次改动会让历史读数与新读数不可比 —— 那是本仓「加尺子」那条纪律的反面:
 * 换尺子可以,但不许在不知情的情况下换。
 *
 * ⚠ **反向自检**(仓规:一条永远绿的闸不是闸)。逐条证伪方式:
 *   · `failureExcerpt` 短文原样 → 把实现改成无条件切头(`text.slice(0, 800)`),
 *     "尾巴留住"那条立刻红(它就是原实现,红的正是它该抓的那次丢失)。
 *   · `blamePathCandidates` 写盘核实 → 把 `isFile` 恒 true,"不存在的路径不算"立刻红。
 *   · 后缀白名单 → 把 `PATH_TOKEN` 放宽成 `\S+\.\w+`,"版本号不是路径"立刻红。
 */
import { describe, expect, test } from 'bun:test';
import { blamePathCandidates, failureExcerpt } from './failure-trace';

describe('failureExcerpt —— 砍错一头才是病', () => {
  test('短于预算 → 原样返回(61/63 份历史记录走这条路,必须逐字不变)', () => {
    const s = 'bun test\n1 pass 0 fail';
    expect(failureExcerpt(s)).toBe(s);
    // 边界:恰好等于预算也算短
    const exact = 'x'.repeat(800);
    expect(failureExcerpt(exact)).toBe(exact);
  });

  test('超预算 → 头和尾都留住(原实现只留头,失败判词在尾巴上)', () => {
    // 盘上真实形状:`tsc && bun test A && bun test` —— 前两段刷屏, 真失败在最后。
    const text = `bun run tsc --noEmit\n${'成功刷屏 '.repeat(400)}\nerror: 1 test failed in src/x.test.ts`;
    const got = failureExcerpt(text);
    expect(got).toContain('bun run tsc --noEmit'); // 头:在跑什么
    expect(got).toContain('1 test failed in src/x.test.ts'); // 尾:判了什么 ← 原实现丢的就是这句
    expect(got).toContain('中间省略');
    expect(got.length).toBeLessThan(text.length);
  });

  test('省略标记报的是真实省略量(不是随口写的数)', () => {
    const text = 'A'.repeat(2000);
    const got = failureExcerpt(text, { head: 10, tail: 20 });
    expect(got).toContain(`中间省略 ${2000 - 10 - 20} 字`);
  });
});

describe('blamePathCandidates —— 认路径, 但只认盘上真有的', () => {
  const yes = (): boolean => true;

  test('tsc 报错点名的文件认得出(assert-failed 里唯一认出过的那一格)', () => {
    const text = 'src/harness/dag-record-acceptance-probe.test.ts(36,3): error TS2353: Object literal may only specify';
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes })).toEqual([
      'src/harness/dag-record-acceptance-probe.test.ts',
    ]);
  });

  test('不存在的路径不算 —— 核不过就丢(漏认不误认)', () => {
    const text = 'error in src/nope.ts and src/yes.ts';
    const only = (p: string): boolean => p.endsWith('src/yes.ts');
    expect(blamePathCandidates(text, { root: '/repo', statFile: only })).toEqual(['src/yes.ts']);
  });

  test('版本号 / 纯噪声不是路径', () => {
    const text = 'bun test v1.3.14 (0d9b296a)\n28 pass\n 0 fail\nRan 28 tests across 3 files. [1.20s]';
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes })).toEqual([]);
  });

  test('[expect_exit] 这类语义失败里没有可归咎的路径 —— 盘上 assert-failed 的主流形状', () => {
    const text = '[expect_exit 1, 实得 0]\nbun test v1.3.14\n20 pass\n 0 fail\n452 expect() calls';
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes })).toEqual([]);
  });

  test('node_modules / .git / .omd 里的路径不归咎(没有节点写它们)', () => {
    const text = 'at node_modules/foo/index.js:1 and .omd/continuity/x.json and src/real.ts';
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes })).toEqual(['src/real.ts']);
  });

  test('去重 + 保持首次出现序 + 服从 limit', () => {
    const text = 'b.ts a.ts b.ts c.ts';
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes })).toEqual(['b.ts', 'a.ts', 'c.ts']);
    expect(blamePathCandidates(text, { root: '/repo', statFile: yes, limit: 2 })).toEqual(['b.ts', 'a.ts']);
  });

  test('默认 statFile 走真盘:仓里真有的认得出, 编的认不出', () => {
    const text = 'src/harness/failure-trace.ts 与 src/harness/绝无此文件.ts';
    expect(blamePathCandidates(text, { root: process.cwd() })).toEqual(['src/harness/failure-trace.ts']);
  });
});
