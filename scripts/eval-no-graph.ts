#!/usr/bin/env bun
/**
 * scripts/eval-no-graph —— r2 no-graph 对照实验运行器(设计
 * docs/plan/2026-08-04-r2-no-graph-baseline-design.md 片2)。
 *
 * 两臂,同任务文本、同座位、同预算面:
 *   **B 臂 (no-graph)** = 单个 agent-leaf 一杆到底(自带工具环 = "Claude Code 式单 agent 长上下文")。
 *   **A 臂 (omd)**     = 默认 f1/f2 走 `dag_run`(conductor 扇出),g1/g2 走 `dag_goal`(solve)——
 *                        经 assembleOmdMcpTools 生产装配,零第二套语义。
 *                        `--engine run|solve` 可脱离这个默认(拆 "档位 × 题型" 混淆,见下)。
 *
 * 作业面:f1 在 `git archive` 导出的快照目录(防翻史抄答案,GWT-R2-4);f2/g1/g2 在本仓只读 +
 * 答案写 out 文件。产物头部记座位行(GWT-R2-1 的 --verify-seats 读它)。
 *
 * 用法:
 *   bun --env-file=.env run scripts/eval-no-graph.ts --task f1 --arm b --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --verify-seats --task f1 --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --score --task f1 --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --task f2 --arm a --engine solve --pair 1   # 补充实验
 *   bun --env-file=.env run scripts/eval-no-graph.ts --score --task f2 --arm a --engine solve --pair 1
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = '.omd/eval/no-graph-baseline';
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const task = (opt('task') ?? '') as 'f1' | 'f2' | 'g1' | 'g2';
const arm = (opt('arm') ?? '') as 'a' | 'b';
const pair = Number(opt('pair') ?? '1');
const cwd = process.cwd();
const TASK_DIR = 'src/eval/tasks/no-graph-baseline';

/**
 * A 臂的引擎档位。**原设计把它和任务格绑死了**(F 格→run,G 格→solve)——于是
 * "solve vs run" 与 "封闭题 vs 开放题" 两个变量捆在一起,读数分不清是谁的功劳。
 * `--engine` 就是拆这个混淆用的:同一道题跑两个档位。
 *
 * 非默认档位的产物落**另一套文件名**(`f2-a-solve-1.md`),不覆盖原对照的产物。
 */
type Engine = 'run' | 'solve';
const defaultEngine = (t: string): Engine => (t === 'g1' || t === 'g2' ? 'solve' : 'run');
const engine: Engine = (opt('engine') as Engine | undefined) ?? defaultEngine(task);
/** 文件名里的臂标识: 默认档位保持 `a`/`b` 不变(旧产物不失效), 非默认档位加后缀。 */
const armKey = (a: string): string => (engine === defaultEngine(task) ? a : `${a}-${engine}`);

function outPath(t: string, a: string, p: number): string {
  return join(cwd, OUT_DIR, `${t}-${a}-${p}.md`);
}
function workDirPath(t: string, a: string, p: number): string {
  return join(cwd, OUT_DIR, `${t}-${a}-${p}-work`);
}

/** f1 作业面: 快照导出 (无 .git)。其余任务: 本仓只读。 */
async function materialize(t: string, a: string, p: number): Promise<{ workCwd: string; taskText: string }> {
  const taskText = readFileSync(join(cwd, TASK_DIR, `${t}-task.md`), 'utf8');
  if (t === 'f1') {
    const { F1_SNAPSHOT_BEFORE } = await import('../src/eval/tasks/no-graph-baseline/f1-check');
    const d = workDirPath(t, a, p);
    if (!existsSync(join(d, 'client-skills'))) {
      mkdirSync(d, { recursive: true });
      execSync(`git archive ${F1_SNAPSHOT_BEFORE} client-skills | tar -x -C ${d}`, { cwd });
    }
    return { workCwd: d, taskText };
  }
  return { workCwd: cwd, taskText };
}

/** 任务定制的臂内指令 (两臂同文 — 只在这里拼一次)。 */
function armPrompt(t: string, taskText: string, answerFile: string): string {
  if (t === 'f1') return `${taskText}\n\n作业目录就是当前目录 (client-skills/ 在其下)。直接编辑文件完成迁移。`;
  return `${taskText}\n\n把最终回答完整写入文件 ${answerFile} (用文件写入工具创建/覆盖)。仓库文件只读参考。`;
}

