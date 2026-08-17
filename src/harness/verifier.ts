/**
 * src/harness/verifier —— omd executor-DAG 的**跨模型校验器** (model-agnostic skeptic)。
 *
 * 落地页角色卡 "Verifier" 的实装: 一个**不绑任何 CLI** 的怀疑者, 职责是**攻击结果而非盖章放行**。
 * DAG 跑完 → 把原任务 + 计划 + 各 leaf 输出交给 verifier → 它逐条对照任务的明确要求, 渲染
 * pass/fail + reason。fail 且配了可用升级模型 → executor-dag 用更强 conductor 重规划重跑 (静默升级)。
 *
 * 为什么 cross-model 而非同模型自审: 同模型自审会**复用同一盲点** (它造的坏计划自己看不出坏)。
 * 默认 verifier 模型走 resolveRoleModel('verifier') = deepseek (≠ 默认 mimo conductor/leaf), 形成
 * 真正的跨模型对抗。env OMD_VERIFIER_MODEL / .omd/config.json 可换。
 *
 * 经济学 (见 [[project-omd-dag-executor-seam]] + conductor 模型校准): conductor 每 task 只跑一次,
 * 坏计划让一整轮 leaf 白干 (风险不对称) → verifier 兜底让弱 conductor 可安全降级: 弱模型造图 +
 * verifier 校验 + 失败才升级强模型。**没配 SOTA 升级模型 (provider 未注册) → 维持弱模型** (executor-dag
 * 内的 provider gate 自动判定, 见 escalationProviderReady)。
 *
 * Invariants:
 *  VER-1 verifier 永不阻断: 抛错由调用方 (executor-dag) 兜; 未结构化输出 → 保守判 fail (不静默放行)。
 *  VER-2 全 leaf 失败 → 不调模型直接 fail (省一次调用, 显然无产出)。
 *  VER-2b 零节点产出 (results 空) → 同样直接 fail: **0 有效样本 ≠ 通过**, 且与 VER-2 分开报判词。
 *  VER-3 信 verifier 的 pass 布尔 (任务要求逐条对照已进 prompt); reason 必带 (fail 时点名缺啥)。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { send, listProviders, assertModelResolvable } from '../model/gateway';
import { resolveRoleModel, listRoleModels } from '../model/gateway';
import { tryResolveSeatModel } from '../model/role-models';
import { seatSpec } from '../model/seats';
import { effectiveSeatSampling } from '../model/seat-overrides';
import { withGoFallback } from '../model/gateway';
import { logger } from './logger';
import type { ModelUsage } from '../model/gateway';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';
import type { BlameEntry } from './dag/blame';

export interface VerifierVerdict {
  /** 结果是否满足任务的全部明确要求 (true = 放行)。 */
  pass: boolean;
  /** fail 时点名缺哪条要求 / 哪里捏造 + 该怎么改 (机制级)。pass 时可空。 */
  reason: string;
  /** 校验调用的 token 用量 (fast-path 时 {in:0,out:0})。 */
  usage: ModelUsage;
}

/** 校验器: 看 (原任务 + 计划 + leaf 结果) → 渲染裁决。注入式 (executor-dag 的 config.verifier)。 */
export type VerifierFn = (req: {
  task: string;
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  /** S-33: 产物三态 (registered/unregistered/missing) 的解析根 (相对 output_path 按它解析)。省略 = 不判产物三态, 卷面逐字节同旧。 */
  artifactRoot?: string;
}) => Promise<VerifierVerdict>;

/** 校验启停状态标 (让"校验已禁用"可见, 防静默丢护栏)。供 boot log / TUI / 状态行读。 */
export type VerifierStatusReason =
  | 'on' // 校验启用
  | 'off:flag' // OMD_VERIFY=0 显式关
  | 'off:unresolved' // 默认 verifier 模型坐标解析不了 → 降级关 (非 explicit)
  | 'off:invalid-explicit'; // 显式配的 verifier 坐标坏 → 响亮警告 + 降级关 (boot 永不砖)
