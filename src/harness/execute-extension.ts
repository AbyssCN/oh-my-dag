/**
 * src/harness/execute-extension —— pi TUI 的 `/execute` 斜杠命令 (plan → DAG → runtime 交接的**门面**)。
 *
 * 执行本体已搬到 `execute-slice.ts` (2026-08-01) —— 这里只剩"怎么把它接到一个交互终端上":
 * 注册命令 · 解析 `--redraw` · 跑完发 **ACCEPTANCE BRIEF** 回 session
 * (`pi.sendUserMessage` 触发 runtime 模型主动验收 + `pi.appendEntry` 留痕)。
 * 验收决策协议在 brief 文本里 (harness prompt), 不硬编码进代码。
 *
 * ⚠ 本文件 import `pi-coding-agent` —— 按约定, **MCP 那条路径不许 import 它**
 * (由 `src/mcp/no-cli-dep.test.ts` 守)。要复用能力请 import `execute-slice.ts`。
 */
import { join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createDagRecorder } from './dag-record';
import { m } from './i18n';
import {
  acceptanceInstructions,
  findLatestSdd,
  resolveConductorDefault,
  type ExecuteDeps,
  type ExecuteExtensionOpts,
} from './execute-slice';
import { iterateExecutorDag, summarizeDagResult, type IterateResult } from './plan/iterate';

/** 汇总 fixpoint 全轮 token 用量 (conductor + leaves; cacheHit ⊆ in)。 */
function sumUsage(r: IterateResult): string {
  let cin = 0, cout = 0, lin = 0, lout = 0, hit = 0;
  for (const round of r.rounds) {
    const u = round.result.usage;
    cin += u.conductor.in;
    cout += u.conductor.out;
    lin += u.leavesIn;
    lout += u.leavesOut;
    hit += u.leavesCacheHit;
  }
  return `conductor ${cin}→${cout} · leaves ${lin}→${lout} (cache hit ${hit})`;
}

/**
 * 造 /execute slash 命令扩展工厂 (plan → DAG → runtime 交接)。
 *
 * @param opts - 模型、轮数、路径、共享 plan 态等配置
 * @param deps - 测试注入 (省略 = 真实实现)
 * @returns ExtensionFactory 供 pi main(args, { extensionFactories: [...] }) 注册
 */
export function createExecuteExtension(
  opts: ExecuteExtensionOpts,
  deps?: ExecuteDeps,
): ExtensionFactory {
  const mkRecorder = deps?.createDagRecorder ?? createDagRecorder;
  const recorder = mkRecorder({ path: opts.recordPath });
  const iterate = deps?.iterateExecutorDag ?? iterateExecutorDag;
  // D-8: conductor 默认 = runtime 坐标 (廉价 conductor 拆除); 显式 opts 优先。
  const conductorModel = opts.conductorModel ?? resolveConductorDefault();

  return (pi) => {
    pi.registerCommand('execute', {
      description: m({
        en: 'Hand the plan (SDD/ledger) to the DAG conductor and run it; emits an acceptance brief on completion. Usage: /execute [--redraw "<failure notes>"]',
        zh: '把规划产物 (SDD/台账) 交给 conductor 分解成 DAG 执行, 完成后发验收 brief。用法: /execute [--redraw "<失败要点>"]',
      }),
      handler: async (args: string, ctx) => {
        // ── ① 解析 --redraw (验收判契约级失败后的重画路径) ──
        const trimmed = args.trim();
        let redrawNotes = '';
        if (trimmed.startsWith('--redraw')) {
          redrawNotes = trimmed.slice('--redraw'.length).trim().replace(/^["']|["']$/g, '');
        }

        // ── ② 取规划产物: docs/plan 最新 SDD; 没有则提示先写 SDD (plan mode/台账回退已随座舱撤除) ──
        const cwd = opts.cwd ?? ctx.cwd;
        const sdd = findLatestSdd(join(cwd, 'docs', 'plan'));
        if (!sdd) {
          ctx.ui.notify(
            m({
              en: 'No plan artifact found: no SDD under docs/plan/. Write the SDD first (YYYY-MM-DD-<slug>.md), then /execute.',
              zh: '没找到规划产物: docs/plan/ 下无 SDD。先写 SDD (YYYY-MM-DD-<slug>.md), 再 /execute。',
            }),
            'warning',
          );
          return;
        }
        const contract: string = sdd.text;
        const source: string = sdd.path;

        // ── ④ task = SDD 契约 (+ redraw 失败要点) → iterateExecutorDag (每轮 dag-record 留痕) ──
        const task = redrawNotes
          ? [
              contract,
              '',
              '===== REDRAW FEEDBACK (上一次 DAG 验收失败, 重画时必须针对性解决) =====',
              redrawNotes,
            ].join('\n')
          : contract;

        ctx.ui.setStatus('execute', m({ en: 'executing DAG…', zh: 'DAG 执行中…' }));
        try {
          const r = await iterate(task, {
            conductorModel,
            leafModel: opts.leafModel,
            agentLeafModel: opts.agentLeafModel,
            judgeModel: opts.judgeModel,
            maxRounds: opts.maxRounds,
            conductorEscalationModel: opts.conductorEscalationModel,
            // 真改文件的接缝: 不接 agentRunner, conductor 派的 agent/产文件节点全是空转 (降级/失败)。
            agentRunner: opts.agentRunner,
            commandRunner: opts.commandRunner,
            onComplete: (res) => {
              recorder.record(res, { question: 'execute ' + source + (redrawNotes ? ' (redraw)' : '') });
            },
          });

          // ── ⑤ ACCEPTANCE BRIEF: 留痕 (appendEntry) + 喂给 runtime 模型触发主动验收 (sendUserMessage) ──
          const summary = r.finalRound
            ? summarizeDagResult(r.finalRound.result, 600)
            : m({ en: '(no output)', zh: '(无产出)' });
          const brief = [
            '<execute-acceptance-brief>',
            '## DAG 执行完毕 → 交接回 runtime (验收阶段)',
            `契约来源: ${source}${redrawNotes ? ' · 本次为 --redraw 重画' : ''}`,
            `收敛状态: [${r.status}] ${r.rounds.length} 轮 · converged=${r.converged}${r.error ? ` · error=${r.error}` : ''}`,
            `Token 用量: ${sumUsage(r)}`,
            '',
            '## DAG 结果摘要',
            summary,
            '',
            acceptanceInstructions(),
            '</execute-acceptance-brief>',
          ].join('\n');

          pi.appendEntry('execute-acceptance', {
            source,
            redraw: redrawNotes || null,
            status: r.status,
            converged: r.converged,
            rounds: r.rounds.length,
          });
          pi.sendUserMessage(brief);
          ctx.ui.notify(
            m({
              en: `[${r.status}] DAG done (${r.rounds.length} rounds, converged=${r.converged}) — acceptance brief sent to runtime model`,
              zh: `[${r.status}] DAG 完成 (${r.rounds.length} 轮, 收敛=${r.converged}) — 验收 brief 已交 runtime 模型`,
            }),
            r.converged ? 'info' : 'warning',
          );
        } catch (e) {
          ctx.ui.notify(m({ en: 'Execute failed: ', zh: '执行失败: ' }) + String(e), 'error');
        } finally {
          ctx.ui.setStatus('execute', undefined);
        }
      },
    });
  };
}
