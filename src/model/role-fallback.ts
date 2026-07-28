/**
 * src/model/role-fallback —— 角色模型兜底链 + 起跑坐席检查 (issue #6)。
 *
 * 背景: judge L2 / 内嵌 dag-review / dream 三处的默认坐标落在 deepseek。没配 DeepSeek 凭证的
 * 环境 (如 kimi+mimo-only) 里, 跑到该环节才炸/降级 —— judge 降级为 oracle 盲从、review 直接抛
 * `provider 'deepseek' 无凭证` 崩掉整阶段、dream 每次 session 结束静默停摆, 而非启动即告警。
 *
 * 修法 (兜底链 + 起跑 WARN, Nick 定): 与 conductorEscalationModel「provider 未注册 → 自动不升级」
 * 同哲学 —— 首选坐标**无可用凭证**时按注册表顺延到第一个有凭证的 provider (裸坐标靠 defaultModel);
 * 全不可达 → 原样返首选, 让下游按既有语义 fail-loud (dream INV-1) 或降级 (judge L3)。
 *
 * ⚠ 判据 = **凭证维度** (piHasCredential + 自有 registry), 不是 assertModelResolvable ——
 * 后者 key-blind: pi-ai 目录认识某 provider 的全坐标即便无 key (实测 deepseek 的 flash/pro 全坐标
 * 都"可解析"), 只有裸 'deepseek' 才 throw。若以可解析为闸, judge/review 的**全坐标** deepseek
 * 无 key 时不会兜底 → 仍在 call 时抛无凭证。故必须问"有没有凭证"而非"认不认识"。
 * OAuth provider (kimi-coding, 凭证走 auth.json 非 env key) 由 piHasCredential 正确纳入 → 不误判。
 */
import { assertModelResolvable } from './index';
import { getProvider, listProviders } from './providers';
import { piHasCredential } from './pi-transport';
import { channelInCooldown } from './provider-health';
import { ALL_SEATS, type OmdSeat, tryResolveSeatModel, resolveConfiguredPools } from './role-models';
import { logger } from '../logger';

/** 坐标前半 = provider 名 ('deepseek:x' → 'deepseek'; 裸名原样)。 */
function providerOf(coord: string): string {
  const i = coord.indexOf(':');
  return i === -1 ? coord : coord.slice(0, i);
}

/**
 * provider 是否有可用凭证 (= 真能调用): 自有 registry 命中 (registerProvider 要求 apiKey → 注册即带 key)
 * 或 pi 通道有凭证 (auth.json / env key, OAuth 亦覆盖)。
 */
function credentialed(provider: string, env: Record<string, string | undefined>): boolean {
  return !!getProvider(provider) || piHasCredential(provider, env);
}

/** 裸 provider 坐标能否解析成可调模型 (有 defaultModel)。兜底目标须过此闸, 否则 'no defaultModel' 崩。 */
function resolvable(coord: string): boolean {
  try {
    assertModelResolvable(coord);
    return true;
  } catch {
    return false;
  }
}

/**
 * 首选坐标是否可用 = **凭证维度 且 运行时健康维度** (双闸)。
 * 凭证: 有 key/OAuth (credentialed)。健康: 不在熔断冷却窗内 (inCooldown, 补 provider-health)。
 * 任一不满足 → 视为不可用 → roleModelWithFallback 顺延兜底。
 */
function usable(coord: string, env: Record<string, string | undefined>): boolean {
  const p = providerOf(coord);
  return credentialed(p, env) && !channelInCooldown(p);
}

// warn-once 去重 (per role→fallback): 「起跑一行 WARN」不刷屏 —— dream 每次 session 结束都会走这条,
// 逐次告警会淹掉日志。首次命中某条兜底路径才打。
const warnedFallback = new Set<string>();

/** 测试钩子: 清 warn-once 去重集 (跨用例复用 warned 会漏断言)。 */
export function resetRoleFallbackWarned(): void {
  warnedFallback.clear();
}

