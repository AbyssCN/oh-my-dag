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
 * 后者 key-blind: pi-ai 目录认识 deepseek 全坐标即便无 key (实测 deepseek:deepseek-v4-flash/pro
 * 都"可解析"), 只有裸 'deepseek' 才 throw。若以可解析为闸, judge/review 的**全坐标** deepseek
 * 无 key 时不会兜底 → 仍在 call 时抛无凭证。故必须问"有没有凭证"而非"认不认识"。
 * OAuth provider (kimi-coding, 凭证走 auth.json 非 env key) 由 piHasCredential 正确纳入 → 不误判。
 */
import { assertModelResolvable } from './index';
import { getProvider, listProviders } from './providers';
import { piHasCredential } from './pi-transport';
import { MODEL_ROLES, resolveRoleModel } from './role-models';
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

/** 首选坐标是否可用 (凭证维度)。 */
function usable(coord: string, env: Record<string, string | undefined>): boolean {
  return credentialed(providerOf(coord), env);
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
    // 兜底目标须**有凭证** (自有 registry 注册即带 key) **且**裸坐标可解析 (有 defaultModel)。
    if (credentialed(p, env) && resolvable(p)) {
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

/**
 * 起跑坐席检查 (issue #6): bootstrapModelRuntime 注册完 provider 后调一次 —— 解析全部 daemon 角色的
 * 默认坐标, **无可用凭证**的角色在启动时打一行 WARN (而非跑到一半炸)。仅告警不改配置, 真正兜底在
 * 各消费点的 roleModelWithFallback。judge/review 的默认坐标同落 deepseek 家族, 与这里的 verifier/dream
 * 同源 —— 本告警覆盖它们的凭证盲区。OAuth 角色 (kimi-coding 掌舵) 凭证走 auth.json → 不误报。
 */
export function warnUnregisteredRoles(env: Record<string, string | undefined> = process.env): void {
  const unusable: string[] = [];
  for (const role of MODEL_ROLES) {
    const coord = resolveRoleModel(role, env);
    if (!usable(coord, env)) unusable.push(`${role}=${coord}`);
  }
  if (unusable.length > 0) {
    logger.warn(
      { unusable },
      `[role-seat] ${unusable.length} 个角色首选 provider 无可用凭证: ${unusable.join(', ')} ` +
        `— 运行时按注册表顺延兜底 (issue #6); 配齐凭证或改 .omd/config.json 消除本告警。`,
    );
  }
}
