#!/usr/bin/env bun
/**
 * scripts/omd-dream —— dream SDD §S6 手动触发 CLI。
 *
 * 用法:
 *   bun run scripts/omd-dream.ts <phase> --run <id>
 *   bun run scripts/omd-dream.ts all     --run <id>   # 一键整跑
 *
 * phase:
 *   gather    — S1 语料采集 (零 LLM)
 *   validate  — S2 候选验证 (零 LLM, 需 --candidates)
 *   merge     — S2 候选合并 (零 LLM, 需 --candidates)
 *   promote   — S3 晋升 + prune (零 LLM)
 *   report    — 打印上次 run 报告
 *   all       — 一键整跑 (gather → extract → validate → merge → promote → report)
 *
 * 硬约束:
 *   - 不改 cli.ts 主注册表
 *   - 不碰 conductor/system prompt
 *   - 不碰主仓真实 memory.db (测试走临时/fixture)
 *   - 账唯一出口 = gateway callModel (不重复 emitModelUsage)
 */
import '../src/harness/script-bootstrap';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDreamAssembly, formatDreamReport, L_MAX, COST_MAX_USD } from '../src/harness/dream/assembly';
import { gather } from '../src/harness/dream/gather';
import { validateDreamCandidate, dreamFactInput } from '../src/harness/dream/validate';
import { mergeDreamCandidates } from '../src/harness/dream/merge';
import { promoteDreamFacts } from '../src/harness/dream/promote';
import { createRunStore } from '../src/mcp/run-store';
import { acquireDreamLock, releaseDreamLock } from '../src/harness/dream/trigger';
import { callModel } from '../src/model';
import type { DreamCandidate } from '../src/harness/dream/validate';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function usage(): never {
  console.error('用法: bun run scripts/omd-dream.ts <phase> [--run <id>] [--cwd <dir>] [--model <provider:model>] [--json]');
  console.error('');
  console.error('phase:');
  console.error('  gather     S1 语料采集 (零 LLM)');
  console.error('  validate   S2 候选验证 (零 LLM, 需 stdin JSON candidates)');
  console.error('  merge      S2 候选合并 (零 LLM, 需 stdin JSON candidates)');
  console.error('  promote    S3 晋升 + prune (零 LLM)');
  console.error('  report     打印上次统计数据');
  console.error('  all        一键整跑 (全图)');
  console.error('  drain      一直分批跑到脏源清空 (存量消化; 三条停机判据见 phaseDrain 注)');
  console.error('');
  console.error('选项:');
  console.error('  --run <id>     run id (省略 = 自动生成)');
  console.error('  --cwd <dir>    工作目录 (默认 cwd)');
  console.error('  --model <m>    provider:modelId (默认 OMD_DREAM_MODEL env)');
  console.error('  --json         JSON 输出 (默认人读)');
  console.error('  --dry-run      只读不写 (all 模式)');
  console.error('  --batch <n>    分批消费: 本跑只吃 ≤n 个 dirty 源, 水位逐段推进 (存量首跑用)');
  console.error('  --max-usd <n>  drain 的总预算 (默认 5.00) — 单跑 $0.10 的上限拦不住 26 跑');
  process.exit(1);
}

interface ParsedArgs {
  phase: string;
  runId: string;
  cwd: string;
  model?: string;
  json: boolean;
  dryRun: boolean;
  batch?: number;
  /** drain 的**总**预算(单跑的 COST_MAX_USD 拦不住 26 跑)。 */
  maxUsd?: number;
}

