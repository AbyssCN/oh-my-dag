/**
 * minimax-quota-meter —— **Token Plan 的额度到底按什么扣**(owner 2026-08-14 追问)。
 *
 * ## 为什么必须实测
 *
 * 官方两句话互相拉扯:
 *   · 「用量会按**对应按量计费价格**扣减套餐内 Token Plan 额度」(FAQ/intro, 按**钱**)
 *   · 却只公布「Ultra 月度容量约 **71 亿 token**」(迁移公告, 按**数**)
 * 两种口径在我们的 workload 上差 **9.4 倍**(inproc 503k vs 4.7M 次/月, 见 plan-econ.ts)——
 * 采购决策直接骑在这个差上, 而它**一次实验就能定**, 没有任何理由继续推。
 *
 * ## 判据(打之前钉死)
 *
 * 两个阶段各自算「消耗 1% 额度 = 多少 token / 多少钱」:
 *   A 阶段 **小 in 大 out**(output 密集)
 *   B 阶段 **大 in 小 out**(input 密集)
 * · 若两阶段的 **token/1%** 一致(比值 ≈1) → **总量口径**(in+out 等权)。
 * · 若两阶段的 **钱/1%** 一致(比值 ≈1) → **钱池口径**(按刊例价加权)。
 * · 两个都不一致 → 还有第三种规则, 老实写"测不出", 不许挑一个顺眼的。
 * 刊例价(国内 M3, ≤512K 输入): 命中 ¥0.42 / 未命中 ¥2.10 / 输出 ¥8.40 每 M。
 *
 * ## 诚实边界
 *
 * · 接口只给**整数百分比**(`current_interval_remaining_percent`), 分辨率 1% —— 所以要消耗到
 *   足够移动几个百分点才有信噪比, 单点差 1% 的读数不作数。
 * · 5h 窗口与周窗口**同时**在动, 本脚本读 5h 那格(粒度更细、恢复更快)。
 * · **这个实验要真烧额度**。预估代价随 `--out-calls`/`--in-calls` 线性增长, 起跑前打印并要求
 *   `--yes` 确认 —— 花的是 owner 的套餐额度, 不给确认就跑等于替他花钱。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/minimax-quota-meter.ts --yes
 */
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT_CALLS = Math.max(1, Number(opt('out-calls') ?? '30'));
const IN_CALLS = Math.max(1, Number(opt('in-calls') ?? '18'));
const KEY = process.env.MINIMAX_CN_API_KEY ?? process.env.MINIMAX_API_KEY;
const ENDPOINT = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
const REMAINS = 'https://www.minimaxi.com/v1/token_plan/remains';
const RATE = { hit: 0.42, miss: 2.1, out: 8.4 }; // ¥ / 1M token
const log = (s: string): void => void process.stderr.write(s + '\n');
if (!KEY) {
  log('缺 MINIMAX_CN_API_KEY');
  process.exit(2);
}

interface Remains {
  intervalPct: number;
  weeklyPct: number;
}
async function remains(): Promise<Remains> {
  const r = await fetch(REMAINS, { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } });
  const j = (await r.json()) as {
    model_remains?: { model_name?: string; current_interval_remaining_percent?: number; current_weekly_remaining_percent?: number }[];
  };
  const g = j.model_remains?.find((m) => m.model_name === 'general');
  return { intervalPct: g?.current_interval_remaining_percent ?? -1, weeklyPct: g?.current_weekly_remaining_percent ?? -1 };
}

interface Burn {
  calls: number;
  in: number;
  cached: number;
  out: number;
}
/** 打一批调用并累计真实 usage(不估算 —— usage 是 provider 回的)。 */
async function burn(kind: 'out-heavy' | 'in-heavy', calls: number): Promise<Burn> {
  const acc: Burn = { calls: 0, in: 0, cached: 0, out: 0 };
  // in-heavy: 灌一大段**每次都不同**的文本(防前缀缓存把 input 变成命中价), 只要一个字的回答。
  // out-heavy: 一句话提示, 要求写满长文。
  const jobs = Array.from({ length: calls }, (_, i) => i);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= jobs.length) return;
        const filler =
          kind === 'in-heavy'
            ? `\n\n以下是待归档的日志片段(编号 ${i}-${Math.random()}), 只需回答"收到":\n` +
              Array.from({ length: 900 }, (_, k) => `[${i}-${k}-${Math.random().toString(36).slice(2)}] event=noop status=ok`).join('\n')
            : '';
        const prompt =
          kind === 'in-heavy'
            ? `只回答两个字"收到", 不要任何其它内容。${filler}`
            : `写一篇关于分布式任务调度里"重试风暴"的技术随笔, 要求 1500 字以上, 分小节, 尽量详尽。(样本 ${i})`;
        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
            body: JSON.stringify({
              model: 'MiniMax-M3',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: kind === 'out-heavy' ? 8192 : 64,
              thinking: { type: kind === 'out-heavy' ? 'adaptive' : 'disabled' },
            }),
          });
          const j = (await res.json()) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
          };
          const u = j.usage ?? {};
          acc.calls++;
          acc.in += u.prompt_tokens ?? 0;
          acc.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
          acc.out += u.completion_tokens ?? Math.max(0, (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0));
        } catch {
          /* 单发失败不致命, calls 不计 —— 但**不吞证据**: 末尾会报实际成功数 */
        }
      }
    }),
  );
  return acc;
}

