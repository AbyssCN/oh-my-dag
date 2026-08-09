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
import { callModel } from '../src/model/index';
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
  console.error('');
  console.error('选项:');
  console.error('  --run <id>     run id (省略 = 自动生成)');
  console.error('  --cwd <dir>    工作目录 (默认 cwd)');
  console.error('  --model <m>    provider:modelId (默认 OMD_DREAM_MODEL env)');
  console.error('  --json         JSON 输出 (默认人读)');
  console.error('  --dry-run      只读不写 (all 模式)');
  process.exit(1);
}

interface ParsedArgs {
  phase: string;
  runId: string;
  cwd: string;
  model?: string;
  json: boolean;
  dryRun: boolean;
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

async function phaseAll(args: ParsedArgs): Promise<void> {
  // 整跑: 调用 assembly
  const report = await runDreamAssembly({
    cwd: args.cwd,
    runId: args.runId,
    callModel: args.dryRun ? undefined : callModel,
    model: args.model,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDreamReport(report));
  }

  if (!report.ok) process.exit(1);
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
  all: phaseAll,
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
