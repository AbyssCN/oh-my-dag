/**
 * plan/llm-judge —— fixpoint 的**默认 LLM 收敛 judge** (iterate / replanner 共用)。
 *
 * fixpoint.ts 保持纯净 (无 model 依赖, 故其测试无需 DB/模型); 默认 judge 实现单独住这层。
 * 两个绑定 (omd 内层 iterate / 宿主宏观引擎 外层 replanner) 只在"如何从 result 抽 {status, summary}"
 * 上不同 → 经 extract 参数化, 共用同一套 callModel + schema + 收敛裁决。
 *
 * 收敛裁决: **信 judge 的 converged 布尔** (阈值 threshold 进 prompt 作 bar, 由 LLM 内化判定),
 * 不在代码里用 score 二次覆盖 LLM 的判断 (避免 score 把明确的 converged=false 静默翻成 true)。
 * score 仅作记录。整轮 failed → 直接判未收敛 (不浪费一次 judge 调用)。
 */
import { z } from 'zod';
import { send } from '../../model/gateway';
import { seatSpec } from '../../model/seats';
import { effectiveSeatSampling } from '../../model/seat-overrides';
import type { FixpointJudge, FixpointVerdict } from './fixpoint';

export const CONVERGENCE_VERDICT_SCHEMA = z.object({
  converged: z.coerce.boolean(),
  score: z.coerce.number().min(0).max(1),
  failureReason: z.coerce.string().optional(),
  /**
   * #228: 下一轮该做什么 (机制级动作)。**必须在 schema 里**, 不然 zod 会把它当未知键剥掉,
   * 于是模型答了、绑定层收不到 —— 那正是本仓在收的静默形状。
   */
  nextSteps: z.coerce.string().optional(),
  /** D-4 DeltaTicket (P1.5): 产出有问题的节点 id (本轮 id 空间); 绑定层翻成指纹毒集禁止复用。 */
  rejectedNodes: z.array(z.coerce.string()).optional(),
  /**
   * **G2 契约反查** (2026-08-28): 这个节点的 goal 本身, 还站得住吗?
   *
   * 上面五位判的都是「这一轮**照 goal** 做到了没有」。这一位判的是**上一层**:
   * goal 相对于**原始任务**有没有写歪 —— 遗漏、弱化、把要求换成了更容易的替代目标。
   *
   * 为什么非要它: 本仓 §静默坑 3 的实测样本是 `tsc` 干净 + 2159 测试全绿而状态映射的标签是反的,
   * 配套测试把它固化了。**机械闸和 judge 都以契约为准, 契约错了它们一起错、并且互相背书。**
   * 唯一能戳破的位置是「有人拿原题回头查契约」, 而在这之前 omd 没有任何一轮做这件事。
   *
   * ⚠ 缺席合法 (`rootTask` 没给 / 模型没答) —— 缺席 ≠ `aligned`。绑定层按「没问过」处理,
   *   不许补一个 aligned (仓规坑①: 「没投票」≠「投了赞成票」)。
   */
  contractVerdict: z.enum(['aligned', 'unknown', 'needs_revision', 'invalid']).optional(),
  /** `contractVerdict !== 'aligned'` 时: 原题的哪一条被写歪了 / 缺了。绑定层原样带进停轮判词。 */
  contractIssue: z.coerce.string().optional(),
  /**
   * **要人回答的那个问题** (ask 出口, 2026-08-28) —— 只有 `contractVerdict='unknown'` 时才有意义。
   *
   * ⚠ **它不是停轮开关。** 停不停由绑定层的确定性判据决定 (连续两轮 unknown), 不由这一位决定 ——
   * 给模型一个"我想停就停"的按钮, 一个爱提问的座位能把每一跑都停在第一轮。
   * 这一位只提供**内容**: 该问什么。触发权在引擎手里 (可靠性来自模型之外)。
   *
   * 缺席合法: 判了 unknown 但说不出具体要问什么, 那就是说不出 —— 绑定层照实写, 不编一个问题。
   */
  askOwner: z.coerce.string().optional(),
});

