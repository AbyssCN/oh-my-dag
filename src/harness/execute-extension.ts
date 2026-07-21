/**
 * src/harness/execute-extension —— plan → DAG → runtime 交接的 pi /execute 命令 (验收闭环入口)。
 *
 * 交接协议 (owner 定): plan mode 里 owner 说「开始执行」→ runtime 模型调 /execute:
 *   ① 取当前规划产物: docs/plan/ 最新 SDD (由 /sdd 落盘, 命名 YYYY-MM-DD-<slug>.md) →
 *     没有则回退 plan 台账 (PlanLedger.crystallize) → 都没有则提示先 /sdd。
 *   ② plan mode 若在开 (共享 planState 注入时可判) → 经 PlanModeState 公开态干净退出
 *     (还原 model/thinking, 同 plan-extension.exitPlan 语义); 无共享态则提示 shift+tab 退出。
 *   ③ SDD 文本作 task/契约喂 iterateExecutorDag (conductor 分解 → DAG 并行执行 → judge 收敛),
 *     每轮经 createDagRecorder 留痕 (iterate-extension 同范式)。
 *   ④ 完成后发 **ACCEPTANCE BRIEF** 回 session (pi.sendUserMessage 触发 runtime 模型主动验收
 *     + pi.appendEntry 留痕): DAG 摘要 + 收敛态 + token 用量 + 四选一验收指令块。
 *     验收决策协议在 brief 文本里 (harness prompt), 不硬编码进代码。
 *
 * `--redraw "<失败要点>"`: 验收判契约级失败后重画 —— 失败要点追加进 task 让 conductor 重分解。
 *
 * 工厂可注入依赖 (deps) 用于测试; 省略 = 生产实现 (iterate-extension 同范式)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { iterateExecutorDag, summarizeDagResult, type IterateResult } from './plan/iterate';
import { createDagRecorder } from './dag-record';
import { runExecutorDagWithPlan, type ExecutorDagResult, type GenerateFn } from './executor-dag';
import { parsePlan, type ConductorPlan } from './conductor-plan';
import type { VerifierFn } from './verifier';
import type { AgentLeafRunner, CommandLeafRunner } from './leaf-runners';
import { callModel, type ModelRequest, type ModelResponse } from '../model';
import type { PlanModeState } from './plan/mode';
import { logger } from './logger';
import { m } from './i18n';

/**
 * D-8: conductor 模型的**默认 = runtime 模型坐标** (env OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL),
 * 而非单独的廉价 conductor —— 廉价 conductor 从散文重推 = 交接税, runtime 模型有全上下文更该当分解器。
 * 解析序 (已设的 env 覆盖优先): OMD_ITER_CONDUCTOR_MODEL > runtime 坐标 > '' (caller 须显式给)。
 * 返回 '' = 环境未配 → caller 若真需 conductor (escalation / conductor 路径) 会自行报「conductorModel 必填」。
 */
export function resolveConductorDefault(): string {
  const override = process.env.OMD_ITER_CONDUCTOR_MODEL?.trim();
  if (override) return override;
  const provider = process.env.OMD_RUNTIME_PROVIDER?.trim();
  const model = process.env.OMD_RUNTIME_MODEL?.trim();
  if (provider && model) return `${provider}:${model}`;
  return '';
}

