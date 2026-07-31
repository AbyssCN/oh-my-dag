/**
 * **内环崩溃夹具的被杀进程**(G2 / S6 最后一格,2026-07-31)。不是测试文件,由
 * `inner-loop-crash.test.ts` spawn。
 *
 * ## 为什么非得再起一个进程
 *
 * `src/harness/plan/inner-loop-fault.test.ts` 的 18 条已经把内环的 F1–F4 打了一遍,但它自己
 * 在文件头老实写着:**那是崩溃的进程内等价物**(跑满 N 轮收手 → 带 `resume` 再起一次),
 * 对 F2/F3/F4 忠实,对 F1 只是近似。而 G2 是**硬闸**,它问的那句话是"崩溃不丢已批准制品" ——
 * 「崩溃」在那份近似里从没真发生过:轮次/毒集/复用源是进程内闭包,同进程里它们没死过。
 *
 * 旧那套真杀夹具(`fault-injection-child.ts`)打的是**外层 fixpoint**(`_fixpoint.json` +
 * `iterateExecutorDag`),而环 D-F 之后搬进了 conductor 节点,状态换成 `_loop-<nodeId>.json`。
 * 那份证据证的是一台**已经不在主路径上**的机器。本夹具就是把它移植到内环。
 *
 * ## 图的形状(为什么是这个形状)
 *
 * 一个 `executor:'conductor'` 节点 `P`,内环 `max_rounds`;它每轮展开同一张两节点子图,
 * **串行**(`write-b` 依赖 `write-a`)—— 串行是刻意的:杀在 b 上时 a 必然已绿,
 * 「已绿不重跑」才有可判的对象。子节点是 `executor:'agent'` 而不是 command:
 * command 节点**刻意不落绿 checkpoint**(便宜且常是验收 oracle),拿它当夹具就永远测不到复用。
 *
 * 全程零 LLM:`generate` 返回预构造子图 + 定值 judge,叶子是注入的假 agentRunner。
 *
 * 用法:
 *   bun run test/core/inner-loop-crash-child.ts --root <dir> --run <runId>
 *     [--resume] [--max-rounds N] [--hang <a|b>] [--hang-round N] [--verdicts reject-b,converge]
 *
 * stdout 末行 `##RESULT## {json}` = 给父进程的结构化读数。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import { expandConductorNode } from '../../src/harness/plan/conductor-expand';
import { PLAN_BOUNDARY } from '../../src/harness/conductor-plan';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { AgentLeafRunner } from '../../src/harness/leaf-runners';
import type { ContentPart } from '../../src/model/gateway';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/executor-dag-types';

// checkpoint 落 <root>/.omd/continuity/<runId>/ —— 夹具自持, 不受宿主 OMD_DATA_HOME 影响。
delete process.env.OMD_DATA_HOME;

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const root = arg('root')!;
const runId = arg('run') ?? 'run-1';
const resume = argv.includes('--resume');
const maxRounds = Number(arg('max-rounds') ?? '2');
const hangNode = arg('hang');
/** 从第几轮起才挂。测"崩在第 2 轮"要让第 1 轮跑完并写下 journal。 */
const hangRound = Number(arg('hang-round') ?? '1');
/** 逐轮裁决: `converge` | `reject-<可读名>`。 */
const verdictSpec = (arg('verdicts') ?? 'converge').split(',');

const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: {
    'write-a': { goal: 'NODE=a 写 A 部分', executor: 'agent' },
    'write-b': { goal: 'NODE=b 写 B 部分', executor: 'agent', depends_on: ['write-a'] },
  },
});

/**
 * 子节点的**内容寻址 id**(D-B)。judge 的 `rejectedNodes` 走精确匹配,可读名会被当幻觉丢掉。
 * 算法与引擎同一个函数 —— 这不是抄一份 id 规则, 是问它要。
 */
