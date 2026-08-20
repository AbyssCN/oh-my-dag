import type { ConductorPlan } from '../conductor-plan';
import type { ModelUsage } from '../../model/gateway';
import {
  type ProbeDiscriminationVerdict,
  type ProbeVacuityVerdict,
  probeDiscrimination,
  probeVacuity,
  type NegativeSample,
} from '../goal/acceptance-gate';

/**
 * 拓扑分层 (Kahn): level k = 所有依赖都在 level <k 的节点。环 → 抛错 (conductor 应产 DAG)。
 * 未知 dep 引用按"已满足"处理 (宽容, conductor 偶发引用不存在节点不应卡死整图)。
 *
 * ⚠ 两条口径的**当前归属** (2026-08-14, issue #25 —— 免得这段注释又变成幻象闸):
 *  - **环**: 首闸在 `PlanSchema` 的 superRefine (fail-closed, 造 plan 的入口全都过它)。这里的抛错
 *    退成兜底 —— 运行期挂进图的子节点 (map/conductor 展开) 不过 schema, 那条路仍靠它。
 *  - **未知 dep**: 没有闸, 就是宽容, 且 `dag-scheduler` 与本函数口径一致 (filter 掉 = 视为已满足)。
 *    它有 intentional 消费方 (子图截断), 所以只由 `plan/static-lint` **报告不拦截**。
 */
export function topoLevels(plan: ConductorPlan): string[][] {
  const ids = Object.keys(plan.nodes);
  const idSet = new Set(ids);
  const placed = new Set<string>();
  const levels: string[][] = [];
  while (placed.size < ids.length) {
    const layer = ids.filter(
      (id) =>
        !placed.has(id) &&
        (plan.nodes[id]!.depends_on ?? []).every((d) => !idSet.has(d) || placed.has(d)),
    );
    if (layer.length === 0) {
      throw new Error(`executor-dag: dependency cycle among [${ids.filter((i) => !placed.has(i)).join(', ')}]`);
    }
    layer.forEach((id) => placed.add(id));
    levels.push(layer);
  }
  return levels;
}

/**
 * 单个 leaf 的执行 prompt: [模板卡] + 节点目标/skill/args + 已完成前驱的输出 (fan-in context)。
 * 模板卡 (node.template 命中注册表时) 置于最前 — 早于 [omd leaf: id]: 同模板 sibling 共享
 * (system前缀+模板body) 的字节稳定前奏 → warmThenFanout 暖发后跨 sibling 命中 prompt-cache
 * (id 行在前会让前缀在 ~12 字符处分叉, 白丢整段模板的 cache 面)。
 */
/** 原始任务注入的字符上限 (超出显式标注截断 —— No-silent-caps)。 */
export const TASK_CONTEXT_MAX_CHARS = 4000;

export function buildLeafPrompt(
  id: string,
  node: ConductorPlan['nodes'][string],
  depResults: Record<string, string>,
  template?: { name: string; body: string },
  taskContext?: string,
): string {
  const parts: string[] = [];
  if (template) parts.push(`<agent-template name="${template.name}">\n${template.body.trim()}\n</agent-template>`);
  // ── 原始任务上下文 (2026-08-04, r2 实测买来的) ──────────────────────────────────
  //
  // 此前 leaf 的**全部世界**是「自己的 goal + 上游输出」—— 原始任务文本一个字都不进。
  // 而 conductor 是看着任务写 goal 的, 于是它理所当然地写出「从可信任务上下文逐字复制 q1–q8
  // 题义」这种 goal。那句话对它成立, 对节点不成立: 那个上下文根本没传下去。
  //
  // **为什么此前没炸**: agent 档的节点有工具, 它会自己跑去把任务文件翻出来读 —— 实测老的两跑
  // 24 节点里 6 个、18 节点里 5 个真的读了 `f2-task.md`。也就是说图从来没携带过题目,
  // 是 agent 在替图自救。g1 把读盘换成 command+leaf 之后自救通道断了, 立刻现形:
  // 一次 33 节点全绿的跑, 交付物是「未提供题义, 无法作答」(run 39450211)。
  //
  // 所以这不是"给 leaf 多点上下文"的优化, 是补一条**图本该有而一直没有的信息通道**。
  // 放在模板卡之后、id 之前: 一次 run 内所有 leaf 的这一段字节完全相同 → 前缀缓存吃得到。
  // 明确框成**背景**并让 Goal 紧随其后, 免得节点改去做整个任务 (收尾那句"只交本步产出"仍在)。
  if (taskContext?.trim()) {
    const t = taskContext.trim();
    const clipped = t.length > TASK_CONTEXT_MAX_CHARS;
    parts.push(
      `<original-task note="背景: 这是本次 run 的原始任务全文。你只负责下面 Goal 那一步; 引用它来补全 goal 里没写全的细节 (题目/格式/约束), 不要替别的节点干活。">\n` +
        `${clipped ? `${t.slice(0, TASK_CONTEXT_MAX_CHARS)}\n…[原始任务过长, 已截断 ${t.length - TASK_CONTEXT_MAX_CHARS} 字符]` : t}\n` +
        `</original-task>`,
    );
  }
  parts.push(`[omd leaf: ${id}]`);
  // 专家框定前置 (persona conditioning, 同 fanout 技法): 把弱 executor 拉进专家区。conductor 仅对吃
  // 专家视角的 leaf 设 (research/judgement/design/drafting), 缺省则无 (机械/file/command 节点不需)。
  if (node.persona) parts.push(`<persona>${node.persona}</persona>`);
  if (node.goal) parts.push(`Goal: ${node.goal}`);
  if (node.skill) parts.push(`Skill: ${node.skill}`);
  if (node.args && Object.keys(node.args).length > 0) parts.push(`Args: ${JSON.stringify(node.args)}`);
  const deps = node.depends_on ?? [];
  if (deps.length > 0) {
    const ctx = deps
      .filter((d) => depResults[d] !== undefined)
      .map((d) => `### ${d}\n${depResults[d]}`)
      .join('\n\n');
    if (ctx) parts.push(`Predecessor outputs:\n${ctx}`);
  }
  // 治 meta 碎话 + 省 output (Nick: leaf 不需要太多 output) + 治 genre 塌缩/捏造 (2026-06-03 高并发验证
  // 发现: "设计/拆步" 类任务被 leaf 当成 "执行一遍" 演 + 捏数据填空 → 显式禁止)。
  parts.push(
    "\nProduce this step's deliverable directly. If the goal is to design / describe / analyze / plan / draft, " +
      'OUTPUT that content — do NOT simulate performing the step, and do NOT fabricate data, results, or inputs you ' +
      'were not given. A one-line confirmation is only for when the deliverable actually went to a file/tool. ' +
      'No preamble, no meta-commentary, no restating the inputs. Be concise.',
  );
  return parts.join('\n');
}

