/**
 * m3-vs-flash-econ —— **M3(直连 + adaptive) vs deepseek-v4-flash: token · 延迟 · 三种钱**。
 *
 * 三种钱都算, 因为它们回答的是不同的问题:
 *   ① 按 **deepseek 官网价** —— 我们今天付的真钱(v4-flash 是现役 inproc leaf 座)。
 *   ② 按 **MiniMax M3 API 刊例价** —— 不买套餐时 M3 的真钱。
 *   ③ 按 **MiniMax Ultra ¥469 套餐折算** —— 买了套餐后 M3 的边际"钱"(额度价)。
 *
 * ## 价格全部一手核过(2026-08-14)
 *
 * - deepseek: api-docs.deepseek.com/quick_start/pricing → v4-flash **$0.0028 / $0.14 / $0.28** 每 M
 *   (命中/未命中/输出)。⚠ **仓里 `cost-ledger.ts:22` 写的是 0.07/0.27/1.10, 已过期且偏高 2–4 倍。**
 *   ⚠⚠ 同页脚注: **2026-08-16 16:00 UTC 起改峰谷计价**, off-peak 0.007/0.22/0.66 · peak 0.014/0.44/1.32
 *   (峰时 01:00–04:00 与 06:00–10:00 UTC)。⇒ 输出价要涨 2.4–4.7 倍, 本表同时给涨价后两档。
 * - MiniMax M3 国内 API(≤512K 输入): **¥0.42 / ¥2.10 / ¥8.40** 每 M。
 * - MiniMax Ultra 套餐: **¥469/月 · 约 71 亿 token**(2026-06-05 官方迁移公告第五节)。
 *
 * ## workload 是实测的(worker-quality 同 10 题, 两边跑的是同一批题)
 *
 *   M3 adaptive(直连) out 1,153 · 中位延迟 3.7s · 正确分 100% · 格式守 100%
 *   v4-flash          out ~1,506(low 2,076 与 low·control 935 的均值 —— 同臂差 2×, 噪声很大)
 *                     in 338 · cacheHit 269 · 中位延迟 3.2~4.6s · 正确分 100% · 格式守 100%
 *   M3 的 in 取 425(经 gateway 实测同 10 题)。
 *
 * ⚠ **这批题上两边都满分 = 尺子饱和**, 所以本表只谈**成本与速度**, 不谈质量高低。
 *   质量差别要看有分辨力的公开基准(FanOutQA: v4-flash strict 25% vs M3 15%, 噪声地板 0)。
 *
 * 跑: bun run scripts/probes/m3-vs-flash-econ.ts
 */

const USD_CNY = 7.1;

interface Rate {
  hit: number;
  miss: number;
  out: number;
}
/** 单位: 每 1M token 的价(原币)。 */
const PRICES: Record<string, { rate: Rate; cur: 'USD' | 'CNY'; note: string }> = {
  'v4-flash (今天)': { rate: { hit: 0.0028, miss: 0.14, out: 0.28 }, cur: 'USD', note: 'deepseek 官网现价' },
  'v4-flash (08-16 谷)': { rate: { hit: 0.007, miss: 0.22, out: 0.66 }, cur: 'USD', note: '涨价后 off-peak' },
  'v4-flash (08-16 峰)': { rate: { hit: 0.014, miss: 0.44, out: 1.32 }, cur: 'USD', note: '涨价后 peak' },
  'M3 API (国内)': { rate: { hit: 0.42, miss: 2.1, out: 8.4 }, cur: 'CNY', note: 'minimax 刊例价 ≤512K 输入' },
};

interface Load {
  id: string;
  what: string;
  in: number;
  cacheRate: number;
  out: number;
  latencyS: number;
}
const M3_ADAPTIVE: Load = { id: 'M3 adaptive', what: 'inproc 单发', in: 425, cacheRate: 0.826, out: 1153, latencyS: 3.7 };
const FLASH: Load = { id: 'v4-flash', what: 'inproc 单发', in: 338, cacheRate: 269 / 338, out: 1506, latencyS: 3.9 };
/** agent leaf 实测(难档): input 密集, output 只占 0.9% —— 与 inproc 的成本结构完全相反。 */
const M3_AGENT: Load = { id: 'M3 agent', what: 'agent leaf 难档', in: 620_593, cacheRate: 0.826, out: 5_917, latencyS: 1053 };

