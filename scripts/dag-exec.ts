#!/usr/bin/env bun
/**
 * scripts/dag-exec —— `dag_run` / `dag_research` 的**脱离会话执行进程** (S2 主菜, SDD 2026-08-10)。
 *
 * ## 为什么新造, 不原样复用 goal-worker (S2 裁决, 交付注释)
 *
 * `scripts/goal-worker.ts` 是 solve (dag_goal detached) 的 worker, 正在扛真载 (4 活进程)。
 * 本进程**骨架逐段照抄**它: 引导序 (bootstrapModelRuntime + assembleOmdMcpTools + 同一份
 * runs.db) / registry 接手 (resume=runId → reopenForResume, 属主 pid = 本进程) / 终态轮询 /
 * 退出前 verifyTerminalPersisted 写穿核验 / 退出码 (2=参数错, 1=失败, 3=写穿不可修, 0=done)。
 * 唯一不适配两点, 正是与 S2 契约冲突处, 故仿不复用:
 *   ① goal-worker 把 goal 经 **argv** 传 (`--goal "..."`); S2 要求参数走**临时文件** ——
 *      argv 不携带原文: 元字符/长度/进程表泄露三害全避 (SDD §2 逐字)。
 *   ② goal-worker 硬编码找 `dag_goal` 工具; S2 要求从 spec 读 `tool` 字段 (dag_run|dag_research)。
 *
 * ## 三条必须与 `omd mcp` 逐字一致的引导 (goal-worker 同款, 错一条就是两套行为)
 *
 * 1. **不 import `script-bootstrap`** —— 它会把 OMD_DATA_HOME 设成 `~/.omd`, 运行态出 cwd;
 *    而 MCP server 那条路读 `<cwd>/.omd/`。分叉 = 母进程与本进程读写两份 runs.db / continuity,
 *    「掉线了接着跑」当场作废, 且症状是沉默的 (两边各自自洽)。
 * 2. **调 `bootstrapModelRuntime()`** —— 短命进程不走 TUI boot, 不引导则 provider 注册表是空的,
 *    leaf 会全部静默秒败。
 * 3. **cwd 由 spec 显式给**, 与母进程一致 —— `.omd/` 全是 cwd 相对的。
 *
 * ## 生命周期
 *
 * 母进程 (dag_run/dag_research handler) **不登记 run** —— 登记由本进程做 (它才是属主, pid
 * 判活要认它; 母进程抢先登记会让下一个 session hydrate 把一个正在跑的 run 判成"被打断")。
 * 代价是毫秒级窗口: 本进程起来之前 dag_status 查无此 run (goal.ts detached 同款注释)。
 *
 * 取消: 母进程写 `.omd/continuity/<runId>/cancel` 标记 + SIGTERM。本进程每轮询周期查标记 →
 * `requestCancel` 自己 → 引擎协作式停 (既有优雅停语义接住); SIGTERM 兜底 (requestCancel 失败
 * 即硬退, 无取消把手的 dag_research 走这条)。
 *
 * 用法 (通常由 dag_run / dag_research handler 起, 手动跑也行):
 *   bun run scripts/dag-exec.ts --run <runId> --spec <path>/spec.json
 */
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';
import { createRunStore } from '../src/mcp/run-store';
import { verifyTerminalPersisted } from '../src/mcp/terminal-verify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OMD_DAG_EXEC_CHILD } from '../src/mcp/tools/dag-tools';

// 自证旗标: 即便手动跑没带 spawn 时的 env, handler 也认得自己是子进程, 不再二次 spawn。
process.env[OMD_DAG_EXEC_CHILD] = '1';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const runId = opt('run');
const specPath = opt('spec');
if (!runId || !specPath) {
  console.error('dag-exec: --run 与 --spec 必填');
  process.exit(2);
}

/** spec = {tool, runId, cwd, args} —— 母进程写的, 见 dag-tools.defaultSpawnDagExec。 */
interface DagExecSpec {
  tool: string;
  runId: string;
  cwd: string;
  args: Record<string, unknown>;
}

