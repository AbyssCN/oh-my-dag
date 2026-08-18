/**
 * D-4 谎报完成闸的**接线**网 (2026-08-10) —— 钉引擎行为, 不是判据。
 *
 * 判据矩阵在 `false-completion.test.ts` (16 测, 词表两面 + 语气/引文/否定筛)。
 * 那份网全绿也说明不了 `dag/engine.ts` 的 `judgeConductorRound` 真的把它接上了 ——
 * `claimed-actions-wiring.test.ts` 的题记就是这份网存在的理由 (S1 的 `orderedChildren`
 * 逐字重建漏字段, 症状是沉默的: 读上去像"这个改动没用")。
 *
 * 所以这里驱动**整条 conductor 内环**, 断言 D-4 闸的三条出口:
 *   ① 已知谎报样本 (命令子节点声称「全部完成」而引擎判 failed) → 父节点当场判未收敛,
 *      **judge 一次都不烧** (确定性先行: 硬矛盾不需要贵座判官背书);
 *   ② 真完成样本 (同图同声称, 命令退出码 0) → 不红, judge 照常被问 (零误伤面);
 *   ③ 只有声称无实败 (inproc 叶子声称「全部完成」) → 不红 (那是 claimed-actions
 *      只报不拦的面, D-4 不越权)。
 *
 * 证据出口 = 节点级 journal 的 prevReason (环唯一的信息通道, 与 claimed-actions-wiring
 * 同一条持久面): 每轮判完 `prevReason = verdict.reason` 覆写 (engine.ts), D-4 的
 * renderFalseCompletionFindings 全文逐字落在这里。
 *
 * 证伪方式 (实现改成什么样会让这条静默变绿):
 * - 引擎侧把 `gateFalseCompletion` 调用删了 / judge 视图漏接 status → ① 的
 *   judgeCalls=0 断言直接红 (judge 被叫了), journal 里也没有 D-4 头;
 * - 把 D-4 判定从「return 未收敛」悄悄降成「只 log」→ ① 的 converged 断言红;
 * - 出口 ②/③ 若把 exit 0 或「无失败证据」也当实败 → 真完成样本被 D-4 当场判未收敛,
 *   误伤面出现 (与纯测同一条零误伤纪律)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../dag/engine';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../continuity/types';
import type { ContentPart } from '../../model/gateway';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/**
 * 固定子图: 一个写方 (inproc leaf) + 一个命令节点。
 * `run-check` 是**谎报样本的载体** —— 它声称「全部完成, 测试全部通过」, 而退出码由测试注入:
 * 1 = 引擎判 failed (D-4 失败证据面: 节点状态 failed); 0 = 真完成 (阴性对照)。
 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: {
    'write-doc': { goal: '写一份 clamp 说明' },
    'run-check': { goal: '跑一次自检', executor: 'command', command: 'bun test' },
  },
});

/** 已知谎报样本的声称句 (与 `false-completion.test.ts` 的 `lying()` 同一句, 双面命中)。 */
const LIAR_CLAIM = '全部完成, 测试全部通过';

function makeGenerate(leafText: string): GenerateFn {
  return async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
      return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
    }
    return { text: leafText, usage: { in: 1, out: 1 } };
  };
}

const plan: ConductorPlan = {
  name: 'p',
  nodes: { P: { goal: '写清楚 clamp 的边界', executor: 'conductor', max_rounds: 2 } },
};

