/**
 * goal/rubric-judge —— **rubric 分型的逐条判官**(R-2, 2026-08-30, owner 裁形状 C)。
 *
 * ## 它补的那个洞
 *
 * `run-goal.ts` 的 rubric 流水线(冻检查 → 劣化自证 → 逐条判 → settle)**消费侧早就建成**,
 * 但它读的 `config.rubricVerdictInputs` 在生产里**恒缺席** —— 归因实测:rubric 类 success 数
 * = 0(240 trial),该分型**结构上不可能 success**,而这些题的 reward 均值反而高于整批。
 * 也就是说 30% 的题被记成失败,标签与成败零相关。
 *
 * ### 为什么原来那个形状谁也填不了
 *
 * `rubricVerdictInputs` 挂在 `RunGoalConfig` 上,**开跑前**由调用方给;而它要装的 `traces`
 * 是「对**真实产物**逐条判的结果」,产物**跑完才存在**。时序上不成立 ⇒ 无人注入不是忘了写。
 *
 * ### owner 裁的形状 C:就地实现 + 现有字段降级为测试注入口
 *
 * 生产由 `run-goal` 在验收时(产物已存在)调本模块算出 `{presented, traces}`;
 * `config.rubricVerdictInputs` 给了就**原样用**(测试控判词),不给才算。
 * 这与同一字段里 `_settleRubric` 的原注逐字同源:「仅供测试的注入点 —— 生产不传,走默认实装」。
 *
 * **不新开接缝**(没做成 `_judgeRubric?: (…) => …`):函数形的价值是「换一个判官实现」,
 * 而判官唯一会变的东西是模型,那个已经由座位表配了。判官本身直接单测,不绕接缝。
 *
 * ## `presented` 必须由**判官回显**重建 —— 否则那道冻检查恒绿
 *
 * `verifyFrozen(checklist, presented)` 比的是内容哈希。要是把冻结那份直接喂回去,
 * 这道闸**永远绿**(自己比自己)。而 `classifyGoal` 全程只调一次,一个 run 内没有第二份
 * 独立的 checklist 来源。
 *
 * 所以判官被要求**逐条回显 `{id, requirement}`**,`presented` 由回显重建。这样才真的能抓到:
 *   · 提示词把 checklist 截断了(长清单撞 token 预算);
 *   · 判官改写/漏判/多编了条目。
 * 两者都是**验收步上的移球门**,而且是静默的 —— 这道闸的全部价值就在这里。
 *
 * ## 反向自检
 *
 *  - 把 `presented` 改成直接返回入参 `spec.items` → `rubric-judge.test.ts` 的
 *    「判官漏一条 ⇒ presented 与冻结份不一致」当场绿(闸失效)⇒ 该用例即是它的证伪。
 *  - 把 `maxFailures` 默认从 0 改成 1 → 「一条不过就整体不过」当场红。
 */
import { z } from 'zod';
import type { GenerateFn } from '../dag/types';
import type { RubricItem, RubricItemTrace, RubricSpec } from './rubric-spec';

/**
 * 「几条不过算整体不过」的默认值。**0 = 全过才算过**(母契约未决第 1 条)。
 *
 * 母契约明写「本片不写 owner 数值」,所以这是**假设不是裁决**:取最保守的那一端。
 * 要放宽由调用方显式给 —— 放宽是 owner 的决定,不该由默认值悄悄替他做。
 */
export const DEFAULT_RUBRIC_MAX_FAILURES = 0;

const VerdictSchema = z.object({
  items: z.array(
    z.object({
      /** 判官回显的条目 id —— `presented` 由它重建, 所以**必须**回显。 */
      id: z.string().min(1),
      /** 判官回显的要求原文 —— 同上; 改写了就是漂, 冻检查会抓到。 */
      requirement: z.string().min(1),
      pass: z.coerce.boolean(),
      /** 理由不许空: 没理由的 yes/no 是投票不是判词 (rubric-spec.ts 的原话)。 */
      reason: z.string().min(1),
    }),
  ),
});

/** 逐条判的 prompt。**要求回显 id + requirement** —— 那是 `presented` 的唯一诚实来源。 */
export function rubricJudgePrompt(spec: RubricSpec, evidence: string): string {
  return [
    '你是**验收判官**。下面是一份**在产物之前就冻结**的 checklist, 和这次交付的证据。',
    '逐条判断每一条要求**成立还是不成立**, 只依据证据; 证据里看不出来的一律判不成立。',
    '',
    '<checklist>',
    ...spec.items.map((i) => `- id=${i.id} :: ${i.requirement}`),
    '</checklist>',
    '',
    '<evidence>',
    evidence.slice(0, 24_000),
    '</evidence>',
    '',
    '只回一个 JSON 对象:',
    '{ "items": [ { "id": string, "requirement": string, "pass": boolean, "reason": string }, ... ] }',
    '',
    '硬要求:',
    '1. `items` 必须**逐条覆盖上面 checklist 的每一条**, 顺序一致, 不多不少。',
    '2. `id` 与 `requirement` 必须**原样回显**上面那份 —— 不许改写、缩写、翻译或补充。',
    '   (这两位会被拿去与冻结的那份逐字节比对; 对不上整份判词作废。)',
    '3. `reason` 不许为空, 要指出证据里的哪一处支持这个判断。',
  ].join('\n');
}

/**
 * 跑一次逐条判。**失败一律返 `null`**(= 这一格缺席, fail-open 由调用方决定怎么读)——
 * 不编一份空 traces。
 *
 * ⚠ 这句话原来写的是「空 traces 会被 `settleRubric` 读成整体过」—— **那是错的, 实测它抛错**
 * (`rubric-spec.ts:116` 的「零痕迹不许判成通过」)。真正的理由更简单也更硬:
 * 「判不了」与「判过了」是两件事, 返一份空 traces 就是拿后者冒充前者 (§静默坑 1);
 * 而下游那道守卫是**保险不是许可** —— 不能因为它会抛就允许上游编空值。
 */
export async function judgeRubric(
  spec: RubricSpec,
  evidence: string,
  deps: { generate?: GenerateFn; model?: string },
): Promise<{ presented: RubricItem[]; traces: RubricItemTrace[] } | null> {
  const { generate, model } = deps;
  if (!generate || !model) return null;
  try {
    const { text } = await generate({
      model,
      traceName: 'judge:rubric',
      messages: [{ role: 'user', content: rubricJudgePrompt(spec, evidence) }],
      // 同 classify 那一发的理由: 省略不等于不限, 而正文被截断 ⇒ JSON 解析失败 ⇒ 整格缺席。
      maxTokens: 32_768,
    } as never);
    const parsed = VerdictSchema.safeParse(JSON.parse(extractJsonObject(text)));
    if (!parsed.success) return null;
    // `presented` **由回显重建**, 不是把 spec.items 喂回去 —— 见文件头「否则那道冻检查恒绿」。
    const presented: RubricItem[] = parsed.data.items.map((i) => ({ id: i.id, requirement: i.requirement }));
    const traces: RubricItemTrace[] = parsed.data.items.map((i) => ({ itemId: i.id, pass: i.pass, reason: i.reason }));
    return { presented, traces };
  } catch {
    // fail-open 但不吞证据: 调用方拿到 null 会在 summary 里写"验收步缺席", 不冒充零判。
    return null;
  }
}

/** 从模型输出里抠出第一个 JSON 对象(容忍 ```json 围栏与前后散文)。抠不到 → 原样返。 */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? text.trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  return start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
}