/** 默认收敛阈值 (进 prompt 作 LLM 判收敛的 bar)。 */
export const DEFAULT_CONVERGENCE_THRESHOLD = 0.8;

export interface LlmJudgeOpts<R> {
  /** 评判模型 'provider:modelId'。falsy → 调用时抛 (fail-closed 配置错, 不静默)。 */
  judgeModel: string | undefined;
  /** 原始任务 (进 prompt 给 judge 对照目标)。 */
  task: string;
  /**
   * G2 (2026-08-28): **原始任务**原文 —— 与 `task` (这个节点的 goal) 是两回事。
   * 给了才挂契约反查块并要求 `contractVerdict`; 缺席 → prompt 一个字不多, schema 那两位留空
   * (= 没问过, 不是 aligned)。
   */
  rootTask?: string;
  /** 收敛阈值 (进 prompt 作 bar)。默认 0.8。 */
  threshold?: number;
  /** 从一轮 result 抽出 {status, summary}: status='failed' 走未收敛快路径; summary 给 judge 看。 */
  extract: (result: R) => { status: 'done' | 'failed'; summary: string };
  /** 采样温度覆盖。省略 = `gate` 座的采样意图 (model/seats.ts)。 */
  temperature?: number;
  /**
   * 思考档。省略 = **不发** → deepseek 侧落 `thinking:{type:"disabled"}`。
   *
   * ⚠ 这个字段 2026-08-01 才补上。此前这里**根本不传档**, 于是 `seats.ts` 写的 `gate.thinking`
   * 是个空旋钮 —— 配置面说闸在 xhigh 上想问题, 实际每一发都关着思考。
   * (顺带: 关着思考才是 temperature 生效的前提, 见 model-caps.samplingIgnoredWhenThinking。
   * 两个旋钮**互斥**, 所以"闸要深想"与"闸要可复现"今天只能二选一。)
   */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof send;
  /**
   * **证据词表**: 把视图里各块的来源(引擎产的事实 vs 执行体的自述)显式告诉 judge。**默认开**。
   *
   * 病灶是判词自己说出来的 (2026-08-03, 不是猜的): 拒绝理由逐字写着
   * 「提供的文件内容**并非真实从磁盘读取**的产物, 而是引擎模拟的文本」「未提供实际写入证据」——
   * 也就是 judge **看得见** `[产物内容 · 引擎读盘]` 那一块, 却**不知道该不该信它**。
   *
   * 病根在 prompt 的静态段: 它讲了收敛标准 (第 2 条反捏造很硬), **却从没说过视图里哪些块是
   * 引擎产的、哪些是执行体说的**。judge 拿不准, 而 fail-closed 的默认就是拒 —— 于是 S1
   * 花钱注入的那份证据, 在它眼里与"执行体自己吹的"没有区别。
   *
   * 这与 D-S 是同一族缺陷 (owner 指令 vs 引擎观察必须在 prompt 里可区分), 只是换了一对:
   * **引擎事实 vs 执行体主张**。
   *
   * **默认开** (2026-08-03 A/B 之后翻的)。5 段 × 8 次 × 两档实测:
   * | | 关 | 开 |
   * |---|---|---|
   * | 点名召回全 `content-contradicts` | **0/8** | **8/8** |
   * | 点名召回全 `claimed-not-written` | **1/8** | **8/8** |
   * | 假阴性 / 假阳性 | 0 / 0 | 0 / 0 |
   * | prompt token | — | +7% |
   *
   * ⚠ **真效果在点名不在收敛**: 两档假阴性都是 0 (我先前记的"残余 19%"没在同口径基线上复现,
   * 那是 n=8 噪声, 已在 SDD 更正)。而**平均点名数两档都是 1.0** —— 它不是"多点几个蒙对",
   * 是点得**更准**。这条正好打在 SDD 标着「S1 之后的下一个目标」的那个回归上 (召回 88.3%→70%),
   * 后果是硬的: 漏点名 → 毒集点不准 → 环在坏结果上继续盖。
   */
  evidenceLegend?: boolean;
}

