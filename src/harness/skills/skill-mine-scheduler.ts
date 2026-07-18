/**
 * src/harness/skills/skill-mine-scheduler — drive the SkillMiner from the pi agent loop.
 *
 * 镜像 learning/pump-scheduler: 每 agent_end (回合间空档) 跑一轮 miner.mine() —— 把已升 confident 的
 * omd.pattern 起草成候选 skill 填进 miner buffer。flywheel 的 proposer (= miner.takeCandidates()) 在
 * 下一个 agent_end 同步排空 → 排进确认队。**绝不在回合中** (LLM 起草调用 off-handler)。
 *
 * Fire-and-forget: mine() 异步跑, 不挡下一个 prompt; throw 记 warn 不传播 (SKM-INV-6: 未记账的 pattern
 * 下轮重试)。Single-flight: 上一轮还在跑时本轮跳过 (不堆叠, LLM 调用不并发)。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { SkillMiner, MineResult } from './skill-miner';
import { logger } from '../../logger';

export interface SkillMineSchedulerOptions {
  miner: SkillMiner;
  /** 观测每轮结果 (审计 / 测试)。 */
  onMine?: (result: MineResult) => void;
}

export function createSkillMineScheduler(opts: SkillMineSchedulerOptions): ExtensionFactory {
  const { miner, onMine } = opts;
  return (pi) => {
    let inFlight = false;
    pi.on('agent_end', () => {
      if (inFlight) return;
      inFlight = true;
      void miner
        .mine()
        .then((r) => {
          if (r.authored > 0 || r.vetoed > 0) {
            logger.info(
              { eligible: r.eligible, fresh: r.fresh, authored: r.authored, vetoed: r.vetoed },
              '[omd/skills] episodic miner authored skill candidates',
            );
          }
          onMine?.(r);
        })
        .catch((err) => {
          logger.warn({ err: (err as Error).message }, '[omd/skills] skill miner failed (pattern unmarked, retried next turn)');
        })
        .finally(() => {
          inFlight = false;
        });
    });
  };
}
