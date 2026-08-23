#!/usr/bin/env bun
/**
 * test-run-triage —— 全量 `bun test` 红了之后, **机械地判它属于哪一类**(纯函数 + 薄 CLI,
 * 零模型调用、零建议、零改动)。
 *
 * ## 它治的是什么
 *
 * 一趟全量红了, 下一步只有两种: **重跑**(这次读数无效)或**去修**(真有东西坏了)。
 * 2026-08-23 一天里这两种混着出现了五次, 而分类全靠人眼看判词 —— 于是最贵的那一类
 * 被误判了一次: `this test timed out after 240000ms` 被当成 flaky 重跑, 而它其实是
 * **夹具里有一处等待没有界**。重跑当然会绿(那处等待只是偶尔不返回), 于是缺陷留在盘上,
 * 三小时后在姊妹文件里以同一形态再红一次。
 *
 * ⇒ **判据:runner 报出 `this test timed out` 这句话, 本身就是夹具缺陷的证据。**
 * 它出现的时候信息量恰恰是零 —— 判词该由夹具打印, 而夹具没来得及打印就被 runner 掐了。
 * 一个能被重跑掩盖的缺陷 = 一个永远不会被修的缺陷, 所以这一类**禁止记成 flaky**。
 *
 * ## 三类与各自的下一步(下一步不同, 才值得分类)
 *
 * | 类 | 认它的凭据 | 下一步 |
 * |---|---|---|
 * | `runner-timeout` | `^ this test timed out after <N>ms.` | **去修夹具的界**, 不许重跑 |
 * | `runtime-accounting` | `await-exit.ts` 那族判词(进程已经不在 / 退出事件丢 / EBADF) | 重跑合法, 但要记一笔 |
 * | `assertion` | 其余 `(fail)` 行 | 照常查判词 |
 *
 * ⚠ `runtime-accounting` 之所以能"重跑合法", 是因为**它自己打了判词**并明说
 * 「本次读数无效」—— 有判词的失败才谈得上被分类。这正好是 `runner-timeout` 缺的那一半。
 *
 * ## 跑法
 *
 *   bun run scripts/test-run-triage.ts --run [bun test 的参数…]   # 跑全量 + 当场判(推荐: `bun run test:full`)
 *   bun run scripts/test-run-triage.ts /tmp/full.txt              # 判一份已有的日志
 *   bun test 2>&1 | bun run scripts/test-run-triage.ts -          # 从 stdin 判
 *
 * 退出码: `0` 零失败 · `1` 有失败但不含 runner 超时 · `2` **含 runner 超时**(夹具的界漏了)。
 * ⚠ `--run` 模式自己 spawn `bun test` 并**完整收集**输出, 不经管道 ——
 *   管道里的 `head` 会吞掉真退出码(本仓踩过), 而这个脚本的产物正是"真退出码 + 分类"。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export type FailureKind = 'runner-timeout' | 'runtime-accounting' | 'assertion';

export interface FailureEntry {
  kind: FailureKind;
  /** `(fail)` 行里的用例名(拿不到就是空串 —— 拿不到也不编)。 */
  test: string;
  /** 该类判据在日志里的那一行原文(给人贴进票里用)。 */
  evidence: string;
}

export interface Triage {
  failures: FailureEntry[];
  /** `N pass` / `N fail` / `N skip` 三个总数; 日志里没有就是 `null`(**读不到 ≠ 0**)。 */
  totals: { pass: number | null; fail: number | null; skip: number | null };
  /** 见文件头退出码表。 */
  exitCode: 0 | 1 | 2;
}

/** `(fail) <名字> [<耗时>]` —— bun 的失败行。 */
const FAIL_LINE = /^\(fail\)\s+(.*?)\s*\[[\d.]+m?s\]\s*$/;
/** runner 自己的超时行(它**紧跟**在对应的 `(fail)` 行之后)。 */
const RUNNER_TIMEOUT = /^\s*\^ this test timed out after \d+ms\.\s*$/;
/**
 * `await-exit.ts` 那族的判词特征。
 * ⚠ 认的是**判词里的固定措辞**, 不是 `EBADF` 三个字母 —— 后者可能来自任何一处真 IO 错误,
 *   而这一族的定义是「进程没了而事件/EOF 没落定」, 只有那几句话说得出这件事。
 */