/**
 * 证据词表 —— 各块的来源与可信度。**只陈述事实来源, 不指示裁决方向**:
 * 说"这是引擎读盘拿到的字节"是事实,说"所以你该通过"就是在替 judge 做判断,
 * 那会把假阴性换成假阳性 (S1 的两侧判据钉的正是这个)。
 */
export const EVIDENCE_LEGEND = `视图里各块的来源 (读结果前先认清, 别把它们当同一种东西):
- \`[引擎实测] …\` —— **引擎自己观测到的事实** (如"写入文件: x.md"), 机器记录, 不是执行体的话。
- \`[产物内容 · 引擎读盘]\` 下面的 \`--- <路径> ---\` 段 —— **引擎从磁盘读出来的真实字节**, 逐字原样, 引擎不加工。
  文件不存在或读不出来时, 引擎会明写"未能读到"; 没有这句就说明盘上真有这些内容。
- 每段结尾那段自由文字 —— **执行体的自述**, 它是一个**主张**, 不是证据。

所以: 判"是不是捏造/假执行确认"时, 以前两类为准; 自述与它们冲突, 信前两类。
自述说得再漂亮也不算数, 但**引擎读盘拿到了内容, 就不该再判它"没真做"**。`;

/**
 * G2 契约反查块 (2026-08-28) —— 只在调用方给了 `rootTask` 时才挂 (缺席零字节)。
 *
 * ⚠ 它**不是新加一层验收环**。「另加一层全局验收」早被拒过, 理由是回边破坏无环
 * (`dag/engine.ts` 内环 judge 那段注)。这里加的是**同一个判官的一位控制头** ——
 * 不加边、不多一次调用、不改控制流的形状, 只是让它在判「照 goal 做到没有」之余,
 * 顺手回答「goal 相对原题站不站得住」。
 */
function contractBackcheckBlock(rootTask: string): string {
  return `

原始任务 (这个节点的 goal 是从它派生出来的):
---
${rootTask}
---

**契约反查** (与上面的收敛判定分开做, 不要混):
不要默认上面那个"原始任务"栏里的 goal 是对的。拿**原始任务**独立重建一遍硬约束清单 ——
精确对象/文件名/路径/字段/格式/数量, 以及"不要改 X""保持 Y 不变""只用 Z"这类限制词 ——
再回头查这个节点的 goal 有没有: 遗漏某一条 · 把某一条弱化 · 把要求换成了更容易做到的替代目标。
- \`aligned\`         = goal 完整覆盖了原题中属于它的那部分, 没有弱化或替换。
- \`unknown\`         = 材料不足以判断 (原题里有条款你无法确认 goal 有没有覆盖)。
- \`needs_revision\`  = goal 漏了或弱化了原题的某条硬约束, 但方向是对的。
- \`invalid\`         = goal 把原题换成了另一个目标, 照它做完原题也不算完成。
⚠ 这一位判的是**契约本身**, 不是这一轮的执行。执行做得再好也不能把 needs_revision 改成 aligned;
   反过来, 契约 aligned 而执行没做到, 那是 converged=false 的事, 与这一位无关。`;
}

