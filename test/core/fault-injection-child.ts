/**
 * 故障注入夹具的**被杀进程** (INV-P2-6 后半)。不是测试文件, 由 `fault-injection.test.ts` spawn。
 *
 * 为什么要真起一个进程: `iterate-persist.test.ts` 已经证了 journal 的读写与"同进程里再调一次能接回",
 * 但那**证不了崩溃恢复** —— 轮次/毒集/复用源是进程内闭包, 同进程里它们本来就没死过。**故障注入的
 * 全部意义就是让那些闭包真的消失一次**。故本夹具跑在独立进程里, 由父进程外力 SIGKILL。
 *
 * 全程零 LLM: 图预构造 (`runExecutorDagWithPlan` 绕开 conductor), 叶子是注入的假 agentRunner,
 * judge 是定值裁决。测的是**引擎的持久化/恢复**, 掺模型进来只会把读数变成噪声。
 *
 * 为什么用 agent 叶子而不是 command 叶子: command 节点**刻意不落绿 checkpoint**
 * (`executor-dag.ts:678` 的设计注: 它便宜且常是验收 oracle, resume 重跑比跳过闸安全) ——
 * 拿它当夹具就永远测不到"已绿节点不重跑"。agent 叶子才走 `saveDoneCheckpoint` 全套
 * (含 outputPaths + artifactHashes), 也才是"已批准制品"这句话的真正落点。
 *
 * 用法:
 *   bun run test/core/fault-injection-child.ts --root <dir> --run <runId>
 *     [--resume] [--max-rounds N] [--hang <nodeId>] [--verdicts reject-b,converge]
 *
 * stdout 末行 `##RESULT## {json}` = 给父进程的结构化读数。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { iterateExecutorDag } from '../../src/harness/plan/iterate';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { AgentLeafRunner } from '../../src/harness/leaf-runners';
import type { FixpointVerdict } from '../../src/harness/plan/fixpoint';
import { hangUntilKilled } from './hang-watchdog';

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
const maxRounds = Number(arg('max-rounds') ?? '1');
const hangNode = arg('hang');
/** 从第几轮起才挂 (默认 1)。测"崩在轮间"要让第 1 轮**跑完并写下 journal**, 崩在第 2 轮。 */
const hangRound = Number(arg('hang-round') ?? '1');
let curRound = 0;
let localRound = 0;
/** 逐轮裁决: `converge` | `reject-<id>` (未收敛且点名) | `blind` (未收敛且不点名 → fail-closed)。 */
const verdictSpec = (arg('verdicts') ?? 'converge').split(',');

/** a → b → c 串行三节点。串行是刻意的: 崩在 c 时 a/b 必然已绿, 「不重跑」才有可判的对象。 */
const NODE_IDS = ['a', 'b', 'c'] as const;
const plan: ConductorPlan = {
  name: 'fault-injection',
  nodes: {
    a: { executor: 'agent', goal: 'NODE=a 写 art-a.txt' },
    b: { executor: 'agent', goal: 'NODE=b 写 art-b.txt', depends_on: ['a'] },
    c: { executor: 'agent', goal: 'NODE=c 写 art-c.txt', depends_on: ['b'] },
  },
} as ConductorPlan;

/**
 * 假 agent 叶子。leaf prompt 里带着节点 goal, 从中认出 `NODE=<id>` —— AgentLeafInput 只有
 * {prompt, model}, 没有节点 id, 这是唯一不改引擎的辨认路径。
 *
 * 每次真执行留两处痕迹: `exec.log` 追加一行 (「跑过几次」的唯一硬判据) + `art-<id>.txt`
 * (已批准制品)。`--hang` 的那个节点两处痕迹都**不留**, 只 touch 哨兵后永久挂起 ——
 * 半完成的节点不该被算作绿, 也给父进程一个确定的"现在杀我"时点。
 */
const agentRunner: AgentLeafRunner = async ({ prompt }) => {
  const id = /NODE=(\w+)/.exec(prompt)?.[1] ?? 'unknown';
  if (id === hangNode && curRound >= hangRound) {
    writeFileSync(join(root, `READY-${id}`), '', 'utf-8');
    await hangUntilKilled(); // 等 SIGKILL —— 但有自毁上限, 见 hang-watchdog.ts (父进程先死时不留孤儿)
  }
  appendFileSync(join(root, 'exec.log'), `${id}\n`, 'utf-8');
  const artifact = join(root, `art-${id}.txt`);
  writeFileSync(artifact, `artifact of ${id}\n`, 'utf-8');
  return { text: `[${id}] 已写 ${artifact}`, usage: { in: 10, out: 10 }, filesTouched: [artifact], cwd: root };
};

const manager = new CheckpointManager(root);
const continuity = { manager, runId, repoRoot: root, ...(resume ? { resume: true } : {}) };

let round = 0;
const judge = async (): Promise<FixpointVerdict> => {
  const spec = verdictSpec[Math.min(round++, verdictSpec.length - 1)] ?? 'converge';
  if (spec === 'converge') return { converged: true, score: 1 };
  if (spec === 'blind') return { converged: false, score: 0, failureReason: '说不出哪错了' };
  return {
    converged: false,
    score: 0,
    failureReason: `${spec} 的产出是编的`,
    rejectedNodes: [spec.slice('reject-'.length)],
  };
};

const before = manager.loadFixpointJournal(runId);
process.stderr.write(
  `[child] resume=${resume} journalRounds=${before?.completedRounds ?? 0} poisoned=${before?.poisoned.length ?? 0}\n`,
);

const res = await iterateExecutorDag('把三步做完', {
  conductorModel: 'fixture:none', // 预构造 plan → conductor 永不被调用 (仅过必填闸)
  leafModel: 'fixture:none',
  agentLeafModel: 'fixture:none',
  agentRunner,
  maxRounds,
  continuity,
  judge,
  _runDag: (_task, cfg, prior) => {
    // 本进程内的轮号 (恢复时接着 journal 数, 否则 --hang-round 在 resume 进程里会错位)。
    curRound = (resume ? before?.completedRounds ?? 0 : 0) + ++localRound;
    return runExecutorDagWithPlan(plan, cfg, prior);
  },
} as Parameters<typeof iterateExecutorDag>[1]);

const after = manager.loadFixpointJournal(runId);
const statuses = res.finalRound?.result.results ?? {};
process.stdout.write(
  `##RESULT## ${JSON.stringify({
    startedFromRound: (resume ? before?.completedRounds ?? 0 : 0) + 1,
    roundsThisProcess: res.rounds.length,
    converged: res.converged,
    completedRounds: after?.completedRounds ?? 0,
    poisoned: after?.poisoned.length ?? 0,
    lastRoundStatuses: Object.fromEntries(
      NODE_IDS.map((id) => [id, (statuses[id] as { status?: string } | undefined)?.status ?? 'absent']),
    ),
    reusedNodes: res.finalRound?.result.reusedNodes ?? [],
  })}\n`,
);
// 引擎里有存活的 keep-alive (心跳/池), 事件循环不会自己空 → 显式退出, 否则父进程永远等不到 exited。
process.exit(0);
