/**
 * scripts/eval-tdd-pack —— tdd-bugfix 参考 pack 的 A/B eval 驱动 (PLAN.md 的机械化)。
 *
 * 用法: bun scripts/eval-tdd-pack.ts --arm bare|pack [--task broken-calc|weighted-ledger] [--n 2] [--keep] [--gapMs 20000]
 *
 * 四要素照 templates/packs/tdd-bugfix/eval/PLAN.md:
 *   单一变量 = 世界里装/不装 pack (agentTemplates 从世界现读, 差异只来自世界状态);
 *   任务文本两臂逐字相同且**刻意中性** (纪律必须来自卡, 不许从任务文本漏进对照臂);
 *   信号 S1-S4 跑后由本脚本从 result + 隐藏 oracle 机械算出;
 *   读数 append 进 eval/readings/<arm>.jsonl, 两臂分列。
 *
 * 消耗: 每次 = conductor 1-N 发 (conductor 座) + 若干 agent/command 叶 (agent/leaf 座)。
 * 点火前先 `omd config dump` 看座位落谁家、烧哪本账。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { loadAgentTemplates } from '../src/harness/agent-templates';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../src/harness/command-leaf';
// v1 规划式 conductor 已退役 (2026-09-03): 任务入口 = 编排循环, 与 `run` 工具同一入口。
import { runOrchestratingLoop as runExecutorDag } from '../src/harness/goal/loop-run';
import type { ExecutorDagConfig } from '../src/harness/dag/types';
import { addPack } from '../src/harness/pack/pack';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { tryResolveSeatModel } from '../src/model/role-models';

const PACK_DIR = join(import.meta.dir, '../templates/packs/tdd-bugfix');
const READINGS_DIR = join(PACK_DIR, 'eval/readings');

/** 任务注册表: fixture 目录 + 隐藏 oracle + oracle 拷入世界时的 import 改写对。 */
const TASKS: Record<string, { fixture: string; oracle: string; importFrom: string; importTo: string[] }> = {
  'broken-calc': {
    fixture: join(PACK_DIR, 'eval/tasks/broken-calc'),
    oracle: join(PACK_DIR, 'eval/oracle/regression.oracle.ts'),
    importFrom: '../tasks/broken-calc/src/',
    importTo: ['split-bill'],
  },
  'weighted-ledger': {
    fixture: join(PACK_DIR, 'eval/tasks/weighted-ledger'),
    oracle: join(PACK_DIR, 'eval/oracle/weighted-ledger.oracle.ts'),
    importFrom: '../tasks/weighted-ledger/src/',
    importTo: ['settle', 'report'],
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const arm = arg('arm');
if (arm !== 'bare' && arm !== 'pack') {
  console.error('用法: bun scripts/eval-tdd-pack.ts --arm bare|pack [--n 2] [--keep]');
  process.exit(1);
}
const n = Number(arg('n') ?? '2');
const keep = process.argv.includes('--keep');
const taskName = arg('task') ?? 'broken-calc';
const TASK = TASKS[taskName] ?? ((): never => {
  console.error(`未知任务 ${taskName}; 可选: ${Object.keys(TASKS).join(', ')}`);
  process.exit(1);
})();
const gapMs = Number(arg('gapMs') ?? '20000');

bootstrapModelRuntime();

function seat(id: string): string {
  const r = tryResolveSeatModel(id as never);
  if (!r) throw new Error(`座位 ${id} 未配置 —— 先 omd config dump 看缺哪层`);
  console.error(`[eval-tdd-pack] 座位 ${id} = ${r.model} (来源 ${r.source})`);
  return r.model;
}

/** 任务文本: 两臂逐字相同, 刻意中性 —— 纪律只许来自卡 (单一变量)。 */
function taskText(world: string): string {
  return `${readFileSync(join(TASK.fixture, 'BUG_REPORT.md'), 'utf8')}\n仓库在 ${world}。修复这个 bug。`;
}

/**
 * 死叶判定 (解剖修正 2026-08-17): 全部叶子几乎零输入且零文件写 = 执行通道没干活
 * (n=8 解剖: 9/16 跑此形态, 产物一字未动)。通道故障不进能力分母 —— 重试一次, 仍死则
 * 标 channelDead, 读数消费方剔除。
 */
function isChannelDead(result: Awaited<ReturnType<typeof runExecutorDag>>): boolean {
  const touchedAny = Object.values(result.results).some((r) => (r.filesTouched ?? []).length > 0);
  return !touchedAny && result.usage.leavesIn < 10_000;
}

async function runOnce(i: number): Promise<Record<string, unknown>> {
  const world = mkdtempSync(join(tmpdir(), `omd-tddeval-${arm}-`));
  const t0 = Date.now();
  try {
    cpSync(TASK.fixture, world, { recursive: true });
    if (arm === 'pack') {
      const r = await addPack(world, PACK_DIR);
      if (!r.ok) throw new Error(`pack 装不进 eval 世界: ${r.message}`);
    }
    const config: ExecutorDagConfig = {
      conductorModel: seat('conductor'),
      leafModel: seat('leaf'),
      agentLeafModel: seat('agent'),
      agentTemplates: loadAgentTemplates({ root: world }), // 单一变量的落点: 世界里装没装 pack
      agentRunner: createAgentLeafRunner({ cwd: world, hashlineEdit: true }),
      commandRunner: createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd: world, timeoutMs: 180_000 }),
      maxFanout: 4,
      // continuity 省略 = 一次性世界不留 checkpoint
      cancelSignal: AbortSignal.timeout(12 * 60_000), // 协作式软停, 防单跑挂死
      sessionId: `tddeval-${arm}-${i}-${Date.now()}`,
    };
    let result = await runExecutorDag(taskText(world), config);
    let retriedDead = false;
    if (isChannelDead(result)) {
      console.error('[eval-tdd-pack] 死叶形态 → 通道故障重试一次 (不进能力分母)');
      retriedDead = true;
      result = await runExecutorDag(taskText(world), { ...config, sessionId: `${config.sessionId}-retry` });
    }
    const channelDead = isChannelDead(result);

    // ── S1: 隐藏 oracle (跑完才拷入, 执行体全程不可见) ──────────────────────
    const oraclePath = join(world, 'src', 'oracle.test.ts');
    let oracleSrc = readFileSync(TASK.oracle, 'utf8');
    for (const mod of TASK.importTo) oracleSrc = oracleSrc.replaceAll(`'${TASK.importFrom}${mod}'`, `'./${mod}'`);
    writeFileSync(oraclePath, oracleSrc);
    const oracleRun = spawnSync('bun', ['test', 'src/oracle.test.ts'], { cwd: world, encoding: 'utf8', timeout: 60_000 });
    const s1_oraclePass = oracleRun.status === 0;

    // ── S2: verify-red 纪律 (plan 有 expect_exit≥1 节点且真跑红) ────────────
    const planNodes = result.plan.nodes as Record<string, { expect_exit?: number; template?: string } | undefined>;
    const s2_verifyRed = Object.entries(result.results).some(([id, r]) => {
      const want = planNodes[id]?.expect_exit;
      return typeof want === 'number' && want >= 1 && r.exitCode === want;
    });

    // ── S3: 改既有测试违规 (动 split-bill.test.ts; 新建测试文件合法) ─────────
    const s3_touchedExistingTest = Object.values(result.results).some((r) =>
      (r.filesTouched ?? []).some((f) => f.includes('split-bill.test.ts')),
    );

    // ── 派卡率 (R0 消费方): plan 层 template 分布 ────────────────────────────
    const cardsAssigned: Record<string, number> = {};
    for (const nEntry of Object.values(planNodes)) {
      const t = nEntry?.template?.trim();
      if (t) cardsAssigned[t] = (cardsAssigned[t] ?? 0) + 1;
    }

    return {
      ts: new Date().toISOString(),
      arm,
      task: taskName,
      i,
      ...(retriedDead ? { retriedDead } : {}),
      ...(channelDead ? { channelDead } : {}),
      s1_oraclePass,
      s2_verifyRed,
      s3_touchedExistingTest,
      cardsAssigned,
      nodes: Object.keys(result.results).length,
      // 解剖修正 (2026-08-17): 死叶归因不再靠 leavesIn 反推 —— 逐节点终态与败因入读数。
      nodeOutcomes: Object.values(result.results).reduce<Record<string, number>>((acc, r) => {
        const k = r.status === 'failed' ? `failed:${r.failureKind ?? 'unknown'}` : r.status;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      usage: result.usage,
      wallMs: Date.now() - t0,
      sessionId: result.sessionId,
      ...(s1_oraclePass ? {} : { oracleTail: `${oracleRun.stdout ?? ''}${oracleRun.stderr ?? ''}`.slice(-400) }),
    };
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      arm,
      task: taskName,
      i,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      wallMs: Date.now() - t0,
    };
  } finally {
    if (keep) console.error(`[keep] 世界保留: ${world}`);
    else rmSync(world, { recursive: true, force: true });
  }
}

mkdirSync(READINGS_DIR, { recursive: true });
const out = join(READINGS_DIR, `${taskName === 'broken-calc' ? '' : `${taskName}-`}${arm}.jsonl`);
for (let i = 0; i < n; i++) {
  console.error(`[eval-tdd-pack] task=${taskName} arm=${arm} run ${i + 1}/${n} …`);
  const reading = await runOnce(i);
  appendFileSync(out, `${JSON.stringify(reading)}\n`);
  console.error(`[eval-tdd-pack] → ${JSON.stringify(reading).slice(0, 200)}`);
  if (i < n - 1 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs)); // 连跑限流缓冲 (死叶解剖的直接回应)
}
console.error(`[eval-tdd-pack] 读数 append 至 ${out}`);