const cost = (b: Burn): number => ((b.in - b.cached) * RATE.miss + b.cached * RATE.hit + b.out * RATE.out) / 1e6;
const tokens = (b: Burn): number => b.in + b.out;

const before = await remains();
log(`起跑额度: 5h 剩 ${before.intervalPct}% · 周剩 ${before.weeklyPct}%`);
log(`计划: A 阶段 ${OUT_CALLS} 次 output 密集 + B 阶段 ${IN_CALLS} 次 input 密集`);
log(`预估代价: 约 ¥${(OUT_CALLS * (8000 * RATE.out) / 1e6 + IN_CALLS * (36000 * RATE.miss) / 1e6).toFixed(1)} 的额度(按刊例价折算)`);
if (!argv.includes('--yes')) {
  log('\n未加 --yes, 不执行 —— 这个实验要真烧 owner 的套餐额度, 得先确认。');
  process.exit(0);
}

const a = await burn('out-heavy', OUT_CALLS);
const midA = await remains();
log(`\nA (output 密集): ${a.calls} 次 · in ${a.in} (cached ${a.cached}) · out ${a.out} · 5h ${before.intervalPct}% → ${midA.intervalPct}%`);

const b = await burn('in-heavy', IN_CALLS);
const midB = await remains();
log(`B (input  密集): ${b.calls} 次 · in ${b.in} (cached ${b.cached}) · out ${b.out} · 5h ${midA.intervalPct}% → ${midB.intervalPct}%`);

const dA = before.intervalPct - midA.intervalPct;
const dB = midA.intervalPct - midB.intervalPct;
log(`\n消耗百分点: A ${dA}pp · B ${dB}pp`);
if (dA <= 0 || dB <= 0) {
  log('⚠ 有一侧没move(≤0pp) —— 分辨率不够或窗口刚重置。加大 --out-calls/--in-calls 重跑, 本次不下结论。');
  process.exit(0);
}
const tokPerPctA = tokens(a) / dA;
const tokPerPctB = tokens(b) / dB;
const cnyPerPctA = cost(a) / dA;
const cnyPerPctB = cost(b) / dB;
const ratioTok = Math.max(tokPerPctA, tokPerPctB) / Math.min(tokPerPctA, tokPerPctB);
const ratioCny = Math.max(cnyPerPctA, cnyPerPctB) / Math.min(cnyPerPctA, cnyPerPctB);
log(`\n每 1% 额度 ≈ token: A ${tokPerPctA.toFixed(0)} · B ${tokPerPctB.toFixed(0)}  → 两阶段比值 ${ratioTok.toFixed(2)}×`);
log(`每 1% 额度 ≈ 钱  : A ¥${cnyPerPctA.toFixed(3)} · B ¥${cnyPerPctB.toFixed(3)}  → 两阶段比值 ${ratioCny.toFixed(2)}×`);
log(
  `\n判定: ${
    ratioTok < 1.35 && ratioCny >= 1.35
      ? '**总量口径**(in+out 等权) —— token/1% 两阶段一致'
      : ratioCny < 1.35 && ratioTok >= 1.35
        ? '**钱池口径**(按刊例价加权) —— 钱/1% 两阶段一致'
        : ratioTok < 1.35 && ratioCny < 1.35
          ? '两者都"一致" —— 说明这两个阶段的 in/out 配比拉得不够开, 判不了, 需要更极端的两臂'
          : '两者都不一致 —— 还有第三种规则, 本次**测不出**, 不猜'
  }`,
);
