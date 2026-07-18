/**
 * src/harness/research/author-spec.ts — conductor-authored fanout spec (缝 A).
 *
 * 单一职责: conductor 一次结构化调用 → (goal, groundTruth) 自动 author 出领域专家
 * ResearchFanoutConfig。消灭手写 lens-spec 的出错源 (字段错 / 漏 persona / 丢灵魂)。
 *
 * 机制:
 *   1. system = "你是 researchFanout 的分解器" + TASTE_CORE 浸染 persona。
 *   2. user = goal + groundTruth。
 *   3. callModel(responseSchema=Zod) → JSON → 校验 → 有界重试 ≤2。
 *   4. question/groundTruth 强制用入参原文, 不让 conductor 篡改。
 */
import { z } from 'zod';
import { send as defaultCallModel } from '../../model/gateway';
import { TASTE_CORE } from '../taste';
import type { ResearchFanoutConfig, ResearchLens } from './fanout';
import { ModelError } from '../../model';

// ── Zod schema: mirror ResearchFanoutConfig (只校验 conductor 能写的字段) ──

const ResearchLensSchema = z.object({
  key: z.string().min(1, 'lens key 不能为空'),
  persona: z.string().min(1, 'persona 不能为空'),
  subAngles: z.array(z.string()).min(1, 'subAngles 至少一个'),
  abstraction: z.string().optional(),
}) satisfies z.ZodType<ResearchLens>;

const SynthesisFramingSchema = z.object({
  key: z.string().min(1),
  framing: z.string().min(1),
});

const JudgeCriterionSchema = z.object({
  key: z.string().min(1),
  criterion: z.string().min(1),
});

/** conductor 输出的内层 schema (不含 question/groundTruth, 那俩从入参取)。
 * **只含智识分解** —— 模型路由 (lens/reason/reduce/judge) 是编排策略, 由调用侧 config 控制,
 * 不让 conductor author (分解器幻觉模型名会让 reduce/judge 阶段全失败)。 */
const ConductorOutputSchema = z.object({
  lenses: z.array(ResearchLensSchema).min(1, '至少一个 lens'),
  synthesisFramings: z.array(SynthesisFramingSchema).min(1, '至少一个 synthesis framing'),
  judgeCriteria: z.array(JudgeCriterionSchema).min(1, '至少一个 judge criterion'),
});

type ConductorOutput = z.infer<typeof ConductorOutputSchema>;

/** system prompt 模板。TASTE_CORE 在调用侧注入 (不分行, 锚入 stable prefix)。 */
const SYSTEM_PROMPT = `你是 researchFanout 的分解器。你的任务是把高层研究 goal + ground-truth 解构成一组专家镜头。

规则:
1. 按 goal 选择 **真专家视角** (领域自激活: 会计问题→注册会计师 / 分布式系统→分布式系统架构师 / 安全问题→安全研究员 / harness 问题→harness 工程师 / UI 问题→首席设计师 / 业务→战略思考者)。
2. 每个 lens 给:
   - persona: 专家身份条件化 (身份+领域+视角, 注入以下工程品味)
   - subAngles: **不同** sub-angle (每个 leaf 一个, 不重采样, 不重复)
   - abstraction (可选): 高阶领域框架注入 (如 "Build Systems à la Carte: applicative vs monadic")
3. 每个 lens 的 persona 必须浸染以下工程品味:

${TASTE_CORE}

4. synthesisFramings: M 个不同的综合 framing (不同立场/方法学, 供后续综合产出候选)。
5. judgeCriteria: K 个评判维度 (adversarial 降单 judge 偏见)。
6. **不要选模型** —— 模型分配是编排策略, 由调用侧控制, 不归你。你只做智识分解。
7. **只输出 JSON**, 不输出 prose, 不输出 markdown 围栏。JSON 必须匹配以下 schema (仅这三个键):
   - lenses: [{key, persona, subAngles:[string,...], abstraction?}]
   - synthesisFramings: [{key, framing}]
   - judgeCriteria: [{key, criterion}]`;

/**
 * Conductor 一次结构化调用: (goal, groundTruth) → 领域专家 ResearchFanoutConfig。
 *
 * @param input.goal — 高层研究目标 (什么视角/做什么决策)。
 * @param input.groundTruth — 代码库 / 事实 ground-truth (注入每个 leaf 防幻觉)。
 * @param input.conductorModel — 分解器模型 (默认 env OMD_CONDUCTOR_MODEL → deepseek:deepseek-v4-pro)。
 * @param input.lensCount — 建议镜头数 (默认让 conductor 自定)。
 * @param input._callModel — 测试 fake 注入。
 * @returns 完整 ResearchFanoutConfig, question/groundTruth 强制 = 入参原文。
 * @throws {ModelError} 校验重试耗尽后的最后一次错误。
 */
export async function authorFanoutSpec(input: {
  goal: string;
  groundTruth: string;
  conductorModel?: string;
  lensCount?: number;
  /** 编排策略: 模型分配由调用侧控制, 不让 conductor author。默认 flash(广度)/pro(推理)。 */
  lensModel?: string;
  reasonModel?: string;
  _callModel?: typeof defaultCallModel;
}): Promise<ResearchFanoutConfig> {
  const call = input._callModel ?? defaultCallModel;
  const model = input.conductorModel ?? process.env.OMD_CONDUCTOR_MODEL ?? 'deepseek:deepseek-v4-pro';

  // 组装 user 消息: goal + groundTruth (lensCount 可选提示)
  let userContent = `## 研究目标 (goal)\n${input.goal}\n\n## 事实根据 (groundTruth)\n${input.groundTruth}`;
  if (input.lensCount !== undefined) {
    userContent += `\n\n请分解为约 ${input.lensCount} 个镜头。`;
  }

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userContent },
  ];

  // callModel 内建 responseSchema 结构化校验 + 有界重试 ≤2
  let response;
  try {
    response = await call({
      model,
      messages,
      responseSchema: ConductorOutputSchema,
      maxRetries: 2, // ≤2 retries → ≤3 attempts total
    });
  } catch (err) {
    // 把校验/parse 错误向上传递, 加 context
    if (err instanceof ModelError) {
      throw new ModelError(
        err.kind,
        `authorFanoutSpec: conductor 分解失败 (${err.attempts} attempt(s)): ${err.message}`,
        { attempts: err.attempts, cause: err },
      );
    }
    throw err;
  }

  const parsed = response.parsed as ConductorOutput;

  // 组装完整 ResearchFanoutConfig: question/groundTruth 强制用入参原文。
  // 模型分配由调用侧 (input) 控制, 非 conductor authored —— reduce/judge 不设 = researchFanout 回退默认。
  const config: ResearchFanoutConfig = {
    question: input.goal,
    groundTruth: input.groundTruth,
    lenses: parsed.lenses,
    synthesisFramings: parsed.synthesisFramings,
    judgeCriteria: parsed.judgeCriteria,
    lensModel: input.lensModel ?? process.env.OMD_LENS_MODEL ?? 'deepseek:deepseek-v4-flash',
    // synth/终审 模型路由: 显式 input > OMD_REASON_MODEL env > 默认 ds-pro。
    reasonModel: input.reasonModel ?? process.env.OMD_REASON_MODEL ?? 'deepseek:deepseek-v4-pro',
  };

  return config;
}
