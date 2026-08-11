/**
 * src/harness/pathfinder/run-tickets —— D-2 散雾出口的**纯核**
 * (契约 `docs/plan/2026-08-11-control-plane-unification.md` 切片 1)。
 *
 * ## 它补的是哪条缝
 *
 * S-1 的散雾成票此前**只挂 pathfinder 派发线** (`afk-hook.reflowGoalResults`): 只有从票派出去的
 * goal run, 结果回流时才提发现物。直接 `solve` / `dag_goal` 的 run 对决策地图**完全不可见** ——
 * 一整趟 run 的未决、发现物、熔断全留在 transcript 里, 人不去读就等于没发生 (SDD 实核注记:
 * `src/harness/goal/` 零 suggested/map_add 命中)。本模块是那条缝的纯核: **一次 run 的终态 →
 * 待开的 suggested 票清单**; 落图由 run-goal 收尾处接线 (拿到 map 句柄才开票)。
 *
 * ## 三条出口 (D-2)
 *
 * ① **契约段未决** —— spec 落盘文件的 `## 未决 (Open)` 段条目 → grill 票。
 * ② **execute 发现物** —— 词表**复用** {@link extractGoalDiscoveries} (S-1 D-G1.5 的唯一定义处)。
 *    本模块只决定**喂哪几行**给它, 不重写一份判据: 两处各算一份词表必漂, 本仓已为这条付过账。
 * ③ **终态面** (blocked / 预算停 / 同因熔断) —— 原因 + blame 摘要 + resume 把手 (G-2)。
 *
 * ## 为什么 ② 与 ③ **分两次**喂词表, 而不是喂一整份 summarizeGoal
 *
 * 词表的三条形里, `阻塞`/`预算停` 两条与 ③ 说的是同一件事, 而 ③ 的票是它的**超集**
 * (多了 blame 摘要与 resume 把手)。一整份喂进去会为同一件事开两张票 —— 一张能动手、一张只能干瞪眼,
 * 而 perRunCap 还会先把能动手的那张挤掉。于是按**输入行**切开: 终态两行走 ③ (标题主体仍由词表出,
 * 只在尾巴挂 blame+resume), stage 行走 ②。**判据仍只有一份**, 分的是喂给它什么。
 *
 * ## 人审票不审 transcript (D-2 验证不对称)
 *
 * 每张票的 title 必须**自足可判**: 出了什么事 + 为什么 + 下一步从哪接。runId 锚由
 * `suggestedBy` 携带 (INV-S1-2 必填, 且 suggestionsLog 逐条记它) —— 票 → runId → 回执双向可达。
 *
 * ## ⚠ 标题的**共同尾巴**会被 S-1 语义去重当成"同一张票"
 *
 * 实测 (hashEmbed 词袋空间, 2026-08-11 首跑当场抓到): 给每条未决票挂一个 `· spec: <文件名>`
 * 出处尾巴, 两条**内容完全不同**的未决 cosine 从 [0.3,0.4) 抬到 [0.5,0.6) (短条目直接 ≥0.8)——
 * 撞上 `applySuggestions` 默认阈值 0.6, 第二条起被静默折进第一条。首跑的症状就是"两条未决只落一张票"。
 * 于是 ① **不挂出处尾巴** (出处经 `suggestedBy` → run 回执可达)。
 *
 * ③ 的 `· resume: dag_goal resume=<runId>` 尾巴同样吃掉约 0.25 的距离 (实测 [0.2,0.3) → [0.5,0.6)),
 * 但它是 G-2 要求的把手, 留着 —— 记在这里是因为**它离 0.6 只剩一格**: 谁再往 ③ 的标题里加共同尾巴,
 * 不同终态就会开始互相吞。加之前先量一次, 别靠感觉。
 *
 * 纯: 零 IO / 零 LLM / 零时钟 (`at` 由调用方给)。spec 正文由调用方读进来 —— **读不到 = ① 缺席,
 * 不是"零未决"** (仓规第一条: NULL ≠ 0)。
 */
