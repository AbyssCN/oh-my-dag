/**
 * src/mcp/tools/intervene —— `dag_intervene` MCP 工具 (SDD #160 D-4 / SDD 片 7)。
 *
 * ## 它是什么
 *
 * 人工介入记录面。把"为什么不得不伸手"留痕到主仓板 —— 调用一次 = 板上多一条
 * `{event:'intervened', runId, cause}`。读数板的 avoidability 段据此算可避免性率。
 *
 * ## 词表单源 (INV-3 / 判据①)
 *
 * `cause` 的合法值域直接复用 `FAILURE_KIND_ORDER` (node-failure.ts) —— 同一份词表,
 * 不在本工具里再列一遍 (列两份必漂)。schema enum 与 recordIntervention 的 fail-loud
 * 校验同源: 非法 cause 在 schema 层拒, 即便绕过 schema 直接调 handler 也再次拒, 抛 →
 * err 回执, 不落盘。
 *
 * ## 写侧共享件 (INV-RC-1 · SDD 片 7 切片 2)
 *
 * 写盘经 `recordIntervention` (`harness/run-control`) —— MCP 与 TUI 收件箱 i 都调
 * 同一份。同一个动作三份实现 = 同一处漂 (pathfinder.ts:112-116 那条教训)。parity 钉在
 * `run-control-parity.test.ts`。
 *
 * ## fail-open 性格 (与 `emitBoard` 同条纪律)
 *
 * recordIntervention 抛 → err 回执含具体错因; 板写失败不掀桌, 但**告诉调用方**写失败。
 * 这一点与 run-goal 的 `emitBoard` 那条「写板失败不掀桌但留日志」的纪律**不同**: 那条
 * 是引擎在跑, 写板失败只丢审计; 这里工具的语义就是写板, 失败就该如实告诉调用方。
 */
import { z } from 'zod';
import { recordIntervention } from '../../harness/run-control';
import { FAILURE_KIND_ORDER } from '../../harness/node-failure';
import type { OmdMcpTool } from '../server';

export interface InterveneToolDeps {
  /** 仓根 — recordIntervention (即 appendBoard) 的基准目录 (主仓状态锚; D-1)。 */
  cwd: string;
}

/** 把词表塞进 z.enum 要的元组形态 (zod 不收 readonly, FAILURE_KIND_ORDER 是 NodeFailureKind[])。 */
const causeTuple = FAILURE_KIND_ORDER as unknown as [string, ...string[]];

/** `cause` 合法值域念法, 出错时塞进 err 回执 (调用方看一眼知道该填哪个)。 */
const causeListForHuman = FAILURE_KIND_ORDER.join(' | ');

export function createInterveneTools(deps: InterveneToolDeps): OmdMcpTool[] {
  return [
    {
      name: 'dag_intervene',
      description: 'Record a human intervention on a run: append an intervened entry to the run-board (cwd).',
      inputSchema: {
        runId: z.string().describe('The run id being intervened on'),
        cause: z
          .enum(causeTuple)
          .describe(`Why intervention was needed — one of: ${causeListForHuman}`),
        note: z
          .string()
          .optional()
          .describe('Optional human note (truncated to 500B on the board layer)'),
      },
      handler: async (args) => {
        const a = args as { runId?: string; cause?: string; note?: string };
        // 二次闸: schema enum 已拒一次; 这里兜底 (绕过 schema 直接调本 handler 也得拒)。
        // 与 recordIntervention 内 fail-loud 校验同源词表 —— 任一处漂都立刻见红。
        if (!a.runId?.trim()) {
          return {
            content: [{ type: 'text' as const, text: 'dag_intervene: runId 必填' }],
            isError: true,
          };
        }
        if (typeof a.cause !== 'string' || !FAILURE_KIND_ORDER.includes(a.cause as never)) {
          return {
            content: [{
              type: 'text' as const,
              text: `dag_intervene: cause 必须是 ${causeListForHuman} 之一, got ${JSON.stringify(a.cause)}`,
            }],
            isError: true,
          };
        }
        const trimmedNote = a.note?.trim();
        try {
          // 写侧走共享件 (INV-RC-1) —— 同 cwd 同 (runId, cause, note) 经 MCP 与经
          // recordIntervention 写出来的板上记录逐字段相等, 仅 ts 不同。parity 钉在
          // run-control-parity.test.ts。
          // recordIntervention 自身对空 runId / 非法 cause 也 fail-loud, 这里
          // 二次闸保留作 defense-in-depth: handler 入口先做 schema 兜底检查 + 共享件
          // 再 fail-loud, 任一处漂立刻见红。
          recordIntervention(deps.cwd, a.runId, a.cause as never, trimmedNote);
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `dag_intervene: 写板失败 — ${(e as Error).message}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `已记 intervened ${a.runId} ${a.cause}`,
          }],
        };
      },
    },
  ];
}