let spec: DagExecSpec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf-8')) as DagExecSpec;
} catch (e) {
  console.error(`dag-exec: spec 读不了 (${specPath}): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
if (spec.tool !== 'dag_run' && spec.tool !== 'dag_research') {
  console.error(`dag-exec: 未知工具 ${spec.tool} (spec 只接受 dag_run | dag_research)`);
  process.exit(2);
}
const cwd = spec.cwd ?? process.cwd();

bootstrapModelRuntime();

// 与母进程**同一份** runs.db (同 goal-worker)。本进程的 registry 实例 = handler 用的那个,
// 终态轮询读的就是它 —— 引擎在**本进程内** fire-and-forget, 状态经它写穿盘上。
const registry = new RunRegistry(undefined, { store: createRunStore({ path: join(cwd, '.omd', 'runs.db') }) });
const tools = assembleOmdMcpTools({ cwd, runRegistry: registry });
const tool = tools.find((t) => t.name === spec.tool);
if (!tool) {
  console.error(`dag-exec: 装配里没有 ${spec.tool} (assemble 变了?)`);
  process.exit(2);
}

// SIGTERM (dag_cancel 兜底): 有取消把手 → 协作式停 (引擎在调度接缝上自己停, 终态 cancelled);
// 没把手 (dag_research) → 直接硬退 —— 不装这个 handler 的话 SIGTERM 默认杀进程, 一样是硬退,
// 但装了能让 dag_run 走优雅路。
process.on('SIGTERM', () => {
  if (!registry.requestCancel(runId, 'SIGTERM (dag_cancel 兜底)')) process.exit(1);
});

console.error(`dag-exec: runId=${runId} tool=${spec.tool} (pid ${process.pid}), 等终态…`);

// 接手 (goal-worker 同款): resume=<runId> 是工具面上唯一能"用调用方给的 runId 起 run"的口子。
// 对**未知** runId, reopenForResume 的语义正是 register + start, 且属主 pid 记的是**本进程**。
const res = (await tool.handler({ ...spec.args, resume: runId } as never, {} as never)) as {
  content: { text: string }[];
  isError?: boolean;
};

if (res.isError) {
  console.error(`dag-exec: ${spec.tool} 拒绝起跑 — ${res.content[0]?.text ?? ''}`);
  // 登记成 failed, 否则盘上留一个 running 的孤儿 (属主 pid 是本进程, 而本进程马上就没了)。
  try {
    registry.fail(runId, `起跑被拒: ${res.content[0]?.text ?? ''}`);
  } catch {
    /* 执行体已登记过终态就算了 */
  }
  process.exit(1);
}

// 轮询 registry 直到终态; 每拍顺带查 cancel 标记 (dag_cancel 写的, 见 dag-tools.makeDagCancel)。
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const cancelPath = join(cwd, '.omd', 'continuity', runId, 'cancel');
for (;;) {
  if (existsSync(cancelPath)) {
    // 标记在 → 协作式取消 (引擎既有优雅停语义接住)。重复读无妨 (requestCancel 幂等)。
    registry.requestCancel(runId, 'cancel 标记 (dag_cancel)');
  }
  const st = registry.getStatus(runId);
  if (st && TERMINAL.has(st)) {
    // 终态写穿核验 (S-12 的灯, goal-worker 同款): 内存终态 ≠ 盘上终态 —— 三次 live 在这儿
    // 静默丢过。必须用**全新连接**核验与修复; 先 close() 干净关掉本进程这条写连接
    // (2026-08-03 实测: 核验时同进程两条写连接报过 disk I/O error)。
    registry.close();
    const verdict = verifyTerminalPersisted(join(cwd, '.omd', 'runs.db'), runId, st);
    console.error(`dag-exec: runId=${runId} 终态 ${st} (写穿核验: ${verdict})`);
    process.exit(verdict === 'unrecoverable' ? 3 : st === 'done' ? 0 : 1);
  }
  await Bun.sleep(2000);
}
