/**
 * plan-econ —— **MiniMax Ultra(¥469) vs MiMo Max(¥659/$100/≈90€)哪个跑得起我们的量**。
 *
 * ## 为什么不比"多少亿 token"
 *
 * 两家的额度口径根本不同, 直接比那个数就是拿两把不同的尺子量:
 *   · **MiMo** = 固定 Credits + **公开折算表**(官网 price/token-plan, 更新 2026-07-15):
 *       mimo-v2.5-pro  cache命中 2.5 / 未命中 **300** / 输出 **600** Credits 每 token
 *       mimo-v2.5      cache命中 2   / 未命中  100  / 输出  200
 *     ⇒ 给定 workload **可精确算**, 零假设。命中与否差 **120 倍**, 所以缓存命中率决定一切。
 *   · **MiniMax** = 官网原话「用量会按**对应按量计费价格**扣减套餐内 Token Plan 额度」
 *     (platform.minimaxi.com/docs/token-plan/intro), 而官方对 Ultra 只公布"月度容量**约 71 亿 token**"
 *     (2026-06-05 迁移公告第五节)。**池子的钱值没公开** ⇒ 只能按"总 token 上限"这一口径估,
 *     并把它当**假设**标出来, 不当事实。
 *
 * 所以本脚本算的是: **拿实测 workload 去扣, 每月各能跑多少次**。
 *
 * ## workload 全是实测, 不是估的(2026-08-14, minimax-cn:MiniMax-M3)
 *
 *   agent-hard  620,593 in / 5,917 out   (H2 因果异址 + H3 全量 oracle, 37 次工具调用, 17.5 min)
 *   agent-easy  157,273 in / 5,356 out   (debug-planted, 14 次工具调用)
 *   inproc      425 in / 1,083 out       (worker-quality 10 题均值; out > in 因为 M3 思考也计 output)
 *
 * ## ⚠ 两条比价格更要紧的非价格因素(写在报告里, 不进算式)
 *
 * 1. **MiMo 条款明确禁止本仓这种用法**: "quota can only be used in programming tools (such as
 *    OpenClaw, OpenCode, etc.), and is prohibited from being used in the form of API calls for
 *    request behaviors in clearly non-Coding scenarios such as **automated scripts and custom
 *    application backends**" —— 违规可**封 API Key**。omd 是自建 harness 批量跑 DAG, 正落在这句里。
 *    MiniMax 的措辞弱得多(FAQ: "designed for individual, interactive developer use…
 *    recommended to use pay-as-you-go for production"), 是**建议**不是**禁止**。
 * 2. **窗口**: MiniMax 有 5 小时 + 周窗口(2026-06 新增周限额, 且明写未用完不结转);
 *    MiMo 官方明写**无 5 小时限制**, 支持集中消耗。对"大规模批量跑"这是相反方向的两个约束:
 *    MiniMax 额度大但**放不开**, MiMo 额度小但**随便烧**。
 *
 * 跑: bun run scripts/probes/plan-econ.ts
 */

interface Workload {
  id: string;
  what: string;
  in: number;
  out: number;
}
/** 全部来自 .omd/eval/m3-agent-hard · m3-agent-smoke · inproc-m3 的真实读数。 */
const WORKLOADS: Workload[] = [
  { id: 'agent-hard', what: 'agent leaf · 难档(因果异址 + 全量 oracle)', in: 620_593, out: 5_917 },
  { id: 'agent-easy', what: 'agent leaf · 易档(debug-planted)', in: 157_273, out: 5_356 },
  { id: 'inproc', what: 'inproc 单发(worker-quality 均值)', in: 425, out: 1_083 },
];

/** 缓存命中率 —— 唯一的自由变量, 所以做敏感性分析而不是钉一个数。 */
const CACHE_RATES = [0.5, 0.826, 0.9];
/** 0.826 = 本仓 inproc 实测(.omd/eval/inproc-m3, 119 次调用: cacheHit 41,734 / in 50,554)。 */

// ── MiMo Max: 官网 Credits 折算表, 零假设 ────────────────────────────────────
const MIMO_MAX_CREDITS = 82_000_000_000; // 82B Credits/月 (¥659 · $100)
const MIMO_PRICE_EUR = 90; // owner 看到的欧元价
const MIMO_RATES = {
  'mimo-v2.5-pro': { hit: 2.5, miss: 300, out: 600 },
  'mimo-v2.5': { hit: 2, miss: 100, out: 200 },
} as const;

function mimoCredits(w: Workload, cacheRate: number, model: keyof typeof MIMO_RATES): number {
  const r = MIMO_RATES[model];
  const hit = w.in * cacheRate;
  const miss = w.in * (1 - cacheRate);
  return hit * r.hit + miss * r.miss + w.out * r.out;
}

// ── MiniMax Ultra: 只有"约 71 亿 token"这一个公开数 ──────────────────────────
const MINIMAX_ULTRA_TOKENS = 7_100_000_000; // 官方: 月度容量约 71 亿 token
const MINIMAX_PRICE_CNY = 469;
/** ⚠ 假设: 71 亿按 **input+output 总量不分类型** 计。官方没公布加权规则, 这是本估算最大的不确定源。 */
function minimaxTokens(w: Workload): number {
  return w.in + w.out;
}

