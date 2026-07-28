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
import type { ExecutorDagConfig } from '../executor-dag-types';
import { logger } from '../logger';

/** D-5 轻重路由: simple = 直接 Execute→Verify→Accept; complex = 全 research→spec→execute。 */
export type GoalTier = 'simple' | 'complex';

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
  /** 强制档位; 省略 = 自动分类 (D-5)。 */
  tier?: GoalTier;
  /** spec 落盘目录 (默认 <cwd>/docs/plan)。 */
  specDir?: string;
  /** 日期串 (spec 文件名)。测试注入; 默认今天 YYYY-MM-DD。 */
  _today?: () => string;
  /** 注入式分类器 (测试 / 自定义)。 */
  _classify?: (goal: string) => Promise<GoalTier>;
  /** 注入式 execute 阶段 (测试传 fake, 不碰 live 模型)。 */
  _iterate?: typeof iterateExecutorDag;
}

export interface RunGoalResult {
  goal: string;
  tier: GoalTier;
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
 * D-5 分类器。承 router 原语的形状 (一次分类调用 + 只回 label), 但**失败方向相反**:
 * router 原语分类落空是 fail-closed 抛错 (它在一张图中间, 乱选一支会污染下游);
 * 这里落空回落 `complex` —— 保守档跑的是"多做一遍接地", 代价是钱; 而误判成 simple 的代价是
 * 一个没有证据的 spec 被当契约执行。两边不对称, 所以不对称地兜。
 */
async function classifyGoal(goal: string, config: RunGoalConfig): Promise<GoalTier> {
  const generate = config.dag.generate;
  const model = config.dag.conductorModel;
  if (!generate || !model) return 'complex';
  try {
    const { text } = await generate({
      model,
      messages: [
        {
          role: 'user',
          content:
            '把下面这个目标分类到 simple / complex 之一, 只回该词。\n' +
            'simple = 做法已经确定、验收可机器判 (改一处代码 / 加一个测试 / 重命名);\n' +
            'complex = 需要先查外部事实或先定契约 (选型 / 新机制 / 跨模块设计)。\n\n' +
            `目标: ${goal}\n\n只回一个词。`,
        },
      ],
      maxTokens: 16,
    });
    const norm = text.trim().toLowerCase();
    if (norm.includes('simple')) return 'simple';
    if (norm.includes('complex')) return 'complex';
    logger.warn({ goal, reply: text.slice(0, 60) }, '[omd/goal] 分类未匹配 → 回落 complex (保守档)');
    return 'complex';
  } catch (err) {
    logger.warn({ err: String(err) }, '[omd/goal] 分类调用失败 → 回落 complex (保守档)');
    return 'complex';
  }
}

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

  // ── S0/S-classify: 轻重路由 (D-5) ────────────────────────────────
  const tier = config.tier ?? (await (config._classify ?? ((g: string) => classifyGoal(g, config)))(goal));
  stages.push({ stage: 'classify', status: 'done', summary: `tier=${tier}` });

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
            '输出: 每条一行 `file:line — 事实`; 找不到相关实现就明说"仓内无既有实现", 不要编。',
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
  const task = specPath
    ? `按下面这份 SDD 契约实施 (契约全文已落盘 ${specPath}):\n\n${evidence}`
    : evidence
      ? `${goal}\n\n参考材料:\n${evidence}`
      : goal;
  const iterate = config._iterate ?? iterateExecutorDag;
  let exec: IterateResult;
  try {
    exec = await iterate(task, { ...config.dag, maxRounds: config.maxRounds ?? 2 });
  } catch (err) {
    stages.push({ stage: 'execute', status: 'failed', summary: `execute 抛错: ${String(err).slice(0, 200)}` });
    return { goal, tier, stages, ...(specPath ? { specPath } : {}), sources, repoContext, converged: false, rounds: 0, reusedNodes: [] };
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
    stages,
    ...(specPath ? { specPath } : {}),
    sources,
    repoContext,
    converged: exec.converged,
    rounds: roundCount,
    reusedNodes,
  };
}
