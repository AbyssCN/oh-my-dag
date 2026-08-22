/**
 * src/tui/tools/ask-user —— **让模型能反问用户一个结构化问题**(2026-08-08,P1 QuestionFlow 的第一步)。
 *
 * ## 为什么先做这个,而不是先 vendor rpiv
 *
 * `docs/bars/rpiv.md` §0 已裁决「vendor 拆层引入」。本程把**当时没有的那个数**量了出来:
 * 要搬的 `state/` + `view/` 是 **29 个文件 3,795 行**。而本仓有一条**会红的可达性闸**
 * (`src/harness/reachability.test.ts`:「没有孤儿」),它的豁免名单要求写出
 * **「谁在什么地方按什么路径拉它」——「写不出这句话 = 它没有入口 = 该删, 不该豁免」**。
 *
 * ⇒ 3,795 行**没有消费者**的代码进不来:要么当场变孤儿把闸弄红,要么要我写一句我写不出的豁免。
 * **所以顺序反了:得先有消费者。** 这个文件就是那个消费者 ——
 * 模型可以调的一个 `ask_user`,UI 用 omd **已经有的** `selectComponent`,一行 vendor 都不需要。
 *
 * 等它真被用起来,**用法会告诉我们** rpiv 那五样(多问题分页 / 多选 / 选项预览 /
 * 长选项折行 / 内联"其它")里到底缺哪几样 —— 那时按需搬,而不是照单全收。
 * ⚠ 这是对 `rpiv.md` §0 **粒度**的修正(不是推翻 vendor 那个决定),理由与数都在上面。
 *
 * ## 反 happy-path(这四条是这个工具真正的难点)
 *
 * 1. **对话框被占**(用户正开着 `/settings`)→ **按"问不出来"回给模型并说明**,不排队。
 *    排队的问题会在用户关掉框的下一瞬弹出来,像是"Esc 又弹回来了"(同审批层的裁决)。
 * 2. **用户按 Esc** → 那是**一个合法答案**("我不选"),不是错误。回给模型让它自己决定怎么办;
 *    抛异常会让模型以为工具坏了然后重试,而重试会**再弹一次框**。
 * 3. **档位必须是 `read`** —— 否则"想问用户一句话"这件事本身要先请用户批准一次,
 *    而那是荒谬的(而且未登记的工具按 fail-closed 归 `write`,不登记就会撞上)。
 * 4. **选项至少两个** —— 一个选项的"选择"不是选择;schema 上就拦住,不进运行期。
 * 5. **「先聊聊这个」与 Esc 必须分得开**(owner 裁决 R5)。抹成同一个回值 = 告诉模型
 *    "随便挑一个吧",而那正是用户按这一项时最不想要的。见 `ASK_USER_DISCUSS`。
 */
import { Type } from 'typebox';
import type { AnyOmdTool } from '../../harness/agent-tools';
import type { DialogHost, SelectOption } from '../components/dialog';
import { select } from '../components/dialog';
import type { OmdTuiTheme } from '../theme';

/** Esc 的回值。**是答案不是错误** —— 措辞要让模型看得懂它该自己决定下一步。 */
export const ASK_USER_CANCELLED = 'User did not choose (pressed Esc). This is not an error - decide yourself: either continue with the most reasonable default, or say what you need and ask again.';
/** 框被占时的回值。同样是答案不是错误。 */
export const ASK_USER_BUSY = 'Cannot ask: another dialog is already open on screen. Do not ask; either continue with the most reasonable default, or wait until this turn ends to ask.';

/**
 * ★ **「先聊聊这个」** —— owner 裁决 R5(`docs/plan/2026-08-08-tui-gauntlet-重建-plan.md` §1):
 * 「问答弹窗要有 **"Chat about this"** 选项」。
 *
 * 它与 Esc **不是一回事**, 这一点是这条裁决的全部价值:
 * - **Esc** = 「我不选, 你自己拿主意」⇒ 模型该按默认继续;
 * - **先聊聊** = 「你这几个选项本身有问题 / 我想先弄清楚再选」⇒ 模型**不该**按默认继续,
 *   该把选项背后的取舍讲出来, 等人回话。
 *
 * 抹成同一个回值, 就等于告诉模型"随便挑一个吧" —— 而那正是用户按这一项时最不想要的。
 */
export const ASK_USER_DISCUSS =
  'User chose "talk it through first" - they do NOT want to decide now. Do not default, and do not re-ask the same question. ' +
  'Explain the trade-offs behind the options (cost and prerequisites each), then wait for their reply.';