const RUNTIME_ACCOUNTING = /退出事件丢|把子进程记账弄丢|管道到不了 EOF|本次读数无效/;

const TOTAL = (word: string): RegExp => new RegExp(`^\\s*(\\d+)\\s+${word}\\s*$`, 'm');

const readTotal = (log: string, word: string): number | null => {
  const m = TOTAL(word).exec(log);
  return m ? Number(m[1]) : null;
};

/**
 * 判一份 `bun test` 的输出。**纯函数** —— 于是判别力可以拿真样本注入验
 * (`test-run-triage.test.ts` 里四份样本全是真机抓的, 不是手编的)。
 */
export function triageTestLog(log: string): Triage {
  const lines = log.split('\n');
  const failures: FailureEntry[] = [];
  // ⚠ 分类要**向前看一行**: runner 的超时行在 `(fail)` 之后; 而 runtime-accounting 的判词
  //   在 `(fail)` **之前**(它是抛出来的 error, 先打印)。两个方向都要看, 顺序是判据不是风格。
  for (let i = 0; i < lines.length; i++) {
    const m = FAIL_LINE.exec(lines[i]!);
    if (!m) continue;
    const test = m[1]!;
    const next = lines[i + 1] ?? '';
    if (RUNNER_TIMEOUT.test(next)) {
      failures.push({ kind: 'runner-timeout', test, evidence: next.trim() });
      continue;
    }
    // 往回找最近的一条 `error:` —— 那是这条用例的判词。找不到就归 assertion(不编)。
    const back = lines.slice(Math.max(0, i - 30), i).reverse();
    const err = back.find((l) => l.startsWith('error:'));
    failures.push(
      err && RUNTIME_ACCOUNTING.test(err)
        ? { kind: 'runtime-accounting', test, evidence: err.slice(0, 300) }
        : { kind: 'assertion', test, evidence: (err ?? '(没找到 error: 判词)').slice(0, 300) },
    );
  }
  const totals = {
    pass: readTotal(log, 'pass'),
    fail: readTotal(log, 'fail'),
    skip: readTotal(log, 'skip'),
  };
  const exitCode = failures.some((f) => f.kind === 'runner-timeout') ? 2 : failures.length > 0 ? 1 : 0;
  return { failures, totals, exitCode };
}

/** 人读的一段。**只报事实与下一步**, 不建议怎么改代码。 */
export function renderTriage(t: Triage): string {
  const n = (v: number | null): string => (v === null ? '读不到' : String(v));
  const head = `读数: ${n(t.totals.pass)} pass / ${n(t.totals.fail)} fail / ${n(t.totals.skip)} skip`;
  if (t.failures.length === 0) return `${head}\n零失败。`;
  const byKind = (k: FailureKind): FailureEntry[] => t.failures.filter((f) => f.kind === k);
  const block = (k: FailureKind, title: string, next: string): string => {
    const items = byKind(k);
    if (items.length === 0) return '';
    return (
      `\n【${title}】${items.length} 条 —— ${next}\n` +
      items.map((f) => `  · ${f.test}\n    ${f.evidence}`).join('\n')
    );
  };
  return (
    head +
    block('runner-timeout', 'runner 超时', '夹具里有一处等待没有界。**禁止记成 flaky 重跑** —— 重跑会绿, 而缺陷留在盘上。') +
    block('runtime-accounting', '运行时记账丢失', '判词自己说了本次读数无效 —— 重跑合法, 但要记一笔(反复出现就该换拿退出码/EOF 的路子)。') +
    block('assertion', '真失败', '照常查判词。')
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let log: string;
  if (args[0] === '--run') {
    const proc = Bun.spawnSync(['bun', 'test', ...args.slice(1)], { stdout: 'pipe', stderr: 'pipe' });
    const dec = new TextDecoder();
    log = `${dec.decode(proc.stdout)}\n${dec.decode(proc.stderr)}`;
    const out = `/tmp/omd-test-run-${Date.now()}.txt`;
    writeFileSync(out, log);
    console.log(`${log.slice(-4000)}\n--- 全文: ${out} ---`);
  } else {
    const src = args[0] ?? '-';
    log = src === '-' ? await Bun.stdin.text() : readFileSync(src, 'utf-8');
  }
  const t = triageTestLog(log);
  console.log(renderTriage(t));
  process.exit(t.exitCode);
}