// ── 另一条参照: 按量付费(API 刊例价)算同一份 workload 值多少钱 ─────────────
/** MiniMax M3 国内 API(≤512K 输入), 元/M token。 */
const MM_API = { hit: 0.42, miss: 2.1, out: 8.4 };
/** MiMo v2.5-pro API, 美元/M token(官网首页)。 */
const MIMO_API = { hit: 0.0036, miss: 0.435, out: 0.87 };
const USD_CNY = 7.1;
const EUR_CNY = 7.8;

const money = (w: Workload, c: number, p: { hit: number; miss: number; out: number }, mul = 1): number =>
  ((w.in * c * p.hit + w.in * (1 - c) * p.miss + w.out * p.out) / 1e6) * mul;

const fmt = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);

console.log('══ 每月能跑多少次(套餐额度 ÷ 单次消耗)══\n');
console.log(`MiniMax Ultra ¥${MINIMAX_PRICE_CNY}/月 · 约 71 亿 token(假设不分 input/output 加权)`);
console.log(`MiMo Max      ¥659 / $100 / ≈€${MIMO_PRICE_EUR}/月 · 82B Credits(官网折算表, 精确)\n`);

for (const w of WORKLOADS) {
  console.log(`── ${w.id}: ${w.what}`);
  console.log(`   实测 ${fmt(w.in)} in / ${fmt(w.out)} out`);
  const mmRuns = MINIMAX_ULTRA_TOKENS / minimaxTokens(w);
  console.log(`   MiniMax Ultra        ${fmt(mmRuns).padStart(8)} 次/月   (与缓存无关: 总量口径)`);
  for (const c of CACHE_RATES) {
    const pro = MIMO_MAX_CREDITS / mimoCredits(w, c, 'mimo-v2.5-pro');
    const std = MIMO_MAX_CREDITS / mimoCredits(w, c, 'mimo-v2.5');
    const tag = c === 0.826 ? ' ←本仓实测缓存率' : '';
    console.log(
      `   MiMo Max cache ${(c * 100).toFixed(0).padStart(3)}%   ${fmt(pro).padStart(8)} 次/月 (pro)` +
        ` · ${fmt(std).padStart(8)} 次/月 (v2.5)${tag}`,
    );
  }
  console.log('');
}

console.log('══ 交叉验证: 同一份 workload 按 API 刊例价值多少钱(元) ══\n');
console.log('(套餐都是补贴价, 这栏只用来看"两家的单位算力谁更贵", 不是套餐价)\n');
for (const w of WORKLOADS) {
  const c = 0.826;
  const mm = money(w, c, MM_API);
  const mi = money(w, c, MIMO_API, USD_CNY);
  console.log(`${w.id.padEnd(11)} MiniMax M3 ¥${mm.toFixed(4).padStart(9)}  ·  MiMo v2.5-pro ¥${mi.toFixed(4).padStart(9)}  → 比值 ${(mm / mi).toFixed(2)}×`);
}

// ── 交叉验证 ②: 把"71 亿 token"按**钱池**解读, 看结论会不会翻 ────────────────
// 官网说额度"按对应按量计费价格扣减" ⇒ 71 亿更可能是某个宣传假设下的折算数, 而非硬 token 上限。
// 用 MiMo 公布的同款假设(cache 90% · 输入输出 99:1 —— 那条已验算与其"1B Credits≈26.37M Token"
// 逐位吻合)反推 MiniMax 的池子钱值, 再拿实测 workload 去扣。
// **两种口径答案接近 = 结论不依赖这个假设**; 差很远就得说"算不准"。
const ASSUMED = { cache: 0.9, outRatio: 1 / 100 };
const perKTokenCny =
  (1000 * (1 - ASSUMED.outRatio) * ASSUMED.cache * MM_API.hit +
    1000 * (1 - ASSUMED.outRatio) * (1 - ASSUMED.cache) * MM_API.miss +
    1000 * ASSUMED.outRatio * MM_API.out) /
  1e6;
const poolCny = (MINIMAX_ULTRA_TOKENS / 1000) * perKTokenCny;
console.log(`\n══ 交叉验证②: MiniMax 额度按「钱池」解读 ══\n`);
console.log(`  反推池值 ≈ ¥${poolCny.toFixed(0)}(71 亿 token × 官方同款假设 cache 90%/IO 99:1 的均价)`);
for (const w of WORKLOADS) {
  const byMoney = poolCny / money(w, 0.826, MM_API);
  const byTotal = MINIMAX_ULTRA_TOKENS / minimaxTokens(w);
  console.log(
    `  ${w.id.padEnd(11)} 钱池口径 ${fmt(byMoney).padStart(8)} 次/月 · 总量口径 ${fmt(byTotal).padStart(8)} 次/月` +
      ` → 差 ${(Math.max(byMoney, byTotal) / Math.min(byMoney, byTotal)).toFixed(2)}×`,
  );
}

console.log('\n══ 单位成本(每次任务合多少钱, 按套餐价 ÷ 月可跑次数)══\n');
for (const w of WORKLOADS) {
  const mmRuns = MINIMAX_ULTRA_TOKENS / minimaxTokens(w);
  const miRuns = MIMO_MAX_CREDITS / mimoCredits(w, 0.826, 'mimo-v2.5-pro');
  console.log(
    `${w.id.padEnd(11)} MiniMax ¥${(MINIMAX_PRICE_CNY / mmRuns).toFixed(4).padStart(8)}/次  ·  ` +
      `MiMo ¥${((MIMO_PRICE_EUR * EUR_CNY) / miRuns).toFixed(4).padStart(8)}/次(按 €90=¥${(MIMO_PRICE_EUR * EUR_CNY).toFixed(0)})`,
  );
}
