#!/usr/bin/env bun
/**
 * scripts/smoke-goal-conductor —— `dag_goal` **live 冒烟** (D-F 之后的第一次真跑)。
 *
 * 存在理由: 到 2026-07-30 为止, `executor:'conductor'` 只有注入式测试, **一次真图都没跑过**。
 * 而 D-F 把 goal 引擎的两段都换成了 conductor 节点 —— 于是"注入式全绿"和"真的能跑"之间那条缝,
 * 现在盖住了整条自主路径。这个脚本就是去踩那条缝的。
 *
 * 它**打生产那条链**: `assembleOmdMcpTools` 装出来的真 `dag_goal` 工具 (真座位 / 真 agent leaf /
 * 真 command 白名单 / 真 continuity), 不是手搭的 config —— 手搭一份就等于测了一个不存在的接线。
 *
 * ⚠ **cwd 是临时沙箱**, 不是本仓: agent leaf 真会写文件。沙箱路径打印在开头, 跑完不删
 * (要看它到底写了什么)。
 *
 * 用法:
 *   bun run scripts/smoke-goal-conductor.ts                 # 缺省: simple 档, 一个写文件的小目标
 *   bun run scripts/smoke-goal-conductor.ts --tier complex  # 走契约段 (贵得多: 多一个 conductor 节点)
 *   bun run scripts/smoke-goal-conductor.ts --goal "..."     # 自定目标
 *   bun run scripts/smoke-goal-conductor.ts --rounds 2       # 内环轮数上限 (默认 1: 只看展开+终判)
 */
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const tier = (arg('tier') ?? 'simple') as 'simple' | 'complex';
const rounds = Number.parseInt(arg('rounds') ?? '1', 10);
const timeoutMs = Number.parseInt(arg('timeout') ?? '600000', 10);
const goal =
  arg('goal') ??
  // 小到能一眼看出真假, 但要求真动手 (写文件) 且有确定性验收 (cat 在命令白名单里)。
  '在当前目录创建文件 notes/hello.md, 内容是一行 "hello omd", 然后用 cat 读出来确认写成功了。';

const sandbox = mkdtempSync(join(tmpdir(), 'omd-smoke-goal-'));
// 给沙箱一点"像个仓"的样子 —— 勘察步扑空不算失败, 但空目录会让 complex 档没什么可看的。
writeFileSync(join(sandbox, 'README.md'), '# smoke sandbox\n\n这是 dag_goal live 冒烟用的临时目录。\n');

console.log(`沙箱: ${sandbox}`);
console.log(`目标: ${goal}`);
console.log(`档位: tier=${tier} · max_rounds=${rounds} · 超时 ${Math.round(timeoutMs / 1000)}s\n`);

const registry = new RunRegistry();
const tools = assembleOmdMcpTools({ cwd: sandbox, runRegistry: registry });
const goalTool = tools.find((t) => t.name === 'dag_goal');
if (!goalTool) throw new Error('装配里没有 dag_goal (assemble 变了?)');

const out = (await goalTool.handler(
  { goal, tier, maxRounds: rounds } as never,
  {} as never,
)) as { content: { text: string }[]; isError?: boolean };
const text = out.content[0]?.text ?? '';
if (out.isError) {
  console.error(`dag_goal 拒绝起跑: ${text}`);
  process.exit(1);
}
const runId = /runId: (\S+)/.exec(text)?.[1] ?? '';
console.log(`runId: ${runId}\n起跑, 轮询中 (每 5s 打一次进度)…\n`);

const t0 = Date.now();
let lastLine = '';
while (Date.now() - t0 < timeoutMs) {
  await Bun.sleep(5000);
  const rec = registry.getRecord(runId);
  const st = rec?.status ?? '?';
  const p = rec?.progress;
  const line = `[${Math.round((Date.now() - t0) / 1000)}s] ${st} · planned ${p?.planned.length ?? 0} · started ${p?.started.length ?? 0} · settled ${p?.settled.length ?? 0}`;
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
  }
  if (st === 'done' || st === 'failed') break;
}

const rec = registry.getRecord(runId);
console.log(`\n── 结果 ──────────────────────────────────────────────`);
console.log(`status: ${rec?.status}`);
console.log(String(rec?.result ?? rec?.error ?? '(无)'));

// ── D-F 的三件产物: 环 journal / 审计 checkpoint / 子节点 checkpoint ─────────────
const contDir = join(sandbox, '.omd', 'continuity');
for (const dir of existsSync(contDir) ? readdirSync(contDir) : []) {
  const d = join(contDir, dir);
  const files = readdirSync(d).sort();
  console.log(`\n── ${dir} ──`);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(readFileSync(join(d, f), 'utf-8')) as Record<string, unknown>;
    if (f.startsWith('_loop-')) {
      console.log(`  ${f}  轮=${j.completedRounds} 收敛=${j.converged ?? false} 毒集=${(j.poisoned as unknown[])?.length ?? 0}`);
    } else if (f === '_dag.json') {
      console.log(`  ${f}  节点=${JSON.stringify(j.nodeIds)}`);
    } else if (f === '_goal.json' || f === '_fixpoint.json') {
      console.log(`  ${f}  ⚠ 不该出现 (D-F 之后 goal 这条路不写它)`);
    } else {
      console.log(`  ${f}  kind=${j.leafKind} status=${j.status} 产物=${JSON.stringify(j.outputPaths ?? [])}`);
    }
  }
}

// 目标本身成没成 —— 与 judge 的意见分开看 (它才是 oracle)。
const wrote = join(sandbox, 'notes', 'hello.md');
if (!arg('goal')) {
  console.log(`\n真产物: ${wrote} ${existsSync(wrote) ? `✅\n  ${readFileSync(wrote, 'utf-8').trim()}` : '❌ 不存在'}`);
}
console.log(`\n沙箱保留在 ${sandbox} (自己看完自己删)。`);
