#!/usr/bin/env bun
/**
 * scripts/smoke-cancel-resume —— **D-P 协作式取消 + 续跑**的 live 冒烟 (2026-07-30)。
 *
 * 存在理由与 `smoke-goal-conductor` 同款: 取消这条路注入式测试全绿, 但"真的停得住、停完真的
 * 接得上"要打**生产那条链**才算数 —— 而且取消最容易坏的两个地方恰恰只有真跑才看得见:
 *   ① 停下来的那一刻手上的东西保没保住 (checkpoint 落没写入磁盘);
 *   ② 停完那个 run 还能不能接着跑 (registry 终态是不是可 resume 的那一档)。
 *
 * ⚠ cwd 是临时沙箱, agent leaf 真写文件。跑完不删。
 *
 * 用法: bun --env-file=.env run scripts/smoke-cancel-resume.ts [--after 12]
 *   --after N  等子节点结清的**上限**秒数 (默认 90): 有子节点结清就立刻叫停, 到点还没有也叫停。
 */
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cancelAfterMs = Number.parseInt(arg('after') ?? '90', 10) * 1000;

const sandbox = mkdtempSync(join(tmpdir(), 'omd-smoke-cancel-'));
writeFileSync(join(sandbox, 'README.md'), '# cancel smoke\n');
// 多步一点的目标: 要有"停下来时还有活没派"这个状态, 一步的目标测不出协作式取消。
const goal =
  arg('goal') ??
  '在当前目录依次创建三个文件: a.txt 内容 "aaa"、b.txt 内容 "bbb"、c.txt 内容 "ccc", 每个都用 cat 确认写成功。';

console.log(`沙箱: ${sandbox}\n目标: ${goal}\n叫停: 一有子节点结清就叫停 (上限 ${cancelAfterMs / 1000}s)\n`);

const registry = new RunRegistry();
const tools = assembleOmdMcpTools({ cwd: sandbox, runRegistry: registry });
const tool = (n: string) => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`装配里没有 ${n}`);
  return (a: Record<string, unknown>) => t.handler(a as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};

const started = await tool('dag_goal')({ goal, tier: 'simple', maxRounds: 2 });
const runId = /runId: (\S+)/.exec(started.content[0]?.text ?? '')?.[1] ?? '';
if (!runId) {
  console.error(`起跑失败: ${started.content[0]?.text}`);
  process.exit(1);
}
console.log(`runId: ${runId}\n`);

// **等到真有子节点结清再叫停**, 不靠掐表 (2026-07-30 实测两次都掐早了: conductor 画一张子图要
// 40s+, 定时叫停全落在那次调用里 → 0 个子节点跑完 → 测不到"已跑完的保留"这条核心承诺)。
// `--after` 因此降级成**上限**: 等到这个点还没有子节点结清就照样叫停 (那也是一种要测的状态)。
const waitStart = Date.now();
while (Date.now() - waitStart < cancelAfterMs) {
  await Bun.sleep(2000);
  if ((registry.getRecord(runId)?.progress?.settled.length ?? 0) >= 1) break;
}
const before = registry.getRecord(runId);
const settledBefore = before?.progress?.settled.length ?? 0;
console.log(
  `叫停前: status=${before?.status} · settled=${settledBefore} · started=${before?.progress?.started.length ?? 0}` +
    (settledBefore === 0 ? '  ⚠ 一个子节点都没跑完 —— 这一跑测不到"已跑完的保留"' : ''),
);

const cancelled = await tool('dag_cancel')({ runId, reason: '冒烟叫停' });
console.log(`\n── dag_cancel 回话 ──\n${cancelled.content[0]?.text}${cancelled.isError ? ' (isError)' : ''}\n`);

// 协作式: 回话之后活还没停 —— 等它自己收尾 (在飞节点跑完)。
const t0 = Date.now();
while (Date.now() - t0 < 300_000) {
  await Bun.sleep(3000);
  const st = registry.getStatus(runId);
  if (st !== 'running') break;
}
const after = registry.getRecord(runId);
console.log(`── 收尾 ──\nstatus: ${after?.status}  (期望 cancelled)`);
console.log(`原因: ${after?.error ?? '(无)'}`);
console.log(`已结清节点: ${after?.progress?.settled.length ?? 0}`);

const contDir = join(sandbox, '.omd', 'continuity', runId);
const greens = existsSync(contDir)
  ? readdirSync(contDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  : [];
console.log(`盘上 checkpoint: ${greens.length} 份 ${greens.length ? `(${greens.join(', ')})` : '❌ 一份都没有 = 取消把已跑完的扔了'}`);
console.log(`沙箱文件: ${readdirSync(sandbox).join(', ')}`);

// ── 续跑: 同一个 runId, 已绿的该被跳过 ────────────────────────────────────────
console.log(`\n── 续跑 (dag_goal resume=${runId}) ──`);
const resumed = await tool('dag_goal')({ goal, tier: 'simple', maxRounds: 2, resume: runId });
console.log(resumed.content[0]?.text ?? '(无回话)');
if (resumed.isError) {
  console.error('❌ 续跑被拒 —— "已跑完的全保留"没兑现');
  process.exit(1);
}
const t1 = Date.now();
while (Date.now() - t1 < 600_000) {
  await Bun.sleep(5000);
  if (registry.getStatus(runId) !== 'running') break;
}
const fin = registry.getRecord(runId);
console.log(`\nstatus: ${fin?.status}`);
console.log(String(fin?.result ?? fin?.error ?? '(无)'));
console.log(`\n沙箱文件: ${readdirSync(sandbox).join(', ')}`);
console.log(`沙箱保留在 ${sandbox}`);
