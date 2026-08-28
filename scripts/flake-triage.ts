#!/usr/bin/env bun
/**
 * scripts/flake-triage —— 全量红逐条单跑复核(T-5,2026-08-28)。
 *
 * ## 它替掉的那个手工动作
 *
 * 全量 `bun test` 红了之后,分辨「结构性红」与「抖动 / 全量下的相互干扰」靠的是同一套动作:
 * 把红的用例归到文件,一个文件一个文件单跑,只留单跑仍红的。这套动作是机械的,
 * 而机械的东西不该每次靠人重做一遍。
 *
 * ⚠ **为什么必须是「单文件重跑」而不是「整套跑两遍」**:两种红的分辨点不同 ——
 * 跑两遍只分得开「随机抖动」,分不开**全量下的相互干扰**(那种红两遍都红,单跑才绿)。
 * 而后者恰恰是本仓已观测到的一种(`src/tui/tools/chat-seat.test.ts`,引擎自己也独立标记过)。
 *
 * ## 三个桶,不是两个
 *
 * · `stable` 单跑仍红 —— 结构性,该修的是它;
 * · `flaky`  单跑转绿 —— 抖动 / 相互干扰 / **或者盘在两次跑之间被改过**,人扫一眼再定;
 *   ⚠ 「单跑那一刻它是绿的」不等于「它是抖动」。同树多窗口作业时第三种最常见。
 * · `unattributed` 归不了属 —— 文件头没抓到、或单跑里找不到那条用例名。
 *
 * 第三个桶是刻意留的(仓规坑 ①:`NULL` ≠ 0 ≠ 不适用)。把归不了属的悄悄塞进
 * `flaky`,就等于拿「我没看见」冒充「我看过了没事」——而那正是这类工具最容易骗人的地方。
 *
 * ## 用法
 *
 *     bun run scripts/flake-triage.ts              # 自己跑一遍全量再复核
 *     bun run scripts/flake-triage.ts <全量输出文件> # 复用已有的一份输出, 不重跑
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface FailureRef {
  /** 归属文件(repo 相对路径);归不了属时是 `null`。 */
  readonly file: string | null;
  /** `(fail)` 那一行去掉前缀与耗时后的用例全名;加载期错误则是 `# 加载期错误: <原文>`。 */
  readonly test: string;
}

/** `bun test` 在每个**有输出的**文件前印一行 `path/to/x.test.ts:`。 */
const FILE_HEADER = /^(\S+\.test\.ts):$/;
/** `(fail) 名字 [12.34ms]` —— 末尾耗时不属于用例名。 */
const FAIL_LINE = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/;
/**
 * 加载期错误 —— **它不印 `(fail)` 行**(2026-08-28 第一次真跑当场撞见)。
 *
 * 实账:`src/harness/memory/staleness.test.ts` 因 `Export named 'fingerprintFile' not found`
 * 整个模块加载失败,bun 摘要记 `3 fail / 1 error`,而 `(fail)` 行只有 2 条。
 * 只认 `(fail)` 的解析器会把它**整条漏掉**,然后报告「全量 2 条红」——
 * 一个把问题数说少了的工具比没有工具更坏。
 */
const ERROR_BLOCK = /^# Unhandled error between tests$/;
/** bun 自己的摘要计数,用来对账「我解析到的」与「它数出来的」。 */
const SUMMARY_FAIL = /^\s*(\d+)\s+fail$/;

/**
 * 从一份 `bun test` 输出里抽出「哪条用例红了、它属于哪个文件」。**纯函数**。
 *
 * 归属靠「最近一个文件头」。bun 只为有输出的文件印头,所以理论上存在
 * 「红了却没印头」的情形 —— 那时归属会落到**上一个**文件上。本函数不去猜:
 * 归属是否成立由调用方拿单跑结果复核(单跑里找不到同名用例 ⇒ 进 `unattributed`)。
 */
export function attributeFailures(output: string): FailureRef[] {
  const out: FailureRef[] = [];
  let current: string | null = null;
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const h = FILE_HEADER.exec(line);
    if (h) {
      current = h[1]!;
      continue;
    }
    if (ERROR_BLOCK.test(line)) {
      // 块形状: `# Unhandled error between tests` / `----` / 原文 / `----`。
      // 取第一行非分隔线的原文当名字 —— 单跑时同一个模块还是加载不了, 名字一致 ⇒ 判 stable。
      const detail = lines.slice(i + 1, i + 5).map((x) => x.trim()).find((x) => x.length > 0 && !/^-+$/.test(x));
      out.push({ file: current, test: `# 加载期错误: ${detail ?? '(原文取不到)'}` });
      continue;
    }
    const f = FAIL_LINE.exec(line);
    if (f) out.push({ file: current, test: f[1]!.trim() });
  }
  return out;
}