export interface ExecuteExtensionOpts {
  /**
   * conductor 模型 'provider:modelId'。省略 → D-8 默认 = runtime 坐标 (resolveConductorDefault:
   * OMD_ITER_CONDUCTOR_MODEL 覆盖 > OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL)。
   */
  conductorModel?: string;
  /** inproc leaf 模型 'provider:modelId'。 */
  leafModel: string;
  /** agent leaf 模型 (带工具改文件)。省略 = leafModel。 */
  agentLeafModel?: string;
  /** 收敛 judge 模型。省略 = leafModel。 */
  judgeModel?: string;
  /** 最大迭代轮数。省略 = iterate 默认 (3)。 */
  maxRounds?: number;
  /** conductor 轮级升级模型 (未收敛多轮换强 conductor 重画)。省略 = 永不升级。 */
  conductorEscalationModel?: string;
  /** 默认工作目录 (SDD 扫描基准)。省略 = ctx.cwd。 */
  cwd?: string;
  /** dag-record SQLite 路径。省略 = createDagRecorder 默认。 */
  recordPath?: string;
  /**
   * agent-kind leaf 执行器 (带工具**真改文件**)。省略 → executor-dag 把 agent 节点降级为无工具
   * inproc (不会改文件) / 产文件节点直接失败 —— "执行 SDD"会空转, 生产接线 (tui) 必须传。
   */
  agentRunner?: AgentLeafRunner;
  /** command-kind leaf 执行器 (确定性 CLI 自验节点)。省略 → command 节点失败。 */
  commandRunner?: CommandLeafRunner;
  /**
   * 共享 plan 状态 (与 createPlanExtension({ state }) 同一实例)。提供后:
   *   ① 无 SDD 文档时回退 ledger 内容作契约; ② plan mode 在开时程序化干净退出。
   * 省略 = 仅 SDD 文档路径可用, plan mode 退出改为文字提示 (shift+tab)。
   */
  planState?: PlanModeState;
}

export interface ExecuteDeps {
  iterateExecutorDag?: typeof iterateExecutorDag;
  createDagRecorder?: typeof createDagRecorder;
}

/** docs/plan/ 下最新 SDD (按 mtime 取 .md; /sdd 命名 YYYY-MM-DD-<slug>.md)。无 → null。 */
export function findLatestSdd(planDir: string): { path: string; text: string } | null {
  let files: string[];
  try {
    files = readdirSync(planDir).filter((f) => f.endsWith('.md'));
  } catch {
    return null; // 目录不存在 = 无 SDD
  }
  let best: { path: string; mtime: number; name: string } | null = null;
  for (const f of files) {
    const p = join(planDir, f);
    try {
      const mt = statSync(p).mtimeMs;
      // mtime 主序; 平手按文件名兜底 —— YYYY-MM-DD- 前缀下字典序=时间序, 且不依赖 readdir 序 (确定性)。
      // 粗粒度 fs (WSL2/网络盘) 上背靠背写的文件 mtime 会相等, 无此兜底则 readdir 序决定, 挑到旧日期文件。
      if (!best || mt > best.mtime || (mt === best.mtime && f > best.name)) best = { path: p, mtime: mt, name: f };
    } catch {
      // 竞态删除等 → 跳过该文件
    }
  }
  if (!best) return null;
  try {
    const text = readFileSync(best.path, 'utf8');
    return text.trim() ? { path: best.path, text } : null;
  } catch {
    return null;
  }
}

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
 * 验收指令块 (交接协议第 3 步, 活在 harness prompt 非代码): runtime 模型收到 brief 后
 * **必须主动**对照 SDD 契约判 pass/fail, 再按成本四选一。
 */