function parseArgs(raw: string[]): ParsedArgs {
  const args: ParsedArgs = {
    phase: '',
    runId: randomUUID().slice(0, 8),
    cwd: process.cwd(),
    json: false,
    dryRun: false,
  };

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (a === '--run' && raw[i + 1]) { args.runId = raw[++i]!; }
    else if (a === '--cwd' && raw[i + 1]) { args.cwd = raw[++i]!; }
    else if (a === '--model' && raw[i + 1]) { args.model = raw[++i]!; }
    else if (a === '--json') { args.json = true; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--batch' && raw[i + 1]) { args.batch = Number(raw[++i]!); }
    else if (a === '--max-usd' && raw[i + 1]) { args.maxUsd = Number(raw[++i]!); }
    else if (!a.startsWith('--')) {
      if (!args.phase) args.phase = a;
      else { console.error(`未知参数: ${a}`); usage(); }
    } else {
      console.error(`未知选项: ${a}`); usage();
    }
  }

  if (!args.phase) usage();
  return args;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

async function phaseGather(args: ParsedArgs): Promise<void> {
  const runStore = createRunStore({ path: join(args.cwd, '.omd', 'runs.db') });
  try {
    const report = await gather({ cwd: args.cwd, runStore });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`dirtyTotal: ${report.dirtyTotal}`);
      console.log(`skippedClean: ${report.skippedClean}`);
      for (const s of report.sources) {
        console.log(`  ${s.type} ${s.key}: ${s.state}${s.dirtyCount > 0 ? ` (+${s.dirtyCount})` : ''}${s.reason ? ` (${s.reason})` : ''}`);
      }
    }
  } finally {
    runStore.close();
  }
}

async function phaseValidate(args: ParsedArgs): Promise<void> {
  // 从 stdin 读 JSON candidates
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf-8');
  let candidates: DreamCandidate[];
  try {
    candidates = JSON.parse(raw);
    if (!Array.isArray(candidates)) throw new Error('expected JSON array');
  } catch (err) {
    console.error(`stdin 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const results: unknown[] = [];
  for (const c of candidates) {
    const r = await validateDreamCandidate(c, { cwd: args.cwd });
    results.push({ candidate: c, ...r });
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results as Array<{ verdict: string; reason?: string }>) {
      console.log(`  ${r.verdict}${r.reason ? `: ${r.reason}` : ''}`);
    }
  }
}

async function phaseMerge(args: ParsedArgs): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf-8');
  let candidates: Array<{ leafId: string; candidate: DreamCandidate }>;
  try {
    candidates = JSON.parse(raw);
    if (!Array.isArray(candidates)) throw new Error('expected JSON array');
  } catch (err) {
    console.error(`stdin 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const report = await mergeDreamCandidates(candidates, { cwd: args.cwd, runId: args.runId });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`ok: ${report.ok}`);
    console.log(`added: ${report.added}  evolved: ${report.evolved}  replaced: ${report.replaced}`);
    console.log(`rejected: ${report.rejected.length}`);
    if (report.failReason) console.log(`failReason: ${report.failReason}`);
  }
}

async function phasePromote(args: ParsedArgs): Promise<void> {
  const report = await promoteDreamFacts({ cwd: args.cwd });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`ok: ${report.ok}`);
    console.log(`promoted: ${report.promoted}  pruned: ${report.pruned}`);
  }
}

async function phaseReport(_args: ParsedArgs): Promise<void> {
  // report 是 all 的副产物; 单独调用时跑一次 gather 看当前状态
  const runStore = createRunStore({ path: join(_args.cwd, '.omd', 'runs.db') });
  try {
    const g = await gather({ cwd: _args.cwd, runStore });
    if (_args.json) {
      console.log(JSON.stringify(g, null, 2));
    } else {
      console.log(`dirtyTotal: ${g.dirtyTotal}`);
      console.log(`skippedClean: ${g.skippedClean}`);
      console.log(`sources: ${g.sources.length} (dirty: ${g.sources.filter(s => s.state === 'dirty').length})`);
    }
  } finally {
    runStore.close();
  }
}

/** 锁位置 —— 与 hook 侧 `dreamLockPath` 同一个文件(一个仓一把, 手起的与 hook 派的共用)。 */
function lockPathOf(cwd: string): string {
  return join(cwd, '.omd', 'dream.lock');
}

