/**
 * per-model 能力表 (owner 2026-07-28) —— 输出上限 + reasoning_effort 词表, **按模型不按 provider**。
 *
 * 修掉两个错配:
 *  1. providers.ts 的 provider 级 maxTokens = 该条目内**所有模型的最大值** → opencode-go 底下 deepseek 是
 *     384K, 于是 glm(官方 128K)/qwen(官方 65K) 全继承 384000, 不给 maxTokens 时会朝它们要 384K。
 *  2. index.ts 的 PROVIDER_EFFORTS 按 provider 键 → 聚合渠道 (opencode-go) 底下住着六个家族, 词表各不相同,
 *     全部落到 UNKNOWN_EFFORTS=['high']。而 qwen 实测**拒绝 'max'**, 发错就是 400 整节点白挂。
 *
 * 数字来源 = 各家官网 (注在每行), 词表 = 官网 ∩ **2026-07-28 实打探针**。探针是必要的:
 * 聚合渠道对未知参数往往照单全收 (能过 ≠ 上游真生效), 但**拒绝是确定信号**。
 * 新增一行前请同样先真打一次 API。
 */
import { logger } from '../logger';

export interface ModelCaps {
  /** 匹配 modelId (小写) 的前缀/正则。 */
  match: RegExp;
  /** 官方最大输出 token。调用方不显式给 maxTokens 时的上限依据。 */
  maxOutput: number;
  /** 该模型真正接受的 reasoning_effort 字面量 (由弱到强); [] = 不发该字段。 */
  efforts: readonly string[];
  /** 该模型不接受的采样参数 (发了就 400)。 */
  rejects?: readonly ('temperature' | 'topP')[];
  /**
   * **开着思考时**采样参数收下但不生效 (2026-08-01)。⚠ 注意限定词 —— 关了思考它是生效的。
   *
   * 与 `rejects` 是**两种不同的坏**, 别混:
   *   · `rejects` = 发了 400, 整节点白挂 —— 响亮, 一次就发现。
   *   · 这一条 = 发了没事, **但旋钮是空的** —— 安静, 可以骗人很久。
   * 后者更危险: 调用方以为自己在控发散度 (best-of-N 的 N 个 lens / 闸要可复现的裁决),
   * 而实际上什么都没发生。
   *
   * ⚠ **第一版把这条写成了无条件的 `honorsSampling: false`, 那是错的** —— 探针只在
   * `reasoning_effort=max` 下打过, 我却把结论写成了这个模型的固有属性。官方文档说清楚了它是
   * **思考模式的性质**: 于是同一个坐标关掉思考就能调温, 而无条件的登记会让人以为那条路也堵着,
   * 顺手抹掉一个真实存在的选择。**限定词是这条登记里最重要的部分。**
   *
   * 缺席 = **没验过**, 不等于生效 (同 `reportsCacheHit` 的三态纪律)。
   */
  samplingIgnoredWhenThinking?: true;
  /**
   * 这家**报不报** prompt-cache 命中 (2026-08-01)。`false` = 已知不报。
   *
   * 登记它是为了把读数板上的「未记录」从**不知道**变成**已知**: 效率轴此前只能说
   * "N 条没有 cacheHit 字段", 读的人分不清是"引擎漏记了"还是"这家根本不报" ——
   * 而两者的下一步相反 (去修引擎 vs 接受这半边永远算不出)。
   * 缺席 = 没验过, **不等于会报** (同这张表其余各位的三态纪律)。
   */
  reportsCacheHit?: false;
  source: string;
}

