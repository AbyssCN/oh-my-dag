/**
 * src/model/pool-report —— **「现在生效的坐标全集 + 各自来自哪一层」的读数**(2026-08-05)。
 *
 * ## 它治的病
 *
 * owner 原话:「为什么一个配置模型给我弄得这么麻烦」。当天连撞三处漂移
 * (研究判优池里一个 429 死座位 · 溢出兜底拿 mimo 跑文本 · review 的 verify 层指着欠费座位),
 * **每一处都是靠 grep 全仓才翻出来的**。
 *
 * 缺的不是"再加一个配置项",是**一处能一眼看全的读数**:某个坐标到底来自 env、来自
 * `.omd/config.json`、还是硬写在某个源码文件里。没有它,漂移只能靠人肉巡检,
 * 而人肉巡检的漏检率就是今天这个样子。
 *
 * ⚠ 本件**只读不改**(同图外观察者那条纪律):它不解析座位、不写配置,只把三层各自说了什么
 * 摆出来。判断留给人。
 */
import { POOL_DEFAULTS, POOL_FALLBACK_NOTE } from './pool-defaults';
import { POOL_TIERS, describeConfiguredPools, poolEnvKey, type PoolTier } from './role-models';

/** 一个池当前的生效值 + 它来自哪一层。 */
export interface PoolReportRow {
  tier: PoolTier;
  /** 生效坐标。空数组 = 该档没有静态默认(由座位推导),见 {@link note}。 */
  coords: readonly string[];
  /** 来源层。`env` = `OMD_POOL_*`;`config` = config 的 pools 段;`default` = 源码兜底;`derived` = 座位推导。 */
  source: 'env' | 'config' | 'default' | 'derived';
  /** 该档的覆盖口(告诉人"想改去改哪儿")。 */
  overrideWith: string;
  /** `derived` 档的补充说明(它没有可列的坐标)。 */
  note?: string;
}

/**
 * 逐档汇报生效值与来源。解析序与执行期**逐字一致**:
 * `OMD_POOL_*` > `.omd/config.json` 的 pools 段 > `pool-defaults.ts` > 座位推导。
 *
 * ⚠ 这个顺序必须跟着执行期改 —— 读数板和执行期各写一份解析序,就会出现
 * 「读数说用 A、实际跑 B」,而那比没有读数更坏(你会以为看过了)。
 * 闸见 `pool-report.test.ts`:它拿同一个 env/config 对着 `resolveConfiguredPools` 比对。
 */
export function reportPools(env: Record<string, string | undefined> = process.env): PoolReportRow[] {
  const configured = describeConfiguredPools(undefined, env);
  return POOL_TIERS.map((tier): PoolReportRow => {
    const overrideWith = `${poolEnvKey(tier)} 或 config.pools.${tier}`;
    const hit = configured[tier];
    if (hit) return { tier, coords: hit.coords, source: hit.source, overrideWith };
    const fallback = POOL_DEFAULTS[tier];
    if (fallback) return { tier, coords: fallback, source: 'default', overrideWith };
    return {
      tier,
      coords: [],
      source: 'derived',
      overrideWith,
      note: POOL_FALLBACK_NOTE[tier] ?? '座位推导',
    };
  });
}

/** 渲染成人读的一段(读数板/`omd_config_status` 用)。`mark` 由调用方给(它掌握凭证判定)。 */
export function renderPoolReport(rows: readonly PoolReportRow[], mark: (coord: string) => string): string[] {
  const label: Record<PoolReportRow['source'], string> = {
    env: 'env',
    config: 'config',
    default: '源码默认',
    derived: '座位推导',
  };
  const out: string[] = [];
  for (const r of rows) {
    const where = `[${label[r.source]}]`.padEnd(8);
    if (r.source === 'derived') {
      out.push(`  ${r.tier.padEnd(20)} ${where} ${r.note ?? ''} — 想固定住改 ${r.overrideWith}`);
      continue;
    }
    out.push(`  ${r.tier.padEnd(20)} ${where} ${r.coords.map(mark).join(', ')}`);
  }
  return out;
}