/**
 * 持锁跑一段。**手起的 CLI 也必须占位** —— 2026-08-28 实测:开关打开后第一次 Stop,
 * hook 派的批与手起的 drain 同时对着一个 memory.db 跑,同一批语料被抽两遍、水位互相覆盖。
 * 只给 hook 侧加锁挡不住这个方向。
 */
async function withDreamLock(cwd: string, fn: () => Promise<void>): Promise<void> {
  if (!acquireDreamLock(lockPathOf(cwd))) {
    console.error('[dream] 已有一个 dream 在跑(锁被占)—— 不重复跑。陈锁 30 分钟自动过期。');
    process.exit(1);
  }
  try {
    await fn();
  } finally {
    releaseDreamLock(lockPathOf(cwd));
  }
}

async function phaseAll(args: ParsedArgs): Promise<void> {
  // 整跑: 调用 assembly
  const report = await runDreamAssembly({
    cwd: args.cwd,
    runId: args.runId,
    callModel: args.dryRun ? undefined : callModel,
    model: args.model,
    ...(args.batch !== undefined && Number.isFinite(args.batch) && args.batch > 0
      ? { batchLeaves: Math.floor(args.batch) }
      : {}),
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDreamReport(report));
  }

  if (!report.ok) process.exit(1);
}

/**
 * **drain —— 一直分批跑到脏源清空**(2026-08-28,存量消化用)。
 *
 * ## 为什么不是"把上限调大跑一次"
 *
 * `assembly` 的 `L_MAX=12`(模型叶)与 `COST_MAX_USD=0.10`(每跑)是**预检不是截断**:
 * 超了整跑失败、**零写入**(`merge.ts` 的第一版是"写完再置 ok:false",比截断更糟 ——
 * 副作用全落了而失败只是装饰,那次改判就是为了这个)。所以把 303 个源塞进一跑
 * 不会"跑得久一点",是**一条都写不进去**。drain 只能是**重复的小批**。
 *
 * ## 三条停机判据(缺一会变成烧钱的死循环)
 *
 * ① **清空**:gather 报 `dirtyTotal === 0` —— 正常出口。
 * ② **游标无进展**:一批下来脏源个数没减少 → 停(源消化不掉,反复烧同一批)。
 * ②b **产出无进展**:连续 `ZERO_YIELD_STREAK` 批 `added+evolved+promoted === 0` → 停。
 *    ⚠ 这一条是 2026-08-28 实跑补的:首版只有②,而②量的是**语料被吃掉了多少**,
 *    不是**产出了多少**。于是一个"只消耗语料、零产出"的 drain 在判据下看起来完全健康 ——
 *    而它每批照烧 12 次模型调用,并且把水位推进了(**那批语料再也采不回来**)。
 *    量错了对象的闸比没有闸更危险,因为它给人一个"在看着"的错觉。
 * ③ **总预算**:`--max-usd`(默认 5.00)。每跑 $0.10 的上限是**单跑**的,
 *    26 跑就是 26 倍 —— 单跑上限拦不住 drain,必须另有一个总额。
 */
/** 连续几批零产出就停。3 = 容得下正常的稀疏(有些批确实没教训), 又拦得住系统性空转。 */
const ZERO_YIELD_STREAK = 3;

