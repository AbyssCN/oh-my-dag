/**
 * goal/run-goal —— 自主 goal 引擎的**薄竖切** (SDD 2026-07-28 omd-goal-engine, P1 / D-9)。
 *
 * 一个 goal 进来, 自主走完 research → spec → execute → verify → 1 轮修复, 阶段间零人工介入
 * (INV-GOAL-1)。它替代的是手动技能链 `/omd-research-deep → /omd-grill → /omd-sdd → /omd-execute`。
 *
 * **外层严格无环** (D-2): 这里是一条固定的阶段序列, 不画回边; 唯一的"环"是 execute 阶段内部的
 * fixpoint (iterateExecutorDag), 它封在节点内且有轮数上限 —— INV-GOAL-4。
 *
 * 为什么阶段序列是**编排代码**而不是一张 DAG: execute 阶段本身要 conductor 现场分解出一整张子图,
 * 那不是"一个节点"。把外层写成三次显式调用, 比造一个能孵化子图的节点类型诚实得多 (D-1: 用 OMD
 * 自己的 executor 当 runtime, 不引第二套编排语义)。
 */
import { join } from 'node:path';
import { iterateExecutorDag, type IterateResult } from '../plan/iterate';
import { loadAgentTemplates } from '../agent-templates';
import { classifyGoal, renderAcceptance, type AcceptanceSpec, type GoalClassification, type GoalTier } from './acceptance';
import type { ExecutorDagConfig } from '../executor-dag-types';

// D-I: 两条轴的类型与分类器都归 ./acceptance (那里是判据轴的单一真源); 此处 re-export 保旧调用面。
export type { AcceptanceSpec, GoalClassification, GoalTier } from './acceptance';

export type GoalStageName = 'classify' | 'survey' | 'research' | 'spec' | 'execute';

export interface GoalStage {
  stage: GoalStageName;
  status: 'done' | 'failed' | 'skipped';
  /** 一行人可读结论 (失败原因 / 跳过理由 / 产物指针)。 */
  summary: string;
}

export interface RunGoalConfig {
  cwd: string;
  /** 引擎 config 基座 (座位 + agent/command/research runner)。execute 阶段直接用它。 */
  dag: ExecutorDagConfig;
  /** execute 阶段总轮数上限 (1 轮修复 = 2)。默认 2 —— D-9 薄竖切就是"一轮修复"。 */
  maxRounds?: number;
  /** research 节点内环轮数 (有界, INV-GOAL-4)。默认 1。 */
  researchRounds?: number;
  /** 强制档位 (成本轴); 省略 = 自动分类 (D-5)。**不覆盖判据轴** —— 验收分型仍照跑 (D-I)。 */
  tier?: GoalTier;
  /** 强制验收分型 (判据轴, D-I); 省略 = 自动分类。 */
  acceptance?: AcceptanceSpec;
  /** spec 落盘目录 (默认 <cwd>/docs/plan)。 */
  specDir?: string;
  /** 日期串 (spec 文件名)。测试注入; 默认今天 YYYY-MM-DD。 */
  _today?: () => string;
  /** 注入式分类器 (测试 / 自定义): 一次出两条轴 (D-I)。 */
  _classify?: (goal: string) => Promise<GoalClassification>;
  /** 注入式 execute 阶段 (测试传 fake, 不碰 live 模型)。 */
  _iterate?: typeof iterateExecutorDag;
}

export interface RunGoalResult {
  goal: string;
  tier: GoalTier;
  /** D-I 验收分型 + 冻结的判卷标准 (执行型带可跑命令; 探索型带学习目标 + 可承受损失)。 */
  acceptance: AcceptanceSpec;
  stages: GoalStage[];
  /** spec 落盘路径 (simple 档 / 无 agentRunner → undefined)。 */
  specPath?: string;
  /** research 阶段真抓到正文的 URL (INV-GOAL-2 证据面)。 */
  sources: string[];
  /** 仓内勘察结论 (survey 阶段产出; 跳过则空串)。 */
  repoContext: string;
  /** execute 阶段是否收敛 (judge 判过)。 */
  converged: boolean;
  /** execute 阶段实跑轮数。 */
  rounds: number;
  /** 修复轮里被复用的节点 (INV-GOAL-3 可证面; 单轮收敛 = 空)。 */
  reusedNodes: string[];
}