import { extractGoalDiscoveries } from './afk-hook';
import type { ApplySuggestionsOpts, ApplySuggestionsResult, SuggestionDraft } from './suggest';
import type { BlameRetryLedger } from '../dag/types';
import type { RunOutcomeKind } from '../run-outcome';
import type { GoalStage, RunGoalResult } from '../goal/run-goal';

/**
 * 开票落图的最小写入口 —— `PathBackend` 的**结构子集** (生产直接把 `resolveBackend(cwd)` 的结果
 * 传进来; `suggest` 是可选实装, 缺 = 该后端还没有 S-1 面 → 闸缺席)。
 * 这里不 import PathBackend 本身: 纯核不该知道 gh/md 后端的存在。
 */
export interface RunTicketSink {
  suggest?: (cwd: string, slug: string, drafts: SuggestionDraft[], opts: ApplySuggestionsOpts) => ApplySuggestionsResult;
}

/** collectRunTickets 的第二入参: run 结果**之外**的那些锚 (纯函数, 全部由调用方喂)。 */
export interface RunTicketContext {
  /** 票身 runId 锚 (INV-S1-2 `suggestedBy`)。空串 = 调用方缺陷, applySuggestions 会整批拒。 */
  runId: string;
  /** 契约段落盘 spec 全文。省略 = ① 出口缺席 (读不到 ≠ 零未决)。 */
  specText?: string;
  /** exec 图的 verifier 面 (`ExecutorDagResult.verification` 子集; 缺席 = 没配 verifier)。 */
  verification?: { pass: boolean; reason: string; circuitBroken?: boolean };
  /** D-4 打回读数 (`ExecutorDagResult.blameRetry`); 缺席 = 本 run 没被打回过。 */
  blameRetry?: BlameRetryLedger;
  /** resume 把手 (人可直接复制的一行)。省略 = `dag_goal resume=<runId>`。 */
  resumeHandle?: string;
}

/** 标题上限: 票是给人一眼判的, 不是给人读的; 也让指纹稳定在一句话上。 */
const TITLE_MAX = 180;

/** 压成单行并截断 (标题里出现换行会把 map markdown 的一行票撑成两行)。 */
function clip(s: string, n = TITLE_MAX): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/**
 * ② 不喂给词表的 stage 结局。**每一格都有独立理由**, 不是"看着像噪声"就滤:
 *  - `not-needed` / `missing-capability`: 「这一步不用跑」「缺件起不来」不是执行发现物。喂进去的话,
 *    每个 simple 档**成功** run 都会长出 `[未收敛·research] simple 档: …` 这种票 —— 直接撞 O-3
 *    (票量级噪声化)。
 *  - `blocked` / `budget-exhausted`: 同一件事归 ③ (那张票是超集: 带 blame + resume)。不开两张。
 *  - `cancelled`: owner 自己按的停, 是外部事件不是发现物。
 * 留下的 `not-converged` / `oracle-failed` / `infra-error` / `empty-result` 才是真发现物。
 * ⚠ `success` **刻意不在这张表里** —— 该不该收成票是词表的判断, 这里只管别喂错料。
 */
const NON_DISCOVERY_OUTCOMES = new Set<RunOutcomeKind>([
  'not-needed',
  'missing-capability',
  'blocked',
  'budget-exhausted',
  'cancelled',
]);

/**
 * stage 行的渲染 —— 必须与 `summarizeGoal` (src/mcp/tools/goal.ts) **逐字节一致**:
 * 词表的 stage 正则吃的就是那个形状。这里不能 import 它 (goal.ts → run-goal.ts → 本模块 = 环),
 * 于是漂移风险由 run-tickets.test.ts 的等价性测试钉住 (那里 import 得起 summarizeGoal)。
 */
function stageLine(s: GoalStage): string {
  return `  [${s.outcome}${s.status === 'done' ? '' : `/${s.status}`}] ${s.stage} — ${s.summary}`;
}