/** 一次跑的观察面: judge 调用次数 (D-4 路径 = 0) + 收敛结论 + journal.prevReason 全文。 */
async function run(checkExit: number, leafText = '已实现 clamp 并写好测试', opts: { freeze?: boolean; root?: string; resume?: boolean } = {}): Promise<{
  judgeCalls: number;
  converged: boolean | undefined;
  judgeConverged: boolean | undefined;
  verdicts: NodeLoopJournal['verdicts'];
  prevReason: string;
  root: string;
}> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'omd-fcwire-'));
  // 2026-08-18: OMD_DATA_HOME 设 → engine 把 journal 落 `~/.omd/projects/<slug>/continuity/<runId>/`, 而非
  // `<root>/.omd/...`。 旧硬编码读 `<root>/.omd/continuity/run-1/_loop-P.json` 在 OMD_DATA_HOME 存在时
  // 一定 ENOENT。 改用 `cm.loopPath` 走与 engine 同一份 `runDir` 解析, 保证读路径 = 写路径。
  const cm = new CheckpointManager(root);
  const judgeCalls = { n: 0 };
  const cfg = {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    generate: makeGenerate(leafText),
    agentTemplates: new Map(),
    // repeatedActionThreshold 调高: 同一失败命令连跑两轮会触发 §8.4 动作级熔断提前退环,
    // 与 D-4 无关 —— 熔断与否不该决定这条网的可观察性。
    repeatedActionThreshold: 99,
    // #148 那格要的是「图内命令红 ∧ 冻结判据绿」同时成立 —— 判据命令 ('true') 与
    // 子图命令 ('bun test') 分开给退出码, 不然一个 runner 一刀切模不出那个组合。
    ...(opts.freeze ? { freezeCriterion: { command: 'true' } } : {}),
    commandRunner: async ({ command }: { command: string }) =>
      ({ text: LIAR_CLAIM, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: command === 'true' ? 0 : checkExit }),
    judgeSend: async () => {
      judgeCalls.n++;
      return {
        text: '',
        parsed: { converged: false, score: 3, failureReason: '还差一点', rejectedNodes: [] },
        usage: { in: 0, out: 0 },
        raw: {},
        model: 'judge:fake',
        attempts: 1,
      };
    },
    continuity: { manager: cm, runId: 'run-1', ...(opts.resume ? { resume: true } : {}) },
  } as unknown as ExecutorDagConfig;
  const r = await runExecutorDagWithPlan(plan, cfg);
  // 路径经 `cm.loopPath` 解析, 与 `runConductorNode.writeLoopJournal` 走的 `runDir` 同源 (MP-INV-5)。
  const journal = JSON.parse(
    readFileSync(cm.loopPath('run-1', 'P'), 'utf-8'),
  ) as NodeLoopJournal;
  return {
    judgeCalls: judgeCalls.n,
    converged: r.results.P?.converged,
    judgeConverged: r.results.P?.judgeConverged,
    verdicts: journal.verdicts,
    prevReason: journal.prevReason ?? '',
    root,
  };
}

describe('接线: 已知谎报样本当场红 (G-6 全引擎路径)', () => {
  test('命令子节点声称「全部完成」+ 引擎判 failed → 未收敛, judge 零调用, 证据带原句与失败事实', async () => {
    const { judgeCalls, converged, prevReason, root } = await run(1);
    // 确定性先行: 硬矛盾当场判, 不烧一次贵座 judge 调用。
    expect(judgeCalls).toBe(0);
    expect(converged).toBe(false);
    // 证据必须可定位: 闸头 + 原声称句 + 失败事实 (不是"有问题"三个字)。
    expect(prevReason).toContain('[D-4 谎报完成]');
    expect(prevReason).toContain('全部完成');
    expect(prevReason).toContain('节点状态: failed');
    // 证伪: 若引擎侧删了挂点 / judge 视图漏接 status → judge 被调用且 journal 里没有 D-4 头。
    rmSync(root, { recursive: true, force: true });
  });
});

