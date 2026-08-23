#!/usr/bin/env bun
/**
 * verifier 校准实验 · **语料提取器**(2026-08-23)
 *
 * 从 `.omd/continuity/<runId>/` 的节点 checkpoint 重建 verifier 真正看到的那两样:
 * `task`(goal 原文)与 `summary`(`summarizeResults` 的输出)。
 *
 * ⚠ **刻意调真的 `summarizeResults`**,不另写一份渲染 —— 两份渲染会漂,
 * 而漂掉之后这个实验量的就不是生产里那个判卷面了(本仓 S-45 同形)。
 *
 * ⚠ 它**只产语料,不打标签**。真值(该过 / 该不过)由人逐条填进
 * `docs/plan/verifier-calibration/labels.json`,并写明**依据**。
 * 提取器猜标签 = 用被测系统的输出当真值,那是循环论证。
 *
 * 用法:`bun run scripts/verifier-calibration-extract.ts [--out <dir>]`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { summarizeResults } from '../src/harness/verifier';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import type { LeafResult } from '../src/harness/dag/types';

const ROOT = join(import.meta.dir, '..');
const CONT = join(ROOT, '.omd/continuity');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1]! : join(ROOT, 'docs/plan/verifier-calibration');

/** 一个 (run, 轮) 状态 = 一条候选语料。`__r1` 后缀是轮 1 的快照。 */
interface Fixture {
  id: string;
  runId: string;
  round: 'r1' | 'final';
  task: string;
  summary: string;
  nodes: number;
  /** 引擎自己当时的判定,**只作对照,不当真值**。 */
  engineNote: { status?: string; failureKind?: string }[];
}

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8'));

/** checkpoint → LeafResult 的最小重建(只填 summarizeResults 真正读的位)。 */
function toLeafResult(ck: Record<string, unknown>): LeafResult {
  const status = (ck.status as string) ?? 'done';
  return {
    id: (ck.nodeId as string) ?? 'unknown',
    status: status === 'failed' ? 'failed' : 'done',
    kind: (ck.leafKind as string) ?? 'agent',
    output: (ck.outputText as string) ?? (ck.summary as string) ?? '',
    deps: [],
    usage: { in: 0, out: 0 },
    ...(ck.outputPaths ? { filesTouched: ck.outputPaths as string[] } : {}),
    ...(ck.shellRuns ? { shellRuns: ck.shellRuns as LeafResult['shellRuns'] } : {}),
  } as LeafResult;
}

function extractRun(dir: string): Fixture[] {
  const runId = basename(dir);
  const dagPath = join(dir, '_dag.json');
  if (!existsSync(dagPath)) return [];
  const dag = readJson(dagPath);
  const plan = (dag.plan ?? dag) as ConductorPlan;
  // ⚠ `dag.goal` 是 **plan 名**(如 `goal-execute-flat`), 不是任务原文 —— 原文在 `taskText`。
  //   2026-08-23 第一版读错了这一位, 提取出来的 task 全是 'goal-execute-flat'。
  const task = (dag.taskText as string) ?? '';
  if (!task || !plan || typeof plan.nodes !== 'object' || plan.nodes === null) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_dag.json' && !f.includes('seat-self'));
  const out: Fixture[] = [];
  for (const round of ['r1', 'final'] as const) {
    // 轮 1 的快照带 `__r1`;终态是不带后缀的那份。轮 1 缺席 ⇒ 该轮没跑到 = 不产语料。
    const picked = files.filter((f) => (round === 'r1' ? f.includes('.__r1.json') : !f.includes('.__r1.json')));
    if (picked.length === 0) continue;
    const results: Record<string, LeafResult> = {};
    const engineNote: Fixture['engineNote'] = [];
    for (const f of picked) {
      const ck = readJson(join(dir, f));
      const id = (ck.nodeId as string) ?? f.replace(/(\.__r1)?\.json$/, '');
      results[id] = { ...toLeafResult(ck), id };
      engineNote.push({ status: ck.status as string, failureKind: ck.failureKind as string });
    }
    out.push({
      id: `${runId.slice(0, 8)}-${round}`,
      runId,
      round,
      task,
      summary: summarizeResults(plan, results),
      nodes: Object.keys(results).length,
      engineNote,
    });
  }
  return out;
}

const dirs = readdirSync(CONT)
  .map((d) => join(CONT, d))
  .filter((d) => existsSync(join(d, '_dag.json')));

const fixtures = dirs.flatMap(extractRun).filter((f) => f.summary.length > 200 && f.task.length > 100);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'fixtures.json'), JSON.stringify(fixtures, null, 1));

console.log(`扫了 ${dirs.length} 个 run 目录 → ${fixtures.length} 条候选语料`);
console.log('id'.padEnd(24) + ' 节点  task字节  summary字节');
for (const f of fixtures.slice(0, 40)) {
  console.log(`${f.id.padEnd(24)} ${String(f.nodes).padEnd(5)} ${String(f.task.length).padEnd(9)} ${f.summary.length}`);
}
console.log(`\n写入 ${join(OUT, 'fixtures.json')}`);
console.log('⚠ 真值标签**没填** —— 由人逐条填 labels.json 并写明依据(提取器猜标签 = 循环论证)。');