export function acceptanceInstructions(): string {
  return [
    '## 验收指令 (runtime 模型必须主动执行, 不等 owner 催)',
    '对照上方 SDD 契约逐条判定 pass/fail (GWT 验收点 + Contracts 不变量), 然后按成本四选一:',
    '1. 接受 (accept): 验收通过 → 接受结果, 向 owner 报告 "做了什么 + 为什么"。',
    '2. 重画 (redraw): 契约级失败 (方向/分解错, 补丁救不回) → /execute --redraw "<失败要点>" 重画 DAG。',
    '3. 迭代 (iterate): 部分收敛 (大盘对, 少数节点欠火候) → /iterate <针对性收敛任务> 定点迭代。',
    '4. 直接修 (direct fix): 小缺口 (diff 小, 自己改比再派 DAG 便宜) → 运行时直接修 + verify。',
    '判定规则: 按任务规模/成本走 —— 缺口越小越往下选 (4 最便宜); 契约级失败必须 2 (重画), 不打补丁;',
    '部分收敛走 3; 全过才 1。选定后立即执行, 完成后 brief owner。',
  ].join('\n');
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

        // ── ② 取规划产物: docs/plan 最新 SDD → 回退 ledger → 都没有则提示 /sdd ──
        const cwd = opts.cwd ?? ctx.cwd;
        const sdd = findLatestSdd(join(cwd, 'docs', 'plan'));
        let contract: string;
        let source: string;
        if (sdd) {
          contract = sdd.text;
          source = sdd.path;
        } else {
          const ledger = opts.planState?.ledger;
          const hasLedger = !!ledger && (ledger.goal.trim() !== '' || ledger.decisions.length > 0);
          if (hasLedger) {
            contract = ledger!.crystallize('执行契约 (plan ledger)', new Date().toISOString().slice(0, 10));
            source = 'plan ledger (未落盘 SDD)';
          } else {
            ctx.ui.notify(
              m({
                en: 'No plan artifact found: no SDD under docs/plan/ and the plan ledger is empty. In plan mode run /sdd first (crystallize the deliberation), then /execute.',
                zh: '没找到规划产物: docs/plan/ 下无 SDD 且 plan 台账为空。先在 plan mode 里 /sdd 落盘审议结论, 再 /execute。',
              }),
              'warning',
            );
            return;
          }
        }

        // ── ③ plan mode 在开 → 经共享 PlanModeState 干净退出 (同 plan-extension.exitPlan 语义);
        //      无共享态则无法程序化退出, brief 里附 shift+tab 提示。──
        const st = opts.planState;
        let planExitHint = '';
        if (st?.status === 'plan') {
          st.status = 'normal';
          if (st.savedModel) void pi.setModel(st.savedModel as Parameters<typeof pi.setModel>[0]);
          if (st.savedThinking) pi.setThinkingLevel(st.savedThinking);
          st.savedModel = null;
          st.savedThinking = null;
          ctx.ui.setStatus('plan', undefined);
          ctx.ui.notify(m({ en: 'Exited PLAN MODE → handing off to DAG', zh: '▶ 已退出 PLAN MODE → 交接给 DAG 执行' }), 'info');
        } else if (!st) {
          planExitHint = m({
            en: '(If the session is still in plan mode, shift+tab out before acting on this brief.)',
            zh: '(若会话仍在 plan mode, 先 shift+tab 退出再执行验收动作。)',
          });
        }

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
            ...(planExitHint ? ['', planExitHint] : []),
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

// ── D-7 step 2 · runtime-finalize (可开关, 默认 OFF) ─────────────────────────────

/** 定稿 review 的动态边界 (draft plan JSON 走此之后)。 */
const FINALIZE_BOUNDARY = '\n\n===== DRAFT PLAN (compiled slice, JSON below the boundary) =====\n\n';

/** runtime 定稿 review 的 system 指令 (强模型审编译草稿 → 补细节/再展开/加 verify/宽深检查)。 */
function finalizeSystemPrompt(): string {
  return [
    'You are the RUNTIME FINALIZER. A ticket compiler已把散尽的决策票**零 LLM**编译成一张 draft',
    'ConductorPlan (每票 → 一个 leaf 节点, depends_on = blockedBy)。你的活 = 用**全上下文**把这张草稿',
    '定稿成可直接执行的 plan, 只**补足与修形**, 不重新发明结构 (D-11 只组装不发明):',
    '- 补叶子级细节: 让每个 node.goal 具体到弱 executor 能独立完成 (加缺的 output_type/output_path/persona)。',
    '- 再展开被降级的节点: 编译器把票的 map/primitive 意图**降级成了 leaf** (票不携带 MapSpec/primitive',
    '  params)。若某 goal 明显是「对 EACH … 逐个处理」的运行时工作表 → 还原成 executor:"map" (补 lister/over/',
    '  itemVar/template); 若明显匹配某控制流形 → 还原成 kind:"primitive" (+ primitive + params)。做不到就**留',
    '  作 leaf** (best-effort, 宁缺毋滥)。',
    '- 加 verify 提示: 对正确性敏感的节点补 postcondition (GWT), 或在末尾加一个 command 验证节点 (如',
    '  "bun run tsc --noEmit && bun test")。',
    '- 宽深 sanity-check: 无真实数据依赖的节点必须是兄弟 (同层并行); 别把逻辑顺序压成 depends_on 深链。',
    '保持无环。保留原有 node id (稳定 key)。',
    '',
    'Output STRICTLY one JSON object matching:',
    '{ "name": string, "description"?: string, "nodes": { "<id>": { "goal"?: string, "persona"?: string,',
    '  "depends_on"?: string[], "executor"?: "leaf"|"agent"|"command"|"map", "command"?: string,',
    '  "output_type"?: "structured"|"file"|"git"|"none", "output_path"?: string,',
    '  "map"?: { "lister": object, "over": string, "itemVar": string, "keyBy"?: string, "template": object },',
    '  "kind"?: "primitive", "primitive"?: string, "params"?: object,',
    '  "postcondition"?: { "method"?: "structural"|"code"|"llm-judge"|"human" } } } }',
  ].join('\n');
}

/** runtime-finalize 开关 + 模型 (D-7 step 2)。默认 OFF → 零成本零 LLM。 */
export interface FinalizeOpts {
  /** !== true → 直接返回 draft, 零成本 (默认 OFF)。 */
  finalize?: boolean;
  /** 定稿 review 模型坐标 'provider:modelId'。省略 = D-8 runtime 坐标。 */
  finalizeModel?: string;
  /** 定稿 review 推理档 (默认 high)。 */
  thinkingLevel?: ModelRequest['thinkingLevel'];
}

/** finalizePlan 的注入依赖 (测试传 fake call)。 */
export interface FinalizeDeps {
  /** 注入式单发模型调用 (默认 callModel from src/model)。 */
  call?: (req: ModelRequest) => Promise<ModelResponse>;
}

/**
 * runtime-finalize (D-7 step 2, 组件 7): **可选**的 runtime 模型定稿, 审 slice-compiler 的 draft plan —
 * 补叶子细节 / 再展开被降级的 map·primitive / 加 verify 提示 / 宽深 sanity-check。**单次可注入 LLM 调用**。
 *
 * 默认 OFF (opts.finalize !== true → 原样返回 draft) → 零成本, 不启用即无 LLM。启用后经 parsePlan 再过
 * PlanSchema 校验; 定稿调用抛错 ∨ 输出未过校验 → **best-effort 回退 draft** (不丢已编译的可执行 slice)。
 */
export async function finalizePlan(
  draftPlan: ConductorPlan,
  opts: FinalizeOpts,
  deps?: FinalizeDeps,
): Promise<ConductorPlan> {
  // 默认 OFF: compiled slice 本身已是可执行 plan → 原样返回, 零 LLM 零成本。
  if (opts.finalize !== true) return draftPlan;

  const call = deps?.call ?? callModel;
  const model = opts.finalizeModel ?? resolveConductorDefault();
  let res: ModelResponse;
  try {
    res = await call({
      messages: [
        { role: 'system', content: finalizeSystemPrompt() },
        { role: 'user', content: `${FINALIZE_BOUNDARY}${JSON.stringify(draftPlan, null, 2)}` },
      ],
      model,
      thinkingLevel: opts.thinkingLevel ?? 'high',
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[omd/execute] runtime-finalize 调用抛错 → 回退 draft (best-effort)');
    return draftPlan;
  }
  // 弱信任: 定稿输出**必须**重过 PlanSchema; 未过 → 回退 draft (不丢 compiled slice)。
  const parsed = parsePlan(res.text);
  if (!parsed.ok) {
    logger.warn({ err: parsed.error }, '[omd/execute] runtime-finalize 输出未过 PlanSchema → 回退 draft (best-effort)');
    return draftPlan;
  }
  return parsed.plan;
}

// ── D-7 · executeSlice: 编译好的 slice → 直执 (跳过 conductor 重分解) ────────────────

/**
 * executeSlice 的配置 (与 execute-extension 已解析的形状一致): leaf/agent 模型 + verifier + cwd + recorder
 * + 可选 runtime-finalize。conductorModel 省略 → D-8 runtime 坐标 (仅 escalation 用)。
 */
export interface ExecuteSliceOpts {
  /** conductor 升级/兜底模型 (D-8 默认 = runtime 坐标)。**仅 verifier fail 升级重规划时用**; 预构造执行不需。 */
  conductorModel?: string;
  /** inproc leaf 模型 'provider:modelId'。必填 (叶子执行要它)。 */
  leafModel: string;
  /** agent leaf 模型 (带工具改文件)。省略 = leafModel。 */
  agentLeafModel?: string;
  /** 跨模型校验器。省略 = 不校验。 */
  verifier?: VerifierFn;
  /** conductor 升级模型 (verifier fail 时)。省略 = 永不升级。 */
  conductorEscalationModel?: string;
  /** 内层 fan-out 并发上限。 */
  maxFanout?: number;
  /** 工作目录 (预留: continuity repoRoot; 当前 P1 不落 continuity)。 */
  cwd?: string;
  /** dag-record 留痕器 (execute-extension 已建的 recorder)。省略 = 不留痕。 */
  recorder?: { record: (res: ExecutorDagResult, meta?: { question?: string }) => string };
  /** runtime-finalize 开关 (默认 OFF)。 */
  finalize?: boolean;
  /** runtime-finalize 模型 (省略 = conductorModel / runtime 坐标)。 */
  finalizeModel?: string;
  /** 注入式 leaf 模型调用 (省略 = executor-dag 默认 send)。测试传 fake leaf runner。 */
  generate?: GenerateFn;
  /** agent-kind leaf 执行器 (带工具改文件)。省略 → agent 节点降级 inproc。 */
  agentRunner?: AgentLeafRunner;
  /** command-kind leaf 执行器 (确定性 CLI)。省略 → command 节点失败。 */
  commandRunner?: CommandLeafRunner;
}

/** executeSlice 注入依赖 (测试传 fake 引擎 / 定稿)。 */
export interface ExecuteSliceDeps {
  /** 注入式预构造执行入口 (默认 runExecutorDagWithPlan)。测试传 fake。 */
  runDagWithPlan?: typeof runExecutorDagWithPlan;
  /** 注入式定稿 (默认 finalizePlan)。 */
  finalizePlan?: typeof finalizePlan;
  /** finalize 的注入式模型调用 (默认 callModel)。 */
  call?: (req: ModelRequest) => Promise<ModelResponse>;
}

/**
 * executeSlice (D-7): 把一张**预构造 ConductorPlan** (pathfinder slice-compiler 的产物) 直接执行 —
 * 经 executor-dag 的 D-7 预构造入口 (runExecutorDagWithPlan) **跳过 conductor 重分解**, 而非把散文再喂
 * iterate 重推 DAG (消除交接税)。可选先经 runtime-finalize 定稿 (默认 OFF)。**单次**执行 (plan 已是分解,
 * 不套 fixpoint 重画)。P2/P3 在区域散尽时调用它。
 *
 * @returns ExecutorDagResult (调用方按需 summarizeDagResult / 发验收 brief)。
 */
export async function executeSlice(
  plan: ConductorPlan,
  opts: ExecuteSliceOpts,
  deps?: ExecuteSliceDeps,
): Promise<ExecutorDagResult> {
  const runDag = deps?.runDagWithPlan ?? runExecutorDagWithPlan;
  const finalize = deps?.finalizePlan ?? finalizePlan;
  // D-8: conductor 默认 = runtime 坐标 (仅 escalation 用)。
  const conductorModel = opts.conductorModel ?? resolveConductorDefault();

  // 可选 runtime 定稿 (默认 OFF → draft 原样)。
  const finalPlan = await finalize(
    plan,
    { finalize: opts.finalize, finalizeModel: opts.finalizeModel ?? conductorModel },
    { call: deps?.call },
  );

  return runDag(finalPlan, {
    conductorModel,
    leafModel: opts.leafModel,
    agentLeafModel: opts.agentLeafModel,
    verifier: opts.verifier,
    conductorEscalationModel: opts.conductorEscalationModel,
    maxFanout: opts.maxFanout,
    generate: opts.generate,
    agentRunner: opts.agentRunner,
    commandRunner: opts.commandRunner,
    onComplete: opts.recorder
      ? (res) => {
          opts.recorder!.record(res, { question: `executeSlice ${finalPlan.name}` });
        }
      : undefined,
  });
}