export interface VerifierStatus {
  enabled: boolean;
  reason: VerifierStatusReason;
  /** enabled 时的 verifier 坐标 (off 时 undefined)。 */
  verifierModel?: string;
}

/** verifier / escalation 的配置片段 (wiring 层经 resolveVerification 产, spread 进 dag config)。 */
export interface VerificationConfig {
  verifier?: VerifierFn;
  conductorEscalationModel?: string;
  maxEscalations?: number;
  /** 校验启停状态标 (始终给, 每条返回路径都设 — off 状态可见)。executor-dag 不读, 供状态层展示。 */
  status: VerifierStatus;
}

export const VERIFIER_VERDICT_SCHEMA = z.object({
  pass: z.coerce.boolean(),
  reason: z.coerce.string(),
});

/**
 * D-1 产出侧助手 (SDD 2026-08-10-blame-scoped-node-retry): 把结构化责备集并进判词散文,
 * 产出 `dag/blame.ts` 的 `parseBlameVerdict` 能解出的 reason。冻结格式同 `BLAME_FENCE`:
 * ```` ```blame\n<BlameEntry[] JSON>\n``` ````, 围栏外散文原样保留 (人读面不变)。
 *
 * **判不出具体节点/产物时别调它** —— 纯散文 reason → 解析 undefined → 下游走现行整轮
 * fail-open (INV-1, 行为逐字节不变)。entries 为空同样原样返回: 空数组会被解析器当不合形拒掉,
 * 与「没附围栏」等价 —— 与其发一个注定作废的围栏, 不如不发。
 * 本函数只做**序列化**, 不做任何解析/校验 —— 责备集语义的唯一实现在 blame.ts (INV-1: 无第二套)。
 */
export function withBlameFence(reason: string, entries: BlameEntry[]): string {
  if (entries.length === 0) return reason;
  return `${reason}\n\`\`\`blame\n${JSON.stringify(entries)}\n\`\`\``;
}

/**
 * 把 DAG 结果汇成给 verifier 看的一段 (失败节点标注, 每节点截断防爆 prompt)。
 *
 * **command 节点必须带上命令串与退出码** (2026-08-01, 校准量出来的)。这道闸的判词是
 * 「默认怀疑, 证据不足时判不通过」, 而此前这里只给 `goal + stdout` —— 于是它看见一个裸的
 * `93`, 既不知道那是哪条命令跑出来的、也不知道退出码, 只能照自己的判据判不过。
 * 六条 fixture 的校准里, **唯一一条它判错的**(真做到了却判不过)判词逐字写着:
 * 「未展示所执行的具体命令与退出码」—— 它要的两样东西**引擎手里都有**
 * (`plan.nodes[id].command` · `LeafResult.exitCode`), 只是没递给它。
 *
 * 这正是 command 节点存在的全部意义: 它是**确定性 oracle** —— 命令串在规划期就定死、退出码
 * 由内核给。把这两样藏起来, 等于请一个怀疑者来审, 却把唯一不需要信任的证据扣下, 逼他去信
 * 一段自述。**假红**由此而来, 而假红的下一步是 escalation 重规划 —— 空转的账就是这么记上的。
 *
 * ⚠ 失败节点的正文仍是 `(failed)` (原样未动 —— 那条没有校准读数支持, 别搭车改);
 * 但退出码照给, 因为 `-1`(闸拒, 命令没跑) 与 `1`(命令跑了、断言没成立) 的下一步相反,
 * 而这个区分此前只能靠下游毒化文案**间接**漏给它。
 *
 * **S-33 产物三态** (2026-08-14): `output_path` 声明了写的节点, 每条都对**盘上真实状态** (`statSync`)
 * 核一次, 分三态入卷 (`artifact: <path> [<state>]`):
 *   - `registered`   盘上有 且 leaf 自报的 `filesTouched` 里也有 —— 正常态。
 *   - `unregistered` 盘上有 但 `filesTouched` 没登记 —— **单独标出并显式告警**: 这不是产物问题,
 *     是**节点上报链的缺陷** (leaf 真写了却没报), 别让判卷官误读成"没写"。
 *   - `missing`      盘上没有 (不论 `filesTouched` 怎么说) —— 声明了却不存在, 该拦。
 * ⚠ `missing` 与失败节点写死的 `(failed)` 正文是**两条独立的线**: 正文不动 (上一条注释的约束),
 * 但缺失的具体路径必须单独出现在 `artifact:` 行上, 不许被 `(failed)` 整体替换吞掉。
 * 只在传了 `artifactRoot` 时判 (省略 = 不判, 卷面逐字节同旧, 老调用方零回归) —— 相对路径按它解析。
 */
