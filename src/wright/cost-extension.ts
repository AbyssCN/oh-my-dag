/**
 * src/wright/cost-extension —— V2-ECON 计量回路接进 TUI (B-1)。
 *
 * `/cost` 看本 session 模型花费/token; budget 超阈 agent_end 红标 (ECON-4 升级不静默)。
 * ledger 经 attachLedger 订阅 callModel 观察者 → 自动记账 conductor/leaf/fanout/cg-audit 的子编排花费。
 * (注: pi 主对话模型的花费在 pi 内部, 不经我们 callModel; 此 ledger 计的是**子编排**花费 — MiMo/DeepSeek 烧在这。)
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createCostLedger, attachLedger, type CostLedger } from '../model/accounting';
import { logger } from '../logger';
import { m } from './i18n';

export interface CostExtensionResult {
  extension: ExtensionFactory;
  ledger: CostLedger;
}

export function createCostExtension(opts: { limitUsd?: number } = {}): CostExtensionResult {
  const ledger = createCostLedger({ limitUsd: opts.limitUsd });

  const extension: ExtensionFactory = (pi) => {
    attachLedger(ledger); // 订阅 callModel usage → 自动记账

    pi.registerCommand('cost', {
      description: m({
        en: 'This session sub-orchestration model spend/token (conductor/leaf/fanout/cg-audit)',
        zh: '本 session 子编排模型花费/token (conductor/leaf/fanout/cg-audit)',
      }),
      handler: async (_args: string, ctx) => {
        const s = ledger.state();
        const byModel = Object.entries(s.byModel)
          .map(([m, x]) => `  ${m}: ${x.calls} call · $${x.costUsd.toFixed(4)} · ${x.in}in/${x.out}out`)
          .join('\n');
        const limit = s.budget.limitUsd > 0 ? `/$${s.budget.limitUsd.toFixed(2)} [${s.budget.level}]` : '';
        const cache = s.cacheSavingsUsd > 0 ? m({ en: ` · cache saved $${s.cacheSavingsUsd.toFixed(4)}`, zh: ` · cache 省 $${s.cacheSavingsUsd.toFixed(4)}` }) : '';
        const unpriced = s.unpriced > 0 ? ` · ${s.unpriced} unpriced` : '';
        const level = s.budget.level === 'exhausted' ? 'error' : s.budget.level === 'warn' ? 'warning' : 'info';
        ctx.ui.notify(
          `💰 ${s.calls} call · $${s.spentUsd.toFixed(4)}${limit}${cache}${unpriced}\n${byModel || m({ en: '  (no sub-orchestration calls this session)', zh: '  (本 session 无子编排调用)' })}`,
          level,
        );
      },
    });

    // 预算超阈 → agent_end 红标日志 (ECON-4: 不静默)。TUI 可见经 /cost。
    pi.on('agent_end', () => {
      const b = ledger.state().budget;
      if (b.level !== 'ok') {
        logger.warn({ level: b.level, spentUsd: b.spentUsd, limitUsd: b.limitUsd }, `[wright/cost] budget ${b.level}`);
      }
    });
  };

  return { extension, ledger };
}
