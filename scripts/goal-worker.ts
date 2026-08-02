#!/usr/bin/env bun
/**
 * scripts/goal-worker —— `dag_goal detached=true` 的**脱离会话工作进程** (S2 后半 / D-W, 2026-08-03)。
 *
 * ## 为什么需要它
 *
 * omd 的 MCP server 是 `StdioServerTransport` + **客户端消失即自杀**(`server.ts` 的退出双保险,
 * 那是修僵尸忙转加的, 是设计)。于是 Claude 会话一结束, 正在跑的 goal 就死在半路 ——
 * 「无人值守跑真活」在那条路上**物理上不成立**, 不管引擎本身多结实。
 *
 * 本进程是**第二个适配器**, 不是第二套引擎: 它照 `omd mcp` 的引导序起来, 装同一份
 * `assembleOmdMcpTools`, 调同一个 `dag_goal` 工具。零新执行路径 —— stamp / 闸 / checkpoint /
 * 留痕 / 毒集全部照旧。(本仓最贵的教训之一就是"第二套语义", 见 `iterateExecutorDag` 那条。)
 *
 * ## 三条必须与 `omd mcp` 逐字一致的引导 (错一条就是两套行为)
 *
 * 1. **不 import `script-bootstrap`。** 它会把 `OMD_DATA_HOME` 设成 `~/.omd`, 于是运行态出 cwd ——
 *    而 MCP server 那条路读的是 `<cwd>/.omd/`。一旦分叉, 母进程与本进程写读两份 `runs.db` 与
 *    两份 `continuity/`, 「掉线了接着跑」当场作废, **而且症状是沉默的** (两边各自都自洽)。
 * 2. **调 `bootstrapModelRuntime()`。** 短命进程不走 TUI boot, 不引导则 provider 注册表是空的,
 *    leaf 会全部静默秒败 (settle(null) 空 output)。
 * 3. **cwd 由 `--cwd` 显式给**, 与母进程一致 —— `.omd/` 全是 cwd 相对的。
 *
 * ## 生命周期
 *
 * 母进程 (dag_goal) 先把 runId 登记进共享的 `runs.db` (pending), 再 spawn 本进程; 本进程一起跑就
 * **把属主 pid 改成自己** (经 registry 的 start/resume), 于是任何后来的 session hydrate 时看到的是
 * "running 且属主活着" —— 而不是"属主死了 → 判成被打断"。母进程随时可以走。
 *
 * 用法 (通常由 `dag_goal detached=true` 起, 手动跑也行):
 *   bun run scripts/goal-worker.ts --run-id <id> --cwd <dir> --goal "..." [--tier simple|complex]
 *                                  [--max-rounds N] [--research-rounds N] [--resume]
 */
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';
import { createRunStore } from '../src/mcp/run-store';
import { verifyTerminalPersisted } from '../src/mcp/terminal-verify';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const runId = opt('run-id');
const goal = opt('goal');
const cwd = opt('cwd') ?? process.cwd();
if (!runId || !goal) {
  console.error('goal-worker: --run-id 与 --goal 必填');
  process.exit(2);
}

bootstrapModelRuntime();

// 与母进程**同一份** runs.db —— 这是"脱离会话"的全部要害: 母进程写 pending, 本进程接手改 running
// 并把属主 pid 换成自己, 后来的 session 才看得到一个"活着的 run"而不是一个孤儿。
const registry = new RunRegistry(undefined, { store: createRunStore({ path: join(cwd, '.omd', 'runs.db') }) });
const tools = assembleOmdMcpTools({ cwd, runRegistry: registry });
const goalTool = tools.find((t) => t.name === 'dag_goal');
if (!goalTool) {
  console.error('goal-worker: 装配里没有 dag_goal (assemble 变了?)');
  process.exit(2);
}

// `dag_goal` 是 fire-and-forget (三段式: 起跑即返回 runId), 所以这里**必须等到终态**才能退 ——
// 进程一退, 在飞的活就跟着没了, 那正是本进程存在的理由。
//
// **为什么首次跑也走 `resume` 这个参数名**: 它是工具面上唯一能"用调用方给的 runId 起一个 run"
// 的口子, 而 detached 的 runId 必须由母进程先生成 (它要立刻回给调用方)。对**未知** runId,
// `reopenForResume` 的语义正是 register + start —— 也就是我们要的那件事, 且属主 pid 记的是
// **本进程**。附带的 `continuity.resume=true` 对一个没有任何 checkpoint 的新 run 是 no-op。
// (不为此新增一个参数: 一个已有语义能表达的事不该有两个入口。)
const res = (await goalTool.handler(
  {
    goal,
    resume: runId,
    ...(opt('tier') ? { tier: opt('tier') } : {}),
    ...(opt('max-rounds') ? { maxRounds: Number(opt('max-rounds')) } : {}),
    ...(opt('research-rounds') ? { researchRounds: Number(opt('research-rounds')) } : {}),
    ...(opt('budget-tokens') ? { budgetTokens: Number(opt('budget-tokens')) } : {}),
    ...(opt('budget-minutes') ? { budgetMinutes: Number(opt('budget-minutes')) } : {}),
  } as never,
  {} as never,
)) as { content: { text: string }[]; isError?: boolean };

if (res.isError) {
  console.error(`goal-worker: dag_goal 拒绝起跑 — ${res.content[0]?.text ?? ''}`);
  // 登记成 failed, 否则盘上留一个 pending 的孤儿 (属主 pid 是本进程, 而本进程马上就没了)。
  try {
    registry.fail(runId, `起跑被拒: ${res.content[0]?.text ?? ''}`);
  } catch {
    /* 已是终态就算了 */
  }
  process.exit(1);
}

console.error(`goal-worker: runId=${runId} 已起跑 (pid ${process.pid}), 等终态…`);

// 轮询自己的 registry 直到终态。`dag_goal` 的 .then 会把状态写成 done/failed/cancelled。
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
for (;;) {
  const st = registry.getStatus(runId);
  if (st && TERMINAL.has(st)) {
    // 终态写穿核验 (S-12 的灯, 2026-08-02): 内存终态 ≠ 盘上终态 —— 两次 live 在这儿静默丢过。
    // 必须用**全新连接**核验与修复 (本进程的长命连接正是嫌疑面), 修不动才带着响亮日志退非零。
    const verdict = verifyTerminalPersisted(join(cwd, '.omd', 'runs.db'), runId, st);
    console.error(`goal-worker: runId=${runId} 终态 ${st} (写穿核验: ${verdict})`);
    process.exit(verdict === 'unrecoverable' ? 3 : st === 'done' ? 0 : 1);
  }
  await Bun.sleep(2000);
}
