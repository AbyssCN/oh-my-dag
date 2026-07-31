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
 *   bun run scripts/smoke-goal-conductor.ts --branch                # R2: 沙箱 git init + 隔离 worktree 跑
 *   bun run scripts/smoke-goal-conductor.ts --case conflicting-specs --rounds 3
 *                                                          # **带种沙箱**: 先种一对自相矛盾的源材料,
 *                                                          #   目标/看点由用例自带 (见 live-seed-cases)
 */
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';
import { setCoreLogger } from '../src/harness/logger';
import { LIVE_SEED_CASES, liveSeedCaseById } from '../src/eval/tasks/live-seed-cases';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const tier = (arg('tier') ?? 'simple') as 'simple' | 'complex';
const rounds = Number.parseInt(arg('rounds') ?? '1', 10);
const timeoutMs = Number.parseInt(arg('timeout') ?? '600000', 10);
// 带种用例 (--case): 目标与沙箱初始内容一起来自用例 —— 冲突必须是**输入**给的, 由目标文字
// 现编一个"你们俩故意写得不一样"是测不出东西的 (见 live-seed-cases 的模块注)。
const seedCase = arg('case') ? liveSeedCaseById(arg('case')!) : undefined;
if (arg('case') && !seedCase) {
  console.error(`没有这个用例: ${arg('case')} (现有: ${LIVE_SEED_CASES.map((c) => c.id).join(', ')})`);
  process.exit(1);
}
const goal =
  arg('goal') ??
  seedCase?.goal ??
  // 小到能一眼看出真假, 但要求真动手 (写文件) 且有确定性验收 (cat 在命令白名单里)。
  '在当前目录创建文件 notes/hello.md, 内容是一行 "hello omd", 然后用 cat 读出来确认写成功了。';

const sandbox = mkdtempSync(join(tmpdir(), 'omd-smoke-goal-'));
// 给沙箱一点"像个仓"的样子 —— 勘察步扑空不算失败, 但空目录会让 complex 档没什么可看的。
writeFileSync(join(sandbox, 'README.md'), '# smoke sandbox\n\n这是 dag_goal live 冒烟用的临时目录。\n');
for (const [rel, content] of Object.entries(seedCase?.files ?? {})) {
  mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
  writeFileSync(join(sandbox, rel), content);
}
if (seedCase) {
  console.log(`用例: ${seedCase.id} · 已种 ${Object.keys(seedCase.files).length} 份源材料`);
  console.log(`看点: ${seedCase.watchFor}\n`);
}

console.log(`沙箱: ${sandbox}`);
console.log(`目标: ${goal}`);
console.log(`档位: tier=${tier} · max_rounds=${rounds} · 超时 ${Math.round(timeoutMs / 1000)}s\n`);

// R2 (2026-07-31): `--branch` 才让沙箱成为 git 仓并走隔离档。默认不 init ——
// 隔离档在**非** git 仓里会降级, 而那条降级路本身也值得偶尔真跑一次, 所以两边都留得到。
const wantBranch = argv.includes('--branch');
if (wantBranch) {
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=smoke@omd', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'seed']]) {
    const r = Bun.spawnSync(['git', ...args], { cwd: sandbox, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) {
      console.error(`沙箱 git ${args[0]} 失败: ${new TextDecoder().decode(r.stderr).trim()}`);
      process.exit(1);
    }
  }
  console.log('沙箱已 git init + 首次提交 → 隔离档有对象可建\n');
}

// ── prompt 观测面 (2026-08-05) ───────────────────────────────────────────────
// live 上我们此前对"模型到底看见了什么"**完全瞎**: 盘上留了 plan / 结果 / checkpoint / journal,
// 唯独没留 prompt —— 而那恰恰是最能解释它为什么那么画的一份。本轮四条缺陷 (A5 三条 + A8 一条)
// 全是靠抓 prompt 抓出来的, 却一条也不是在 live 上抓的。
//
// 走 `setCoreLogger` 这个现成接缝: 引擎在 `logger.debug` 上发 prompt, 默认实现是空函数
// (生产零成本), 这里注入一个会记的。不新开旋钮、不读 env。
const promptDir = join(sandbox, '.omd', 'prompts');
mkdirSync(promptDir, { recursive: true });
let promptSeq = 0;
const promptIndex: { file: string; phase: string; node: string; model: string; bytes: number }[] = [];
setCoreLogger({
  debug: (obj) => {
    const o = obj as { phase?: string; node?: string; model?: string; prompt?: string; system?: string; round?: number };
    if (!o?.prompt) return;
    const n = String(promptSeq++).padStart(3, '0');
    const safeNode = String(o.node ?? 'x').replace(/[^\w.-]/g, '_').slice(0, 40);
    const file = `${n}-${o.phase}-${safeNode}${o.round === undefined ? '' : `-r${o.round}`}.txt`;
    const body = (o.system ? `===== SYSTEM =====\n${o.system}\n\n` : '') + `===== USER =====\n${o.prompt}`;
    writeFileSync(join(promptDir, file), body);
    promptIndex.push({ file, phase: String(o.phase), node: String(o.node ?? ''), model: String(o.model ?? ''), bytes: body.length });
  },
  info: (obj, msg) => console.log(msg ?? '', typeof obj === 'string' ? obj : ''),
  warn: (obj, msg) => console.warn(msg ?? '', typeof obj === 'string' ? obj : ''),
  error: (obj, msg) => console.error(msg ?? '', obj),
});

const registry = new RunRegistry();
const tools = assembleOmdMcpTools({ cwd: sandbox, runRegistry: registry });
const goalTool = tools.find((t) => t.name === 'dag_goal');
if (!goalTool) throw new Error('装配里没有 dag_goal (assemble 变了?)');