async function runArmB(t: string, p: number): Promise<void> {
  const { createAgentLeafRunner } = await import('../src/harness/agent-leaf');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  const { bootstrapModelRuntime } = await import('../src/model/bootstrap');
  bootstrapModelRuntime();
  const seats = resolveEngineModels(process.env);
  const model = seats.agentLeafModel ?? seats.leafModel;
  const { workCwd, taskText } = await materialize(t, 'b', p);
  const answerFile = outPath(t, 'b', p).replace(/\.md$/, '-answer.md');
  const runner = createAgentLeafRunner({ cwd: workCwd, hashlineEdit: true, leafTimeoutMs: 3_600_000 });
  const started = Date.now();
  const r = await runner({ prompt: armPrompt(t, taskText, answerFile), model });
  mkdirSync(join(cwd, OUT_DIR), { recursive: true });
  writeFileSync(
    outPath(t, 'b', p),
    `arm: b (no-graph 单 agent)\nseat: ${model}\ntask: ${t} pair: ${p}\nwallMs: ${Date.now() - started}\n` +
      `usage: in=${r.usage.in} out=${r.usage.out}\nworkDir: ${workCwd}\n\n---\n\n${r.text.slice(0, 4000)}`,
  );
  console.log(`b 臂完成: ${outPath(t, 'b', p)}`);
}

async function runArmA(t: string, p: number): Promise<void> {
  const { assembleOmdMcpTools } = await import('../src/mcp/assemble');
  const { RunRegistry } = await import('../src/mcp/run-registry');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  const { bootstrapModelRuntime } = await import('../src/model/bootstrap');
  bootstrapModelRuntime();
  const seats = resolveEngineModels(process.env);
  const { workCwd, taskText } = await materialize(t, armKey('a'), p);
  const answerFile = outPath(t, armKey('a'), p).replace(/\.md$/, '-answer.md');
  // 陈旧产物清场 (2026-08-04 实测污染): pair3 复测的 write 节点发现上一跑的答案文件"已验证"
  // 便不再写, 评分评到了旧引擎的答案 (Langfuse ed4dbe39: "Existing … prior run, 16:50")。
  // 重跑必须从空白开始, 否则"分数"量的是磁盘残留不是本跑。
  rmSync(answerFile, { force: true });
  const registry = new RunRegistry();
  const tools = assembleOmdMcpTools({ cwd: workCwd, runRegistry: registry });
  const toolName = engine === 'solve' ? 'dag_goal' : 'dag_run';
  const tool = tools.find((x) => x.name === toolName)!;
  const started = Date.now();
  const args = toolName === 'dag_goal'
    ? { goal: armPrompt(t, taskText, answerFile), maxRounds: 2 }
    : { task: armPrompt(t, taskText, answerFile) };
  const res = (await tool.handler(args as never, {} as never)) as { content: { text: string }[]; isError?: boolean };
  const runId = /runId: (\S+)/.exec(res.content[0]?.text ?? '')?.[1];
  if (!runId || res.isError) throw new Error(`A 臂起跑失败: ${res.content[0]?.text}`);
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  for (;;) {
    const st = registry.getStatus(runId);
    if (st && TERMINAL.has(st)) break;
    await Bun.sleep(3000);
  }
  mkdirSync(join(cwd, OUT_DIR), { recursive: true });
  writeFileSync(
    outPath(t, armKey('a'), p),
    `arm: ${armKey('a')} (omd ${toolName})\nseat: ${(seats.agentLeafModel ?? seats.leafModel)}\n` +
      `task: ${t} pair: ${p} engine: ${engine}\n` +
      `wallMs: ${Date.now() - started}\nrunId: ${runId}\nstatus: ${registry.getStatus(runId)}\nworkDir: ${workCwd}\n`,
  );
  console.log(`a 臂完成: ${outPath(t, armKey('a'), p)} (${registry.getStatus(runId)})`);
}

