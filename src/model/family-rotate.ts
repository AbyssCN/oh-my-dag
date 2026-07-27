/**
 * family-rotate —— N 路跨家族分配, stamp 兄弟散布 + research (lens/synth/judge panel) 的唯一真源。
 *
 * 本仓铁律 (README design rules): 「同族 N 个单元共享盲点」。任何 ≥2 个独立单元的扇出 —— 无论生成
 * (lens / synth framing) 还是评判 (judge panel / verify) —— 都该把单元轮到不同模型家族。此前 stamp-pass
 * 内联了一套 (fams[i%len] + 家族内游标), research 则没有 (全用单 lensModel)。抽到这里成唯一实现。
 *
 * 算法: 坐标按 modelFamily 分桶 → **平滑加权轮转 (SWRR)** 选家族 → 家族内游标轮坐标。
 *   - 无权重 = 均匀跨家族 (DAG 兄弟散布用: 只求不同族, 不管成本)。
 *   - 带权重 = 「N% 走某坐标」的经济约束 (research 发散池用: 如 50% 留订阅 mimo-v2.5-pro,
 *     另 50% 由付费 Go 家族 qwen/minimax/deepseek 分)。权重挂在坐标上, 家族权重 = 族内坐标权重之和。
 *
 * SWRR (nginx 平滑加权轮转): 每步所有家族 current += weight, 取 current 最大者, 选中者 current -= total。
 * 分布平滑 (不扎堆), 且长跑收敛到精确权重比。纯函数, 无 I/O。
 */
import { modelFamily } from './channels';

/**
 * 造 n 个坐标分配, 跨家族最大化。
 * @param coords 候选坐标池 (provider:modelId)。空 → []。
 * @param n 要分配的单元数 (镜头/兄弟/评判维度数)。≤0 → []。
 * @param opts.weights coord→相对权重 (缺省 1); 用于加权 (如 mimo-v2.5-pro:3 → 50%)。
 * @param opts.familyOf 家族解析 (测试注入; 默认 modelFamily)。
 */
export function rotateFamilies(
  coords: string[],
  n: number,
  opts: { weights?: Record<string, number>; familyOf?: (c: string) => string } = {},
): string[] {
  const famOf = opts.familyOf ?? modelFamily;
  const clean = coords.map((c) => c.trim()).filter(Boolean);
  if (clean.length === 0 || n <= 0) return [];

  // 按家族分桶 (保坐标入池序 → 家族内轮转稳定)。
  const buckets = new Map<string, string[]>();
  for (const c of clean) {
    const f = famOf(c);
    buckets.set(f, [...(buckets.get(f) ?? []), c]);
  }
  const fams = [...buckets.keys()];

  // 家族权重 = 族内坐标权重之和 (coord 缺省 1)。
  const famWeight = new Map<string, number>(
    fams.map((f) => [f, (buckets.get(f) ?? []).reduce((s, c) => s + (opts.weights?.[c] ?? 1), 0)]),
  );
  const totalW = [...famWeight.values()].reduce((a, b) => a + b, 0);

  const current = new Map<string, number>(fams.map((f) => [f, 0]));
  const cursor = new Map<string, number>(fams.map((f) => [f, 0]));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // SWRR: 全家族 current += 权重, 取最大。
    let pick = fams[0]!;
    for (const f of fams) {
      const next = current.get(f)! + famWeight.get(f)!;
      current.set(f, next);
      if (next > current.get(pick)!) pick = f;
    }
    current.set(pick, current.get(pick)! - totalW);
    // 家族内游标轮坐标。
    const arr = buckets.get(pick)!;
    const ci = cursor.get(pick)!;
    out.push(arr[ci % arr.length]!);
    cursor.set(pick, ci + 1);
  }
  return out;
}