const out = (await goalTool.handler(
  { goal, tier, maxRounds: rounds, ...(wantBranch ? { branchStrategy: 'branch' } : {}) } as never,
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
      // **环唯一的信息通道**摊开: 上一轮的失败原因 + 图外观察者的话就在这里。
      // 只打轮数等于把这条通道当黑盒 —— 而 A5 普查治的正是"通道里的话读者做不做得了事"。
      const reason = String(j.prevReason ?? '').trim();
      if (reason) {
        console.log(`    ┌ 进下一轮的话 (${reason.length}B):`);
        for (const line of reason.split('\n').slice(0, 14)) console.log(`    │ ${line.slice(0, 150)}`);
        if (reason.split('\n').length > 14) console.log('    │ …');
      }
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
if (!arg('goal') && !seedCase) {
  console.log(`\n真产物: ${wrote} ${existsSync(wrote) ? `✅\n  ${readFileSync(wrote, 'utf-8').trim()}` : '❌ 不存在'}`);
}
// 带种用例: 产物是用例自己的事, 这里只把写出来的东西摊开 —— 判"抓到冲突没有"要看内容,
// 而**存在 ≠ 对**: 一个硬凑出 "100-500" 的摘要文件同样存在 (那正是最坏的一种)。
if (seedCase) {
  // ⚠ **产物根必须跟着 branch strategy 走**(2026-07-31 第二次 live 撞出来的): `--branch` 档下
  // 活跑在 `.omd/runs/<runId>` 那棵隔离树里, 而这一段原本写死查沙箱主树 —— 于是它报
  // 「docs/ 不存在, 一份都没写出来」, 而文件明明都在。**冒烟唯一要看的东西被自己的路径写死弄瞎了。**
  // 与本轮修的那条引擎缺陷是同一形态: 隔离动了, 消费面没跟上。
  const workRoot = wantBranch ? join(sandbox, '.omd', 'runs', runId) : sandbox;
  if (wantBranch) console.log(`(隔离档: 产物根 = ${workRoot})`);
  const docs = join(workRoot, 'docs');
  console.log(`\n── 产物 (${seedCase.id}) ──`);
  // withFileTypes: 真跑过一次就撞上了 —— agent leaf 会在 docs/ 下建子目录, 对目录 readFileSync
  // 抛 EISDIR, 于是**整个产物摊开这一段没了**, 而那正是这次冒烟唯一要看的东西。
  for (const e of existsSync(docs) ? readdirSync(docs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []) {
    if (!e.isFile()) {
      console.log(`\n  docs/${e.name}/ (目录, 未展开)`);
      continue;
    }
    const body = readFileSync(join(docs, e.name), 'utf-8').split('\n').map((l) => `    ${l}`).join('\n');
    console.log(`\n  docs/${e.name}:\n${body}`);
  }
  if (!existsSync(docs)) console.log('  (docs/ 不存在 —— 一份都没写出来)');
}
// ── prompt 索引 ───────────────────────────────────────────────────────────────
console.log(`\n── prompt (${promptIndex.length} 份, 全文在 ${promptDir}) ──`);
for (const p of promptIndex) {
  console.log(`  ${p.file.padEnd(46)} ${String(p.bytes).padStart(7)}B  ${p.model}`);
}
if (promptIndex.length === 0) console.log('  (一份都没记 —— logger 接缝没接上?)');
else {
  // A8 的 live 判读: 围栏在**真** prompt 里立住没有。确定性检查, 零模型调用。
  const all = promptIndex.map((p) => readFileSync(join(promptDir, p.file), 'utf-8'));
  const fenced = all.filter((t) => /<untrusted src="[^"]*" [0-9a-f]{8}>/.test(t)).length;
  const withHeader = all.filter((t) => t.includes('信任 token')).length;
  console.log(`  A8: 带围栏的 prompt ${fenced}/${all.length} · 带 token 声明的 ${withHeader}/${all.length}`);
  const leaked = all.filter((t) => {
    const nonce = /<untrusted src="[^"]*" ([0-9a-f]{8})>/.exec(t)?.[1];
    if (!nonce) return false;
    const outside = t.split(new RegExp(`<untrusted src="[^"]*" ${nonce}>[\\s\\S]*?</untrusted ${nonce}>`, 'g')).join('');
    return outside.includes('<owner 指令>'); // 不带 token 的 owner 块出现在围栏外 = 逃逸
  }).length;
  console.log(`  A8: 疑似逃逸 (围栏外出现无 token 的 owner 块) ${leaked} 份 ${leaked === 0 ? '✅' : '❌'}`);
}

// ── 读数板 (本次运行的全部确定性读数, 一次跑完全拿) ────────────────────────────
// 每次 live 都该白拿这一整版 —— 否则 ⑦⑧ 那些新仪表要等到有人想起来才被读一次。
const dbPath = join(sandbox, '.omd', 'dag-runs.db');
if (existsSync(dbPath)) {
  console.log(`\n══ 读数板 (${dbPath}) ══`);
  const r = Bun.spawnSync(['bun', 'run', 'scripts/omd-readout.ts', '--db', dbPath], { stdout: 'pipe', stderr: 'pipe' });
  console.log(new TextDecoder().decode(r.stdout));
  const err = new TextDecoder().decode(r.stderr).trim();
  if (err) console.error(err);
} else {
  console.log(`\n⚠ 没有留痕库 ${dbPath} —— 读数板这一整版拿不到 (recorder 没接上?)`);
}

console.log(`\n沙箱保留在 ${sandbox} (自己看完自己删)。`);
