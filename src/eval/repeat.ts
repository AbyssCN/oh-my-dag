/**
 * src/eval/repeat —— 「同段跑 n 次取分布」的尺子 + 冻结聚合口径 (SDD #159 切片 1)。
 *
 * 缺口 (#159 / #97 缺口②): src/eval 全域无「同段跑 n 次取分布」概念 —— G6 换座关键读数建立在
 * 1/21 (n=1 事件) 上, 尺子问题与采样噪声分不开。本文件交三件:
 *   1. repeatSegment  —— 任一段可跑 n 次、逐次落盘, 单次 run 抛错不中断段。
 *   2. aggregateBool / aggregateNum / renderRepeatLine  —— 冻结口径 (INV-3: 仓内 Wilson/均值
 *      方差只在此出现一次, 消费者 import, 不重写)。
 *   3. 判据③的反向自检面 —— 确定性 50% 段必须把"尺子本身在动"显出来, 不然尺子是死的。
 *
 * 不变量:
 *   INV-1 逐次落盘: 第 k 次跑完, 盘上 ≥ k 行 (中途死了已跑次数在盘上, 不是终局一次性写)。
 *   INV-2 单次 run 抛错不中断段: 该次记 {error} 且照落盘, 后续次照跑; error 次不进 bool/num
 *        聚合的分母, 但 renderRepeatLine 带 `err=<m>` 注记 (错误被静默并进分母或蒸发都是撒谎)。
 *   INV-3 聚合口径单点: Wilson/均值方差只在本文件出现一次。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 一次重复测量的记录; value = run(i) 的返回, 或 `{error: string}` 当该次抛错 (INV-2)。 */
export interface RepeatRecord<T> {
  i: number;
  /** ISO 时间戳 (UTC), 落盘后的可重放锚; 同一秒内也唯一是因为 `i`。 */
  at: string;
  value: T;
}

/** bool 段的冻结聚合: n / pass / rate / Wilson 95%。Wilson 公式见 wilson95() 内注释。 */
export interface AggregateBool {
  n: number;
  pass: number;
  rate: number;
  wilson95: [number, number];
}

/** num 段的冻结聚合: n / mean / 样本 sd (n-1) / min / max。 */
export interface AggregateNum {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
}

/**
 * 任一段可跑 n 次, 逐次落盘, 单次 run 抛错不中断段 (INV-2)。
 *
 * @param opts.id       段名, 同时是落盘文件名锚 (`<cwd>/.omd/eval/repeats/<id-sanitized>.jsonl` 默认 sink)
 * @param opts.n        ≥1, 违约抛。决定了聚合分母与口径行 `n=N`。
 * @param opts.run      一次测量。抛错 → 该次记 `{error}` 落盘 + 后续次照跑。
 * @param opts.sink     可选逐次落盘注入面; 缺省 append 到默认路径。Hermetic 测试一律用注入 sink
 *                      不碰真 .omd。
 *
 * 返回的 records 与 sink 的顺序一致 (1..n); error 次的 value 是 `{error: string}` 形状。
 * error 次**不进** aggregateBool/Num 的分母 —— 调用方在调用聚合前自己过 `r.value !== {error}`,
 * 详见 plan-validity 等消费者。
 */
export async function repeatSegment<T>(opts: {
  id: string;
  n: number;
  run: (i: number) => Promise<T>;
  sink?: (line: string) => void;
}): Promise<RepeatRecord<T | { error: string }>[]> {
  if (!Number.isInteger(opts.n) || opts.n < 1) {
    throw new Error(`repeatSegment: n must be an integer >= 1, got ${opts.n}`);
  }
  const sink = opts.sink ?? defaultSink(opts.id);
  const records: RepeatRecord<T | { error: string }>[] = [];
  for (let i = 0; i < opts.n; i++) {
    const at = new Date().toISOString();
    let value: T | { error: string };
    try {
      value = await opts.run(i);
    } catch (e) {
      value = { error: e instanceof Error ? e.message : String(e) };
    }
    const rec: RepeatRecord<T | { error: string }> = { i, at, value };
    records.push(rec);
    // INV-1: 逐次落盘, 立刻写, 不攒批。
    sink(JSON.stringify(rec));
  }
  return records;
}