/** kebab-case slug (spec 文件名用); 非字母数字折成 '-', 截断 48。 */
export function goalSlug(goal: string): string {
  const s = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'goal';
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);

/**
 * 跑一个 goal 到底 (INV-GOAL-1)。
 *
 * @returns 每阶段的结论 + spec 路径 + 证据 URL + 收敛情况。**失败不抛** —— 阶段级失败记在
 *   stages 里往下走 (execute 阶段仍会拿到手上有的东西), 调用方按 stages 判要不要人接手。
 */
export async function runGoal(goal: string, config: RunGoalConfig): Promise<RunGoalResult> {
  const stages: GoalStage[] = [];
  const sources: string[] = [];
  let specPath: string | undefined;
  let evidence = '';
  let repoContext = '';

  // ── S0/S-classify: 轻重路由 (D-5, 成本轴) + **验收分型** (D-I, 判据轴) ──────────
  //
  // 一次调用出两条轴。显式配置各自压过分类结果 —— 但 `tier` 只压成本轴, 压不到判据轴:
  // "我知道这活儿轻" 与 "我知道这活儿怎么判" 是两句不同的话, 说了前一句不等于说了后一句。
  const classified = await (config._classify ?? ((g: string) => classifyGoal(g, { generate: config.dag.generate, model: config.dag.conductorModel })))(goal);
  const tier = config.tier ?? classified.tier;
  const acceptance = config.acceptance ?? classified.acceptance;
  stages.push({
    stage: 'classify',
    // 判成执行型却拿不到可跑命令时, 分类器已降级成探索型 (acceptance.ts 的 fallbackExploratory)
    // 并把原因写进 learningGoal —— 这里把它抬成 stage 摘要, 别让降级只活在日志里。
    status: 'done',
    summary:
      acceptance.kind === 'executable'
        ? `tier=${tier} · 验收=执行型 \`${acceptance.command}\` (期望退出码 ${acceptance.expectExit})`
        : `tier=${tier} · 验收=探索型 · 学习目标: ${acceptance.learningGoal.slice(0, 120)}`,
  });
  // 冻结的判卷标准: 同一份文本进 spec 起草与 execute 任务文本 (两处各写一份就会漂,
  // 而"判据漂了"正是作弊达标最舒服的入口)。
  const acceptanceBlock = renderAcceptance(acceptance);

  if (tier === 'complex') {
    // ── S0.5 Survey (仓内勘察): **agent 节点只读跑一趟仓库**, 产出当 research 的锚点 + spec 的仓内事实。
    //
    // 为什么必须有这一站: research 节点是 inproc 扇出 (无工具, 只能读喂给它的语料), agent 节点反过来
    // (有全套读写工具, 无 web)。两边能力互补但**互相看不见** —— 少了这一步, research 就是在不知道
    // "我们仓里已经有什么"的前提下去查外面, 查回来的东西没法跟既有实现对齐, spec 也就只能凭空写。
    // 图级组合本来就能表达 (agent 读仓 → research → agent 改码), 这里是把它固化进自主管线。
    if (config.dag.agentRunner) {
      try {
        const r = await config.dag.agentRunner({
          prompt: [
            '你是仓内勘察员。**只读不改**: 不要动任何文件, 不要跑会改状态的命令。',
            `目标: ${goal}`,
            '任务: 找出这个目标在**本仓**里的落点与既有实现 —— 相关模块/文件、已有的同类机制、',
            '会被影响的接缝、以及仓内已经定过的相关约定 (契约/SDD/注释里的裁决)。',
            '',
            // 输出形状刻意与 DEFAULT_FANIN_SCHEMA 对位 (tldr / key_points / **artifacts** / open_questions):
            // survey 将来变成图节点后, 它的输出会经 fan-in **定向摘要**喂给下游。摘要器只对 `artifacts`
            // 那一类"产物锚"逐字保留, 其余一律压成散文 —— 而本节点最值钱的恰恰是 `file:line` 这种锚。
            // 更要命的是下游 research 是 **inproc 无工具**: 摘要视图附的"全文在 <path>, 需要细节自己 Read"
            // 那条逃生口对它是废的, 压丢了就找不回来。所以这里先把事实钉进锚区, 而不是散在正文里。
            '## 输出格式 (严格照此三段, 不要加别的段)',
            '### 事实 (逐条一行, 格式 `file:line — 事实`)',
            '这一段是本次勘察的**产物锚**: 下游据它决定改哪里。只写你真读到的行, 一行一条。',
            '### 结论 (1-3 句)',
            '这个目标在本仓的落点是什么、有没有同类机制可复用。',
            '### 存疑 (无则写"无")',
            '看不准的接缝 / 相互矛盾的约定 / 没覆盖到的地方。',
            '',
            '找不到相关实现就在「事实」段写"仓内无既有实现", 不要编。',
            '这份结论会当作事实锚喂给后续的外部调研与契约起草 —— 编造的一行会污染整条链。',
          ].join('\n'),
          model: config.dag.agentLeafModel ?? config.dag.leafModel,
        });
        repoContext = r.text.trim();
        stages.push({
          stage: 'survey',
          status: repoContext ? 'done' : 'failed',
          summary: repoContext ? `${repoContext.split('\n').length} 行仓内事实` : 'survey 空输出',
        });
      } catch (err) {
        stages.push({ stage: 'survey', status: 'failed', summary: `survey 抛错: ${String(err).slice(0, 200)}` });
      }
    } else {
      stages.push({ stage: 'survey', status: 'skipped', summary: '无 agentRunner → 无仓内事实' });
    }

    // ── S1 Research: 真 web (D-6)。无 runner = 没有 web 能力 → 跳过并留痕, 不假装研究过。
    if (config.dag.researchRunner) {
      try {
        const r = await config.dag.researchRunner({
          question: goal,
          // 仓内勘察结论当事实锚 (research 的 leaf 是 inproc, 看不见仓库 —— 只能这么喂进去)。
          ...(repoContext ? { groundTruth: repoContext } : {}),
          rounds: config.researchRounds ?? 1,
        });
        sources.push(...r.sources);
        evidence = r.text;
        stages.push({
          stage: 'research',
          status: r.sources.length > 0 ? 'done' : 'failed',
          summary:
            r.sources.length > 0
              ? `${r.sources.length} 个来源真抓到正文${r.reportPath ? ` · ${r.reportPath}` : ''}`
              : '零来源 — 无真抓取痕迹, 该结果不当证据用',
        });
        // 零来源 = 假 grounded, 不进 spec 的证据段 (与 research 节点闸同一判据)。
        if (r.sources.length === 0) evidence = '';
      } catch (err) {
        stages.push({ stage: 'research', status: 'failed', summary: `research 抛错: ${String(err).slice(0, 200)}` });
      }
    } else {
      stages.push({
        stage: 'research',
        status: 'skipped',
        summary: '无 researchRunner (未配 search provider) → 本次 goal 没有外部证据',
      });
    }

    // ── S3 PlanSpec: spec-author 卡写 SDD 落盘 (D-7)。
    if (config.dag.agentRunner) {
      const tpl = loadAgentTemplates({ root: config.cwd }).get('spec-author');
      const dir = config.specDir ?? join(config.cwd, 'docs', 'plan');
      const path = join(dir, `${(config._today ?? todayStr)()}-${goalSlug(goal)}.md`);
      const prompt = [
        tpl?.body ?? '把目标结晶成一份可执行的 SDD 契约。',
        '',
        `## 目标\n${goal}`,
        // 两个证据源分开标: 仓内事实是"我们已经有什么", 研究证据是"外面怎么做" —— 混在一起
        // 会让起草者分不清哪条能直接落地、哪条要先适配。
        repoContext
          ? `\n## 仓内事实 (只读勘察, file:line)\n${repoContext}`
          : '\n## 仓内事实\n(未勘察 — 任何关于"仓里已有什么"的断言都必须进「未决」段, 不许凭印象写)',
        evidence ? `\n## 研究证据 (真 web, 来源见下)\n${evidence}\n\n来源:\n${sources.map((u) => `- ${u}`).join('\n')}` : '\n## 研究证据\n(本次无外部证据 — 只能依据仓内事实; 任何需要外部事实支撑的决策必须进「未决」段)',
        // D-I: 判卷标准在起草**之前**就已冻结, 起草者的活是把它写进契约的验收段并据它拆步骤,
        // 不是重新发明一套自己够得着的判据。
        `\n${acceptanceBlock}`,
        `\n## 落盘路径 (写到这里)\n${path}`,
      ].join('\n');
      try {
        const r = await config.dag.agentRunner({ prompt, model: config.dag.agentLeafModel ?? config.dag.leafModel });
        const wrote = (r.filesTouched ?? []).some((f) => f.endsWith(`${goalSlug(goal)}.md`));
        specPath = wrote ? path : undefined;
        stages.push({
          stage: 'spec',
          // 没真写盘 = 只吐了文本 —— 记 failed 但不断流程 (下游拿 r.text 当契约仍能跑)。
          status: wrote ? 'done' : 'failed',
          summary: wrote ? path : 'spec 未落盘 (agent 只吐了文本), 下游改用其正文当契约',
        });
        evidence = r.text || evidence;
      } catch (err) {
        stages.push({ stage: 'spec', status: 'failed', summary: `spec 抛错: ${String(err).slice(0, 200)}` });
      }
    } else {
      stages.push({ stage: 'spec', status: 'skipped', summary: '无 agentRunner → 不产 spec, 直接执行目标' });
    }
  } else {
    stages.push({ stage: 'research', status: 'skipped', summary: 'simple 档: 直接 Execute→Verify (D-5)' });
    stages.push({ stage: 'spec', status: 'skipped', summary: 'simple 档: 无需先定契约 (D-5)' });
  }

  // ── S5-S8 Execute + Verify + 1 轮修复: 内层 DAG 的外层 fixpoint。
  // task = spec 全文 (有则) 否则 goal 本身; 执行器读到的是契约, 不是对话。
  //
  // D-I: 判卷标准**无条件**附在任务文本末尾 —— 包括 simple 档 (它不产 spec, 判据没有别的落点)
  // 与 spec 未落盘的降级路径。conductor 据它把验收命令连成图里一个 executor:'command' 节点;
  // 探索型则据它知道"这次没有机器判据"从而不去伪造一个。
  const body = specPath
    ? `按下面这份 SDD 契约实施 (契约全文已落盘 ${specPath}):\n\n${evidence}`
    : evidence
      ? `${goal}\n\n参考材料:\n${evidence}`
      : goal;
  const task = `${body}\n\n${acceptanceBlock}`;
  const iterate = config._iterate ?? iterateExecutorDag;
  let exec: IterateResult;
  try {
    exec = await iterate(task, { ...config.dag, maxRounds: config.maxRounds ?? 2 });
  } catch (err) {
    stages.push({ stage: 'execute', status: 'failed', summary: `execute 抛错: ${String(err).slice(0, 200)}` });
    return { goal, tier, acceptance, stages, ...(specPath ? { specPath } : {}), sources, repoContext, converged: false, rounds: 0, reusedNodes: [] };
  }
  // 复用面取**最后一轮** (INV-GOAL-3 问的是"修复轮复用了多少", 首轮恒 0)。
  const reusedNodes = exec.finalRound?.result?.reusedNodes ?? [];
  const roundCount = exec.rounds.length;
  stages.push({
    stage: 'execute',
    status: exec.converged ? 'done' : 'failed',
    summary: `${roundCount} 轮${exec.converged ? '收敛' : `未收敛 (${exec.status})`}${reusedNodes.length ? ` · 复用 ${reusedNodes.length} 节点` : ''}`,
  });

  return {
    goal,
    tier,
    acceptance,
    stages,
    ...(specPath ? { specPath } : {}),
    sources,
    repoContext,
    converged: exec.converged,
    rounds: roundCount,
    reusedNodes,
  };
}
