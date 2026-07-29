/**
 * goal/acceptance —— **D-I 验收分型** (2026-07-29, owner 拍板)。
 *
 * classify 这一站的问题换了: 从「要不要 research」改成「**这个目标的验收方式是哪一种**」。
 *
 * 为什么这是最该先问的一句: 自主环最重要的死法不是"做不出来", 是**作弊达标** —— 执行体把
 * 判据本身改到自己够得着的地方 (放宽断言 / skip 掉红的 / mock 掉被测逻辑 / 干脆删测试),
 * 然后诚实地报告"绿了"。防它的唯一办法是**在动手之前就把判卷标准冻结下来**, 且冻结的东西
 * 必须是执行体改不动的: 一条**别人来跑**的命令。
 *
 * 于是分两型, 两条完全不同的路:
 *
 * - **执行型 (executable)** —— 成败机器可判。**必须**产出一条可跑的验收命令 (`command`)。
 *   这条命令进 spec 的判卷标准段、进 execute 的任务文本, 最终落成图里一个 `executor:'command'`
 *   节点。它必须**当场就判定跑得起来** (过 command-leaf 的 fail-closed 闸) —— 规划期说能跑、
 *   执行期被闸拒 = 「假红」: 一个合法验证步被拦下, 看起来却像测试失败。
 *
 * - **探索型 (exploratory)** —— 成败机器判不了 (选型 / 摸清一个领域 / 找出有哪些坑)。
 *   既然判不了成败, 就**不许假装能判**。换成两样东西: **学习目标** (学到什么才算没白跑) +
 *   **可承受损失** (愿意为它花掉多少)。后者是探索型唯一的硬边界 —— 判不了对错时, 能定的
 *   只有亏损上限。
 *
 * ⚠ 分型 ≠ 轻重路由。`GoalTier` (simple/complex) 问的是"要不要先查外部事实/先定契约", 是**成本**轴;
 * 验收分型问的是"怎么判成没成", 是**判据**轴。两条轴此前混在一句 prompt 里 (旧分类器的 simple
 * 描述同时含"做法已确定"与"验收可机器判") —— 一个做法未定但验收可机器判的目标, 在旧口径下无处安放。
 */
import { DEFAULT_COMMAND_ALLOWLIST, commandBlockReason } from '../command-leaf';
import { logger } from '../logger';
import type { GenerateFn } from '../executor-dag-types';

/** D-5 轻重路由 (成本轴): simple = 直接 Execute→Verify; complex = 全 research→spec→execute。 */
export type GoalTier = 'simple' | 'complex';

/**
 * D-I 验收分型 (判据轴)。判别联合而非"一堆可选字段" —— 可选字段版会长成又一个空旋钮:
 * 声明面写着 command?, 谁也不保证它在。
 */
export type AcceptanceSpec =
  | {
      kind: 'executable';
      /** 别人来跑的验收命令。已过 {@link isRunnableAcceptanceCommand}。 */
      command: string;
      /** 期望退出码 (D-K)。verify-green 是 0; 冻结判据时一并记, 免得后面被改。 */
      expectExit: number;
    }
  | {
      kind: 'exploratory';
      /** 学到什么才算这次没白跑 (判不了成败, 至少判得了"有没有学到")。 */
      learningGoal: string;
      /** 愿意为它花掉多少 (轮数 / 时间 / token)。探索型唯一的硬边界。 */
      affordableLoss: string;
    };

export interface GoalClassification {
  tier: GoalTier;
  acceptance: AcceptanceSpec;
}

/**
 * 一条验收命令是否**真跑得起来** = 过 command-leaf 的 fail-closed 闸 (白名单 / 元字符 / git 只读 /
 * 危险命令)。判据借的是执行期那一份 (`commandBlockReason`), 不是这里另抄一份 —— 抄一份早晚先漂,
 * 而漂的后果恰是「假红」。
 *
 * @returns null = 可跑; 否则一行拒因。
 */
export function acceptanceCommandBlockReason(command: string): string | null {
  const c = command.trim();
  if (!c) return '[blocked empty: 验收命令为空]';
  return commandBlockReason(c, DEFAULT_COMMAND_ALLOWLIST);
}

