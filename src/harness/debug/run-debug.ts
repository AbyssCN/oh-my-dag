/**
 * harness/debug/run-debug —— dag-debug 编排循环(裸 shell 复现/探测 + DAG 假设扇出 + 三振纪律)。
 *
 * SDD: docs/plan/2026-07-22-dag-debug.md。issue #9。
 *
 * 形状(SDD §2.1):
 *   red = $`reproCmd`            拿确定失败证据(裸 shell, --repro 给才跑; D-4 不走 command 节点)
 *   cgAvailable = probe codegraph   plan 期能力探测 → 喂 scope goal(D-5 降级)
 *   for round in 1..maxRounds:
 *     plan = compileDebugPlan({failure, red, cgAvailable, ruledOut})
 *     res  = runExecutorDagWithPlan(plan, config)
 *     judge CONFIRMED? → 报告 + 提议修(默认不改文件) → return root-cause
 *     else ruledOut += 本轮 judge NONE 排除清单 → 下轮带反馈重扇
 *   三振全无根因 → return exhausted(升 owner, 不无限烧 token; SDD §3.5)
 *
 * ★ 无根因不修: judge 未 CONFIRMED 绝不提修(judge goal 已钉, 本层只据 ROOT_CAUSE 头分流)。
 * 全节点只读, 无写盘(默认只提议; 实装修复走 gated 模式, v1 defer)。
 */
import { $ } from 'bun';
import { compileDebugPlan, JUDGE_NODE_ID, HYPOTHESES_NODE_ID } from './debug-plan';
import { runExecutorDagWithPlan } from '../executor-dag';
import type { ExecutorDagConfig, ExecutorDagResult } from '../executor-dag-types';

/** 复现证据 / judge 输出截断上限(护 prompt + 报告尺寸)。 */
const RED_MAX = 4000;

export interface RunDebugOptions {
  /** 失败描述(症状 / stack trace / "昨天还好的")。 */
  failure: string;
  /** 复现命令(裸 shell; 期望它 red)。省略 → 据症状 + 范围推断, 无 red 证据。 */
  reproCmd?: string;
  /** 子进程 cwd(= 仓根)。复现 + codegraph 探测都在此下。 */
  cwd: string;
  /** 已装配的 DAG 执行配置(model/agentRunner/maxFanout 由脚本注入)。 */
  dagConfig: ExecutorDagConfig;
  /** 三振上限(默认 3; SDD §3.5)。 */
  maxRounds?: number;
  /** 每轮假设扇出上限(默认走 debug-plan 的 5)。 */
  maxHypotheses?: number;
  // ── 注入接缝(测试传 fake, 不碰 live 模型 / 真 shell)──
  _runDag?: (plan: ReturnType<typeof compileDebugPlan>, config: ExecutorDagConfig) => Promise<ExecutorDagResult>;
  _probeCodegraph?: (cwd: string) => boolean;
  _runRepro?: (cmd: string, cwd: string) => Promise<string>;
}

export interface RunDebugResult {
  /** root-cause = judge CONFIRMED 早停; exhausted = 三振全无根因升 owner。 */
  status: 'root-cause' | 'exhausted';
  /** 实际跑了几轮。 */
  rounds: number;
  /** codegraph 探测结果(报告透明化: 是否降级)。 */
  cgAvailable: boolean;
  /** 复现拿到的 red(无 --repro 则 undefined)。 */
  redEvidence?: string;
  /** CONFIRMED 时的 judge 全文(根因 + 提修提议)。 */
  rootCause?: string;
  /** 各轮 judge NONE 排除清单(exhausted 时升 owner 的"排除了什么")。 */
  ruledOut: string[];
  /** 组装好的 markdown 报告。 */
  reportMarkdown: string;
}

/** 默认复现: sh -c 跑整条命令, 合并 stdout+stderr(red 常在 stderr), 不抛(期望非零退出)。 */
const runReproDefault = async (cmd: string, cwd: string): Promise<string> => {
  const r = await $`sh -c ${cmd}`.cwd(cwd).nothrow().quiet();
  const body = `${r.stdout.toString()}${r.stderr.toString()}`;
  return `$ ${cmd}\n[exit ${r.exitCode}]\n${body}`.slice(0, RED_MAX);
};

/** 默认 codegraph 探测: CLI 在 PATH 即视为可用(cg-retrieve 走 CLI 命令节点, 同源)。 */
const probeCodegraphDefault = (_cwd: string): boolean => Bun.which('codegraph') != null;

/** judge 输出是否宣告 CONFIRMED 根因(首行 ROOT_CAUSE: CONFIRMED ...)。 */
function judgeConfirmed(output: string): boolean {
  return /^\s*ROOT_CAUSE:\s*CONFIRMED\b/im.test(output);
}

