/**
 * src/harness/session/bucket —— 「该不该存一次档」的**档距口径**(#211)。
 *
 * 两条路共用一份:Claude Code 的 hook(`continuity-hook.ts`)与 omd 自己的会话
 * (`omd-checkpoint.ts`)。口径分家 = 同一个用户在两个 harness 下拿到两种存档节奏,
 * 而那种差异事后没人分得清是"设计如此"还是"漏改了一处"。
 *
 * @module
 */

/** 冻结档位缺省,与 `docs/examples/.../session-continuity.ts:45` 同 env 同值。 */
export const DEFAULT_SESSION_BUCKET = 200_000;

/**
 * 档位阈值:env 未设 → 缺省;设了但**非正有限数** → `null`。
 *
 * `null` 的语义是「不拿坏配置造档位」——回落到默认值会让一个写错的 env 静默变成正常行为,
 * 那正是配置类静默失效的经典形状。
 */
export function bucketThreshold(env: NodeJS.ProcessEnv): number | null {
  const raw = env.OMD_SESSION_BUCKET;
  if (raw === undefined) return DEFAULT_SESSION_BUCKET;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** token 数 → 档位序号(0 = 还没过首档)。 */
export function bucketIndex(tokens: number, threshold: number): number {
  return Math.floor(tokens / threshold);
}