/** 便捷谓词。 */
export const isRunnableAcceptanceCommand = (command: string): boolean =>
  acceptanceCommandBlockReason(command) === null;

/**
 * 探索型兜底 —— 分型失败 / 执行型拿不到可跑命令时用它, **并把原因原样写进学习目标**。
 *
 * 为什么兜到探索型而不是"执行型但命令留空": 执行型的全部意义就是那条命令, 留空的执行型
 * 是个说自己可判、实际无人判的目标 —— 正是本模块要杀的那种。降级到探索型至少诚实:
 * 它明说"这次没有机器判据", 于是 spec 卡会被要求补出一条, 补不出就按探索型的规矩走 (定亏损上限)。
 */
export function fallbackExploratory(why: string): AcceptanceSpec {
  return {
    kind: 'exploratory',
    learningGoal: `(验收分型未成立: ${why}) 先弄清这个目标的成败到底该怎么判 —— 能不能落成一条可跑的命令。`,
    affordableLoss: '一轮执行的开销; 仍判不出判据就停下来交人, 不要靠多跑几轮蒙过去。',
  };
}

/** 分类器的 JSON 形状 (弱模型也吃得下的扁平结构; 深校验在下方 normalize)。 */
interface RawClassification {
  tier?: unknown;
  acceptance_kind?: unknown;
  command?: unknown;
  learning_goal?: unknown;
  affordable_loss?: unknown;
}

/**
 * 把模型吐的 JSON 归一成 {@link GoalClassification}。**弱模型不可信原则**: 每一格都自己兜,
 * 兜不住就往保守方向落 —— 但保守的方向在两条轴上**相反**:
 *
 * - tier 落 `complex`: 多做一遍接地, 代价是钱; 误判成 simple 的代价是一份没有证据的契约被执行。
 * - acceptance 落 `exploratory`: 假装机器可判而实际无人判, 比明说"这次判不了"坏得多。
 */
export function normalizeClassification(raw: RawClassification): GoalClassification {
  const tier: GoalTier = String(raw.tier ?? '').toLowerCase().includes('simple') ? 'simple' : 'complex';
  const kind = String(raw.acceptance_kind ?? '').toLowerCase();

  if (kind.includes('exec')) {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    const blocked = acceptanceCommandBlockReason(command);
    if (blocked) {
      logger.warn({ command, blocked }, '[omd/goal] 判执行型但验收命令跑不起来 → 降级探索型 (D-I)');
      return { tier, acceptance: fallbackExploratory(`执行型但命令不可跑 — ${blocked}`) };
    }
    // expectExit 恒 0: 这里定的是**总验收** (绿), 不是 TDD 中途的证红步 (那一步的 expect_exit:1
    // 由 spec 写进图里, 见 spec-author 卡的 TDD 流程段)。
    return { tier, acceptance: { kind: 'executable', command, expectExit: 0 } };
  }

  const learningGoal = typeof raw.learning_goal === 'string' ? raw.learning_goal.trim() : '';
  const affordableLoss = typeof raw.affordable_loss === 'string' ? raw.affordable_loss.trim() : '';
  if (!learningGoal || !affordableLoss) {
    // 探索型缺了这两样就退回一个空壳分型 —— 那等于既没有机器判据也没有人判据, 什么都没定。
    return { tier, acceptance: fallbackExploratory('探索型缺学习目标或可承受损失') };
  }
  return { tier, acceptance: { kind: 'exploratory', learningGoal, affordableLoss } };
}

