/**
 * goal/run-goal —— 自主 goal 引擎的**薄竖切** (SDD 2026-07-28 omd-goal-engine, P1 / D-9)。
 *
 * 一个 goal 进来, 自主走完 research → spec → execute → verify → 1 轮修复, 阶段间零人工介入
 * (INV-GOAL-1)。它替代的是手动技能链 `/omd-research-deep → /omd-grill → /omd-contract → /omd-execute`。
 *
 * **外层严格无环** (D-2): 这里是一条固定的阶段序列, 不画回边。
 *
 * **D-F (2026-07-30): 外层 fixpoint 已撤**。此前 execute 段走 `iterateExecutorDag` —— 一层 run 级
 * 的环 (重画整张内层图) 套着节点内可能存在的另一层。P1 的 double-loop 教训是两层 verify 必须
 * 二选一 (成本翻倍 + 谁负责收敛语义打架), D-A 定的是**留节点内那一层**。于是现在两段都是
 * 一个 `executor:'conductor'` 节点:
 *
 *   契约段 `goal-contract` (specRounds) · 执行段 `goal-execute` (maxRounds)
 *
 * 环因此封在节点内且有轮数上限 (INV-GOAL-4), 状态 (轮次/毒集/上轮原因) 落**节点级** journal
 * `_loop-<nodeId>.json` —— run 级 `_fixpoint.json` 在这条路上不再被写也不再被读 (概念没删,
 * 是从 run 级降到了节点级; 删掉它等于把"被拒产出借崩溃复活"那个缺陷换个方式重新引入)。
 *
 * ⚠ 撤外层的代价记在 `judge_final` 上: 内环 judge 判的是**一个节点的 goal**, 而执行段那个节点的
 * goal 就是整个任务, 所以「整体目标成了吗」仍有人问 —— 但只有 `judge_final:true` 才在最后一轮
 * 真去问。别把它当成可省的旋钮。
 *
 * 为什么阶段序列仍是**编排代码**而不是一张 DAG: 判卷标准 (D-I) 必须留在环外, 它是在 classify 段
 * 算好后冻进两个节点的输入的 —— 让它进图就等于让执行体自己的环去产出判据 (D-J 整套防作弊的地基
 * 就是"判卷标准是执行体动不了的东西")。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../executor-dag';
import { makeDefaultGenerate } from '../executor-dag-defaults';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult } from '../executor-dag-types';
import { classifyGoal, renderAcceptance, type AcceptanceSpec, type GoalClassification, type GoalTier } from './classify-acceptance';
import type { RunOutcomeKind } from '../run-outcome';
import type { ExecutorDagConfig } from '../executor-dag-types';

// D-I: 两条轴的类型与分类器都归 ./acceptance (那里是判据轴的单一真源); 此处 re-export 保旧调用面。
export type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';

export type GoalStageName = 'classify' | 'survey' | 'research' | 'spec' | 'execute';

export interface GoalStage {
  stage: GoalStageName;
  status: 'done' | 'failed' | 'skipped';
  /**
   * **这一步是怎么结束的** (N5, 2026-07-31)。`status` 一字未动, 这是**加的那一位**。
   *
   * 治的是 2026-07-31 第二跑 live 抓到的那行: 一次判定正确的 BLOCKED 被 `status` 念成 `failed`
   * (`[failed] execute — 2 轮阻塞…`), 而同一份摘要底下另一行写着"阻塞(需外部输入)" ——
   * 同一份输出里两行互相打架。词表与判据在 {@link RunOutcomeKind}。
   */
  outcome: RunOutcomeKind;
  /** 一行人可读结论 (失败原因 / 跳过理由 / 产物指针)。 */
  summary: string;
}