describe('#148 判词溯源: 合成票 ≠ judge 票 (B0 run 6251afc4 的形状)', () => {
  test('图内命令红 (D-4 合成拒绝) ∧ 冻结判据绿 → 环按判据收敛; journal 记 gate-rejected, judgeConverged 缺席', async () => {
    const { judgeCalls, converged, judgeConverged, verdicts, root } = await run(1, '已实现 clamp 并写好测试', { freeze: true });
    // 环的结论由判据定 (D-I 以判据为准), 中途闸红不翻它 —— 旧行为链: D-4 合成的 rejected
    // 被写进 judgeConverged → goal 层拿它压过 converged → 全绿的 run 判 not-converged (#148)。
    expect(converged).toBe(true);
    expect(judgeCalls).toBe(0); // D-4 确定性先行, judge 一发没烧
    // 「没投票」≠「投了反对票」: 合成票不进 judgeConverged, journal 里与真 judge 票分词记。
    expect(judgeConverged).toBeUndefined();
    expect(verdicts).toEqual([{ round: 1, criterion: 'green', judge: 'gate-rejected' }]);
    // 证伪: engine 的 criterion-green return 去掉 `verdict.synthetic` 守卫 → judgeConverged=false
    //   回来, 第三条断言红; roundVerdicts 不分 synthetic → 第四条断言红 (judge:'rejected')。
    rmSync(root, { recursive: true, force: true });
  });

  test('真 judge 反对票 ∧ 冻结判据绿 → 环仍按判据收敛, 但 judgeConverged=false 且 journal 记 rejected (真票不降级)', async () => {
    const { judgeCalls, converged, judgeConverged, verdicts, root } = await run(0, '已实现 clamp 并写好测试', { freeze: true });
    expect(judgeCalls).toBeGreaterThan(0); // 没有硬矛盾 → judge 真被问了 (fake 判「还差一点」)
    expect(converged).toBe(true);
    expect(judgeConverged).toBe(false); // judge 自己的票原样带出 —— 判据轴「judge 太紧」那格靠它
    expect(verdicts).toEqual([{ round: 1, criterion: 'green', judge: 'rejected' }]);
    rmSync(root, { recursive: true, force: true });
  });

  test('#148 尾巴 resume: journal 已收敛 → judge 票从 verdicts 尾巴还原 (真反对票不丢, 合成票仍缺席)', async () => {
    // 真反对票那一跑 → 同 root 同 runId 续跑: 环不重开 (judge 0 发), 票跟着结论一起回来。
    // 证伪: 把 runConductorNode 的 journal-converged 返回里 restoredJudge 那几行删掉 →
    // 第二跑 judgeConverged=undefined, 下面倒数第二条断言红。
    const first = await run(0, '已实现 clamp 并写好测试', { freeze: true });
    expect(first.judgeConverged).toBe(false);
    const resumed = await run(0, '已实现 clamp 并写好测试', { freeze: true, root: first.root, resume: true });
    expect(resumed.judgeCalls).toBe(0); // 环没重开, 直接返上次结论
    expect(resumed.converged).toBe(true);
    expect(resumed.judgeConverged).toBe(false);
    rmSync(first.root, { recursive: true, force: true });

    // 合成票那一跑 (gate-rejected): resume 后同样**不**冒充 judge 票 —— 缺席还是缺席。
    const gated = await run(1, '已实现 clamp 并写好测试', { freeze: true });
    expect(gated.judgeConverged).toBeUndefined();
    const gatedResumed = await run(1, '已实现 clamp 并写好测试', { freeze: true, root: gated.root, resume: true });
    expect(gatedResumed.converged).toBe(true);
    expect(gatedResumed.judgeConverged).toBeUndefined();
    rmSync(gated.root, { recursive: true, force: true });
  });
});

describe('接线: 真完成样本不误伤 (G-6 阴性对照)', () => {
  test('同图同声称, 命令退出码 0 → 不红, judge 照常被问', async () => {
    const { judgeCalls, prevReason, root } = await run(0);
    expect(judgeCalls).toBeGreaterThan(0); // 没有硬矛盾, 收敛与否交给判官
    expect(prevReason).not.toContain('[D-4 谎报完成]');
    // 证伪: 若实现把 exit 0 也当失败证据 → 真完成样本被 D-4 当场判未收敛, 误伤面出现。
    rmSync(root, { recursive: true, force: true });
  });

  test('只有声称无实败 (inproc 叶子声称「全部完成」) → 不红 (claimed-actions 只报不拦的面)', async () => {
    // write-doc 是 inproc leaf, 产出「全部完成」= 完工声称, 但引擎没有任何失败证据
    // (命令节点退出码 0, 有「命令退出码符合预期」事实) → D-4 两条单变量缺一, 不构成谎报。
    const { judgeCalls, prevReason, root } = await run(0, '全部完成');
    expect(judgeCalls).toBeGreaterThan(0);
    expect(prevReason).not.toContain('[D-4 谎报完成]');
    // 证伪: 若 D-4 对「无失败证据的声称」也判 fail → 良性完工报告被拦, 闸抢在
    // claimed-actions 前面把语气未筛的句子打进毒集 (只报不拦是拨闸前置, D-4 不该跳级)。
    rmSync(root, { recursive: true, force: true });
  });
});