/** 分类 prompt。白名单**拼进 prompt** —— 承 conductor prompt 的同一条教训: 不给表就只能猜, 猜错即假红。 */
export function classifyPrompt(goal: string): string {
  return [
    '你在给一个自主执行环做**开跑前的两个判断**。只回一个 JSON 对象, 不要别的字。',
    '',
    '判断一 `tier` (成本轴 — 要不要先接地):',
    '  "simple"  = 做法已经确定, 直接动手就行;',
    '  "complex" = 需要先查外部事实或先定契约 (选型 / 新机制 / 跨模块设计)。',
    '',
    '判断二 `acceptance_kind` (判据轴 — **成没成怎么判**):',
    '  "executable"  = 成败机器可判。**必须**同时给 `command`: 一条别人来跑、退出码 0 即算达成的命令。',
    '  "exploratory" = 成败机器判不了 (摸清一个领域 / 选型 / 找出有哪些坑)。给 `learning_goal`',
    '                  (学到什么才算没白跑) 与 `affordable_loss` (愿意为它花掉多少)。',
    '',
    '⚠ 判据轴与成本轴**互相独立**: 一个做法未定的目标, 验收照样可能是机器可判的 (先查清楚怎么做,',
    '  但做完跑 `bun test` 就知道成没成)。别因为 tier=complex 就往 exploratory 上靠。',
    '⚠ 拿不准就选 "exploratory"。给一条**判不了真假**的命令比承认判不了坏得多 —— 它会让整个环',
    '  以为自己有验收, 而实际上没有。',
    '',
    `\`command\` 的首个词必须是这些之一, 否则命令会被安全闸拒绝执行 (看起来像测试失败, 实则没跑):`,
    `  ${DEFAULT_COMMAND_ALLOWLIST.join(' ')}`,
    '可以用 && 串联 (每环独立过闸); 其它 shell 运算符 (; | $() ` 重定向) 一律拒绝。',
    '',
    '形状: {"tier":"simple"|"complex","acceptance_kind":"executable"|"exploratory",',
    '       "command"?:string,"learning_goal"?:string,"affordable_loss"?:string}',
    '',
    `目标: ${goal}`,
  ].join('\n');
}

/**
 * 跑分类 (一次调用出两条轴)。无 generate/model, 或调用/解析失败 → 全保守档
 * (`complex` + 探索型兜底), **不抛** —— 分类是路由不是闸, 挂了该继续往下走。
 */
export async function classifyGoal(
  goal: string,
  deps: { generate?: GenerateFn; model?: string },
): Promise<GoalClassification> {
  const { generate, model } = deps;
  if (!generate || !model) {
    return { tier: 'complex', acceptance: fallbackExploratory('无分类器 (缺 generate/model)') };
  }
  try {
    const { text } = await generate({
      model,
      messages: [{ role: 'user', content: classifyPrompt(goal) }],
      maxTokens: 400,
    });
    const raw = JSON.parse(extractJsonObject(text)) as RawClassification;
    return normalizeClassification(raw);
  } catch (err) {
    logger.warn({ err: String(err) }, '[omd/goal] 分类调用/解析失败 → 全保守档 (complex + 探索型)');
    return { tier: 'complex', acceptance: fallbackExploratory('分类调用或解析失败') };
  }
}

/** 从模型输出里抠出第一个 JSON 对象 (容忍 ```json 围栏与前后散文)。抠不到 → 原样返 (交给 JSON.parse 抛)。 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * **冻结的判卷标准** —— 同一份文本进 spec 起草 prompt、进 execute 的任务文本。
 *
 * 一份而不是两份是要点: 判卷标准分两处写, 两处就会漂, 而"判据漂了"正是作弊达标最舒服的入口。
 */
export function renderAcceptance(a: AcceptanceSpec): string {
  if (a.kind === 'executable') {
    return [
      '## 判卷标准 (冻结 — 执行型)',
      '本目标的达成判据是**这一条命令**, 由外部来跑, 退出码即结论:',
      '```',
      a.command,
      '```',
      `期望退出码: ${a.expectExit}。`,
      '',
      '这条命令与它所断言的东西在实施开始前即已冻结。实施过程中**不许**改动它, 也不许改动它所',
      '依赖的断言 —— 需要改判据说明判据错了, 那是要回来重新定的事, 不是实施途中顺手做的事。',
    ].join('\n');
  }
  return [
    '## 判卷标准 (冻结 — 探索型)',
    '本目标**没有机器判据** —— 不要伪造一个 (给一条判不了真假的命令比承认判不了坏得多)。',
    `- 学习目标: ${a.learningGoal}`,
    `- 可承受损失: ${a.affordableLoss}`,
    '',
    '判不了成败时能定的只有亏损上限。到了上限还没弄清楚, 就停下来把已知与未知交出去,',
    '不要靠多跑几轮蒙过去。',
  ].join('\n');
}