/** 「先聊聊」那一项的 value。用不可能与序号撞的串。 */
const DISCUSS = '\u0000discuss';

const SCHEMA = Type.Object({
  question: Type.String({ description: 'The question to ask. One sentence, concrete.' }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: 'Short option text shown in the list.' }),
      description: Type.Optional(Type.String({ description: 'One line of extra context for this option.' })),
    }),
    // ⚠ 两个起 —— 一个选项的"选择"不是选择。
    { minItems: 2, maxItems: 8, description: 'Between 2 and 8 mutually exclusive options.' },
  ),
});

export interface AskUserUi {
  host: DialogHost;
  theme: OmdTuiTheme;
  /** 把问答留一份到对话记录 —— 框关掉之后"刚才问了什么、选了什么"要回看得到(同审批回执)。 */
  appendNotice: (text: string) => void;
}

/**
 * ⚠ **惰性解析**:工具面是在 TUI 建起来**之前**装配的(`cli.ts` 那里有同一个环:
 * "先有工具面才有 backend, 而节点事件要灌回 backend" —— 那里用的也是延迟指针)。
 * 所以这里收的是一个**取 UI 的函数**,不是 UI 本身。
 * 取不到(还没建好 / 这条装配路径没有 UI)→ 按"问不出来"回, 不抛。
 */
export type AskUserResolver = () => AskUserUi | null;

/**
 * 造 `ask_user` 工具。
 *
 * @returns 单元素数组 —— 与 `createCodegraphTools` / `createSkillTools` 同形,
 *   调用方 `...` 展开即可;将来要按能力探测决定挂不挂时,签名不用动。
 */
export function createAskUserTool(resolve: AskUserResolver): AnyOmdTool[] {
  const tool: AnyOmdTool = {
    name: 'ask_user',
    label: 'ask_user',
    description:
      'Ask the human a multiple-choice question and wait for their answer. ' +
      'Use it when the answer would change what you build and you cannot settle it from the code or the request — ' +
      'not for choices with an obvious default. The answer may be "cancelled"; handle that yourself.',
    promptSnippet: 'ask_user(question, options[]) - ask the user a multiple-choice question (only when the answer would change what you do; skip if there is an obvious default).',
    parameters: SCHEMA,
    // 它占住输入区并等人 —— 绝不能与别的工具并行跑。
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const { question, options } = params as { question: string; options: { label: string; description?: string }[] };
      const deps = resolve();
      if (!deps || deps.host.busy) {
        return { content: [{ type: 'text' as const, text: ASK_USER_BUSY }], details: { answered: false, reason: 'busy' } };
      }
      const opts: SelectOption[] = [
        ...options.map((o, i) => ({
          // value 用**序号**不用 label:label 可能重复, 也可能带模型自己加的空白。
          value: String(i),
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        // ★ R5:恒在最后一项。**不由模型决定给不给** —— 它是用户的退路, 不是模型的选项之一。
        { value: DISCUSS, label: 'talk it through first', description: 'the options look wrong, or you want to understand first' },
      ];
      deps.appendNotice(`A question for you: ${question}`);
      const picked = await select(deps.host, deps.theme, { title: question, options: opts, maxVisible: 8 });
      if (picked === null) {
        deps.appendNotice('(you did not choose - it was told to use its own judgement)');
        return { content: [{ type: 'text' as const, text: ASK_USER_CANCELLED }], details: { answered: false, reason: 'cancelled' } };
      }
      if (picked === DISCUSS) {
        deps.appendNotice('(you chose to talk it through - it was asked to lay out the trade-offs and wait)');
        return { content: [{ type: 'text' as const, text: ASK_USER_DISCUSS }], details: { answered: false, reason: 'discuss' } };
      }
      const idx = Number(picked);
      const chosen = options[idx];
      if (!chosen) {
        // 越界只可能是内部错 —— 但也**不抛**:抛了模型会重试, 重试会再弹一次框。
        return { content: [{ type: 'text' as const, text: ASK_USER_CANCELLED }], details: { answered: false, reason: 'cancelled' } };
      }
      deps.appendNotice(`you chose: ${chosen.label}`);
      return {
        content: [{ type: 'text' as const, text: `User chose: ${chosen.label}` }],
        details: { answered: true, index: idx, label: chosen.label },
      };
    },
  };
  return [tool];
}
