/**
 * src/harness/learning/confidence-scheduler.ts — 把 ConfidenceAdjuster 接进 pi agent loop。
 *
 * 每个 agent_end 后 (off-thread, single-flight): ① runUpgradeScan —— 把够格的 tentative 升 confident
 * (进 grounding) ② evaluateObservations —— 熔断器: 升级后变坏的回滚成 tentative。
 *
 * 顺序: 先升级再熔断 (本轮新升的本轮不会被熔断, 因还没注入过 → getSessionsWhereFactActive 空 → 跳过,
 * 留待之后被注入并观察)。最终一致: 任何这轮没赶上的下个 agent_end 补上 (增量, 不强求单轮完成)。
 *
 * Fire-and-forget: 不阻塞下一 prompt; 抛错只 log 不传播 (升级/回滚下轮重试, 幂等)。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  runUpgradeScan,
  evaluateObservations,
  resolveConfig,
  type ConfidenceConfig,
  type UpgradeMemory,
  type BreakerEventQuery,
  type ObservationStore,
} from './confidence-adjuster';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';
import { logger } from '../../logger';

export interface ConfidenceSchedulerOptions {
  /** OmdMemory (liveTentativeFacts / collectIdentityEvidence / liveByIdentity / writeFact)。 */
  memory: UpgradeMemory & { liveByIdentity(namespace: string, identityKey: string): ValidatedFact | null };
  /** FullEventStore (升级证据查询 + grounding 归因 + observation/cooldown + recordTurn)。 */
  eventStore: BreakerEventQuery & ObservationStore & { recordTurn(sessionId: string): void };
  /** 当前 runtime session id (turns 分母按 session 记)。 */
  sessionId: string;
  /** 阈值覆盖 (默认中道, env 可调)。 */
  config?: Partial<ConfidenceConfig>;
  /** 观测回调 (审计 / 测试)。 */
  onCycle?: (r: { upgraded: number; rolledBack: number; confirmed: number }) => void;
}

export function createConfidenceScheduler(opts: ConfidenceSchedulerOptions): ExtensionFactory {
  const config = resolveConfig(opts.config);
  return (pi) => {
    let inFlight = false;
    pi.on('agent_end', () => {
      // 这一轮发生了 = drift率的分母 +1 (在闸/熔断器跑前先记, 当轮即计入)。
      opts.eventStore.recordTurn(opts.sessionId);
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        const up = await runUpgradeScan(opts.memory, opts.eventStore, config, { obs: opts.eventStore });
        const br = await evaluateObservations(opts.memory, opts.eventStore, opts.eventStore, config);
        if (up.upgraded.length || br.rolledBack.length || br.confirmed.length) {
          logger.info(
            { upgraded: up.upgraded.length, rolledBack: br.rolledBack.length, confirmed: br.confirmed.length },
            '[omd/learning] confidence cycle: tentative→confident 升级 + 熔断器评估',
          );
        }
        opts.onCycle?.({ upgraded: up.upgraded.length, rolledBack: br.rolledBack.length, confirmed: br.confirmed.length });
      })()
        .catch((err) => {
          logger.warn({ err: (err as Error).message }, '[omd/learning] confidence cycle failed (retried next turn)');
        })
        .finally(() => {
          inFlight = false;
        });
    });
  };
}
