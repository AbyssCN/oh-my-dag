/**
 * scripts/omd-fanout-seats —— **research fanout 的每个 stage 实际会用哪个坐标**
 * (`bun run scripts/omd-fanout-seats.ts`)。
 *
 * ## 它治的是一次真实的静默失效(2026-08-14,花了一整跑才发现)
 *
 * owner 要求「把 fanout 那几个座位挪到 M3」。我改了 `config.models` 的
 * `lens/reduce/judge/reason` 四个座,`resolveSeatModel` 四个全返 M3,座位探针全绿 ——
 * **然后跑完发现 6 个 stage 里只有 3 个真的换了**,另外 3 个(gen/synth/judge,占输入 82%)
 * 仍在旧坐标上,全程零报错。
 *
 * 根因:`config.json` 还有**第二张声明面** `pools`,而
 * `web-fanout.ts:405/407` 让 `divergePool = pools.lens`、`judgePool = pools.judge` ——
 * gen / synth / judge 三个 stage 读的是**池**,池**静默盖过**座位登记表。
 * 「声明面往前跑了,消费面没跟上,两边都不报错」——本仓图鉴 S-1/S-4 的同一形状,又来一次。
 *
 * ## 为什么是脚本而不是散文
 *
 * 仓规:「想加新纪律前先问:能不能做成会红的闸?能就别写成散文。」
 * 换座位之前跑一次这个,**不花一个 token** 就能看见每个 stage 真正的落点 ——
 * 而上一次看见它花了一整跑(~2.1M)。
 *
 * ⚠ 边界:它只解析**静态可解的那部分**(座位 + 池)。`opts.*Model` 显式覆盖、council
 * 出的 per-lens 模型这类**运行期**决定,这里看不见 —— 那一层的真值只有跑完读
 * `.omd/seat-usage.jsonl` 的 traceName×model 才有(`scripts/omd-seat-usage.ts --trace`)。
 * **别把这里的绿当成"跑起来一定是这样"。**
 */
import { resolveConfiguredPools, resolveRoleModelConfigured } from '../src/model/role-models';
// 两个池常量的真身在 web-fanout (它们由 POOL_DEFAULTS 派生) —— 从消费点取, 不另抄一份。
import { LENS_DIVERGENCE_POOL, JUDGE_PANEL_POOL } from '../src/harness/research/web-fanout';

interface StageRow {
  stage: string;
  /** 真正决定这个 stage 坐标的那一层。 */
  来源: string;
  坐标: string[];
}

const pools = resolveConfiguredPools();
const seat = (id: string): string => {
  try {
    return resolveRoleModelConfigured(id).model;
  } catch (e) {
    return `⚠ 解析失败: ${(e as Error).message.slice(0, 60)}`;
  }
};

// 逐条对应 web-fanout.ts / fanout.ts 的取值链 —— 改那边记得改这里 (行号写在来源列)。
const lensPool = pools.lens ?? LENS_DIVERGENCE_POOL;
const judgePool = pools.judge ?? JUDGE_PANEL_POOL;
const rows: StageRow[] = [
  { stage: 'gen (L×V 广度叶)', 来源: pools.lens ? 'config.pools.lens (盖过 lens 座!)' : 'LENS_DIVERGENCE_POOL 源码默认', 坐标: lensPool },
  { stage: 'synth (M framing)', 来源: pools.lens ? 'config.pools.lens (synthPool 缺省回落 divergePool)' : 'divergePool 默认', 坐标: lensPool },
  { stage: 'judge (K panel)', 来源: pools.judge ? 'config.pools.judge (盖过 judge 座!)' : 'JUDGE_PANEL_POOL 源码默认', 坐标: judgePool },
  { stage: 'reduce (镜头内归并)', 来源: "reduce 座 (fanout.ts:328)", 坐标: [seat('reduce')] },
  { stage: 'gap (缺口分析)', 来源: 'reason 座 (assemble → cfg.reasonModel)', 坐标: [seat('reason')] },
  { stage: 'fusion + graft (终笔)', 来源: 'judge 座 (web-fanout.ts:409)', 坐标: [seat('judge')] },
];

console.log('\nresearch fanout —— 每个 stage 静态可解的落点\n');
console.log('  ' + 'stage'.padEnd(22) + '坐标'.padEnd(40) + '来源');
for (const r of rows) console.log('  ' + r.stage.padEnd(22) + r.坐标.join(', ').padEnd(40) + r.来源);

// 座位 ≠ 实际落点时**显式喊出来** —— 这正是那次静默失效唯一缺的一句话。
const mismatches: string[] = [];
if (pools.lens && !pools.lens.includes(seat('lens'))) {
  mismatches.push(`lens 座 = ${seat('lens')}, 但 gen/synth 实际走 config.pools.lens = ${pools.lens.join(', ')}`);
}
if (pools.judge && !pools.judge.includes(seat('judge'))) {
  mismatches.push(`judge 座 = ${seat('judge')}, 但 judge panel 实际走 config.pools.judge = ${pools.judge.join(', ')}`);
}
if (mismatches.length) {
  console.log('\n⚠ 座位与实际落点不一致 (改座位不会生效在这些 stage 上):');
  for (const m of mismatches) console.log(`  · ${m}`);
  console.log('  → 要么同步改 config.json 的 pools 段, 要么把 pools 删掉让座位登记表说了算。');
} else {
  console.log('\n✓ 座位与池一致 (静态层面没有被盖过的座位)。');
}
console.log('\n⚠ 运行期覆盖 (opts.*Model / council 出的 per-lens 模型) 这里看不见 ——');
console.log('  跑完读 `bun run scripts/omd-seat-usage.ts --trace` 的 traceName×model 才是真值。\n');