async function phaseDrain(args: ParsedArgs): Promise<void> {
  const batch = args.batch !== undefined && args.batch > 0 ? Math.floor(args.batch) : 12;
  const maxUsd = args.maxUsd ?? 5.0;
  let spent = 0;
  let pass = 0;
  let prevDirty = Number.POSITIVE_INFINITY;
  let zeroYield = 0;

  for (;;) {
    const runStore = createRunStore({ path: join(args.cwd, '.omd', 'runs.db') });
    let dirtySources: number;
    let dirtyTotal: number;
    try {
      const g = await gather({ cwd: args.cwd, runStore });
      dirtyTotal = g.dirtyTotal;
      dirtySources = g.sources.filter((s) => s.state === 'dirty').length;
    } finally {
      runStore.close();
    }

    if (dirtySources === 0) {
      console.log(`[drain] 清空 — 共 ${pass} 批, 花费 ~$${spent.toFixed(3)}`);
      return;
    }
    if (dirtySources >= prevDirty) {
      // ② 无进展:上一批没减少任何脏源。再跑一次只会再烧一次同样的钱。
      console.error(
        `[drain] **停:无进展** — 脏源 ${prevDirty} → ${dirtySources}, 第 ${pass} 批之后没减少。` +
          ' 这批源大概率是消化不掉的(extract 恒失败 / 语料坏)—— 单独看 dream.log 那几条, 别继续烧。',
      );
      process.exit(1);
    }
    if (spent >= maxUsd) {
      console.error(`[drain] **停:总预算用尽** — 花了 ~$${spent.toFixed(3)} ≥ $${maxUsd}, 还剩 ${dirtySources} 个脏源。加 --max-usd 才继续。`);
      process.exit(1);
    }

    prevDirty = dirtySources;
    pass++;
    console.log(`[drain] 第 ${pass} 批 — 脏源 ${dirtySources} / 脏条目 ${dirtyTotal} / 本批 ≤${batch} / 已花 ~$${spent.toFixed(3)}`);

    const report = await runDreamAssembly({
      cwd: args.cwd,
      // 每批一个新 runId —— 用同一个的话报告与账本会把 26 批叠成一批, 事后分不开哪批出的哪条。
      runId: `${args.runId}-p${pass}`,
      callModel: args.dryRun ? undefined : callModel,
      model: args.model,
      batchLeaves: batch,
    });
    spent += report.costUsd ?? 0;
    console.log(formatDreamReport(report));

    // ②b 产出判据。**注意 costUsd 在订阅制座位上恒 0** —— 所以 `--max-usd` 那条闸对这类
    // 座位是**不动的**(一个在任何干预下都不动的数,量的是尺子不是被测物)。产出判据是这里
    // 唯一真正会动的那条,别把它也删了。
    const yielded = (report.added ?? 0) + (report.evolved ?? 0) + (report.promoted ?? 0);
    zeroYield = yielded === 0 ? zeroYield + 1 : 0;
    if (zeroYield >= ZERO_YIELD_STREAK) {
      console.error(
        `[drain] **停:连续 ${ZERO_YIELD_STREAK} 批零产出** — 语料在被消耗、水位在推进、事实一条没多。` +
          ' 先查 extract 拿到的输入够不够(assembly.buildExtractRunInput 目前不喂 transcript),别继续烧。',
      );
      process.exit(1);
    }
    if (!report.ok) {
      // 一批失败**不立刻退出**:失败的那批不推进水位, 下一轮 gather 会再看见它 ——
      // 于是判据②(无进展)会在下一圈接住它。这里退出的话, 一条坏语料就能挡住其余全部。
      console.error(`[drain] 第 ${pass} 批失败(水位未推进, 下一圈由"无进展"判据接住)`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const PHASES: Record<string, (args: ParsedArgs) => Promise<void>> = {
  gather: phaseGather,
  validate: phaseValidate,
  merge: phaseMerge,
  promote: phasePromote,
  report: phaseReport,
  all: (a: ParsedArgs) => withDreamLock(a.cwd, () => phaseAll(a)),
  drain: (a: ParsedArgs) => withDreamLock(a.cwd, () => phaseDrain(a)),
};

try {
  const args = parseArgs(process.argv.slice(2));
  const handler = PHASES[args.phase];
  if (!handler) {
    console.error(`未知 phase: ${args.phase}。可用: ${Object.keys(PHASES).join(', ')}`);
    process.exit(1);
  }
  await handler(args);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