export const MODEL_CAPS: readonly ModelCaps[] = [
  {
    // api-docs.deepseek.com: 1M 上下文 · 最大输出 384K · reasoning_effort 官方 high/max
    // (low/medium 等同 high, xhigh 等同 max)。探针: 拒 'minimal', 其余全收。
    // 表记的是"**接受**哪些字面量"(发过去不 400), 不是"语义上等价于谁":
    // low/medium 官方说等同 high, 但探针证明确实收 —— 收就列上, 让调档意图能原样出门。
    match: /^deepseek-v4/,
    maxOutput: 384_000,
    efforts: ['low', 'medium', 'high', 'max'],
    // 2026-08-01 实测 (reasoning_effort=max, 同一 prompt 各 6 发): temp 0.0 与 temp 1.8 的输出
    // **分布一模一样**, 而且 **temp 0.0 本身就不确定** (6 发出了 3 个不同值) —— 后者是决定性的:
    // 真在生效的话 temp 0 该近乎恒定。
    // 官方口径 (api-docs.deepseek.com/guides/thinking_mode 「输入输出参数」) 逐字:
    //   「思考模式不支持 temperature / top_p / presence_penalty / frequency_penalty 参数。
    //     为了兼容已有软件, 设置这些参数不会报错, 但也不会生效。」
    // —— 是**思考模式**的性质, 不是这个模型的固有属性。关了思考它就认。
    samplingIgnoredWhenThinking: true,
    source: 'api-docs.deepseek.com/guides/thinking_mode (+2026-08-01 采样探针 n=6×2)',
  },
  {
    // platform.kimi.ai: 上下文 1,048,576 · max_completion_tokens 默认 131,072 (上限 1,048,576)
    // · 顶层 reasoning_effort low/high/max, 默认 max, 且**目前只有 max 真生效**; K3 恒开思考。
    // 默认取官方默认值 131,072 而非上限 —— 上限那个数是"输入+输出共享预算"的理论顶。
    match: /^kimi-k3/,
    maxOutput: 131_072,
    efforts: ['low', 'high', 'max'],
    // opencode-go 路由的 kimi-k3 一带 temperature/topP 就 400 (2026-07-27 实测, 裸调正常)。
    rejects: ['temperature', 'topP'],
    source: 'platform.kimi.ai/docs (+2026-07-27 实测)',
  },
  {
    // minimax.io/blog/minimax-m3 + platform.minimaxi.com: 1M 上下文 · 最大输出 131K (硬顶 524,288)。
    match: /^minimax-m3/,
    maxOutput: 131_072,
    efforts: ['low', 'medium', 'high', 'max'],
    source: 'platform.minimaxi.com/docs/guides/text-generation',
  },
  {
    // docs.bigmodel.cn/cn/guide/models/text/glm-5: 最大输出 128K
    // · thinking{type:enabled|disabled} 控开关, glm-5.2 另有 reasoning_effort 控深度 (high/max)。
    match: /^glm-5/,
    maxOutput: 128_000,
    efforts: ['high', 'max'],
    source: 'docs.bigmodel.cn/cn/guide/models/text/glm-5',
  },
  {
    // qwencloud.com/models/qwen3.7-max: 1M 上下文 · 最大输出 65.53K。
    // 官方走 enable_thinking/thinking_budget 而非 reasoning_effort; 探针实测**'max' 被 400 拒**,
    // 故词表封顶 high —— 这是"发错就挂"的那类, 宁可不省。
    match: /^qwen3\.7/,
    maxOutput: 65_536,
    efforts: ['low', 'medium', 'high'],
    source: 'qwencloud.com/models/qwen3.7-max (+2026-07-28 探针: max→400)',
  },
  {
    // qwen3.8-max (2026-08-05 进 judge 判优池时补的条目)。
    // ⚠ **不是照抄 3.7**: 同一发探针在 3.8 上 `max` 档**通过**了(3.7 是 400 拒),所以这条
    //   的 efforts 比 3.7 宽一格。两条各写各的 —— 合并成 `/^qwen3\.[78]/` 就等于把 3.8 封到
    //   high,白丢一档;反过来把 3.7 放开则是"发错就挂"。
    // ⚠ `maxOutput` **沿用 3.7 的 65.53K 且未实测**:它是保守值,少要不会挂、多要会。
    //   哪天判优输出被截断,先来查这一行。
    match: /^qwen3\.8/,
    maxOutput: 65_536,
    efforts: ['low', 'medium', 'high', 'max'],
    source: '2026-08-05 探针: effort max→200 OK; maxOutput 沿用 3.7 未实测',
  },
  {
    // mimo.mi.com/models/zh-CN/mimo-v2.5-pro: 1M 上下文 · 最大输出 128K
    // · thinking 走 extra_body {"type":"disabled"}。
    // effort 词表: 直连端点 2026-07-25 实测只认 low/medium/high ('max'/'minimal' 均 400)。
    match: /^mimo-v2\.5/,
    maxOutput: 128_000,
    efforts: ['low', 'medium', 'high'],
    source: 'mimo.mi.com/models (+2026-07-25 实测)',
  },
  {
    // developers.openai.com/api/docs/guides/reasoning: gpt-5.6 用 reasoning.mode + reasoning.effort,
    // max 为 Sol 专属。经 pi transport 走 Responses API, maxTokens 语义为 max_output_tokens。
    match: /^gpt-5/,
    maxOutput: 128_000,
    efforts: ['low', 'medium', 'high', 'max'],
    // Codex 通道一带 temperature 就 400:`Unsupported parameter: temperature`(2026-07-31 实测)。
    // 这条不是小事: 它撞上的是 **judge 座位** —— 每一轮判词调用直接抛错、环拿不到裁决,
    // 于是 goal 环在这个座位配置下**根本不可能收敛**, 而它表现出来的样子是"任务太难,一直在修"。
    // 实测那一跑空转了 65 分钟。topP 未单独验过, 不凭猜列进来。
    rejects: ['temperature'],
    // 2026-08-01 实测: 这家的 usage 里没有 prompt-cache 命中位 —— 一次真跑的 12 条 generation
    // 里 3 条"未记录", 正是 codex 那几发。**六个强座位的缓存收益因此不可观测**, 而同一跑的
    // deepseek 侧是 84~98%。登记下来, 读数板才说得出"这家不报"而不是"不知道"。
    reportsCacheHit: false,
    source: 'developers.openai.com/api/docs/guides/reasoning (+2026-07-31/08-01 实测)',
  },
];