export function summarizeResults(
  plan: ConductorPlan,
  results: Record<string, LeafResult>,
  artifactRootOrMaxPerNode?: string | number,
  maxPerNode = 1200,
): string {
  const artifactRoot = typeof artifactRootOrMaxPerNode === 'string' ? artifactRootOrMaxPerNode : undefined;
  const effMaxPerNode = typeof artifactRootOrMaxPerNode === 'number' ? artifactRootOrMaxPerNode : maxPerNode;
  const lines: string[] = [`plan: ${plan.name} · ${Object.keys(results).length} nodes`];
  for (const [id, leaf] of Object.entries(results)) {
    const node = plan.nodes[id];
    const head = `### ${id} [${leaf.status}]${node?.goal ? ` — ${node.goal}` : ''}`;
    const meta = [
      node?.command ? `$ ${node.command}` : '',
      leaf.exitCode === undefined
        ? ''
        : `exit ${leaf.exitCode}${leaf.exitCode < 0 ? ' (command-leaf 闸拒 — 命令未执行)' : ''}`,
    ].filter(Boolean);
    if (artifactRoot && node?.output_path) {
      const resolved = isAbsolute(node.output_path) ? node.output_path : join(artifactRoot, node.output_path);
      let onDisk = false;
      try {
        statSync(resolved);
        onDisk = existsSync(resolved);
      } catch {
        onDisk = false;
      }
      const touched = (leaf.filesTouched ?? []).includes(node.output_path);
      const state = !onDisk ? 'missing' : touched ? 'registered' : 'unregistered';
      meta.push(`artifact: ${node.output_path} [${state}]`);
      if (state === 'unregistered') {
        meta.push(
          `⚠ ${node.output_path} 盘上真有, 但节点未在 filesTouched 里登记 —— 这是节点上报链的缺陷, 不是产物没写。`,
        );
      }
    }
    const body = leaf.status === 'failed' ? '(failed)' : (leaf.output ?? '').slice(0, effMaxPerNode);
    lines.push([head, ...meta, body].join('\n'));
  }
  return lines.join('\n\n');
}

/**
 * **判卷真值** (D-5, SDD `docs/plan/2026-08-11-inner-loop-v2-control-inversion.md`) ——
 * harness 在**注入面**知道、而判卷面此前拿不到的那几份值。
 *
 * 实证判例 (本仓 `.omd/dag-runs.db` run `4a609621`, 2026-08-10 probe, 判词逐字):
 * 「唯一保留意见: 句中『信任 token 03880693』**在我可见的任务文本里无对应来源, 无法核验**」。
 * 那个 token 是引擎自己注入进 leaf prompt 最开头的 (engine 的 runNonce → prompt-fence 的
 * `trustHeader`), 而判卷官只拿到原始 task + 结果摘要。**注入面知道真值、判卷面拿不到 = 确定性假阳**:
 * verifier 章程 (默认怀疑) 是对的, 拿闭卷考开卷题是错的。
 *
 * 所以真值随卷 —— 不是放宽判据, 是把「只能信一段自述」换成「能逐字符比对」。
 */
export interface JudgingTruths {
  /** A8 本轮信任 token (engine 的 runNonce, 见 prompt-fence.ts)。 */
  trustToken?: string;
}

