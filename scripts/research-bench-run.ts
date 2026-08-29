#!/usr/bin/env bun
/**
 * scripts/research-bench-run —— 拿研究类 bench 的 prompt 跑 omd,产 markdown 报告 + 逐题读数。
 *
 * ## 为什么存在
 *
 * 到 2026-08-29 为止,omd 只有**一把尺子**(code80 代码 bench),而验收分型里的
 * `rubric`(逐条判)和 `exploratory`(学习目标)两格**一次都没被量过**。
 * ResearchRubrics / DeepResearch Bench 这类语料的判分形状恰好就是 rubric —— 所以它们
 * 不是"换个领域再测一遍",是第一次给那一格通电。
 *
 * 语料形状(ResearchRubrics `processed_data.jsonl`):
 *   `{prompt, sample_id, domain, conceptual_breadth, logical_nesting, exploration, rubrics[]}`
 *   判官吃的是 `<sample_id>.md`,所以本脚本的产物文件名**必须**是 sample_id。
 *
 * ## 它只做两件事
 *
 * 1. 每题跑一次 `scripts/dag-research.ts --out <outDir>/<sample_id>.md`;
 * 2. **逐题记读数**,写 `<outDir>/readings.jsonl`。
 *
 * 判分**不在这里**:那一步走语料自带的判官(见 `docs/plan/` 里的研究 bench 票),
 * 本脚本一个字都不判 —— 产出与判分分开,判官换了不用改这里。
 *
 * ## 读数为什么是这四个
 *
 * 冒烟那一跑要回答的正是"101 个能不能一口气跑"。四个数各答一问:
 *   · `searchDelta`  —— 一次研究搜几次?(配额撑不撑得住,tavily 只剩三位数)
 *   · `tokensDelta`  —— 一次多少 token?(成本能不能外推到 101)
 *   · `wallMs`       —— 一次多久?(排批用)
 *   · `reportBytes`  —— 报告真落盘了吗?(接缝有没有通)
 *
 * **失败也照记**(`ok:false` + 原文):只记成功的实验没有信息量。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Task {
  prompt: string;
  sample_id: string;
  domain?: string;
  exploration?: string;
  conceptual_breadth?: string;
  rubrics?: unknown[];
}

/** 池账本读数(搜了几次)。取不到就返 null —— **不返 0**:「没量到」与「一次没搜」是两件事。 */
async function searchUsed(): Promise<number | null> {
  try {
    const { createWebStackFromEnv } = await import('../src/harness/web/index');
    const st = createWebStackFromEnv(process.env).searchPool.status();
    return st.reduce((a, s) => a + (typeof s.used === 'number' ? s.used : 0), 0);
  } catch {
    return null;
  }
}

/** tui-usage.jsonl 的累计 in/out。同上:取不到返 null。 */
function tokensUsed(): { in: number; out: number } | null {
  const p = join(process.env.HOME ?? '', '.omd', 'tui-usage.jsonl');
  if (!existsSync(p)) return null;
  let tin = 0;
  let tout = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { in?: number; out?: number };
      tin += j.in ?? 0;
      tout += j.out ?? 0;
    } catch { /* 半行/损坏行跳过, 不影响 delta 的量级 */ }
  }
  return { in: tin, out: tout };
}

/**
 * 冒烟选题: 按 `exploration` 分层各取一个 (Low / Medium / High)。
 *
 * 为什么分层而不是随便挑三个: 要回答的是"搜索次数随探索度怎么涨", 三个同类样本外推不出斜率。
 */
export function pickSmoke(tasks: Task[], n = 3): Task[] {
  const tiers = ['Low', 'Medium', 'High'];
  const out: Task[] = [];
  for (const t of tiers) {
    const c = tasks.filter((x) => x.exploration === t).sort((a, b) => (a.rubrics?.length ?? 0) - (b.rubrics?.length ?? 0));
    if (c[0]) out.push(c[0]); // 同层里挑 rubric 最少的 —— 冒烟阶段判分也便宜
  }
  return out.slice(0, n);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataPath = flag('data') ?? '/tmp/researchrubrics/data/researchrubrics/processed_data.jsonl';
  const outDir = flag('out') ?? '/tmp/rr-reports';
  const rounds = flag('rounds') ?? '1';
  const ids = flag('ids')?.split(',').map((s) => s.trim()).filter(Boolean);
  const smoke = args.includes('--smoke');
  if (!existsSync(dataPath)) {
    process.stderr.write(`research-bench-run: 语料不在 ${dataPath}\n`);
    process.exit(1);
  }
  const all: Task[] = readFileSync(dataPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Task);
  const tasks = ids ? all.filter((t) => ids.includes(t.sample_id)) : smoke ? pickSmoke(all) : all;
  if (tasks.length === 0) {
    process.stderr.write('research-bench-run: 选出 0 个任务 (--ids 对不上?)\n');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const readingsPath = join(outDir, 'readings.jsonl');
  process.stderr.write(`[rr-run] ${tasks.length} 个任务 → ${outDir} (rounds=${rounds})\n`);

  for (const [i, t] of tasks.entries()) {
    const md = join(outDir, `${t.sample_id}.md`);
    const s0 = await searchUsed();
    const k0 = tokensUsed();
    const t0 = Date.now();
    let ok = false;
    let err = '';
    try {
      const proc = Bun.spawn(
        ['bun', 'run', join(import.meta.dir, 'dag-research.ts'), t.prompt, '--rounds', rounds, '--out', md],
        { stdout: 'inherit', stderr: 'inherit', cwd: join(import.meta.dir, '..') },
      );
      const code = await proc.exited;
      ok = code === 0 && existsSync(md) && statSync(md).size > 0;
      if (!ok) err = `exit=${code} · 报告${existsSync(md) ? `只有 ${statSync(md).size} 字节` : '没落盘'}`;
    } catch (e) {
      err = (e as Error).message;
    }
    const s1 = await searchUsed();
    const k1 = tokensUsed();
    const reading = {
      sample_id: t.sample_id,
      domain: t.domain ?? null,
      exploration: t.exploration ?? null,
      rubrics: t.rubrics?.length ?? null,
      ok,
      ...(err ? { err } : {}),
      wallMs: Date.now() - t0,
      // null = 没量到 (账本读不了), 不是 0 次 —— 两者事后必须分得开。
      searchDelta: s0 !== null && s1 !== null ? s1 - s0 : null,
      tokensDelta: k0 && k1 ? { in: k1.in - k0.in, out: k1.out - k0.out } : null,
      reportBytes: existsSync(md) ? statSync(md).size : 0,
    };
    appendFileSync(readingsPath, `${JSON.stringify(reading)}\n`);
    process.stderr.write(
      `[rr-run] ${i + 1}/${tasks.length} ${t.sample_id} ${ok ? '✓' : '✗'} · ${Math.round(reading.wallMs / 1000)}s · ` +
        `搜 ${reading.searchDelta ?? '?'} 次 · ${reading.reportBytes} 字节${err ? ` · ${err}` : ''}\n`,
    );
  }
  process.stderr.write(`[rr-run] 读数 → ${readingsPath}\n`);
}
