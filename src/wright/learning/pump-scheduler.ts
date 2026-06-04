/**
 * src/wright/learning/pump-scheduler.ts — drive DreamPump from the pi agent loop.
 *
 * The compounding loop's clock: after each agent turn ends, drain any runtime
 * signals accumulated this turn (drift, future: corrections) into consolidated
 * wright.* facts. Gated: a pump with 0 new events skips the model call (LRN-5),
 * so a turn without drift costs nothing.
 *
 * Fire-and-forget: the pump runs async OFF the agent_end handler — it never
 * blocks the next prompt, and a consolidate throw is logged, not propagated
 * (watermark stays put → retried next turn, LRN-4). Single-flight: a pump still
 * running when the next agent_end fires is skipped (no overlap, no pile-up).
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { DreamPump } from './types';
import { logger } from '../../logger';

export interface PumpSchedulerOptions {
  pump: DreamPump;
  /** Observe each completed pump (audit / test). */
  onPump?: (result: { eventsConsumed: number; factsWritten: number }) => void;
}

/**
 * Extension that runs `pump.pump()` once per `agent_end`, off-thread and
 * single-flight. The seam from "signals recorded" → "facts consolidated".
 */
export function createDreamPumpScheduler(opts: PumpSchedulerOptions): ExtensionFactory {
  const { pump, onPump } = opts;
  return (pi) => {
    let inFlight = false;
    pi.on('agent_end', () => {
      if (inFlight) return;
      inFlight = true;
      // Off the handler: do not block the loop on a consolidation model call.
      void pump
        .pump()
        .then((r) => {
          if (r.eventsConsumed > 0) {
            logger.info(
              { eventsConsumed: r.eventsConsumed, factsWritten: r.factsWritten, factsRejected: r.factsRejected },
              '[wright/learning] dream pump consolidated runtime signals',
            );
          }
          onPump?.({ eventsConsumed: r.eventsConsumed, factsWritten: r.factsWritten });
        })
        .catch((err) => {
          logger.warn({ err: (err as Error).message }, '[wright/learning] dream pump failed (watermark held)');
        })
        .finally(() => {
          inFlight = false;
        });
    });
  };
}
