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
import type { FixpointJudge, FixpointVerdict } from './fixpoint';

export const CONVERGENCE_VERDICT_SCHEMA = z.object({
  converged: z.coerce.boolean(),
  score: z.coerce.number().min(0).max(1),
  failureReason: z.coerce.string().optional(),
  /** D-4 DeltaTicket (P1.5): 产出有问题的节点 id (本轮 id 空间); 绑定层翻成指纹毒集禁止复用。 */
  rejectedNodes: z.array(z.coerce.string()).optional(),
});

/** 默认收敛阈值 (进 prompt 作 LLM 判收敛的 bar)。 */
export const DEFAULT_CONVERGENCE_THRESHOLD = 0.8;

export interface LlmJudgeOpts<R> {
  /** 评判模型 'provider:modelId'。falsy → 调用时抛 (fail-closed 配置错, 不静默)。 */
  judgeModel: string | undefined;
  /** 原始任务 (进 prompt 给 judge 对照目标)。 */
  task: string;
  /** 收敛阈值 (进 prompt 作 bar)。默认 0.8。 */
  threshold?: number;
  /** 从一轮 result 抽出 {status, summary}: status='failed' 走未收敛快路径; summary 给 judge 看。 */
  extract: (result: R) => { status: 'done' | 'failed'; summary: string };
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof send;
}

function judgePrompt(task: string, summary: string, round: number, threshold: number): string {
  return `你在评判一个多步任务第 ${round} 轮的执行结果是否**收敛** (质量已达可交付, 再迭代不会实质变好)。

判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数 (如"3 步")、字数/篇幅、必须标注的东西 (如"标依赖")、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行的结果)。**逐条**对照本轮结果。

收敛标准 (bar):
1. **任一明确要求未满足 → converged=false** (即使整体质量尚可)。failureReason 必须点名缺了哪条要求。
2. 结果是**真实交付物**而非捏造的数据/假执行确认 (如凭空编客户数据、"已发送/已录入" 这类没真做却声称做了的); 捏造 → converged=false。
3. 以上都过, 再看质量分 ≥ ${threshold} 视作收敛 —— 你须**内化这个标准**后给出 converged 布尔。

原始任务:
---
${task}
---

本轮执行结果:
---
${summary}
---

输出 JSON 四字段:
- converged (bool): 是否已达收敛标准 (不动点到达)。这是裁决, 必须与你的 score 一致。
- score (0..1): 质量分
- failureReason (string, converged=false 时必填): 缺哪条明确要求 / 哪里捏造 + 下一轮该怎么改 (机制级, 不是"不够好")
- rejectedNodes (string[], converged=false 时必填): **点名产出有问题的节点 id** —— 上面结果里每段
  \`### <id> [状态]\` 开头的那个 id, 逐字照抄。判据是"这段产出本身错了/缺了/是编的", 不是"这个节点无关"。
  **宁可多点名, 不可漏点名**: 没被点名的节点, 它这一轮的产出会被原样当作已批准结果复用进下一轮 ——
  漏点一个, 下一轮就在坏结果上继续盖。拿不准的点上。整轮都不可用就把所有 id 都列上。`;
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
      messages: [{ role: 'user', content: judgePrompt(opts.task, summary, round, threshold) }],
      temperature: 0.3,
      maxTokens: 4096, // 700 会被推理族的 reasoning 吃光 → 空裁决
      responseSchema: CONVERGENCE_VERDICT_SCHEMA,
    });
    const v = r.parsed as
      | { converged: boolean; score: number; failureReason?: string; rejectedNodes?: string[] }
      | undefined;
    if (!v) return { converged: false, score: 0, failureReason: 'judge 未结构化输出' };
    // 信 judge 的 converged 布尔 (threshold 已进 prompt); score 仅记录, 不二次覆盖判断。
    const converged = v.converged === true;
    return {
      converged,
      score: v.score,
      failureReason: converged ? undefined : v.failureReason ?? '未达收敛标准',
      // D-4: 收敛了就没有毒 (产出全批准); 未收敛才带票。judge 漏填 = 空票, 由绑定层记账 (不静默当"全批准")。
      ...(converged || !v.rejectedNodes?.length ? {} : { rejectedNodes: v.rejectedNodes }),
    };
  };
}