/**
 * 每份真值的**卷面写法** (键 → 判卷官读得懂的一行)。
 * 注入面新增一份判卷相关真值 = 在这里加一行; 加漏了, 装配期闸 (`assertJudgingTruthsCarried`)
 * 就会因为「值没出现在卷面上」当场抛 —— 这正是本表不做成通用登记框架也不会静默漂的原因。
 */
const TRUTH_LINES: { [K in keyof Required<JudgingTruths>]: (v: string) => string } = {
  trustToken: (v) =>
    `- **信任 token (A8)** = \`${v}\` —— harness 在任务正文最开头注入的 (prompt-fence 的 runNonce), ` +
    `**它不出现在原始任务文本里是设计如此**, 不是执行体编的。结果里出现的 token 与上面这串**逐字符相同** ` +
    `→ 已核验为真, 不构成"凭空编造"; 不同 / 伪造 / 该带却没带, 才是问题。`,
};

/** 把判卷真值渲染成卷面一段。一份都没有 → 返回空串 (卷面逐字节同旧, 老调用方零回归)。 */
export function renderJudgingTruths(truths: JudgingTruths): string {
  const lines = (Object.keys(TRUTH_LINES) as (keyof JudgingTruths)[])
    .map((k) => (truths[k] ? TRUTH_LINES[k](truths[k]!) : ''))
    .filter(Boolean);
  return lines.length === 0
    ? ''
    : `\n判卷真值 (harness 注入面给的确定性事实, **不是**执行体自述 —— 可逐字符比对):\n${lines.join('\n')}\n`;
}

/**
 * **装配期闸** (D-5 / G-4 前半): 断言「判卷官拿到 = 判卷所需全部真值」——
 * 每份注入的真值都必须**真的出现在卷面上**, 缺一份即抛, 错误指名是哪一份。
 *
 * 为什么是抛而不是记一行 warn: 缺的后果是判卷官闭卷考 → 确定性假阳 → escalation 重规划空转,
 * 而那笔账要跑完整张 DAG 才记上。**拒起跑**是唯一能让它在花钱之前可见的形式 (fail-loud)。
 */
export function assertJudgingTruthsCarried(truths: JudgingTruths, paper: string): void {
  const missing = Object.entries(truths)
    .filter(([, v]) => typeof v === 'string' && v.length > 0 && !paper.includes(v))
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `verifier: 判卷真值未随卷 — ${missing.join(', ')} (harness 注入面已知, 判卷面拿不到) → 拒起跑。` +
        ` 修法: 在 verifier.ts 的 TRUTH_LINES 里给这份真值补一行卷面写法 (D-5)。`,
    );
  }
}