function judgePrompt(task: string, summary: string, round: number, threshold: number, legend = true, rootTask?: string): string {
  return `你在评判一个多步任务第 ${round} 轮的执行结果是否**收敛** (质量已达可交付, 再迭代不会实质变好)。

判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数 (如"3 步")、字数/篇幅、必须标注的东西 (如"标依赖")、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行的结果)。**逐条**对照本轮结果。

${legend ? `${EVIDENCE_LEGEND}\n\n` : ''}收敛标准 (bar):
1. **任一明确要求未满足 → converged=false** (即使整体质量尚可)。failureReason 必须点名缺了哪条要求。
2. 结果是**真实交付物**而非捏造的数据/假执行确认 (如凭空编客户数据、"已发送/已录入" 这类没真做却声称做了的); 捏造 → converged=false。
3. 以上都过, 再看质量分 ≥ ${threshold} 视作收敛 —— 你须**内化这个标准**后给出 converged 布尔。

原始任务:
---
${task}
---
${rootTask ? contractBackcheckBlock(rootTask) : ''}

本轮执行结果:
---
${summary}
---

输出 JSON 五字段:
- converged (bool): 是否已达收敛标准 (不动点到达)。这是裁决, 必须与你的 score 一致。
- score (0..1): 质量分
- failureReason (string, converged=false 时必填): 缺哪条明确要求 / 哪里捏造。**只写诊断, 不写动作。**
- nextSteps (string, converged=false 时必填): **下一轮该做什么** —— 机制级动作 (改哪个文件的哪一处 /
  补哪条验证命令 / 先做哪一步), 不是"再仔细些""质量不够"这类评价。这一段会**逐字**送进下一轮的
  提示词且不参与截断预算, 所以它是你唯一能让下一轮真正改变行为的通道; 与 failureReason 分两个字段写,
  **不要把动作混回 failureReason**。
- rejectedNodes (string[], converged=false 时必填): **点名产出有问题的节点 id** —— 上面结果里每段
  \`### <id> [状态]\` 开头的那个 id, 逐字照抄。判据是"这段产出本身错了/缺了/是编的", 不是"这个节点无关"。
  **宁可多点名, 不可漏点名**: 没被点名的节点, 它这一轮的产出会被原样当作已批准结果复用进下一轮 ——
  漏点一个, 下一轮就在坏结果上继续盖。拿不准的点上。整轮都不可用就把所有 id 都列上。${
    rootTask
      ? `
- contractVerdict (aligned|unknown|needs_revision|invalid): **契约反查**的结论, 见上。
- contractIssue (string, contractVerdict ≠ aligned 时必填): 原题的**哪一条**被漏了/弱化了/换掉了, 逐字引原题那句。
- askOwner (string, **只在 contractVerdict='unknown' 时**填): 要人回答的那**一个**具体问题 ——
  形如"原题里的 X 指的是 A 还是 B?"。写成一句可以直接回答的话, 不要写"需要更多信息"这类空话。
  ⚠ 写了它**不会**让这一轮停下来 —— 停不停由引擎按连续 unknown 的轮数定。你只负责说该问什么。`
      : ''
  }`;
}

/**
 * 造默认 LLM 收敛 judge。整轮 failed → 未收敛 (不调模型); 否则 callModel → 信其 converged 布尔。
 */