/** 取 judge 节点输出(done 才有内容; failed/缺失 → 空串驱动继续/exhausted)。 */
function judgeOutput(res: ExecutorDagResult): string {
  const j = res.results[JUDGE_NODE_ID];
  return j && j.status === 'done' ? j.output : '';
}

/** 汇总本轮假设 verify 子节点的裁决(map 子 id 形如 `hypotheses::<key>`)供报告。 */
function roundVerdicts(res: ExecutorDagResult): string[] {
  const prefix = `${HYPOTHESES_NODE_ID}::`;
  return Object.entries(res.results)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, leaf]) => {
      const key = id.slice(prefix.length);
      const verdict = leaf.status === 'failed' ? 'FAILED' : (leaf.output.match(/VERDICT:\s*(\w+)/i)?.[1] ?? '?');
      return `${key}: ${verdict}`;
    });
}

/**
 * 跑一次根因调查。返回结构化结果 + markdown 报告。
 * 默认只提议不改文件(全节点只读); 三振纪律防无限扇出。
 */
export async function runDebug(opts: RunDebugOptions): Promise<RunDebugResult> {
  if (!opts.failure.trim()) throw new Error('runDebug: failure 描述不能为空');
  const maxRounds = opts.maxRounds ?? 3;
  const runDag = opts._runDag ?? runExecutorDagWithPlan;
  const probe = opts._probeCodegraph ?? probeCodegraphDefault;
  const runRepro = opts._runRepro ?? runReproDefault;

  const redEvidence = opts.reproCmd ? await runRepro(opts.reproCmd, opts.cwd) : undefined;
  const cgAvailable = probe(opts.cwd);

  const ruledOut: string[] = [];
  const perRound: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const plan = compileDebugPlan({
      failure: opts.failure,
      redEvidence,
      cgAvailable,
      priorRefuted: ruledOut,
      maxHypotheses: opts.maxHypotheses,
    });
    const res = await runDag(plan, opts.dagConfig);
    const verdicts = roundVerdicts(res);
    const jOut = judgeOutput(res);
    perRound.push(`### Round ${round}\n假设裁决: ${verdicts.join(' · ') || '(无)'}\n\n${jOut || '(judge 无输出)'}`);

    if (judgeConfirmed(jOut)) {
      return {
        status: 'root-cause',
        rounds: round,
        cgAvailable,
        redEvidence,
        rootCause: jOut,
        ruledOut,
        reportMarkdown: renderReport({ opts, cgAvailable, redEvidence, status: 'root-cause', rounds: round, perRound }),
      };
    }
    // 无根因: judge NONE 输出即"排除了什么"(SDD §2.1) → 喂下轮 lister 避重复猜。
    if (jOut.trim()) ruledOut.push(`R${round}: ${jOut.trim().slice(0, 800)}`);
  }

  return {
    status: 'exhausted',
    rounds: maxRounds,
    cgAvailable,
    redEvidence,
    ruledOut,
    reportMarkdown: renderReport({ opts, cgAvailable, redEvidence, status: 'exhausted', rounds: maxRounds, perRound }),
  };
}

function renderReport(a: {
  opts: RunDebugOptions;
  cgAvailable: boolean;
  redEvidence?: string;
  status: 'root-cause' | 'exhausted';
  rounds: number;
  perRound: string[];
}): string {
  const head = a.status === 'root-cause'
    ? `# 根因调查报告 — ✅ 根因确认(${a.rounds} 轮)`
    : `# 根因调查报告 — ⚠️ 三振无根因,升 owner(${a.rounds} 轮)`;
  return [
    head,
    ``,
    `**失败症状**: ${a.opts.failure}`,
    `**codegraph**: ${a.cgAvailable ? '可用(符号导航)' : '降级(ugrep 文本搜索)'}`,
    a.opts.reproCmd ? `**复现**: \`${a.opts.reproCmd}\`` : `**复现**: (无 --repro; 据症状推断)`,
    a.redEvidence ? `\n<details><summary>red 证据</summary>\n\n\`\`\`\n${a.redEvidence}\n\`\`\`\n</details>` : '',
    ``,
    ...a.perRound,
    ``,
    a.status === 'exhausted'
      ? `> 三振全无 CONFIRMED 根因。下一步(investigate 纪律): 换角度重扇 / 埋点观察 / 升 owner 定夺。**无根因不修**。`
      : `> 提修提议见上(默认只提议不改文件; 实装走显式闸,修复须过 oracle 红→绿复验)。`,
  ].filter((l) => l !== '').join('\n');
}