/**
 * bun 自己数出来的坏用例总数。取不到 → `null`(取不到 ≠ 0)。
 *
 * ⚠ **`N fail` 已经把 `N error` 算在内了,不许相加**。实测(2026-08-28 那一跑):
 * 摘要 `3 fail / 1 error`,而输出里只有 **2** 条 `(fail)` 行 + **1** 个加载期错误块
 * —— 2 + 1 = 3 = 那个 `fail`。首版写成 `fail + error` 得 4,于是分母自检**恒报假警**,
 * 而一个恒报警的自检等于没有自检。`error` 仍单独解析出来只为读它的存在性,不进和。
 *
 * **分母自检**用:解析到的条数与它对不上,说明解析器漏了一种形态 ——
 * 一个把问题数说少了的工具比没有工具更坏,所以这个数必须报出来,不许内部消化。
 */
export function declaredBadCount(output: string): number | null {
  let fail: number | null = null;
  for (const line of output.split('\n')) {
    const f = SUMMARY_FAIL.exec(line);
    if (f) fail = Number(f[1]);
  }
  return fail;
}

/** 跑一份 `bun test`(可指定文件),回原始输出。退出码不看 —— 红不红由输出里的 `(fail)` 说。 */
function runBunTest(target?: string): string {
  const args = target ? ['test', target] : ['test'];
  const r = spawnSync('bun', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

export interface TriageReport {
  readonly stable: FailureRef[];
  readonly flaky: FailureRef[];
  readonly unattributed: FailureRef[];
}

/** 复核:逐文件单跑一次,按「单跑里那条用例还在不在红名单里」分三桶。 */
export function triage(failures: readonly FailureRef[], runFile: (f: string) => string): TriageReport {
  const stable: FailureRef[] = [];
  const flaky: FailureRef[] = [];
  const unattributed: FailureRef[] = [];
  /** 一个文件只单跑一次,同文件多条红共用那一份结果。 */
  const cache = new Map<string, Set<string>>();
  for (const f of failures) {
    if (f.file === null) {
      unattributed.push(f);
      continue;
    }
    let solo = cache.get(f.file);
    if (!solo) {
      solo = new Set(attributeFailures(runFile(f.file)).map((x) => x.test));
      cache.set(f.file, solo);
    }
    if (solo.has(f.test)) stable.push(f);
    else if (solo.size === 0) flaky.push(f);
    // 单跑也红、但红的是**别的**用例 ⇒ 归属存疑, 不许当成「它绿了」。
    else unattributed.push(f);
  }
  return { stable, flaky, unattributed };
}

if (import.meta.main) {
  const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : runBunTest();
  const failures = attributeFailures(src);
  // ── 分母自检: 先说清「我解析到几条 / bun 数出来几条」──────────────────────────
  // 对不上就大声说, 不许内部消化。把问题数说少了的工具比没有工具更坏。
  const declared = declaredBadCount(src);
  if (declared !== null && declared !== failures.length) {
    console.error(
      `⚠ 分母对不上: bun 数出 ${declared} 条坏用例, 本脚本只解析到 ${failures.length} 条。\n` +
        `  差的那些是**本脚本没认出来的形态** —— 下面的报告是不全的, 别拿它当全貌。\n`,
    );
  }
  if (failures.length === 0) {
    console.log(declared ? '本脚本解析到 0 条(见上面的分母告警)。' : '全量零红 —— 没有要复核的。');
    process.exit(declared ? 1 : 0);
  }
  console.log(`全量 ${failures.length} 条红 (bun 自己数 ${declared ?? '?'} 条), 逐文件单跑复核中…\n`);
  const r = triage(failures, (f) => runBunTest(f));
  const show = (label: string, xs: FailureRef[]) => {
    console.log(`${label} (${xs.length})`);
    for (const x of xs) console.log(`  ${x.file ?? '(归不了属)'} :: ${x.test}`);
    console.log('');
  };
  show('■ 单跑仍红 —— 结构性, 该修的是这些', r.stable);
  // ⚠ 「单跑转绿」只是**单跑那一刻它是绿的**, 不等于「它是抖动」。同树多窗口作业时,
  //   盘可能在全量与单跑之间被改过 (2026-08-28 首次真跑就撞到: 一条加载期错误在单跑时
  //   已经绿了, 因为隔壁窗口把那个模块补完了)。所以这一桶要人扫一眼, 不是自动免罪。
  show('□ 单跑转绿 —— 抖动 / 相互干扰 / 或者盘在两次跑之间被改过, 人扫一眼再定', r.flaky);
  show('? 归属存疑 —— 单跑里找不到同名用例, 自己去看一眼', r.unattributed);
  // 退出码只认结构性红: 抖动不该让 CI 红, 归属存疑也不该 —— 但它们都印出来了。
  process.exit(r.stable.length > 0 ? 1 : 0);
}