/**
 * 角色模型兜底链: 首选坐标无可用凭证 → 顺延注册表第一个有凭证且可解析的 provider (裸坐标)。
 * 命中兜底时 warn-once。全不可达 → 原样返 preferred (调用方按既有语义 fail-loud / 降级)。
 *
 * @param preferred 首选坐标 ('provider:modelId' 或裸 'provider')。
 * @param role      角色名 (仅用于日志, 如 'judge' / 'review' / 'dream')。
 */
export function roleModelWithFallback(
  preferred: string,
  role: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (usable(preferred, env)) return preferred;
  for (const p of listProviders()) {
    // 兜底目标须**有凭证** (自有 registry 注册即带 key)、**运行时健康** (不在熔断冷却) **且**裸坐标
    // 可解析 (有 defaultModel)。跳过冷却中的 provider, 避免顺延到另一个正在限流/宕机的后端。
    if (credentialed(p, env) && !channelInCooldown(p) && resolvable(p)) {
      const key = `${role}:${preferred}→${p}`;
      if (!warnedFallback.has(key)) {
        warnedFallback.add(key);
        logger.warn(
          { role, preferred, fallback: p },
          `[role-fallback] ${role} 首选坐标 '${preferred}' 无可用凭证 → 兜底到已注册 '${p}' (issue #6)`,
        );
      }
      return p;
    }
  }
  return preferred; // 全不可达: 原样返, 下游 fail-loud (dream INV-1) / 降级 (judge L3)
}

/** 坐标可用性 (凭证 + 未熔断) —— 导出供起跑自检 / 计划期硬闸复用。 */
export function coordUsable(coord: string, env: Record<string, string | undefined> = process.env): boolean {
  return usable(coord, env);
}

/** 一个座位的自检结论。 */
export type SeatStatus = 'ok' | 'unset' | 'no-credential';
export interface SeatCheck {
  seat: OmdSeat;
  /** 解析到的坐标; status='unset' 时无。 */
  coord?: string;
  status: SeatStatus;
}

/**
 * **座位自检** (INV-MODEL-5, P0 2026-07-28): 遍历全部 16 个座位, 报「未配 / 无凭证 / ok」。
 * 纯读不改配置, 不抛 —— 拿它做启动告警面与 omd_config_status 的数据源;
 * "解不到就失败"的硬闸是 {@link assertSeatsUsable} (只对本次 run 真要用的座位)。
 */
export function checkSeats(env: Record<string, string | undefined> = process.env): SeatCheck[] {
  return ALL_SEATS.map((seat): SeatCheck => {
    const r = tryResolveSeatModel(seat, { env });
    if (!r) return { seat, status: 'unset' };
    return { seat, coord: r.model, status: usable(r.model, env) ? 'ok' : 'no-credential' };
  });
}

/**
 * **计划期硬闸** (INV-MODEL-5 的"响亮失败"): 本次 run 真要用的座位里有未配 / 无凭证的 → 抛,
 * 错误里指名座位与坐标。
 *
 * 为什么只闸「真要用的」而不是全部 16 座: dream/continuity 是 opt-in 后台角色, 没配它们不该
 * 挡住一次 dag_run。全景在 {@link checkSeats}, 那是告警面不是闸。
 */
export function assertSeatsUsable(
  seats: readonly OmdSeat[],
  env: Record<string, string | undefined> = process.env,
): void {
  const bad = checkSeats(env).filter((c) => seats.includes(c.seat) && c.status !== 'ok');
  if (bad.length === 0) return;
  const detail = bad
    .map((c) => (c.status === 'unset' ? `${c.seat}=<未配>` : `${c.seat}=${c.coord} (无凭证)`))
    .join(', ');
  throw new Error(
    `[omd/model] 起跑自检失败 —— ${bad.length} 个座位不可用: ${detail}。` +
      `修: omd_set_key / omd_register_provider 配凭证, 或 omd_set_role 换座位, 或 omd models auto 重分配。` +
      `(此前这里是静默兜底, 跑到一半才 402/无凭证崩。)`,
  );
}

