/**
 * src/harness/execute-slice —— plan → DAG 的**执行本体** (SDD 定位 · conductor 默认座 · 跑图 · 收尾)。
 *
 * 2026-08-01 从 `execute-extension.ts` 拆出来。此前本体与 pi TUI 的 `/execute` 斜杠命令同住一个文件,
 * 而消费本体的有三处**都不是 TUI**: MCP 的 `path_deliver`(executeSlice) 与 review 的 spec 轴
 * (findLatestSdd) —— 于是零 UI 的 stdio server 只为了一个函数就把整个 `pi-coding-agent` 拖进了
 * 自己的 import 图。
 *
 * 现在的约定: **`*-extension.ts` 只放 pi TUI 的门面**, 能力本体住在别处。这条约定由
 * `src/mcp/no-cli-dep.test.ts` 守着 (从 MCP 入口走 import 图, 命中 pi-coding-agent 即红)。
 *
 * 交接协议 (owner 定; 2026-07-25 plan mode 撤除后 SDD 文档是唯一规划产物入口):
 *   ① 取当前规划产物: docs/plan/ 最新 SDD (命名 YYYY-MM-DD-<slug>.md) → 没有则提示先写 SDD。
 *   ② SDD 文本作 task/契约喂 iterateExecutorDag (conductor 分解 → DAG 并行执行 → judge 收敛),
 *     每轮经 createDagRecorder 留痕。
 * 验收 brief 的**发射**是 TUI 那侧的事 (见 execute-extension.ts), 文本在 acceptanceInstructions()。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { iterateExecutorDag, type IterateResult } from './plan/iterate';
import { createDagRecorder } from './dag-record';
import { runExecutorDagWithPlan, type ExecutorDagResult, type GenerateFn } from './executor-dag';
import { resolveSeatThinking } from '../model/role-models';
import { parsePlan, type ConductorPlan } from './conductor-plan';
import type { VerifierFn } from './verifier';
import type { AgentLeafRunner, CommandLeafRunner } from './leaf-runners';
import { callModel, type ModelRequest, type ModelResponse } from '../model';
import { logger } from './logger';
import { tryResolveSeatModel } from '../model/role-models';

/**
 * D-8: conductor 模型的默认 = **'conductor' 座位** (单一 resolver, INV-MODEL-1)。
 *
 * 座位链自带这里原有的两层: OMD_ITER_CONDUCTOR_MODEL 是 env 层别名, OMD_RUNTIME_PROVIDER/MODEL 是
 * defaultModel 层 —— 只是现在 **config.models 压过它们** (P0 前反着, 于是改了 config 也不生效)。
 * D-8 的本意 (runtime 模型有全上下文, 更该当分解器) 由「config 没配 conductor 时回落 runtime 坐标」保住。
 * 返回 '' = 一层都没配 → caller 若真需 conductor 会自行报「conductorModel 必填」。
 */
export function resolveConductorDefault(): string {
  return tryResolveSeatModel('conductor')?.model ?? '';
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
    '- 加 verify 节点: 对正确性敏感的产出, 在末尾加一个 command 验证节点 (如',
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
    '  } } }',
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
  recorder?: {
    record: (res: ExecutorDagResult, meta?: { question?: string; runId?: string; entry?: string }) => string;
  };
  /**
   * 入口名 (进 `DagRunRecord.entry`)。`path_deliver` 传 `'path_deliver'`。
   * 省略 = 留 NULL,而不是编一个 —— 见 `DagRunRecord.entry` 的注。
   */
  entry?: string;
  /** 引擎 runId (进 `DagRunRecord.runId`,按它归组一次交付的账)。 */
  runId?: string;
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
    // S-T: 座位推理档随座位下发 (TUI 路径与 MCP 路径同源, 别只给一条路)。
    seatThinking: (coord: string) => resolveSeatThinking(coord),
    onComplete: opts.recorder
      ? (res) => {
          opts.recorder!.record(res, {
            question: `executeSlice ${finalPlan.name}`,
            ...(opts.entry ? { entry: opts.entry } : {}),
            ...(opts.runId ? { runId: opts.runId } : {}),
          });
        }
      : undefined,
  });
}