async function score(t: string, p: number): Promise<void> {
  // 显式 --arm = 只评这一个 (补充实验的非默认档位是单臂产物, 没有配对的另一臂)。
  const arms = arm ? [armKey(arm)] : ['a', 'b'];
  for (const a of arms) {
    const head = existsSync(outPath(t, a, p)) ? readFileSync(outPath(t, a, p), 'utf8') : '';
    if (!head) {
      console.log(`${t}-${a}-${p}: 产物缺席`);
      continue;
    }
    if (t === 'f1') {
      const { scoreF1 } = await import('../src/eval/tasks/no-graph-baseline/f1-check');
      const s = scoreF1(workDirPath(t, a, p));
      console.log(`${t}-${a}-${p}: ${s.hit}/${s.total}${s.misses.length ? ` · 首漏 ${s.misses[0]}` : ''}`);
    } else {
      const ansFile = outPath(t, a, p).replace(/\.md$/, '-answer.md');
      const ans = existsSync(ansFile) ? readFileSync(ansFile, 'utf8') : head;
      const mod = t === 'f2' ? await import('../src/eval/tasks/no-graph-baseline/f2-checklist')
        : t === 'g1' ? await import('../src/eval/tasks/no-graph-baseline/g1-rubric')
        : await import('../src/eval/tasks/no-graph-baseline/g2-registry');
      const s = t === 'f2'
        ? (mod as { scoreF2: (x: Record<string, string>) => { hit: number; total: number } }).scoreF2(
            Object.fromEntries([...ans.matchAll(/^(q\d+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!])),
          )
        : t === 'g1'
          ? (() => { const r = (mod as { scoreG1: (x: string) => { hits: string[]; total: number } }).scoreG1(ans); return { hit: r.hits.length, total: r.total }; })()
          : (() => { const r = (mod as { scoreG2: (x: string) => { hits: string[]; total: number } }).scoreG2(ans); return { hit: r.hits.length, total: r.total }; })();
      // **诊断第二读数** (2026-08-04): 官方分保持严格 —— 任务文本明写 `qN: …`, 违约就是违约,
      // 不因为难看就放宽。但只留一个数会把**两种不同的失败**读成同一种: 一次实测 (pair2,
      // run c042df95) 内容 6/8 正确却因行首用全角 `｜` 官方 0/8。那是"没遵守输出契约",
      // 不是"没找到事实", 而报告要按这两件事分别归因 (格式违约 → 契约/闸问题;
      // 事实缺失 → 检索/综合问题)。故: 宽分隔符只在**严格解析不足 8 题**时作为诊断印出,
      // 明标 `诊断` 二字, 永不替代官方分。
      let diag = '';
      if (t === 'f2') {
        const strictLines = [...ans.matchAll(/^(q\d+):\s*(.+)$/gm)].length;
        if (strictLines < 8) {
          const tolerant = Object.fromEntries(
            [...ans.matchAll(/^(q\d+)\s*[:：｜|]\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!]),
          );
          const st = (mod as { scoreF2: (x: Record<string, string>) => { hit: number; total: number } }).scoreF2(tolerant);
          diag = ` · 诊断(宽分隔符, 非官方): 解析 ${Object.keys(tolerant).length} 题 → 内容 ${st.hit}/${st.total}`;
        }
      }
      console.log(`${t}-${a}-${p}: ${s.hit}/${s.total}${diag}`);
    }
  }
}

function verifySeats(t: string, p: number): void {
  const seat = (a: string): string => {
    const m = /seat: (.+)/.exec(readFileSync(outPath(t, a, p), 'utf8'));
    return m?.[1] ?? '(缺)';
  };
  const [sa, sb] = [seat('a'), seat('b')];
  if (sa !== sb) {
    console.error(`✗ 座位不一致 (GWT-R2-1): a=${sa} b=${sb} — 该对作废重跑`);
    process.exit(1);
  }
  console.log(`✓ 座位一致: ${sa}`);
}

if (import.meta.main) {
  if (argv.includes('--verify-seats')) {
    verifySeats(task, pair);
  } else if (argv.includes('--score')) {
    await score(task, pair);
  } else if (arm === 'a') {
    await runArmA(task, pair);
  } else if (arm === 'b') {
    await runArmB(task, pair);
  } else {
    console.error('用法: --task f1|f2|g1|g2 --arm a|b [--pair N] | --verify-seats | --score');
    process.exit(2);
  }
}