function verifierPrompt(task: string, summary: string, truths: JudgingTruths = {}): string {
  return `你是一个**跨模型校验者**, 审一个多步任务的执行结果是否真正满足任务。你的职责是**攻击结果、找出它没满足任务的地方**, 而不是盖章放行 —— 默认怀疑, 证据不足时判不通过。

判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数、字数/篇幅、必须覆盖的子部分、必须标注的东西、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行)。**逐条**对照结果。

不通过 (pass=false) 的判据 (任一命中即不过):
1. 任一明确要求未满足 (即使整体看起来不错) —— reason 点名缺了哪条。
2. **高风险接缝** (契约边界 / 状态机 / 法定数字 / 安全) 即使"看起来对"也要质疑其正确性; 无法确证正确 → 不过。
3. 结果是**捏造的数据 / 假执行确认** (凭空编输入、"已发送/已录入" 这类没真做却声称做了的) → 不过。
4. 计划有节点失败导致结果不完整 → 不过。
${renderJudgingTruths(truths)}
原始任务:
---
${task}
---

执行结果:
---
${summary}
---

输出 JSON 两字段:
- pass (bool): 结果是否满足任务全部明确要求且无捏造。这是裁决。
- reason (string): pass=false 时**必填** —— 缺哪条要求 / 哪里捏造或不可信 + 重新规划时该怎么修 (机制级, 不是"不够好")。pass=true 时一句话说明已覆盖。

责备集 (可选输出, 只在你能**确定**失败具体出在哪个节点/产物时用):
- 「执行结果」里每段以 \`### <id> [状态]\` 开头 —— 那个 <id> 就是 DAG 节点 id, 与计划节点一一对应。
- 失败能指认具体节点/产物时, 在 reason 里追加一个 \`\`\`blame 围栏, 围栏内是**一行 JSON 数组** (冻结格式, 见 dag/blame.ts 的 BLAME_FENCE), 每条二选一:
  - {"node": "<节点id>", "reason": "为什么是这个节点"} —— node 逐字照抄 \`### <id>\` 里的 id (写错=点名无效, 不会被定点重跑)。
  - {"artifact": "<产物标识>", "reason": "为什么是这个产物"} —— 产物不对时才用 (如输出文件路径)。
  - 多个节点/产物就并列多条; 每条 reason 都是机制级 (缺什么 / 错在哪 / 下轮怎么修)。
  格式示例 (围栏语言标签 \`blame\` 即协议标记, 不能少):
  \`\`\`blame
  [{"node": "draft", "reason": "草稿验收不合格"}]
  \`\`\`
- **确定不了**具体是哪个节点/产物 → **不要**附围栏, reason 保持纯散文。判不出节点的打回走整轮重跑, 这是设计内的兜底, 不是失职。
- 围栏是硬协议: 解析器只认 \`\`\`blame 围栏 + 合法 JSON 数组; 格式错 / 空数组 → 围栏作废 = 整轮重跑 (fail-open)。`;
}

export interface DefaultVerifierOpts {
  /** 校验模型 'provider:modelId'。falsy → 调用时抛 (fail-closed 配置错, 不静默)。 */
  verifierModel: string | undefined;
  /** 校验推理档 (默认 xhigh=max — 对抗式审查值得最大推理; flash 基座便宜 + max effort = Nick 2026-06-16)。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof send;
  /** D-5 判卷真值 (harness 注入面知道的那几份)。省略 = 一份都不随卷, 卷面逐字节同旧。 */
  truths?: JudgingTruths;
}