export function makeLlmConvergenceJudge<R>(opts: LlmJudgeOpts<R>): FixpointJudge<R> {
  const threshold = opts.threshold ?? DEFAULT_CONVERGENCE_THRESHOLD;
  const call = opts.callModelFn ?? send;
  return async (result, round): Promise<FixpointVerdict> => {
    if (!opts.judgeModel) {
      throw new Error('llm-judge: judgeModel 必填 (或给 config 注入自定义 judge)');
    }
    const { status, summary } = opts.extract(result);
    // 整轮失败 → 直接未收敛, 带上失败摘要作下一轮改进方向 (省一次 judge 调用)。
    if (status === 'failed') {
      return { converged: false, score: 0, failureReason: `整轮 failed: ${summary.slice(0, 200)}` };
    }
    const r = await call({
      model: opts.judgeModel,
      // #144 洞 1: gate 座的两条出口里, 只有 halt-judge 那条带标签; 这条此前无名 →
      // 「gate 烧了多少」只量到一半。标签分得比座位细 (同座两条出口), 归座在 seat-usage 侧做。
      meta: { role: 'gate:convergence' },
      messages: [{ role: 'user', content: judgePrompt(opts.task, summary, round, threshold, opts.evidenceLegend ?? true, opts.rootTask) }],
      // 采样意图取自 `gate` 座 (model/seats.ts): 闸的裁决要可复现。调用方给了就压过它。
      // C4: 座位采样经 config.seats 覆盖层 (无覆盖 = 编译期表逐字节同值); 显式 opts 仍最高优先。
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : effectiveSeatSampling('gate')),
      // 档由**座位登记表**驱动 (不是"什么都不传碰巧关着")。gate 座实测定在 off, 理由见 seats.ts。
      thinkingLevel: opts.thinkingLevel ?? seatSpec('gate')?.thinking ?? 'off',
      maxTokens: 4096, // 700 会被推理族的 reasoning 吃光 → 空裁决
      responseSchema: CONVERGENCE_VERDICT_SCHEMA,
    });
    const v = r.parsed as
      | {
          converged: boolean;
          score: number;
          failureReason?: string;
          nextSteps?: string;
          rejectedNodes?: string[];
          contractVerdict?: 'aligned' | 'unknown' | 'needs_revision' | 'invalid';
          contractIssue?: string;
          askOwner?: string;
        }
      | undefined;
    // A5 (2026-07-31): 这句话的**读者是下一轮重画的 conductor**, 而它出现在 `<上一轮未通过>` 里 ——
    // 读者会把那块里的任何东西当成对自己方案的评价, 于是"judge 未结构化输出"会让它去迎合一句
    // 根本不存在的判词改图。先把这件事撇清, 再给一条它做得了的事。
    if (!v) {
      return {
        converged: false,
        score: 0,
        failureReason:
          '【引擎侧事故, 不是对上一轮方案的评价】judge 没有产出可解析的结构化裁决。' +
          '也就是说**上一轮的方案没有被判过**, 没有任何证据说它坏 —— ' +
          '不要为了迎合一句不存在的判词去改图; 若上一轮的产出看起来是完整的, 原样再交一次即可。',
      };
    }
    // 信 judge 的 converged 布尔 (threshold 已进 prompt); score 仅记录, 不二次覆盖判断。
    const converged = v.converged === true;
    return {
      converged,
      score: v.score,
      // A5: 兜底文案此前是 `'未达收敛标准'` —— 报得对, 但它进下一轮之后读者**什么也做不了**
      // (它本来就知道没达标, 缺的正是"哪儿不达标")。judge 没说就是没说, **不许替它编一条理由**;
      // 但"这一轮没有反馈"这件事本身可以说成一句读者用得上的话: 别猜, 回到目标重新审。
      failureReason: converged
        ? undefined
        : v.failureReason ??
          'judge 判未收敛, **但没有给出理由** —— 这一轮没有可用的失败信息。' +
            '不要去猜上一轮哪一步错了 (猜错了会连对的那步一起改掉): 请回到目标本身重新审一遍, ' +
            '优先补上"怎么才算做完"这类可验证的步骤。',
      // #228: 收敛了没有"下一步"; 未收敛而 judge 漏填 → **留缺席**, 不许像 failureReason 那样
      // 兜一段话。两者的读者不同: failureReason 的兜底是说给下一轮听的"别去猜", 而 nextSteps
      // 是要被逐字当动作执行的 —— 编一条假动作比没有动作更坏。缺席由绑定层决定不挂这一块。
      ...(converged || !v.nextSteps ? {} : { nextSteps: v.nextSteps }),
      // D-4: 收敛了就没有毒 (产出全批准); 未收敛才带票。judge 漏填 = 空票, 由绑定层记账 (不静默当"全批准")。
      ...(converged || !v.rejectedNodes?.length ? {} : { rejectedNodes: v.rejectedNodes }),
      // G2: 契约反查与 `converged` **正交** —— 收敛了也照样带出去 (最危险的那一格正是
      // `converged=true ∧ contractVerdict='invalid'`: 活干完了, 干的是另一件事)。
      // 缺席 (没给 rootTask / 模型没答) → 不写键, **不补 aligned** (仓规坑①)。
      ...(v.contractVerdict ? { contractVerdict: v.contractVerdict } : {}),
      ...(v.contractVerdict && v.contractVerdict !== 'aligned' && v.contractIssue
        ? { contractIssue: v.contractIssue }
        : {}),
      // ask 出口: 只在 `unknown` 这一态带出去 —— 其它三态下模型写的"问题"没有语义位置,
      // 带出去只会让绑定层多一个永远用不上的字段 (缺席 ≠ 空串, 仓规坑①)。
      ...(v.contractVerdict === 'unknown' && v.askOwner ? { askOwner: v.askOwner } : {}),
    };
  };
}