/** ModelUsage 累加 (跨 plan/verify 尝试合计成本)。 */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { in: a.in + b.in, out: a.out + b.out, cacheHit: (a.cacheHit ?? 0) + (b.cacheHit ?? 0) };
}

// ── plan 过滤器 (plan 落地后、执行前的确定性挂点) ────────────────────────────
export { filterOracleCommandNodes } from '../oracle-plan-filter';

// ── self_check 判据自证 (P1 D-3 / INV-1-3) ─────────────────────────────────
//
// conductor 写出的 self_check 必须过 `acceptance-gate.ts` 的判别力/空世界自证。一份**明显错**的
// 产物上仍通过的判据被悄悄丢弃 (退回 INV-1-2 旁路, 不判节点红)。失败原文原样带回来, 给观测面
// 留证据 —— 那条留法在 #165/#204 反复被撞过 (灰日志不读等于没留)。
//
// 探针在 `acceptance-gate.ts` 是 fail-open:没样本 / 跑不起来 → 不拦。所以 `vetSelfCheck` 在没
// 接线的情况下恒放行 —— 那**不是**「判据一定可信」的承诺, 而是把这条闸写在调用面由 caller 决定
// 跑多严。本期落地后 caller (goal 引擎) 给的是空目录 vs 真仓副本二选一, 默认真仓副本; 测试侧注入
// 假 runner 与样本来钉判据形状。
export interface SelfCheckVetResult {
  /** 校对后的 self_check (被闸拒时为 undefined —— 退回旁路, 不判红)。 */
  kept: { command: string; expect_exit: number } | undefined;
  /** 闸判 (冗余存底, 给日志/HUD 读数, 不读就当静默)。 */
  verdict: ProbeDiscriminationVerdict | ProbeVacuityVerdict | { status: 'skipped'; reason: string };
  /** 被闸拒时落账: 探针的原话 + 探针跑了哪种 (= 给后续阅读/调试的证据)。 */
  droppedWhy?: string;
}

/**
 * 判 self_check 是否值得跑 —— 给一份**显式留痕**(闸拒 = 不留 = 闸没存在过)。
 *
 * @param selfCheck 待校验的判据 (缺省 = undefined → 旁路)
 * @param deps sample = 分类器给的错样本, runIn = 探针用的命令 runner, repoRoot = 探针建真副本
 *   用的仓根 (缺省 → 空目录形态, fail-open)。
 */
export async function vetSelfCheck(
  selfCheck: { command: string; expect_exit?: number } | undefined,
  deps: {
    sample?: NegativeSample;
    runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>;
    repoRoot?: string;
  } = {},
): Promise<SelfCheckVetResult> {
  if (!selfCheck) {
    return { kept: undefined, verdict: { status: 'skipped', reason: 'no self_check (旁路, INV-1-2)' } };
  }
  const spec = { command: selfCheck.command, expect_exit: selfCheck.expect_exit ?? 0 };
  // 优先跑判别力探针 (有 sample 时) —— 比空世界自检强一档 (后者抓不到 #165 那条「命令在空世界
  // 红但在错答案上仍绿」的病)。没 sample 则跑空世界自检 —— 两道都 fail-open, 跑不起来 = 放行。
  if (deps.sample) {
    const v = await probeDiscrimination(spec.command, deps.sample, spec.expect_exit, {
      ...(deps.runIn ? { runIn: deps.runIn } : {}),
      ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
    });
    if (v.status === 'ring') {
      // `v.why` 是冻结文本 (acceptance-gate.ts:311), 不再措辞。
      const why = `self_check 闸拒 (判别力探针 ring): ${v.why}`;
      return { kept: undefined, verdict: v, droppedWhy: why };
    }
    return { kept: spec, verdict: v };
  }
  const v = await probeVacuity(
    spec.command,
    deps.runIn
      ? async ({ command }) => {
          // 探针跑在 caller 给的 cwd 上; probeVacuity 的签名不带 cwd, 在这里剥掉。
          const r = await deps.runIn!({ command, cwd: deps.repoRoot ?? process.cwd() });
          return { exitCode: r.exitCode };
        }
      : async ({ command }: { command: string }) => ({ exitCode: 0 }),
    spec.expect_exit,
  );
  if (v.status === 'ring') {
    const why = `self_check 闸拒 (空世界自检 ring): ${v.why}`;
    return { kept: undefined, verdict: v, droppedWhy: why };
  }
  return { kept: spec, verdict: v };
}