/**
 * 默认 sink: append 到 `<cwd>/.omd/eval/repeats/<id-sanitized>.jsonl`, 按行 JSON。
 *
 * id 安全化: 非 `[A-Za-z0-9_-]` 替换为 `_` —— 路径注入面防御 (即使 id 来自用户, 也不会越目录)。
 * 路径拼装独立抽出成 `repeatPath` 是为了单测能纯验拼装, 不碰盘。
 */
function defaultSink(id: string): (line: string) => void {
  const path = repeatPath(id, '.omd/eval/repeats');
  return (line: string) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + '\n');
  };
}

/** 段 id → 落盘路径。纯函数, 单测用它验文件名安全化 (不碰盘)。 */
export function repeatPath(id: string, base = '.omd/eval/repeats'): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${base}/${safe}.jsonl`;
}

/**
 * Wilson 95% 区间 —— 二项比例在「小 n 下不塌边界」(n=1 也得有不是 0/1 的开口)。
 * 公式: center = (p + z²/2n) / (1 + z²/n), margin = z·sqrt(p(1-p)/n + z²/4n²) / (1 + z²/n),
 *        lo = max(0, center - margin), hi = min(1, center + margin), z=1.96。
 * 出处: 标准 Agresti-Coull 形式 (《Categorical Data Analysis》); 与 Wilson 1927 等价。
 * 仓内唯一处 (INV-3)。
 */
function wilson95(pass: number, n: number): [number, number] {
  if (n <= 0) return [0, 0];
  const z = 1.96;
  const z2 = z * z;
  const p = pass / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * bool 段冻结聚合 (D-2)。`values` = n 次测量的布尔结果, 调用方应**先过 error 次**再传:
 * repeatRecords.filter(r => !('error' in r.value)).map(r => r.value as boolean)。
 *
 * n=0 时 rate=0、wilson=[0,0] (无信号≠满分, 与 parseBunTest 同保守口径)。
 */
export function aggregateBool(values: readonly boolean[]): AggregateBool {
  const n = values.length;
  const pass = values.reduce((acc, v) => acc + (v ? 1 : 0), 0);
  const rate = n === 0 ? 0 : pass / n;
  const [lo, hi] = wilson95(pass, n);
  return { n, pass, rate, wilson95: [lo, hi] };
}

/**
 * num 段冻结聚合 (D-2)。样本标准差用 n-1 (Bessel 校正); n=0 返零值结构, n=1 返 mean=x、
 * sd=0 (样本差无定义, 不假装)。
 *
 * 调用方同样需要先过 error 次。
 */
export function aggregateNum(values: readonly number[]): AggregateNum {
  const n = values.length;
  if (n === 0) return { n, mean: 0, sd: 0, min: 0, max: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n === 1) return { n, mean, sd: 0, min: values[0]!, max: values[0]! };
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const sd = Math.sqrt(sq / (n - 1));
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n, mean, sd, min, max };
}

/**
 * 冻结口径行 (D-2)。读数板/报告只许印这一行, 不许自己再算一遍 (口径两处算必漂)。
 *
 * 形如: `<id>: 3/20 (rate .150 · Wilson95 [.052, .360] · n=20)`;
 *       errors > 0 时 末尾追 ` · err=<m>` 注记 (INV-2: 错误蒸发即撒谎)。
 *
 * `errs` 默认 0; 消费者从 repeatSegment 返回的 records 数 error 次传过来。
 */
export function renderRepeatLine(id: string, agg: AggregateBool, errs: number = 0): string {
  const [lo, hi] = agg.wilson95;
  const tail = errs > 0 ? ` · err=${errs}` : '';
  // 规格形如 `rate .150 / Wilson95 [.052, .360]` — 脱 [0,1) 前导 0, 读数紧; 1.000 不脱。
  const fmt = (x: number): string => {
    const s = x.toFixed(3);
    return s.startsWith('0.') ? '.' + s.slice(2) : s;
  };
  return `${id}: ${agg.pass}/${agg.n} (rate ${fmt(agg.rate)} · Wilson95 [${fmt(lo)}, ${fmt(hi)}] · n=${agg.n})${tail}`;
}