/** 一个显式配置的池子的自检结论 (tier + 池内每个坐标可用与否)。 */
export interface PoolCheck {
  tier: string;
  /** 池内**不可用**的坐标 (有凭证的不列)。 */
  unusable: string[];
  /** 池子总坐标数 (判"整池全死"用)。 */
  size: number;
}

/**
 * **池子自检** (2026-07-29)。座位自检管不到这里 —— `config.pools` 是**第三条轴**:
 * 它不回答"某个座位用哪个模型", 而是"stamp pass 把节点判成 cheap 档时从哪几个坐标里轮换"。
 * 显式配了 pools 的档位**完全不经过座位链** (`mcp/assemble.ts` 的 `cfgPools.x ?? 座位推导`),
 * 于是既躲开 env 覆盖, 也躲开 checkSeats —— 一池子欠费 provider 照样开跑, 直到 429/403 才炸。
 *
 * 只查**显式配置**的池子: 未配的档位由座位推导而来, 那些坐标已被 checkSeats 覆盖, 重复查是噪声。
 */
export function checkPools(env: Record<string, string | undefined> = process.env): PoolCheck[] {
  const pools = resolveConfiguredPools();
  return Object.entries(pools)
    .filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].length > 0)
    .map(([tier, coords]) => ({
      tier,
      unusable: coords.filter((c) => !usable(c, env)),
      size: coords.length,
    }));
}

/**
 * 起跑坐席检查 (issue #6 → P0 扩到全部座位): bootstrapModelRuntime 注册完 provider 后调一次 ——
 * **无可用凭证**的座位在启动时打一行 WARN (而非跑到一半炸)。仅告警不改配置: boot 时还不知道这次
 * 要用哪些座位, 硬闸留给 assertSeatsUsable (计划期, 只闸真要用的)。
 * OAuth 座位 (kimi-coding 掌舵) 凭证走 auth.json → 不误报。
 */
export function warnUnregisteredRoles(env: Record<string, string | undefined> = process.env): void {
  const bad = checkSeats(env).filter((c) => c.status !== 'ok');
  if (bad.length > 0) {
    const detail = bad
      .map((c) => (c.status === 'unset' ? `${c.seat}=<未配>` : `${c.seat}=${c.coord}`))
      .join(', ');
    logger.warn(
      { unusable: detail, count: bad.length },
      `[role-seat] ${bad.length} 个座位未配或无可用凭证: ${detail} ` +
        `— 运行时按注册表顺延兜底 (issue #6); 配齐凭证或改 .omd/config.json 消除本告警。`,
    );
  }
  // 池子那条轴 (config.pools): 显式配的档位绕开座位链, 座位全绿也可能一池子欠费 provider。
  for (const p of checkPools(env)) {
    if (p.unusable.length === 0) continue;
    const dead = p.unusable.join(', ');
    // 整池全死 = 该档位每个节点必炸 (轮换轮到谁都一样), 提到 error 级 —— 这正是"跑到一半 429"的源头。
    if (p.unusable.length === p.size) {
      logger.error(
        { tier: p.tier, dead, size: p.size },
        `[role-pool] config.pools.${p.tier} **整池无可用凭证** (${dead}) — 判到该档的节点会全数失败。` +
          `注意 pools 不经过座位链: env / --*-model / config.models 都覆盖不了它, 只能改 .omd/config.json 的 pools 段。`,
      );
    } else {
      logger.warn(
        { tier: p.tier, dead, size: p.size },
        `[role-pool] config.pools.${p.tier} 有 ${p.unusable.length}/${p.size} 个坐标无可用凭证: ${dead} ` +
          `— 轮换轮到它们的节点会失败。pools 不经过座位链, 只能改 .omd/config.json 的 pools 段。`,
      );
    }
  }
}
