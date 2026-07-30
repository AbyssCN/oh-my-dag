/**
 * src/mcp/tools/triage —— **owner 收件箱的调用面** (S3 出口 + 入口, 2026-07-31)。
 *
 * ## 为什么出口必须和入口一起做
 *
 * 三条独立来源指向同一个洞:
 *  - Addy Osmani 的五件套: automation 的产出**进 Triage 收件箱**, 无发现的自己归档;
 *  - better-harness 的 Automation Readiness 第 8 条: `triage path` —— findings 落到哪、谁看;
 *  - 我们自己 D-AA 的记账: detached run 跑完/跑挂了, **今天只有一个日志文件**。
 *
 * 无人值守的产出**必须有个去处**, 否则"跑完了"与"没人知道跑完了"没有区别 —— 而后者比不跑更坏,
 * 因为它消耗了钱还制造了"已经在跑"的错觉。
 *
 * ## 两个工具
 *
 * - `dag_triage`: **看**。待决岔口 + 需要人看一眼的 run (blocked / 预算停 / failed / 被打断)。
 * - `dag_rule`: **裁**。裁决一个岔口 → 自动变成一条 owner 指令 → 下一轮 conductor 逐字读到。
 *
 * ## 一条纪律
 *
 * `dag_rule` **不自动重启 run**。裁决与重跑是两个决定 (owner 可能裁完想先看看别的);
 * 而"裁决了就自动跑"会让一次手滑变成一次真花钱。回话里给出 resume 命令, 由 owner 扣扳机 ——
 * 与 pathfinder `path_deliver` 的权力闸同一条理由。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { OwnerInbox } from '../owner-inbox';
import type { RunRegistry, RunStatus } from '../run-registry';

export interface TriageToolDeps {
  inbox: OwnerInbox;
  runRegistry: RunRegistry;
  /** 列出所有 run 的状态 (registry 已 hydrate 磁盘, 所以跨会话可见)。 */
  listRuns?: () => { runId: string; status: RunStatus; goal: string; error?: string }[];
}

/** 需要人看一眼的终态 —— 与"跑完了没事"的区别就是这张表。 */
const NEEDS_EYES: RunStatus[] = ['failed', 'cancelled'];

export function createTriageTools(deps: TriageToolDeps): OmdMcpTool[] {
  const listRuns = deps.listRuns ??
    (() =>
      deps.runRegistry.listRuns().map((runId) => {
        const r = deps.runRegistry.getRecord(runId)!;
        return { runId, status: r.status, goal: r.goal, ...(r.error ? { error: r.error } : {}) };
      }));

  return [
    {
      name: 'dag_triage',
      description: 'Owner inbox: open decision forks + runs that need a human look. Read-only.',
      inputSchema: {
        runId: z.string().optional().describe('Only this run; omit = everything'),
      },
      handler: async (args) => {
        const { runId } = args as { runId?: string };
        const forks = deps.inbox.openForks(runId);
        const runs = listRuns().filter((r) => (runId ? r.runId === runId : NEEDS_EYES.includes(r.status)));

        const lines: string[] = [];
        lines.push(`待决岔口: ${forks.length} · 需要看一眼的 run: ${runs.length}`);
        if (forks.length) {
          lines.push('', '── 待决岔口 (dag_rule forkId=<id> ruling="…") ──');
          for (const f of forks) {
            lines.push(
              `[${f.id}]${f.blocking ? ' **红线, 图停在这儿等你**' : ''}`,
              `  问题: ${f.question}`,
              `  我的建议: ${f.recommendation}`,
              // 假设必须显示 —— owner 要判的不只是"选哪个", 还有"它已经按什么在跑了"。
              `  它已按此假设继续跑: ${f.assumption}`,
              `  run=${f.runId} 节点=${f.nodeId} 第 ${f.round} 轮 · ${f.createdAt}`,
            );
          }
        }
        if (runs.length) {
          lines.push('', '── 需要看一眼的 run ──');
          for (const r of runs) {
            lines.push(`[${r.runId}] ${r.status} · ${r.goal}${r.error ? `\n  ${r.error.split('\n')[0]}` : ''}`);
          }
        }
        // no-silent-caps 的反面: 空也要如实说是空, 而不是什么都不回。
        if (!forks.length && !runs.length) lines.push('', '(收件箱是空的)');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    },
    {
      name: 'dag_rule',
      description: 'Rule on a decision fork. The ruling becomes a verbatim owner directive for the next round.',
      inputSchema: {
        forkId: z.string().describe('Fork id from dag_triage'),
        ruling: z.string().describe('Your decision, verbatim — it goes to the conductor unedited'),
      },
      handler: async (args) => {
        const { forkId, ruling } = args as { forkId?: string; ruling?: string };
        if (!forkId || !ruling?.trim()) {
          return { content: [{ type: 'text' as const, text: 'dag_rule: forkId 与 ruling 都必填' }], isError: true };
        }
        const existing = deps.inbox.getFork(forkId);
        if (!existing) {
          return { content: [{ type: 'text' as const, text: `dag_rule: 没有这个岔口 ${forkId}` }], isError: true };
        }
        if (existing.status === 'ruled') {
          // 裁决是一次性的 —— 如实说已裁过并把上次的裁决念出来, 别静默覆盖。
          return {
            content: [{ type: 'text' as const, text: `dag_rule: ${forkId} 已裁决过 — ${existing.ruling}` }],
            isError: true,
          };
        }
        const out = deps.inbox.rule(forkId, ruling);
        if (!out) {
          return { content: [{ type: 'text' as const, text: `dag_rule: ${forkId} 裁决失败` }], isError: true };
        }
        const changed = out.fork.assumption.trim() !== ruling.trim();
        return {
          content: [{
            type: 'text' as const,
            text: [
              `已裁决 ${forkId}`,
              `  问题: ${out.fork.question}`,
              `  裁决: ${ruling}`,
              // 这一行是给 owner 的风险提示, 不是引擎行为: 裁决与假设不同 → 建立在假设上的产出该重算。
              changed
                ? `  ⚠ 与它跑时用的假设**不同** (假设是「${out.fork.assumption}」) — 建立在该假设上的产出需要重算`
                : `  与它跑时用的假设一致 — 已有产出不受影响`,
              '',
              // 权力闸: 裁决与重跑是两个决定, 不自动扣扳机 (同 pathfinder path_deliver)。
              `裁决已进 run ${out.fork.runId} 的指令队列, **下一轮**由 conductor 逐字读到。`,
              `接着跑: dag_goal resume=${out.fork.runId} goal="<原目标>"`,
            ].join('\n'),
          }],
        };
      },
    },
  ];
}
