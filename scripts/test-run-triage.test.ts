/**
 * `test-run-triage` 的判别力闸。
 *
 * ⚠ **四份样本全是真机抓的**(2026-08-23 当天的全量日志与一次真跑), 不是手编的 ——
 * 手编样本只能证明「正则和我脑子里的格式一致」, 而这个脚本要认的恰恰是**真实输出**的格式。
 * 每份样本下面都注了它来自哪一趟。
 *
 * 反向自检(2026-08-23 各跑过一遍, 还原复绿):
 * - 把 `RUNNER_TIMEOUT` 正则改成永不命中 ⇒ ★ 那条红(240s / 180s 两份都掉进 assertion,
 *   而那正是当天真实发生过的误判 —— 判别力就在这一格);
 * - 把 `RUNTIME_ACCOUNTING` 改成永不命中 ⇒ EBADF 那条红;
 * - 把 `exitCode` 里 runner-timeout 的优先级去掉 ⇒ 「超时与真失败并存」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { renderTriage, triageTestLog } from './test-run-triage';

/** 真样本 A —— 2026-08-23 第一趟全量(/tmp/fulltest.txt:697), F2 挂满 bun 的 240s 单测上限。 */
const SAMPLE_RUNNER_TIMEOUT = `
test/core/fault-injection.test.ts:
[omd/executor-dag] planned {"plan":"fake-plan","nodes":4,"levels":3}
(fail) F2 崩在轮间 —— 外层轮次与毒集跨进程存活 > maxRounds 是总上界: 崩一次不该换来额外轮数 [240014.35ms]
  ^ this test timed out after 240000ms.

 6776 pass
 2 skip
 1 fail
Ran 6779 tests across 582 files. [386.03s]
`;

/** 真样本 B —— 补完哨兵总上界之后那一趟(/tmp/full6.txt:822), 姊妹文件同形挂到 180s。 */
const SAMPLE_RUNNER_TIMEOUT_SIBLING = `
test/core/inner-loop-crash.test.ts:
(fail) G2/F1 真杀 —— 外力杀死留下的盘面本身是不是可读的 > SIGKILL 之后 runDir 里每一个 .json 都完整可解析 —— 撕裂在这类故障下构造上不可能 [180004.88ms]
  ^ this test timed out after 180000ms.

 6776 pass
 2 skip
 1 fail
`;

/** 真样本 C —— /tmp/full5.txt:703, bun 1.3.14 丢退出事件那族(判词自己说了"本次读数无效")。 */
const SAMPLE_RUNTIME_ACCOUNTING = `
test/core/fault-injection.test.ts:
error: runChild(resume 子进程): proc.exited 抛了 (Error: EBADF: bad file descriptor, epoll_ctl), 而子进程 (pid 3168938) **已经不在**。 这是运行时的子进程回收缺陷 (bun 1.3.14: 退出事件丢了), 不是被测对象的问题 —— 本次读数无效, 重跑。 同源的另一面是 EBADF/epoll_ctl。详见 src/harness/proc/await-exit.ts 的模块注。
      at awaitExitBounded (/home/dev/repos/oh-my-dag/src/harness/proc/await-exit.ts:226:15)
      at async runChild (/home/dev/repos/oh-my-dag/test/core/fault-injection.test.ts:62:9)
(fail) F3 坏盘 —— 撕裂/残留/损坏不得把恢复路径炸掉 > _fixpoint.json 被截断 → 不炸, 退回第 1 轮 (fail-open), 但毒集确实丢了 [421.55ms]

 6776 pass
 2 skip
 1 fail
`;

/** 真样本 D —— 一次真跑 `bun test` 的普通断言失败(/tmp/omd-sample, bun 1.3.14)。 */
const SAMPLE_ASSERTION = `
x.test.ts:
1 | import { expect, test } from 'bun:test';
2 | test('样本: 普通断言失败', () => {
3 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/omd-sample/x.test.ts:3:13)
(fail) 样本: 普通断言失败 [0.16ms]

 0 pass
 1 fail
 1 expect() calls
`;

/** 真样本 E —— 2026-08-23 收尾那趟全绿(/tmp/full7.txt)。 */
const SAMPLE_CLEAN = `
 6777 pass
 2 skip
 0 fail
 24122 expect() calls
Ran 6779 tests across 582 files. [117.48s]
`;

describe('test-run-triage 判别力', () => {
  test('★ runner 超时判成 runner-timeout, 退出码 2 —— 这一格就是当天被误判成 flaky 的那一格', () => {
    for (const sample of [SAMPLE_RUNNER_TIMEOUT, SAMPLE_RUNNER_TIMEOUT_SIBLING]) {
      const t = triageTestLog(sample);
      expect(t.failures).toHaveLength(1);
      expect(t.failures[0]!.kind).toBe('runner-timeout');
      expect(t.failures[0]!.evidence).toContain('this test timed out');
      expect(t.exitCode).toBe(2);
      // 下一步必须念出来 —— 分类不说下一步, 等于没分类。
      expect(renderTriage(t)).toContain('禁止记成 flaky');
    }
  });

  test('运行时记账丢失那族判成 runtime-accounting, 退出码 1 (重跑合法)', () => {
    const t = triageTestLog(SAMPLE_RUNTIME_ACCOUNTING);
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]!.kind).toBe('runtime-accounting');
    expect(t.exitCode).toBe(1);
    expect(renderTriage(t)).toContain('重跑合法');
  });

  test('普通断言失败判成 assertion, 判词原文跟着出来', () => {
    const t = triageTestLog(SAMPLE_ASSERTION);
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]!.kind).toBe('assertion');
    expect(t.failures[0]!.evidence).toContain('expect(received).toBe(expected)');
    expect(t.exitCode).toBe(1);
  });

  test('全绿 ⇒ 零条目、退出码 0, 且三个总数都读得出来', () => {
    const t = triageTestLog(SAMPLE_CLEAN);
    expect(t.failures).toHaveLength(0);
    expect(t.totals).toEqual({ pass: 6777, fail: 0, skip: 2 });
    expect(t.exitCode).toBe(0);
  });

  test('超时与真失败并存 ⇒ 退出码取 2 (最贵的那一类不许被别的盖过去)', () => {
    const t = triageTestLog(SAMPLE_RUNNER_TIMEOUT + SAMPLE_ASSERTION);
    expect(t.failures.map((f) => f.kind).sort()).toEqual(['assertion', 'runner-timeout']);
    expect(t.exitCode).toBe(2);
  });

  test('日志里没有总数行 ⇒ 三个都是 null, **不编 0**(读不到 ≠ 零, 仓规 §静默坑 1)', () => {
    const t = triageTestLog('bun test v1.3.14\n(还没跑完就被掐了)\n');
    expect(t.totals).toEqual({ pass: null, fail: null, skip: null });
    expect(renderTriage(t)).toContain('读不到');
  });
});
