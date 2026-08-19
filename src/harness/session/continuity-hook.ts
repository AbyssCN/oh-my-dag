/**
 * src/harness/session/continuity-hook —— Stop / PreCompact 触发判定与派发装配(#206)。
 *
 * 与 `scripts/session-continuity-hook.ts` 的分工同 writer:**逻辑在这里,副作用在薄壳里**。
 * 分开的理由是实测出来的:薄壳首行 `import script-bootstrap` 会把 `OMD_DATA_HOME` 写进
 * 进程 env —— 谁为了拿这几个纯函数 import 它,谁的 env 就被改了(测试首跑即撞)。
 *
 * ## 这一格补的是什么
 *
 * `docs/examples/claude-code/hooks/session-continuity.ts`(冻结)是纯决策器:吐
 * `{decision:'block'}` 让 CC 多走一轮 + 记 ledger,**从不 spawn writer**。于是链路断在
 * 「没有任何东西会自动调 `scripts/session-writer.ts`」上,`facts` 表里 continuity 零行。
 * 本模块给出触发判定 + 派发参数,薄壳负责真 spawn(detached,蒸馏是后台活)。
 *
 * @module
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../project-scope';
import type { StopLedger } from './stop-ledger';

// ─── Public types ───────────────────────────────────────────────────────────

export interface ContinuityHookInput {
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  /** CC loop guard 防递归。 */
  readonly stop_hook_active?: boolean;
  readonly [key: string]: unknown;
}

export type ContinuityMode = 'rolling' | 'precompact';

export type ContinuityTrigger =
  | Readonly<{ fire: false; why: string }>
  | Readonly<{ fire: true; mode: ContinuityMode; bucket: number }>;

/** 冻结档位缺省,与 `docs/examples/.../session-continuity.ts:45` 同 env 同值。 */
export const DEFAULT_SESSION_BUCKET = 200_000;

/** 档位阈值:env 未设 → 缺省;设了但非正有限数 → null(fail-open:不拿坏配置造档位)。 */
function bucketThreshold(env: NodeJS.ProcessEnv): number | null {
  const raw = env.OMD_SESSION_BUCKET;
  if (raw === undefined) return DEFAULT_SESSION_BUCKET;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── 触发判定(纯函数,零副作用)────────────────────────────────────────────

/**
 * 跨档判定用 **bucket 序号跨越**(`floor(now/B) > floor(prev/B)`),与 memory-hub
 * `continuity-stop.mjs:89-90` 同形 —— 冻结模块那条「≥ 档位且前一条 <」一个 session 只响一次,
 * 400k / 600k 全部漏掉(#206 D-4)。
 */
export function decideContinuityTrigger(
  input: ContinuityHookInput,
  ledger: StopLedger,
  env: NodeJS.ProcessEnv = process.env,
): ContinuityTrigger {
  // PreCompact:压缩前恒存一次档 —— 那正是最需要快照的时刻,不看档位。
  if (input.hook_event_name === 'PreCompact') return { fire: true, mode: 'precompact', bucket: 0 };
  if (input.hook_event_name !== 'Stop') return { fire: false, why: `事件 ${input.hook_event_name} 不决策` };
  // 守卫不是触发:CC loop guard 命中 = 本轮由 hook 自己引发, 不再记一次。
  if (input.stop_hook_active === true) return { fire: false, why: 'stop_hook_active' };

  const threshold = bucketThreshold(env);
  if (threshold === null) return { fire: false, why: 'OMD_SESSION_BUCKET 配置坏 → 不造档位' };

  const entries = ledger.entries;
  const last = entries[entries.length - 1];
  if (last === undefined) return { fire: false, why: '空 ledger' };
  if (last.tokenBucket === null) return { fire: false, why: '最新条缺 token → 绝不伪造' };

  const nowIdx = Math.floor(last.tokenBucket / threshold);
  if (nowIdx < 1) return { fire: false, why: `未过首档 (${last.tokenBucket} < ${threshold})` };

  // 基准取**此前全部** entry 的最高档,不是"前一条"。
  // ⚠ 这条是真跑出来的:一个 Stop 之间会追加**多条** entry(一轮里每次 tool 调用各一条 assistant
  // 记录)。只比最后两条,跨档那一跳落在中间时就永远看不见了 —— 实测本仓一条 transcript 末尾是
  // `220262, 220956, 221759, 221759, 221759`,最后两条恒等,任何档距都判不出跨越。
  // 取历史最高档是无状态的,且天然幂等:同档再来多少条都不会重复触发;ctx 因压缩回落也不会误触发。
  let prevIdx = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const t = entries[i]!.tokenBucket;
    if (t === null) continue; // 缺读数的条跳过 —— 不伪造,也不因它抬高基准
    prevIdx = Math.max(prevIdx, Math.floor(t / threshold));
  }

  return nowIdx > prevIdx
    ? { fire: true, mode: 'rolling', bucket: nowIdx }
    : { fire: false, why: `同档延续 (${nowIdx})` };
}

// ─── 派发装配 ───────────────────────────────────────────────────────────────

/** 引擎锚 = 本仓根,**不随 cwd**:别的 repo 引本 hook 时那个 repo 没有 writer 脚本。 */
export function engineRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * spawn 参数装配(抽成纯函数是为了让「派了什么」可断言 —— detached 子进程本身测不了)。
 * `OMD_CONTINUITY_MECHANICAL=1` → 追加 `--mechanical` 跳过模型调用,端到端闸靠它跑成确定性。
 */
export function writerArgv(
  transcript: string,
  sessionId: string,
  mode: ContinuityMode,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const argv = [
    'run',
    join(engineRoot(), 'scripts/session-writer.ts'),
    '--transcript',
    transcript,
    '--session',
    sessionId,
  ];
  if (mode === 'precompact') argv.push('--precompact');
  if (env.OMD_CONTINUITY_MECHANICAL === '1') argv.push('--mechanical');
  return argv;
}

/**
 * writer 的 session 目录 —— 与 `writer.ts:361` / `ledger.ts:142` 逐字同源。
 * 这三处任何一处漂了,ledger 就是写给没人读的地方(hooks README「路径必须字面对齐」那条)。
 */
export function sessionDirOf(sessionId: string, cwd?: string): string {
  const scope = resolveProject(cwd);
  return resolve(scope.rootPath, scope.dataPath(join('session', sessionId)));
}