/**
 * ① 解析 spec 的「未决 (Open)」段: 段内**顶格** `-`/`*` 条目各成一条。
 * 续行 (缩进 / `·` 开头) 归属上一条但不单独成票 —— 一条未决就是一张票, 不按行拆。
 * 找不到该段 → 空数组 (这份 spec 没有未决段, 与"没读到 spec"由调用方分辨)。
 */
export function parseOpenItems(specText: string): string[] {
  const lines = specText.split('\n');
  const items: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // 标题行: 进/出「未决 (Open)」段。中英两种写法都收 (本仓 SDD 模板是「## 未决 (Open)」)。
      inside = /未决/.test(heading[2]!) || /\bopen\b/i.test(heading[2]!);
      continue;
    }
    if (!inside) continue;
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;
    const text = bullet[1]!.replace(/\*\*/g, '').trim();
    if (text) items.push(text);
  }
  return items;
}

/** ③ 终态面 (blocked / 预算停 / 同因熔断) → 票。标题主体仍由 S-1 词表出, 尾巴挂 blame + resume。 */
function terminalDrafts(r: RunGoalResult, ctx: RunTicketContext): Array<Omit<SuggestionDraft, 'suggestedBy'>> {
  const out: Array<Omit<SuggestionDraft, 'suggestedBy'>> = [];
  const resume = ctx.resumeHandle ?? `dag_goal resume=${ctx.runId}`;
  // blame 摘要: 点名了几个节点 / 失效闭包多大。缺席 = 本 run 没被打回过 —— 不编一个 0
  // (「没打回」与「打回但点名 0 个 (fail-open 走整轮)」是两件事, blameSize=0 正是后者)。
  const blame = ctx.blameRetry ? ` · blame ${ctx.blameRetry.blameSize} 节点/失效闭包 ${ctx.blameRetry.closureSize}` : '';
  // 同因熔断 (内环 v2 D-6): S-1 词表里**没有**这一形 —— 它早于熔断机制。原因面 = verifier 判词。
  if (ctx.verification?.circuitBroken) {
    out.push({ type: 'grill', title: clip(`[同因熔断] ${ctx.verification.reason}${blame} · resume: ${resume}`) });
  }
  const terminalLines = [
    ...(r.blocked ? [`阻塞 (需外部输入): ${r.blocked}`] : []),
    ...(r.budgetStopped ? [`预算停: ${r.budgetStopped}`] : []),
  ];
  for (const d of extractGoalDiscoveries(terminalLines.join('\n'))) {
    out.push({ type: d.type, title: clip(`${d.title}${blame} · resume: ${resume}`) });
  }
  return out;
}

/**
 * 一次 run 的终态 → 待开的 suggested 票清单 (D-2 三条出口, ③ → ① → ② 序)。
 *
 * **序不是审美**: perRunCap (默认 5) 从尾巴丢, 所以带 resume 把手的终态票排最前 —— 被挤掉的
 * 应该是"顺手记一笔"的发现物, 不是"这趟卡在哪、从哪接着跑"。
 *
 * 无未决 / 无发现物 / 正常收敛 → 空数组 (调用方据此不落图)。
 */
export function collectRunTickets(r: RunGoalResult, ctx: RunTicketContext): SuggestionDraft[] {
  const open: Array<Omit<SuggestionDraft, 'suggestedBy'>> = (ctx.specText ? parseOpenItems(ctx.specText) : []).map(
    // 未决 = 待人裁的问题 → grill (task 会被派发去"干", 而这里要的是先裁)。
    // 标题**不挂 spec 出处尾巴**: 实测它会把不同未决推过语义去重线 (见头注)。
    (item) => ({ type: 'grill' as const, title: clip(`[未决] ${item}`) }),
  );
  const discoveries: Array<Omit<SuggestionDraft, 'suggestedBy'>> = extractGoalDiscoveries(
    r.stages.filter((s) => !NON_DISCOVERY_OUTCOMES.has(s.outcome)).map(stageLine).join('\n'),
  ).map((d) => ({ type: d.type, title: clip(d.title) }));

  return [...terminalDrafts(r, ctx), ...open, ...discoveries].map((d) => ({ ...d, suggestedBy: ctx.runId }));
}
