/**
 * src/eval/scorer —— conductor-eval 的客观打分核 (SDD 2026-07-21 Phase 0)。
 *
 * 一次 benchmark run = 跑一次 conductor DAG build (+ 有界 self-heal) → 对产物跑 tsc+test 命令闸,
 * 返回 4 量: firstShotPass(heal 前) / finalPass(heal 后) / healRounds / 按角色 token。
 *
 * 契约 (docs/plan/2026-07-21-conductor-eval-model-economics.md):
 *  - INV-6: 客观分**只**来自 tsc+test 命令闸 (parseBunTest 过测比例), 不用 verifier.ts 的 LLM verdict。
 *  - D-metric: firstShot(iter0, 未被 self-heal 掩盖) 喂 ①分解质量; final×成本 喂 ④经济; healRounds = thrash 代理。
 *  - 复用 dag-build 用的**积木** (classifyOracle) —— dag-build.ts 是脚本 (import 即执行), 不能 import,
 *    故此处不包裹它, 只共享 heal-fixpoint 的分支谓词, 保持与 dag-build 同一停机语义。
 *
 * 可测性: 编排 (scoreRun) 的模型/IO 全走注入接缝 (runDag / probe) —— 单测不起真模型也能验 4 量结构
 * 与 heal 循环 (承 "单测不烧 $, 真 build 留给 Phase ④")。纯解析 (parseBunTest) 独立可测。
 */
import type { ExecutorDagResult } from '../harness/executor-dag-types';
import { classifyOracle, type OracleSnapshot } from '../harness/build/oracle-classify';

/** `bun test` 汇总计数。total = pass+fail (skip 不计); fraction = pass/total, 无测试 → 0 (保守: 无信号≠满分)。 */
export interface BunTestResult {
  pass: number;
  fail: number;
  total: number;
  fraction: number;
}

/**
 * 解析 `bun test` 输出的过测比例 (纯函数, INV-6 的比例核)。
 * bun 汇总行形如 ` 12 pass` / ` 3 fail`, 各占一行。取**行锚定的最后一处匹配** (汇总在尾;
 * 防被中途 per-test `(pass)`/测试名里的数字误匹配)。无 pass/fail 行 (无测试/构建失败) → total 0 → fraction 0。
 */
export function parseBunTest(output: string): BunTestResult {
  const lastLineCount = (re: RegExp): number => {
    const g = new RegExp(re.source, 'gm');
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = g.exec(output)) !== null) n = Number(m[1]);
    return n;
  };
  const pass = lastLineCount(/^\s*(\d+)\s+pass\s*$/);
  const fail = lastLineCount(/^\s*(\d+)\s+fail\s*$/);
  const total = pass + fail;
  const fraction = total === 0 ? 0 : pass / total;
  return { pass, fail, total, fraction };
}

/** 一次 run 的 4 量 (+ 原始明细供落盘复盘)。 */
export interface RunMetrics {
  /** heal 前第一次过测比例 (0..1) —— ①分解质量信号。 */
  firstShotPass: number;
  /** heal 后终值过测比例 (0..1) —— ④质量。 */
  finalPass: number;
  /** self-heal 轮数 —— thrash 代理。 */
  healRounds: number;
  /** 本次 build DAG 的节点数。 */
  nodeCount: number;
  /** 按角色 token 累加 (跨初次 build + 各 heal 轮)。USD 折算见 src/model/cost-ledger, 此处只留 token 原值。 */
  usage: {
    conductorIn: number;
    conductorOut: number;
    leavesIn: number;
    leavesOut: number;
    leavesCacheHit: number;
  };
  raw: { firstShot: BunTestResult; final: BunTestResult };
}

/** oracle 探针 (注入接缝): 在**目标 workdir** 跑确定性命令闸, 只回结构化读数, 不含模型。 */
export interface OracleProbe {
  /** 跑 tsc → 结构化错误行 (空 = 无编译错)。 */
  tsc: () => Promise<string[]>;
  /** 跑 `bun test <scope>` → 原始 stdout+stderr (交 parseBunTest)。 */
  test: () => Promise<string>;
}

/** scoreRun 的注入依赖: 全部模型/IO 边界在此, 故编排逻辑可脱离真模型单测。 */
export interface ScoreDeps {
  /** 跑一次 conductor DAG build (初次 + 每 heal 轮), 回引擎结果 (含 usage/results)。 */
  runDag: (task: string) => Promise<ExecutorDagResult>;
  /** 每次 build 后的 oracle 探针。 */
  probe: OracleProbe;
  /** 由错误 digest 造 heal 轮的 fix 任务 (与 dag-build heal 语义一致: 只修不加不改契约)。 */
  fixTaskFor: (digest: string) => string;
}

function accumulate(acc: RunMetrics['usage'], r: ExecutorDagResult): void {
  acc.conductorIn += r.usage.conductor.in;
  acc.conductorOut += r.usage.conductor.out;
  acc.leavesIn += r.usage.leavesIn;
  acc.leavesOut += r.usage.leavesOut;
  acc.leavesCacheHit += r.usage.leavesCacheHit;
}

/**
 * 跑一次 benchmark 打分。green = tsc 零错 **且** 过测比例 == 1 (与 dag-build 同: tsc+test 双绿才算)。
 * heal 循环沿 classifyOracle 的封闭分支: 只在 'healable' 且预算未尽时续烧; hard_fail/stuck/green 皆停
 * (与 dag-build.ts 逐字节同一 fixpoint 语义, 复用同一谓词)。
 */
export async function scoreRun(
  task: string,
  opts: { maxHeal: number },
  deps: ScoreDeps,
): Promise<RunMetrics> {
  const usage: RunMetrics['usage'] = {
    conductorIn: 0,
    conductorOut: 0,
    leavesIn: 0,
    leavesOut: 0,
    leavesCacheHit: 0,
  };

  const first = await deps.runDag(task);
  accumulate(usage, first);
  const nodeCount = Object.keys(first.results).length;

  const probeOnce = async (): Promise<{ snap: OracleSnapshot; bt: BunTestResult }> => {
    const tscErrs = await deps.probe.tsc();
    const bt = parseBunTest(await deps.probe.test());
    const snap: OracleSnapshot = {
      green: tscErrs.length === 0 && bt.fraction === 1,
      digest: [tscErrs.slice(0, 15).join('\n'), bt.fail > 0 ? `${bt.fail} test fail` : '']
        .filter(Boolean)
        .join('\n'),
      tscErrs,
    };
    return { snap, bt };
  };

  let cur = await probeOnce();
  const firstShot = cur.bt;
  let healRounds = 0;
  let branch = classifyOracle(cur.snap, null);
  while (branch === 'healable' && healRounds < opts.maxHeal) {
    healRounds++;
    const prevDigest = cur.snap.digest;
    const fixRes = await deps.runDag(deps.fixTaskFor(cur.snap.digest));
    accumulate(usage, fixRes);
    cur = await probeOnce();
    branch = classifyOracle(cur.snap, { digest: prevDigest });
  }

  return {
    firstShotPass: firstShot.fraction,
    finalPass: cur.bt.fraction,
    healRounds,
    nodeCount,
    usage,
    raw: { firstShot, final: cur.bt },
  };
}