const cny = (l: Load, p: { rate: Rate; cur: 'USD' | 'CNY' }): number => {
  const raw = (l.in * l.cacheRate * p.rate.hit + l.in * (1 - l.cacheRate) * p.rate.miss + l.out * p.rate.out) / 1e6;
  return p.cur === 'USD' ? raw * USD_CNY : raw;
};

console.log('══ ① 单次 inproc 调用的钱(元, 含缓存命中率实测值)══\n');
console.log(`  M3 adaptive : in ${M3_ADAPTIVE.in} (cache ${(M3_ADAPTIVE.cacheRate * 100).toFixed(0)}%) · out ${M3_ADAPTIVE.out} · 中位延迟 ${M3_ADAPTIVE.latencyS}s`);
console.log(`  v4-flash    : in ${FLASH.in} (cache ${(FLASH.cacheRate * 100).toFixed(0)}%) · out ${FLASH.out} · 中位延迟 ${FLASH.latencyS}s\n`);
const m3Cny = cny(M3_ADAPTIVE, PRICES['M3 API (国内)']!);
for (const [name, p] of Object.entries(PRICES)) {
  if (name.startsWith('M3')) continue;
  const f = cny(FLASH, p);
  console.log(
    `  v4-flash @ ${name.padEnd(20)} ¥${f.toFixed(6)} /次   ·   M3 API ¥${m3Cny.toFixed(6)} /次   → M3 是它的 ${(m3Cny / f).toFixed(2)}×`,
  );
}

console.log('\n══ ② 买了 MiniMax Ultra ¥469 之后, M3 的边际成本 ══\n');
const ULTRA_CNY = 469;
const ULTRA_TOKENS = 7_100_000_000;
for (const l of [M3_ADAPTIVE, M3_AGENT]) {
  const runs = ULTRA_TOKENS / (l.in + l.out);
  console.log(
    `  ${l.what.padEnd(16)} ${(runs / 1000).toFixed(1)}k 次/月 · 折 ¥${(ULTRA_CNY / runs).toFixed(6)}/次` +
      `  (API 刊例价要 ¥${cny(l, PRICES['M3 API (国内)']!).toFixed(4)}/次 → 套餐省 ${(cny(l, PRICES['M3 API (国内)']!) / (ULTRA_CNY / runs)).toFixed(0)}×)`,
  );
}

console.log('\n══ ③ 跑满一个月 Ultra 额度, 同样的量用 deepseek 要多少钱 ══\n');
for (const l of [M3_ADAPTIVE, M3_AGENT]) {
  const runs = ULTRA_TOKENS / (l.in + l.out);
  console.log(`  ${l.what} · ${(runs / 1000).toFixed(1)}k 次:`);
  for (const [name, p] of Object.entries(PRICES)) {
    if (name.startsWith('M3')) continue;
    // 同一份 workload 换 deepseek 跑(token 量按 M3 实测, 两模型的 verbosity 差别另算)
    const total = cny(l, p) * runs;
    console.log(`     deepseek @ ${name.padEnd(20)} ¥${total.toFixed(0).padStart(7)}   vs   Ultra 套餐 ¥${ULTRA_CNY}`);
  }
  console.log('');
}

console.log('⚠ ③ 的口径: 拿 M3 的 token 量去套 deepseek 的价, 只回答"同样多的 token 谁便宜"。');
console.log('   它**不**回答"同一个任务谁便宜" —— 那要看两模型跑同一任务各自吐多少 token');
console.log('   (inproc 上实测 M3 1,153 vs flash 1,506 out, M3 反而少 23%; agent leaf 上没有 flash 的对照读数)。');