export interface RunGoalConfig {
  cwd: string;
  /** 引擎 config 基座 (座位 + agent/command/research runner)。execute 阶段直接用它。 */
  dag: ExecutorDagConfig;
  /**
   * execute 段 conductor 节点的**内环**轮数上限 (1 轮修复 = 2)。默认 2 —— D-9 薄竖切就是"一轮修复"。
   * 上限 4 (schema 钳)。轮的语义是**逐轮重展开**, 不是重跑同一张子图。
   */
  maxRounds?: number;
  /** research 节点内环轮数 (有界, INV-GOAL-4)。默认 1。 */
  researchRounds?: number;
  /**
   * 契约段 (survey/research/spec 那个 conductor 节点) 的内环轮数。默认 1 = 只画一次。
   * >1 才启用**补调研**: 契约写完若判未达成, 下一轮重画时可以长出一个上一轮没有的调研步 (D-G′/D-A)。
   */
  specRounds?: number;
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
  /**
   * 分类定稿回调 (判据轴证据钩子): 分类成功 (含降级 / fail-open / 探索型) 后**恰好调一次**,
   * 在 `_runDag` 与任何运行记录之前 —— 调用方可在此持久化探针裁决 (`acceptanceProbe`)。
   * 分类器抛错时**不调** (那时没有定稿的分类可持久化)。
   */
  onClassified?: (classified: GoalClassification) => void;
  /**
   * 注入式 DAG 执行 (测试传 fake; 默认 runExecutorDagWithPlan)。
   * **契约段与执行段共用这一个注入口** —— 两段都是一张单 conductor 节点的图 (D-F),
   * 靠 `plan.name` (`goal-contract` / `goal-execute`) 分辨是谁在调。
   */
  _runDag?: (plan: ConductorPlan, config: RunGoalConfig['dag']) => Promise<ExecutorDagResult>;
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
  /**
   * **这一趟 goal 是怎么结束的** (N5, 2026-07-31)。词表与每格的下一步在 {@link RunOutcomeKind}。
   *
   * 与 `converged` 的关系: `converged` 只答"成没成"这一位, 而没成的那一侧此前要靠调用方
   * 自己去看 `blocked` / `budgetStopped` / `cancelled` 三个可选字段**有没有值**来拼 ——
   * 拼错的成本已经见过: 一次正确的 BLOCKED 被念成 failed。这一位把那次拼装收成一处。
   *
   * 恒等于最后那个 execute 阶段的 `outcome` (goal 就是以它收尾的)。
   */
  outcome: RunOutcomeKind;
  /**
   * **两条判据各自说了什么**(N9, 2026-07-31)。`judge` = 收敛判据(judge 判词);
   * `oracle` = 冻结判据(可执行验收命令的退出码;判据不是可执行式时恒 true)。
   *
   * 为什么要把两个布尔单独暴露, 而不是让调用方从 {@link outcome} 反推:**反推不出来**。
   * 上面那段 outcome 的算式里, `judge` 为假时一律落 `not-converged` ——
   * **不管 `oracle` 是什么**。于是「judge 说没收敛、而冻结判据其实过了」(= 白转了几轮)
   * 这一格在词表上根本不存在, 两个布尔算完就被扔了。
   *
   * 而那一格恰恰是「收敛判据可不可信」的另一半证据: 只看 `oracle-failed` 只能发现 judge 太松,
   * 发现不了 judge 太紧。两侧都要看得见, 这条轴才是对称的。
   *
   * 契约段就结束(没跑 execute)→ 缺席, 不编 —— 那时两条判据一条都没判过。
   */
  criteria?: { judge: boolean; oracle: boolean };
  /**
   * **BLOCKED 异步出口** (D-Q): 环判定"没有外部输入推不动"而提前退出的原因。
   * 与 `converged: false` 的区别是**该怎么办**: 未收敛 = 轮数用尽/judge 说没达标, 再给几轮可能就成;
   * blocked = 判据是确定性的 (环空转 / 检测者喊停), 再给多少轮都一样, 该由 owner 看一眼。
   * 恒与 `converged: false` 同时出现。
   */
  blocked?: string;
  /**
   * **环因预算停的** (2026-07-31, Loop Engineering 第四条停止轴)。与 `blocked` 分开的理由是
   * **下一步不一样**: blocked = 再多轮都一样, 该 owner 看; budgetStopped = 加预算 resume 很可能就成。
   * 恒与 `converged: false` 同时出现。
   */
  budgetStopped?: string;
  /**
   * **协作式取消** (D-P) 的原因。给了 = 这次是被叫停的, 不是跑完的 —— 已跑完的节点与轮次
   * 全在盘上, `dag_goal resume=<同一个 runId>` 接着跑。
   */
  cancelled?: string;
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
  // ⚠ `generate` 必须**回落到引擎的默认实现**, 不能只读 config.dag.generate ——
  // 后者是**注入口** (测试传 fake), 生产从来不设它 (`runExecutorDag` 自己 `?? makeDefaultGenerate`)。
  // 只读它的后果是: 生产每一次 dag_goal 都拿不到分类器 → 静默降级成探索型 → **D-I 的执行型验收
  // (那条强制可跑命令) 在真实路径上从未成立过**。2026-07-30 第一次 live 冒烟才看见这行:
  //   「验收分型未成立: 无分类器 (缺 generate/model)」
  // ——机制在、测试全绿、生产零生效, 正是这仓一直在杀的空旋钮形态, 而这次空掉的是防作弊的地基。
  const classified = await (config._classify ??
    ((g: string) =>
      classifyGoal(g, {
        generate: config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID()),
        model: config.dag.conductorModel,
        // **空世界自检** (2026-07-31, G4): 活还没干之前先跑一遍判出的验收命令 —— 这时候就过 =
        // 它区分不了"做完了"与"还没做"。给不给 runner 决定这层加固在不在, 与 `generate` 那条
        // 教训同源: 只在测试里接、生产不接, 就是又一个"机制在、生产零生效"的空旋钮。
        ...(config.dag.commandRunner ? { runCommand: config.dag.commandRunner } : {}),
      })))(goal);
  // 探针裁决钩子: 分类定稿后恰好调一次 (含 fallback / 探索型), 进 `_runDag` 与任何运行记录之前。
  // `_classify` 抛错时这行到不了 → 天然不调, 不存在"抛错也硬调"的路径。
  config.onClassified?.(classified);
  const tier = config.tier ?? classified.tier;
  const acceptance = config.acceptance ?? classified.acceptance;
  stages.push({
    stage: 'classify',
    // 判成执行型却拿不到可跑命令时, 分类器已降级成探索型 (acceptance.ts 的 fallbackExploratory)
    // 并把原因写进 learningGoal —— 这里把它抬成 stage 摘要, 别让降级只活在日志里。
    status: 'done',
    // 分类器降级 (判执行型却拿不到可跑命令) **不记 empty-result**: 它照样产出了一份可用的判据轴,
    // 只是换了一型。记成"空手而归"会让读数板把一次正常的探索型分类数成缺陷。
    outcome: 'success',
    summary:
      acceptance.kind === 'executable'
        ? `tier=${tier} · 验收=执行型 \`${acceptance.command}\` (期望退出码 ${acceptance.expectExit})`
        : `tier=${tier} · 验收=探索型 · 学习目标: ${acceptance.learningGoal.slice(0, 120)}`,
  });
  // 冻结的判卷标准: 同一份文本进 spec 起草与 execute 任务文本 (两处各写一份就会漂,
  // 而"判据漂了"正是作弊达标最舒服的入口)。
  const acceptanceBlock = renderAcceptance(acceptance);

  if (tier === 'complex') {
    // ── S0.5–S3 契约段 (D-G′, 2026-07-29): 勘察 → 调研 → 起草 **合成一个 `executor:'conductor'` 节点**。
    //
    // 推翻的是「预构造这三个节点」: 静态图表达不了"要不要先查外面"这个分支 —— 而 conductor 节点的
    // **展开调用本身**就是那次判断 (它看着 goal 与仓内情况决定吐哪几步), 分支不需要显式表达。
    // 更值钱的是**补调研**: `max_rounds > 1` 时环是**逐轮重展开**, 于是"契约写完发现证据不够"可以在
    // 第 2 轮长出一个第 1 轮压根没有的调研步 —— 不需要回边 (每轮都是一张全新的无环子图)。
    //
    // ⚠ **判卷标准刻意留在这个节点之外** (owner 定, 方案 A): 它由 classify 在环外算好, 冻进节点的
    // goal 当输入。放进子图就等于让**执行体自己的环**去产出判据 —— 而环每轮都重画, 判据也就跟着能变。
    // D-I 整套防作弊的地基就是那一句「判卷标准是执行体动不了的东西」, 判据进环这句话就没了。
    // (两条轴本来就是分开的: 成本轴"要不要接地"交给 conductor 判, 判据轴"成没成怎么判"绝不下放。)
    if (config.dag.agentRunner) {
      const dir = config.specDir ?? join(config.cwd, 'docs', 'plan');
      const path = join(dir, `${(config._today ?? todayStr)()}-${goalSlug(goal)}.md`);
      const prepPlan: ConductorPlan = {
        name: 'goal-contract',
        nodes: {
          contract: {
            executor: 'conductor',
            ...(config.specRounds && config.specRounds > 1 ? { max_rounds: config.specRounds } : {}),
            goal: [
              `为下面这个目标产出一份**可执行的 SDD 契约**, 落盘到 ${path}。`,
              '',
              `## 目标\n${goal}`,
              '',
              '## 你要分解出的步骤 (按需, 不是必须全有)',
              '- **仓内勘察** (`executor:"agent"`, 只读): 找出目标在本仓的落点与既有实现, 输出逐行',
              '  `file:line — 事实`。没有这一步, 后面的调研与起草就是在不知道"我们已经有什么"的前提下进行。',
              '- **外部调研** (`executor:"research"`): **只在需要外部事实时才加** (选型 / 新机制 / 别人怎么做)。',
              '  仓内答得出来的问题别用它 —— 它抓不到一个真页面就会失败。',
              // researchRounds 是公开旋钮 (dag_goal 的入参)。合并成子图之后, 它只能经这句话传下去 ——
              // 不传就成了一个"配了但不生效"的空旋钮, 正是这仓一直在杀的形态。
              `  调研深度已定: 该节点必须写 \`"research": { "rounds": ${config.researchRounds ?? 1} }\`。`,
              '- **契约起草** (`executor:"agent"`, `template:"spec-author"`, `output_type:"file"`,',
              `  \`output_path:"${path}"\`): 必须用那张卡, 它带着契约骨架与防作弊条款。`,
              '  它要 depends_on 上面那些步骤 —— 拿不到事实就只能凭空写。',
              '',
              // D-I 方案 A: 判据在这里是**输入**, 不是待办。
              acceptanceBlock,
              '',
              '起草者的活是把上面这份判卷标准**原样写进契约的验收段**并据它拆实施步骤 ——',
              '**不是**重新发明一套自己够得着的判据。它在你开始之前就已经定死了。',
            ].join('\n'),
          },
        },
      } as ConductorPlan;
      try {
        // 独立 runId 后缀: 与 execute 段共用 runId 会让两张不同的图互相覆盖 `_dag.json`。
        // 后缀是确定性的 → `dag_goal resume=<runId>` 照样接得回这一段。
        const dagCfg = config.dag.continuity
          ? { ...config.dag, continuity: { ...config.dag.continuity, runId: `${config.dag.continuity.runId}-contract` } }
          : config.dag;
        const res = await (config._runDag ?? runExecutorDagWithPlan)(prepPlan, dagCfg);
        const leaf = res.results.contract;
        const touched = leaf?.filesTouched ?? [];
        const wrote = touched.some((f) => f.endsWith(`${goalSlug(goal)}.md`));
        specPath = wrote ? path : undefined;
        // 子节点里认出各段, 只为把结论如实抬进 stages (给人看的那一面不该因为合并成一个节点而变糊)。
        // **「压根没这一步」与「跑了但空手而归」要分开记** —— 合成一个 skipped 就把后者藏起来了,
        // 而后者才是需要人看一眼的那种 (勘察跑了却什么都没找到 ≠ 这次不需要勘察)。
        const kids = Object.entries(res.results).filter(([k]) => k.startsWith('contract::'));
        const researched = kids.filter(([, r]) => r.kind === 'research');
        sources.push(...researched.flatMap(([, r]) => r.sources ?? []));
        // 勘察步 = 有工具但没写文件的 agent 子节点 (起草步会写文件, 据此区分)。
        const surveyKid = kids.find(([, r]) => r.kind === 'agent' && !(r.filesTouched ?? []).length)?.[1];
        repoContext = surveyKid?.output?.trim() ?? '';
        evidence = leaf?.output ?? '';
        stages.push({
          stage: 'survey',
          status: !surveyKid ? 'skipped' : repoContext ? 'done' : 'failed',
          // N5 的原型对: 这两格 **status 都是"没成"那一侧, outcome 相反** ——
          // 「conductor 没分解出勘察步」= 它判定不需要 (什么都不用做);
          // 「勘察步跑了但空输出」= 需要人看一眼。旧的 skipped|failed 二选一恰好把这一对压扁过。
          outcome: !surveyKid ? 'not-needed' : repoContext ? 'success' : 'empty-result',
          summary: !surveyKid
            ? 'conductor 未分解出勘察步'
            : repoContext
              ? `${repoContext.split('\n').length} 行仓内事实`
              : '勘察步空输出 (跑了但什么都没找到 — 与"不需要勘察"不是一回事)',
        });
        stages.push({
          stage: 'research',
          status: researched.length === 0 ? 'skipped' : sources.length > 0 ? 'done' : 'failed',
          // 同上那一对: 「判无需外部调研」≠「调研跑了零来源」。后者在节点级是 no-sources,
          // 在 stage 级与勘察空输出同一个下一步 (重跑/换检索式) → 并进 empty-result。
          outcome: researched.length === 0 ? 'not-needed' : sources.length > 0 ? 'success' : 'empty-result',
          summary:
            researched.length === 0
              ? 'conductor 判定无需外部调研 (D-G′: 这个分支现在由它自己判)'
              : sources.length > 0
                ? `${sources.length} 个来源真抓到正文`
                : '零来源 — 无真抓取痕迹, 该结果不当证据用',
        });
        stages.push({
          stage: 'spec',
          // 没真写盘 = 只吐了文本 —— 记 failed 但不断流程 (下游拿正文当契约仍能跑)。
          status: wrote ? 'done' : 'failed',
          outcome: wrote ? 'success' : 'empty-result',
          summary: wrote ? path : 'spec 未落盘 (契约段没产出文件), 下游改用其正文当契约',
        });
      } catch (err) {
        // 抛错 = 引擎自己出事, 与"契约写了但没达标"是两回事 (ERROR vs STALLED)。
        stages.push({ stage: 'spec', status: 'failed', outcome: 'infra-error', summary: `契约段抛错: ${String(err).slice(0, 200)}` });
      }
    } else {
      // 缺件跳过与"不需要"跳过共用 status: 'skipped', 而下一步相反 (补配置 vs 什么都不用做)。
      stages.push({ stage: 'survey', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 无仓内事实' });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 契约段整体跳过' });
      stages.push({ stage: 'spec', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 不产 spec, 直接执行目标' });
    }
  } else {
    stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: 'simple 档: 直接 Execute→Verify (D-5)' });
    stages.push({ stage: 'spec', status: 'skipped', outcome: 'not-needed', summary: 'simple 档: 无需先定契约 (D-5)' });
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
  // 成因由**调用点**给, 不在这里按 summary 文本猜 —— 猜就是又一处会漂的独立判断 (P1 为它付过账)。
  const bail = (summary: string, outcome: RunOutcomeKind): RunGoalResult => {
    stages.push({ stage: 'execute', status: 'failed', outcome, summary });
    return { goal, tier, acceptance, stages, ...(specPath ? { specPath } : {}), sources, repoContext, converged: false, rounds: 0, reusedNodes: [], outcome };
  };
  const execPlan: ConductorPlan = {
    name: 'goal-execute',
    nodes: {
      execute: {
        executor: 'conductor',
        max_rounds: config.maxRounds ?? 2,
        // D-F 的兜底那一半: 撤了外层就没有别的层再问「整体目标成了吗」。这个开关让内环在
        // **最后一轮也判一次**, 裁决经 LeafResult.converged 出来 —— 否则 `dag_goal` 只能拿
        // "跑完了"当"成了", 那是谎报完成最舒服的入口。
        judge_final: true,
        goal: task,
      },
      // ── D-I 的冻结判据: **环外的确定性闸** (2026-07-30 第三次 live 冒烟补上) ──────────
      //
      // 此前判卷标准只进任务文本, 指望 conductor 把它连成图里一个 command 节点 —— 实测它没连:
      // 冻结的是 `grep -qx "hello omd" notes/hello.md`, 它自己画的验证步是 `cat notes/hello.md`。
      // 于是"执行型验收"这四个字在生产上从没被真跑过, D-J 整套防作弊的地基就只剩一句提醒。
      //
      // 放**环外**而不是让内环去跑, 是 D-I 方案 A 那条纪律的直接后果: 判卷标准必须是执行体动不了的
      // 东西。环每轮重画子图, 判据进环就跟着能变; 挂在环外这一个 command 节点上, 它由 runGoal 构造、
      // conductor 碰不到、内环 judge 也改不了它。
      //
      // 语义是**必要非充分**: 收敛 = 内环 judge 说成了 **且** 这条命令退出码对。judge 说成了而命令
      // 没过 = 正是 D-I 要抓的那种"作弊达标"; 命令过了而 judge 说没成 = 任务里还有命令覆盖不到的
      // 明确要求。两侧都 fail-closed。
      ...(acceptance.kind === 'executable'
        ? {
            accept: {
              executor: 'command',
              command: acceptance.command,
              expect_exit: acceptance.expectExit,
              depends_on: ['execute'],
              goal: '冻结判据 (环外确定性闸)',
            },
          }
        : {}),
    },
  } as ConductorPlan;
  let exec: ExecutorDagResult;
  try {
    // 护栏③: **只有可执行判据**才进环。非可执行判据的 `oracleOk` 恒 true, 给了它就等于第一轮必停。
    // 环外那个 `accept` 节点保留不动 —— 它仍是收尾时那次权威判定 (`oracleOk` 的取值源没变),
    // 环内这份只负责"能不能早点停", 两者判的是同一条命令, 不会给出相反的结论。
    const execCfg =
      acceptance.kind === 'executable'
        ? { ...config.dag, freezeCriterion: { command: acceptance.command, ...(acceptance.expectExit !== undefined ? { expectExit: acceptance.expectExit } : {}) } }
        : config.dag;
    exec = await (config._runDag ?? runExecutorDagWithPlan)(execPlan, execCfg);
  } catch (err) {
    return bail(`execute 抛错: ${String(err).slice(0, 200)}`, 'infra-error');
  }
  const execLeaf = exec.results.execute;
  if (!execLeaf) return bail('execute 节点无结果 (引擎没跑到它)', 'infra-error');
  // `converged` 缺席 = 没人判过 → 一律**不算成** (judge_final 已保证它在, 缺席意味着引擎跑歪了)。
  // judge 自己那一票优先: 环内判据绿时 `converged` 是**判据**说的, 不是 judge 说的
  // (见 LeafResult.judgeConverged)。混用会让判据轴把"判据绿"误记成"judge 也说绿"。
  const judgeSaidOk = execLeaf.judgeConverged ?? execLeaf.converged === true;
  // D-I 环外闸: 执行型才有这个节点。它**没跑**(引擎没走到 / 被 quorum 级联跳过)也算没过 ——
  // 冻结判据的意义就是"没被证明过就不算成", fail-closed 与 converged 缺席同一条纪律。
  const acceptLeaf = acceptance.kind === 'executable' ? exec.results.accept : undefined;
  const oracleOk = acceptance.kind !== 'executable' ? true : acceptLeaf?.status === 'done';
  const converged = judgeSaidOk && oracleOk;
  const roundCount = execLeaf.rounds ?? 0;
  // INV-GOAL-3 可证面: 复用现在全发生在**内环**里 (子节点内容寻址, 同 id ≡ 同规格 + 同祖先规格)。
  const reusedNodes = exec.reusedNodes ?? [];
  // D-Q / D-P: 两种"没跑完但不是失败"的收尾, 各自如实报 —— 都恒不算收敛 (fail-closed)。
  const blocked = execLeaf.blocked;
  const budgetStopped = execLeaf.budgetStopped;
  // **引擎自己出事**导致环提前退出 (今天唯一来源: judge 调不通)。与 blocked 分开的理由是
  // 下一步相反: blocked 要人给外部输入, 这个要**修引擎** —— 而它此前落 `not-converged`,
  // 于是读的人会去加轮数, 恰恰是最没用的那个动作。
  const infraStopped = execLeaf.infraStopped;
  const cancelledReason = exec.cancelled?.reason;
  // 判词与 oracle **分开报**: 两者不一致时那句话本身就是结论 —— judge 说成了而冻结判据没过,
  // 正是 D-I 要抓的"作弊达标"; 反过来则是"任务里还有命令覆盖不到的明确要求"。
  const oracleNote =
    acceptance.kind !== 'executable'
      ? ''
      : oracleOk
        ? ' · 冻结判据 ✅'
        : ` · **冻结判据没过** (\`${acceptance.command}\` → ${acceptLeaf?.status ?? '没跑'})`;
  // ── N5: 终止原因**判一次, 两个消费者读同一份** ────────────────────────────────
  //
  // 此前这道阶梯只活在下面那句摘要文本里 —— 于是 `status` 那一位不得不用 `converged ? done : failed`
  // 独立再判一遍, 两处一漂就出现了 2026-07-31 live 那行「一次正确的 BLOCKED 被念成 failed」。
  // 阶梯顺序一字未改 (外部事件 > 资源轴 > 环的结论 > 判据分歧), 只是把它的结论抬成了一个词。
  const outcome: RunOutcomeKind = converged
    ? 'success'
    : cancelledReason
      ? 'cancelled'
      : infraStopped
        ? 'infra-error'
        : budgetStopped
          ? 'budget-exhausted'
          : blocked
            ? 'blocked'
          : judgeSaidOk && !oracleOk
            ? 'oracle-failed'
            : 'not-converged';
  stages.push({
    stage: 'execute',
    // ⚠ `status` 保持原样 (三态一字未动, 全仓 `=== 'done'` 的消费者行为不变) ——
    // 一次正确的 BLOCKED 在这一位上**仍然**是 failed。念对它是 `outcome` 的职责, 不是这一位的。
    status: converged ? 'done' : 'failed',
    outcome,
    summary:
      `${roundCount} 轮${
        outcome === 'success' ? '收敛'
        : outcome === 'cancelled' ? `被叫停 (${cancelledReason}) — 已跑完的保留, 同 runId 可 resume`
        : outcome === 'budget-exhausted' ? `预算停: ${budgetStopped!.slice(0, 300)}`
        : outcome === 'infra-error' ? `引擎侧停: ${infraStopped!.slice(0, 300)} —— **别加轮数**, 这是引擎该修的`
        : outcome === 'blocked' ? `阻塞: ${blocked!.slice(0, 300)}`
        : outcome === 'oracle-failed' ? '判词说成了但冻结判据没过 (D-I: 以判据为准)'
        : `未收敛 (${execLeaf.status})`
      }${oracleNote}` +
      `${reusedNodes.length ? ` · 复用 ${reusedNodes.length} 节点` : ''}` +
      `${exec.observations?.length ? ` · 图外观察 ${exec.observations.length} 条` : ''}`,
  });

  return {
    goal,
    tier,
    acceptance,
    stages,
    outcome,
    ...(specPath ? { specPath } : {}),
    sources,
    repoContext,
    converged,
    criteria: { judge: judgeSaidOk, oracle: oracleOk },
    rounds: roundCount,
    reusedNodes,
    ...(blocked ? { blocked } : {}),
    ...(budgetStopped ? { budgetStopped } : {}),
    ...(cancelledReason ? { cancelled: cancelledReason } : {}),
  };
}
