/**
 * src/wright/memory/prune-scheduler — live wright.memory 的 TTL 垃圾回收 (接 dream 路径决策的尾巴)。
 *
 * 背景 (2026-06-04 dream 路径决策): live 路径 (dream-pump→writeFact) 一直往 WrightMemory 写 fact, 但
 * `WrightMemory.prune()` (软删 idle>30d 的 agent_tentative fact, isExpired) **从未挂到生产** —— 只 test
 * 可达。这是 live fact 唯一的无界增长源 (confident/human 永不过期, identity-supersession 已防精确重复)。
 *
 * **刻意只 prune 不 dedup**: 近义 tentative fact 的归宿已被生命周期覆盖 —— 复现则升 confident (不该 dedup),
 * 不复现则 30d 后 prune 过期。embedding-相似 DEDUP 会误删不同身份的 confident pattern (fuzzy 上的破坏性
 * 操作), 且与 TTL 重叠 = 无第二需求者的 slop。故 GC = prune-only。
 *
 * **cadence = session_start (非 agent_end)**: TTL 是 30 天窗口, 一个 session 内不会有新过期项 → 每回合扫
 * 全表 = 纯浪费。会话边界扫一次 = 正解 (开 session 时清掉上次遗留的过期 tentative)。同步且廉价
 * (<10k fact, SDD §7), 无需 fire-and-forget。失败软降级, 不阻断 session。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { WrightMemory } from './store';
import { logger } from '../../logger';

export interface PruneSchedulerOptions {
  /** 只需 prune() 切面 (测试可注入 stub)。 */
  memory: Pick<WrightMemory, 'prune'>;
  /** 观测每次 GC 的过期数 (审计 / 测试)。 */
  onPrune?: (expired: number) => void;
}

/** session_start 跑一次 TTL GC (软删 idle>30d 的 tentative fact)。confident/human 永不动。 */
export function createPruneScheduler(opts: PruneSchedulerOptions): ExtensionFactory {
  const { memory, onPrune } = opts;
  return (pi) => {
    pi.on('session_start', () => {
      try {
        const expired = memory.prune();
        if (expired > 0) {
          logger.info({ expired }, '[wright/memory] TTL GC: 软删过期 tentative fact');
        }
        onPrune?.(expired);
      } catch (e) {
        logger.debug({ e: String(e) }, '[wright/memory] prune skip');
      }
    });
  };
}