/**
 * **采样参数按能力过滤, 而且丢弃要出声**(2026-07-31)。两条通道 (原生 / pi) 共用这一处 ——
 * 各写一份正是今天这个 bug 的成因: 原生那条早就在查表, pi 那条从来没查, 于是 codex 上每一发
 * 都带 temperature 出门、每一发 400, 而 judge 就坐在那个座位上。
 *
 * ## 为什么丢弃必须响
 *
 * 静默丢掉 400 是没了, 但换来一个**更安静的失效**: `plan/best-of-n.ts` 与 `plan/distill.ts`
 * 拿 temperature/topP 当**发散度**旋钮 (一个 lens 一档: 0.25/0.75, topP 0.85/0.9/0.95)。
 * 这些 lens 若跑在拒绝该参数的坐标上, 旋钮被悄悄吃掉 → **N 个 lens 塌成一模一样的 N 份**,
 * 你以为在发散, 其实在跑 N 遍同一个。那正是这个仓一直在杀的形状: 机制在、生产零生效。
 *
 * 今天是**潜伏**的 (lens/distill 座位现在都是 deepseek, 收 temperature), 但座位是配置,
 * 迟早有人把 lens 挪到强座位上 —— 到那天这条 WARN 就是唯一的线索。
 *
 * 每对 (坐标, 旋钮) **只吼一次**: best-of-N 一轮就是 N 发, 每发都吼会把日志刷成噪音,
 * 而噪音里没人看得见第一条 (同 langfuse 导出失败的那条纪律)。
 */
const droppedShouted = new Set<string>();
export function samplingFor(
  modelId: string,
  req: { temperature?: number; topP?: number },
  opts: { thinking?: boolean } = {},
): { temperature?: number; topP?: number } {
  const caps = capsFor(modelId);
  const rejects = caps?.rejects;
  // 「收下但不生效」是**思考模式**的性质 —— 关了思考同一个坐标就认这个旋钮 (见 caps 字段注)。
  const ignoredNow = caps?.samplingIgnoredWhenThinking === true && opts.thinking === true;
  const out: { temperature?: number; topP?: number } = {};
  for (const knob of ['temperature', 'topP'] as const) {
    const v = req[knob];
    if (v === undefined) continue; // 调用方没给 = 没有意图被丢, 不作声
    if (!rejects?.includes(knob)) {
      out[knob] = v;
      // **收下但不生效**那一类: 照发不误 (哪天它开始认了就自动生效, 猜错也不亏), 但要出声 ——
      // 否则"我配了 temperature 0.2 所以裁决可复现"会是一句没人质疑的假话。
      if (ignoredNow) {
        const k2 = `${modelId}::${knob}::noop`;
        if (!droppedShouted.has(k2)) {
          droppedShouted.add(k2);
          logger.warn(
            { model: modelId, knob, value: v },
            `[omd/model-caps] ${modelId} **开着思考时收下 ${knob} 但不生效** (官方: 不报错也不生效) —— ` +
              `这一发的"发散度/确定性"其实没被控制住。要它真生效: **把这个座位的 thinking 关掉**, ` +
              `或换一个思考模式下仍认采样的模型。同 (坐标,旋钮) 只吼一次。`,
          );
        }
      }
      continue;
    }
    const key = `${modelId}::${knob}`;
    if (droppedShouted.has(key)) continue;
    droppedShouted.add(key);
    logger.warn(
      { model: modelId, knob, value: v },
      `[omd/model-caps] ${modelId} 拒收 ${knob} → 已丢弃。**调用方要的"发散度"这一发没生效** —— ` +
        `若这是 best-of-N / distill 的某个 lens, 它与别的 lens 现在跑的是同一档采样。` +
        `后续同 (坐标,旋钮) 只进 debug。`,
    );
  }
  return out;
}

/** 测试用: 清"吼过了"标记。 */
export function _resetDroppedKnobShoutForTest(): void {
  droppedShouted.clear();
}

/** 查一个 modelId 的能力; 未登记 → undefined (调用方走保守兜底)。 */
export function capsFor(modelId: string): ModelCaps | undefined {
  const id = modelId.toLowerCase();
  return MODEL_CAPS.find((c) => c.match.test(id));
}

/** 该模型的官方最大输出; 未登记 → undefined。 */
export function maxOutputFor(modelId: string): number | undefined {
  return capsFor(modelId)?.maxOutput;
}