/** 造默认跨模型校验器。全 leaf 失败 → 不调模型直接 fail (VER-2); 否则 callModel → 信其 pass 布尔。 */
export function createDefaultVerifier(opts: DefaultVerifierOpts): VerifierFn {
  const call = opts.callModelFn ?? send;
  const truths = opts.truths ?? {};
  // D-5 / G-4: **装配期**就把卷面渲染一次并断言真值都在上面 —— 缺即抛 = 拒起跑。
  // 放在这里而不是判卷时: 判卷时才发现, 已经跑完一整张 DAG 了 (那笔账正是这条契约要省的)。
  assertJudgingTruthsCarried(truths, verifierPrompt('', '', truths));
  return async ({ task, plan, results, artifactRoot }): Promise<VerifierVerdict> => {
    if (!opts.verifierModel) {
      throw new Error('verifier: verifierModel 必填 (无硬默认, 形如 provider:modelId)');
    }
    const leaves = Object.values(results);
    // VER-2b (2026-08-09 补): **零节点产出的跑永不算通过**。
    // 原判据写的是 `leaves.length > 0 && 全 failed`, 那个 `> 0` 让"一个 leaf 都没跑完"从闸边上溜过去 ——
    // 于是 verifier 拿着一份 `plan: X · 0 nodes` 的空摘要去问模型, 而模型对着空摘要照样可能判 pass。
    // 0 有效样本 ≠ 通过: 什么都没量到的跑不许是绿的 (`run-outcome.ts` 的「空图不编 success」是同一条判据
    // 的另一半, 那边早就这么写了)。与全 failed **分开报** —— 「没跑」和「跑了全挂」是两件事 (NULL ≠ 0)。
    if (leaves.length === 0) {
      return { pass: false, reason: '零节点产出 — 一个 leaf 都没跑完, 0 有效样本 ≠ 通过', usage: { in: 0, out: 0 } };
    }
    // VER-2: 全失败 → 显然无产出, 省一次调用。
    if (leaves.every((l) => l.status === 'failed')) {
      return { pass: false, reason: '所有 leaf 执行失败 — 计划无产出', usage: { in: 0, out: 0 } };
    }
    const summary = summarizeResults(plan, results, artifactRoot);
    // A② GO fallback: verifierModel 走 opencode-go 端点溢出 → 回退 ds-v4-pro 官方 (跨模型校验不能因 GO 抖动整轮失败)。
    const r = await withGoFallback(opts.verifierModel, (m) =>
      call({
        model: m,
        // #144 洞 1: 这一发此前**不带 role** → 落进 seat-usage 的 `(unattributed)` 桶,
        // 于是"verifier 到底烧了多少"结构上答不出来。标签原文即座位名。
        meta: { role: 'verifier' },
        messages: [{ role: 'user', content: verifierPrompt(task, summary, truths) }],
        // 采样意图取自座位登记表 (model/seats.ts): 终审要**稳定** —— 同一份产出不该这次过下次不过。
        // C4: 座位采样经 config.seats 覆盖层 (无覆盖 = 编译期表逐字节同值)。
        ...effectiveSeatSampling('verifier'),
        // xhigh 推理档 + 700 预算 = reasoning 必吃光正文 (这是审查 oracle 闸, 空裁决最伤)。
        maxTokens: 8192,
        // 档由**座位登记表**驱动 (同 gate: 别让 seats.ts 写的东西到不了调用上)。
        // ⚠ 它今天坐在 codex 上, 而那家**关不掉思考** —— 2026-08-01 实测 xhigh 与 off 两臂逐字相同,
        // `reasoning=undefined` 时 gpt-5 照样内部推理。所以这个旋钮此刻是**没有效果**的, 不是没接。
        // 一旦这个座位挪到关得掉思考的模型 (如 deepseek), gate 那组对照就直接适用 —— **重量一次再定档**。
        thinkingLevel: opts.thinkingLevel ?? seatSpec('verifier')?.thinking ?? 'xhigh',
        responseSchema: VERIFIER_VERDICT_SCHEMA,
      }),
    );
    const v = r.parsed as { pass: boolean; reason: string } | undefined;
    // VER-1: 未结构化输出 → 保守 fail (不静默放行)。
    if (!v) return { pass: false, reason: 'verifier 未结构化输出 → 保守判不通过', usage: r.usage };
    const pass = v.pass === true;
    return { pass, reason: pass ? v.reason ?? '已覆盖任务要求' : v.reason ?? '未满足任务要求', usage: r.usage };
  };
}

export interface ResolveVerificationOpts {
  /** 关掉校验 (返空 config = 无 verifier, executor-dag 退回无校验老行为)。默认开。 */
  enabled?: boolean;
  /** 校验模型坐标。省略 = resolveRoleModel('verifier') (默认 deepseek, 跨 mimo conductor)。 */
  verifierModel?: string;
  /**
   * conductor 升级模型坐标 (verifier fail 时重规划用)。省略 = env OMD_CONDUCTOR_ESCALATION_MODEL。
   * **provider 未注册 (没配 API key) → executor-dag 自动不升级, 维持弱模型** (Nick 指令)。
   */
  escalationModel?: string;
  /** verifier-fail → 升级重规划的最大次数 (默认 executor-dag 的 1)。 */
  maxEscalations?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  callModelFn?: typeof send;
  env?: Record<string, string | undefined>;
}

/**
 * wiring 层助手: 据 role-models + env 产 {verifier, conductorEscalationModel}, spread 进 dag config。
 * executor-dag 保持纯净 (不读 env / role-models, 设计锁); 这层负责"默认走哪个模型 + 升级模型从哪来"。
 */
