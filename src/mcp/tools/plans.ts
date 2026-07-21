/**
 * src/mcp/tools/plans — omd_plans: plan-memory 账本可观测 (Phase A 证据门仪表, issue #10)。
 *
 * 列 family 战绩 + 版本链。Phase B 开门判据一屏可读: 任一 family runs≥3 ∧ ok率≥0.8。
 * Pure-fn factory, mirror memory.ts 形状。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { PlanLedger } from '../../harness/plan-ledger';

export function createPlansTool(ledger: PlanLedger | undefined): OmdMcpTool {
  return {
    name: 'omd_plans',
    description:
      'List plan-memory ledger: task families with run stats and plan version chains. Evidence gate for Phase B replay.',
    inputSchema: {
      familyId: z.string().optional().describe('Show version chain of one family (omit = list all families)'),
    },
    handler: async ({ familyId }) => {
      if (!ledger) {
        return { content: [{ type: 'text' as const, text: 'plan-ledger 未装配 (assemble 未传 ledger)。' }], isError: true };
      }
      try {
        if (familyId) {
          const versions = ledger.plans(familyId as string);
          if (versions.length === 0) {
            return { content: [{ type: 'text' as const, text: `family ${familyId}: 无版本 (id 有误?)` }], isError: true };
          }
          const lines = [
            `family ${familyId} 版本链:`,
            ...versions.map((v) =>
              `  v${v.version} ${v.id}  runs=${v.runs} ok=${v.okRuns} cost=$${v.totalCostUsd.toFixed(4)} ` +
              `${v.verified ? '[verified]' : '[weak]'}${v.parentId ? ` parent=${v.parentId.slice(0, 8)}` : ''}`,
            ),
          ];
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        const fams = ledger.families();
        if (fams.length === 0) {
          return { content: [{ type: 'text' as const, text: 'plan-ledger 空 — 还没有记账的 dag_run。' }] };
        }
        // 证据门判据 (issue #10): runs≥3 ∧ ok率≥0.8 → Phase B 候选。
        const lines = ['plan-memory 账本 (Phase B 证据门: runs≥3 ∧ ok率≥0.8):', ''];
        for (const f of fams) {
          const okRate = f.runs > 0 ? f.okRuns / f.runs : 0;
          const gate = f.runs >= 3 && okRate >= 0.8 ? ' ✅证据门达标' : '';
          const retired = f.retired ? ' [retired]' : '';
          lines.push(
            `[${f.id.slice(0, 8)}] runs=${f.runs} ok率=${(okRate * 100).toFixed(0)}% versions=${f.versions}${gate}${retired}`,
            `  ${f.canonicalTask.slice(0, 100)}`,
          );
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `omd_plans 失败: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  };
}