const CHILD_ID: Record<string, string> = Object.fromEntries(
  expandConductorNode('P', JSON.parse(SUB_PLAN) as ConductorPlan).children.map((c) => [c.originalId, c.id]),
);

const plan: ConductorPlan = {
  name: 'inner-loop-crash',
  nodes: { P: { goal: '两部分都要写好', executor: 'conductor', max_rounds: maxRounds } },
} as ConductorPlan;

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 本进程见到的轮号(resume 时接着 journal 数, 否则 --hang-round 在续跑进程里会错位)。 */
const before = new CheckpointManager(root).loadNodeLoopJournal(runId, 'P');
let localRound = 0;
const curRound = (): number => (resume ? (before?.completedRounds ?? 0) : 0) + localRound;

const generate: GenerateFn = async (req) => {
  const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
  // conductor 的重展开请求 → 每轮同一张子图 (子节点 id 因此逐轮相同, 复用才谈得上)
  if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
    localRound++;
    return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
  }
  return { text: 'out', usage: { in: 1, out: 1 } };
};

/**
 * 假 agent 叶子。每次真执行留两处痕迹:`exec.log` 追加一行(「跑过几次」的唯一硬判据)+
 * `art-<id>.txt`(已批准制品)。`--hang` 的那个节点两处都**不留**,只 touch 哨兵后永久挂起 ——
 * 半完成的节点不该被算作绿,也给父进程一个确定的"现在杀我"时点。
 */
const agentRunner: AgentLeafRunner = async ({ prompt }) => {
  const id = /NODE=(\w+)/.exec(prompt)?.[1] ?? 'unknown';
  if (id === hangNode && curRound() >= hangRound) {
    writeFileSync(join(root, `READY-${id}`), '', 'utf-8');
    await new Promise<never>(() => {}); // 等 SIGKILL
  }
  appendFileSync(join(root, 'exec.log'), `${id}\n`, 'utf-8');
  const artifact = join(root, `art-${id}.txt`);
  writeFileSync(artifact, `artifact of ${id}\n`, 'utf-8');
  return { text: `[${id}] 已写 ${artifact}`, usage: { in: 10, out: 10 }, filesTouched: [artifact], cwd: root };
};

let judged = 0;
const config = {
  conductorModel: 'fixture:none',
  leafModel: 'fixture:none',
  agentLeafModel: 'fixture:none',
  generate,
  agentRunner,
  agentTemplates: new Map(),
  judgeSend: async () => {
    const spec = verdictSpec[Math.min(judged++, verdictSpec.length - 1)] ?? 'converge';
    const converged = spec === 'converge';
    return {
      text: '',
      parsed: {
        converged,
        score: converged ? 9 : 3,
        ...(converged ? {} : { failureReason: '还差一点' }),
        rejectedNodes: spec.startsWith('reject-') ? [CHILD_ID[`write-${spec.slice('reject-'.length)}`] ?? spec] : [],
      },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'judge:fake',
      attempts: 1,
    };
  },
  continuity: { manager: new CheckpointManager(root), runId, ...(resume ? { resume: true } : {}) },
} as unknown as ExecutorDagConfig;

const res = await runExecutorDagWithPlan(plan, config);
const after = new CheckpointManager(root).loadNodeLoopJournal(runId, 'P');
process.stdout.write(
  `##RESULT## ${JSON.stringify({
    startedFromRound: (resume ? (before?.completedRounds ?? 0) : 0) + 1,
    converged: res.results.P?.converged ?? false,
    status: res.results.P?.status ?? 'absent',
    rounds: res.results.P?.rounds ?? 0,
    completedRounds: after?.completedRounds ?? 0,
    poisoned: after?.poisoned?.length ?? 0,
    reusedNodes: res.reusedNodes ?? [],
  })}\n`,
);
// 引擎里有存活的 keep-alive (心跳/池), 事件循环不会自己空 → 显式退出。
process.exit(0);
