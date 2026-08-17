/**
 * scripts/eval-tdd-pack —— tdd-bugfix 参考 pack 的 A/B eval 驱动 (PLAN.md 的机械化)。
 *
 * 用法: bun scripts/eval-tdd-pack.ts --arm bare|pack [--n 2] [--keep]
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
import { runExecutorDag } from '../src/harness/dag/engine';
import type { ExecutorDagConfig } from '../src/harness/dag/types';
import { addPack } from '../src/harness/pack/pack';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { tryResolveSeatModel } from '../src/model/role-models';

const PACK_DIR = join(import.meta.dir, '../templates/packs/tdd-bugfix');
const FIXTURE = join(PACK_DIR, 'eval/tasks/broken-calc');
const ORACLE = join(PACK_DIR, 'eval/oracle/regression.oracle.ts');
const READINGS_DIR = join(PACK_DIR, 'eval/readings');

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

bootstrapModelRuntime();

function seat(id: string): string {
  const r = tryResolveSeatModel(id as never);
  if (!r) throw new Error(`座位 ${id} 未配置 —— 先 omd config dump 看缺哪层`);
  return r.model;
}

/** 任务文本: 两臂逐字相同, 刻意中性 —— 纪律只许来自卡 (单一变量)。 */
function taskText(world: string): string {
  return `${readFileSync(join(FIXTURE, 'BUG_REPORT.md'), 'utf8')}\n仓库在 ${world}。修复这个 bug。`;
}

async function runOnce(i: number): Promise<Record<string, unknown>> {
  const world = mkdtempSync(join(tmpdir(), `omd-tddeval-${arm}-`));
  const t0 = Date.now();
  try {
    cpSync(FIXTURE, world, { recursive: true });
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
    const result = await runExecutorDag(taskText(world), config);

    // ── S1: 隐藏 oracle (跑完才拷入, 执行体全程不可见) ──────────────────────
    const oraclePath = join(world, 'src', 'oracle.test.ts');
    writeFileSync(oraclePath, readFileSync(ORACLE, 'utf8').replace("'../tasks/broken-calc/src/split-bill'", "'./split-bill'"));
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
      i,
      s1_oraclePass,
      s2_verifyRed,
      s3_touchedExistingTest,
      cardsAssigned,
      nodes: Object.keys(result.results).length,
      usage: result.usage,
      wallMs: Date.now() - t0,
      sessionId: result.sessionId,
      ...(s1_oraclePass ? {} : { oracleTail: `${oracleRun.stdout ?? ''}${oracleRun.stderr ?? ''}`.slice(-400) }),
    };
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      arm,
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
const out = join(READINGS_DIR, `${arm}.jsonl`);
for (let i = 0; i < n; i++) {
  console.error(`[eval-tdd-pack] arm=${arm} run ${i + 1}/${n} …`);
  const reading = await runOnce(i);
  appendFileSync(out, `${JSON.stringify(reading)}\n`);
  console.error(`[eval-tdd-pack] → ${JSON.stringify(reading).slice(0, 200)}`);
}
console.error(`[eval-tdd-pack] 读数 append 至 ${out}`);