export function resolveVerification(opts: ResolveVerificationOpts = {}): VerificationConfig {
  if (opts.enabled === false) {
    logger.info('[omd/verifier] 跨模型校验: OFF (OMD_VERIFY=0 显式关)');
    return { status: { enabled: false, reason: 'off:flag' } };
  }
  const env = opts.env ?? process.env;
  // **中间版** (fail-fast vs 优雅降级 的折中): 坐标坏时的行为分两种 ——
  //   · explicit (opts.verifierModel / OMD_VERIFIER_MODEL / file / override 指定过) → 用户明确要 verifier,
  //     坐标坏 = typo, **fail-fast throw** (别让他以为开着其实没开)。
  //   · 仅出厂 default 兜底 (没人显式配) 解析不了 → verifier 是可选增强, **优雅降级关闭**, 不砖 boot。
  // 两路都在 boot 早 detect (非等 leaves 跑完才在 verify 处崩, 那才是原始 footgun)。
  const verifierSource = listRoleModels(env).find((e) => e.role === 'verifier')?.source ?? 'default';
  const explicit = !!opts.verifierModel || verifierSource !== 'default';
  const verifierModel = opts.verifierModel ?? resolveRoleModel('verifier', env);
  try {
    assertModelResolvable(verifierModel, 'verifier');
  } catch (err) {
    // boot 永不砖 (owner 锁 2026-07-19): 配错 ≠ 不能启动 —— 用户必须能进 TUI/`omd init` 修配置。
    // explicit 配错时用 error 级响亮警告 (别让他以为开着) + 状态带 'off:invalid-explicit' 供 /config 展示。
    if (explicit) {
      logger.error(
        { verifierModel, err: (err as Error).message },
        `[omd/verifier] 跨模型校验: OFF — 显式指定的 verifier 模型无法解析 (typo? provider 未注册/缺 key?) ` +
          `— 修正 OMD_VERIFIER_MODEL / config.json 的 verifier 为完整 provider:model, 或跑 omd init 重配。`,
      );
      return { status: { enabled: false, reason: 'off:invalid-explicit' } };
    }
    logger.warn(
      { verifierModel, err: (err as Error).message },
      '[omd/verifier] 跨模型校验: OFF (默认 verifier 模型无法解析 → 降级; 设 OMD_VERIFIER_MODEL 启用)',
    );
    return { status: { enabled: false, reason: 'off:unresolved' } };
  }
  const verifier = createDefaultVerifier({
    verifierModel,
    thinkingLevel: opts.thinkingLevel,
    callModelFn: opts.callModelFn,
  });
  // `escalation` 座位经**单一 resolver** 解析 (INV-MODEL-1): config.models → env(正名 + 老名别名)
  // → auto-assign → defaultModel。此前这里直读 env, 于是 config 配了 escalation 也不生效 ——
  // 那个座位被 auto-assign 派了模型、被起跑自检查了凭证, 却没有任何人读它 (2026-07-28 空旋钮全仓扫)。
  const escalationModel = (opts.escalationModel ?? tryResolveSeatModel('escalation', { env })?.model)?.trim();
  logger.info(
    { verifierModel, escalationModel: escalationModel || undefined },
    '[omd/verifier] 跨模型校验: ON',
  );
  return {
    verifier,
    conductorEscalationModel: escalationModel || undefined,
    maxEscalations: opts.maxEscalations,
    status: { enabled: true, reason: 'on', verifierModel },
  };
}

/** escalation 模型是否可解析 (= 配了 key 或 pi 目录后备可达)。不可达 → 不升级, 维持弱模型。
 *  走完整解析链 (自有注册表 + pi-ai 目录后备) — 仅查 listProviders 会漏掉 kimi-coding 等
 *  OAuth provider (统一模型层后它们只在 pi 后备通道可达), 把 K3 挡在 escalation 位外。 */
export function escalationProviderReady(coord: string | undefined): coord is string {
  if (!coord) return false;
  try {
    assertModelResolvable(coord, 'escalation');
    return true;
  } catch {
    return false;
  }
}
