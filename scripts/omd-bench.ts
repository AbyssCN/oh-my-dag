#!/usr/bin/env bun
/**
 * omd-bench —— **把本仓自己的真 bug 做成考题**(2026-08-05,owner 定向)。
 *
 * 为什么不追公开榜、一道题怎么来、validation contract 是哪三条,全部见
 * `src/eval/bench/task.ts` 顶注(那里有 OpenAI 停报 / Berkeley 刷穿 / ICSE 7-8% 虚高的出处)。
 *
 * ```
 *   omd-bench extract [--limit 300] [--max 8]   扫 git 历史挑候选, 逐个跑合约, **合格的才存盘**
 *   omd-bench list                              列已建成的题
 *   omd-bench validate [--id X]                 重跑合约(题库体检: 环境漂了会红)
 * ```
 *
 * ## 隔离(Berkeley 那条裂缝, 照实写)
 *
 * 每次试跑起一个**独立 git worktree**(Anthropic:每次 trial 从干净环境开始;残留状态会让
 * 分数虚高 —— 他们实测过 Claude 靠读上一次 trial 的 git 历史拿分)。
 * **但我们不声称能防一个主动改判分器的 agent**:worktree 与判分进程仍在同一台机器、同一文件系统。
 * 现在堵住的是「候选偷改测试」这一条(判分前逐字节核对受保护路径),
 * **不是**「agent 主动攻击评测器」那一条。要防后者得把评测器放到它够不着的地方,那是另一条正交防线。
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { judgeContract, type BenchTask, type RunObservation } from '../src/eval/bench/task';

const argv = process.argv.slice(2);
const cmdName = argv[0] ?? '';
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPO = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const TASKS_DIR = join(REPO, 'src', 'eval', 'bench', 'tasks');
const log = (s: string): void => void process.stderr.write(s + '\n');

const git = (args: string[], cwd = REPO): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** 在给定 cwd 跑一条命令, 记退出码/耗时/尾部。**不抛** —— 失败本身就是读数(RED 世界要的就是它)。 */
function runCommand(command: string, cwd: string, timeoutMs = 300_000): RunObservation {
  const t0 = Date.now();
  try {
    const out = execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { command, exitCode: 0, durationMs: Date.now() - t0, tail: out.slice(-1500) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      command,
      // status 缺席(超时/被信号杀)记 -1, **不记 0** —— 那会把一次没跑完读成"通过"(仓规 NULL≠0)。
      exitCode: typeof err.status === 'number' ? err.status : -1,
      durationMs: Date.now() - t0,
      tail: `${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}`.slice(-1500),
    };
  }
}

/**
 * 起一个隔离世界:`baseSha` 的树,再把 `overlaySha` 的指定文件覆盖上去。
 * RED 世界 = base=父提交 + overlay=修复提交的**测试**;GREEN 世界 = base=修复提交, 无 overlay。
 */
function withWorld<T>(baseSha: string, overlay: { sha: string; paths: string[] } | null, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'omd-bench-'));
  try {
    git(['worktree', 'add', '--detach', '--quiet', dir, baseSha]);
    // node_modules 软链回主仓 —— worktree 里没有依赖, 装一遍要几分钟且每次 trial 都要装。
    // 只读共享, 不写入(候选只改 src/)。
    const nm = join(REPO, 'node_modules');
    if (existsSync(nm)) symlinkSync(nm, join(dir, 'node_modules'), 'dir');
    for (const p of overlay?.paths ?? []) {
      const body = git(['show', `${overlay!.sha}:${p}`]);
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return fn(dir);
  } finally {
    try { git(['worktree', 'remove', '--force', dir]); } catch { /* 已被清掉 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Candidate { sha: string; parent: string; subject: string; impl: string[]; tests: string[] }

/** 扫 git 历史挑候选:同时改了 `src/` 实现与 `.test.ts`, 且形状干净(1 实现 + 1 测试)。 */
function candidates(limit: number): Candidate[] {
  const out: Candidate[] = [];
  for (const line of git(['log', '--format=%H%x09%P%x09%s', '-n', String(limit)]).trim().split('\n')) {
    const [sha, parents, ...rest] = line.split('\t');
    const parent = (parents ?? '').split(' ')[0];
    if (!sha || !parent) continue; // 根提交/合并提交的第一父之外不处理
    const files = git(['show', '--pretty=format:', '--name-only', sha]).trim().split('\n').filter(Boolean);
    const tests = files.filter((f) => f.endsWith('.test.ts'));
    const impl = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f.startsWith('src/'));
    // 形状硬约束: 恰好 1 实现 + 1 测试。多文件的题边界不干净 ——
    // 判分命令说不清"该改哪儿", 而且 GREEN 更容易因为漏抽文件而假红。宁可少收题。
    if (impl.length === 1 && tests.length === 1) {
      out.push({ sha, parent, subject: (rest.join('\t') || '').trim(), impl, tests });
    }
  }
  // **真修复优先**: 合约的第 4 条(RED 必须是断言失败而非加载失败)天然会把
  // 「新增功能」类 commit 拒掉 —— 父提交上那个符号根本不存在, 测试加载就炸。
  // 每验一道题要跑两次测试(慢), 所以先试最可能过的那些, 别把预算烧在必拒的候选上。
  const fixish = (s: string): number => (/^fix|^refactor|修|bug|缺陷|堵|漏|根因|吞证据/.test(s) ? 0 : 1);
  return out.sort((a, b) => fixish(a.subject) - fixish(b.subject));
}

function taskOf(c: Candidate): BenchTask {
  const test = c.tests[0]!;
  return {
    id: `${c.sha.slice(0, 8)}-${test.replace(/^.*\//, '').replace(/\.test\.ts$/, '')}`,
    fixSha: c.sha,
    baseSha: c.parent,
    title: c.subject,
    // 题面**只给症状与判分命令, 不给答案**: 实现路径要不要告诉被测方是个变量,
    // 这里给了(等价于"issue 里指出了大致位置"), 与 SWE-bench 给 issue 文本同档。
    statement:
      `本仓存在一个缺陷。issue 描述(来自修复该缺陷的 commit 标题):\n  ${c.subject}\n\n` +
      `判据:\`${`bun test ${test}`}\` 必须通过。\n` +
      `⚠ **不许改动测试文件 \`${test}\`** —— 判分前会逐字节核对, 改了这一跑作废。\n` +
      `相关实现文件:${c.impl.join(', ')}`,
    implPaths: c.impl,
    testPaths: c.tests,
    command: `bun test ${test}`,
  };
}

/** 跑一道题的合约:RED(父树 + 新测试)必须红,GREEN(修复树)必须绿,同一条命令。 */
function proveContract(t: BenchTask): { red: RunObservation; green: RunObservation } {
  const red = withWorld(t.baseSha, { sha: t.fixSha, paths: t.testPaths }, (d) => runCommand(t.command, d));
  const green = withWorld(t.fixSha, null, (d) => runCommand(t.command, d));
  return { red, green };
}

function loadTasks(): BenchTask[] {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')) as BenchTask);
}

/**
 * 起一个**候选世界**:base=父提交(有缺陷) + 覆盖上修复提交的测试文件。
 * 这正是 RED 世界 —— 被测方要做的就是把它变绿。**worktree 不清理**(调用方拿到路径后自己收),
 * 因为跑完还要在里面核对受保护路径与跑回归。
 */
function makeCandidateWorld(t: BenchTask): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-bench-run-'));
  git(['worktree', 'add', '--detach', '--quiet', dir, t.baseSha]);
  const nm = join(REPO, 'node_modules');
  if (existsSync(nm)) symlinkSync(nm, join(dir, 'node_modules'), 'dir');
  // ⚠ `.omd/config.json` 是 **cwd 相对且 gitignored** —— worktree 里没有它, omd 引擎起不来
  //    (本仓已知坑: 后台 agent / --worktree 全中)。拷一份进去, 让 A 臂能跑。
  const cfg = join(REPO, '.omd', 'config.json');
  if (existsSync(cfg)) {
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), readFileSync(cfg, 'utf8'));
  }
  for (const p of t.testPaths) {
    const body = git(['show', `${t.fixSha}:${p}`]);
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

function dropWorld(dir: string): void {
  try { git(['worktree', 'remove', '--force', dir]); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}

/** 受保护路径**逐字节**核对(与题目锚定的 `fixSha` 版本比)。返回被改动的路径。 */
function touchedProtected(t: BenchTask, dir: string): string[] {
  return t.testPaths.filter((p) => {
    const want = git(['show', `${t.fixSha}:${p}`]);
    let got = '';
    try { got = readFileSync(join(dir, p), 'utf8'); } catch { return true; } // 删掉也算改动
    return got !== want;
  });
}

/**
 * 交给被测方的题面 —— 两臂**逐字相同**,否则量到的是提示词差异不是编排差异。
 *
 * `--no-hint` (2026-08-18 加难度): 去掉「相关实现文件」那一行。带着它, 题面等价于
 * "issue 里指出了大致位置"; 去掉之后被测方要自己定位, 读改轮次变多 —— 那正是行锚定编辑
 * (hashline) 该显出差别的地方。**两臂同开同关**, 否则量的是提示词不是工具。
 */
function candidatePrompt(t: BenchTask): string {
  const statement = argv.includes('--no-hint')
    ? t.statement.split('\n').filter((l) => !l.startsWith('相关实现文件')).join('\n')
    : t.statement;
  return (
    `${statement}\n\n` +
    `工作目录就是当前仓库。改完之后本地跑一次 \`${t.command}\` 自查。\n` +
    '只改实现, 不要改测试文件。'
  );
}

/** 一臂跑完的**代价读数**(不判对错, 但两臂比较全靠它 —— 承 Claw-Eval:token efficiency 是一等公民)。 */
interface ArmCost { wallMs: number; tokensIn: number; tokensOut: number; toolCalls: number | null; seat: string; note: string }

async function runArm(t: BenchTask, arm: 'a' | 'b', dir: string, opts: { budgetMs: number }): Promise<ArmCost> {
  const { bootstrapModelRuntime } = await import('../src/model/bootstrap');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  bootstrapModelRuntime();
  const seats = resolveEngineModels(process.env);
  const started = Date.now();

  if (arm === 'b') {
    const { createAgentLeafRunner } = await import('../src/harness/agent-leaf');
    // `--seat <coord>`: 钉这一跑的座位, 不动全局 config。env 旋钮在这里无效 ——
    // INV-MODEL-1 让 config.models 压过 env, 所以换座只能靠显式传 (实测 OMD_AGENT_MODEL 不生效)。
    const model = opt('seat') ?? seats.agentLeafModel ?? seats.leafModel;
    // `--no-hashline` (2026-08-18 A/B): 关掉行锚定编辑, 回到 pi 原生 `edit`。
    // 单一变量就是这一个开关 —— 座位/题面/超时/隔离世界全不动。
    const hashlineEdit = !argv.includes('--no-hashline');
    const runner = createAgentLeafRunner({ cwd: dir, hashlineEdit, leafTimeoutMs: 1_800_000 });
    // `--profile <name>`: 工具面 A/B 用 —— 档案从**主仓**解析, 隔离世界是 git worktree, 里面没有 .omd/。
    // 不传 = 生产全工具面 (与本 flag 加入前逐字节相同, 老读数仍可比)。
    const profileName = opt('profile');
    const profile = profileName ? (await import('../src/harness/profiles/profile')).resolveProfile(profileName, REPO) : undefined;
    if (profileName && !profile) throw new Error(`omd-bench: 主仓 .omd/profiles 里没有档案 ${profileName}`);
    const r = await runner({ prompt: candidatePrompt(t), model, ...(profile ? { profile } : {}) });
    return {
      wallMs: Date.now() - started,
      tokensIn: r.usage.in, tokensOut: r.usage.out,
      // 三态: 有数 / 真零 / 采不到。**采不到记 null 不记 0**(本仓栽过: 采集器自己撒谎)。
      toolCalls: typeof r.toolCalls === 'number' ? r.toolCalls : null,
      seat: model, note: String(r.text ?? '').slice(-400),
    };
  }

  const { assembleOmdMcpTools } = await import('../src/mcp/assemble');
  const { RunRegistry } = await import('../src/mcp/run-registry');
  const registry = new RunRegistry();
  const tools = assembleOmdMcpTools({ cwd: dir, runRegistry: registry });
  const tool = tools.find((x) => x.name === 'dag_run');
  if (!tool) throw new Error('omd-bench: 装不出 dag_run');
  const res = (await tool.handler({ task: candidatePrompt(t) } as never, {} as never)) as {
    content: { text: string }[]; isError?: boolean;
  };
  const runId = /runId: (\S+)/.exec(res.content[0]?.text ?? '')?.[1];
  if (!runId || res.isError) throw new Error(`A 臂起跑失败: ${res.content[0]?.text}`);
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  // 实测账(2026-09-01): A 臂第一题无限轮询 6h47m, 叶子进程全无而状态停 running —— 等待环无界。
  // 装个 deadline(--budget-ms, 默认 30 分钟), 超时记 error verdict 带 runId 与 registry 状态, 退非零。
  const deadlineAt = Date.now() + opts.budgetMs;
  for (;;) {
    const st = registry.getStatus(runId);
    if (st && TERMINAL.has(st)) break;
    if (Date.now() >= deadlineAt) {
      const finalStatus = registry.getStatus(runId) ?? 'unknown';
      throw new Error(
        `A 臂等待环 deadline 超时 (${opts.budgetMs}ms): runId=${runId} registry.status=${finalStatus}`
      );
    }
    await Bun.sleep(3000);
  }
  return {
    wallMs: Date.now() - started,
    // A 臂的 token 账在 run 结果里, 这里先记 0 并在 note 里留 runId —— **别编一个看起来像真的数**。
    tokensIn: 0, tokensOut: 0, toolCalls: null,
    seat: seats.agentLeafModel ?? seats.leafModel,
    note: `dag_run runId=${runId} status=${registry.getStatus(runId)} (⚠ token 账未接, 记 0 是"未采集"不是"真 0")`,
  };
}

async function main(): Promise<void> {
  if (cmdName === 'run') {
    const id = opt('id');
    const arm = (opt('arm') ?? '') as 'a' | 'b';
    if (!id || (arm !== 'a' && arm !== 'b')) { log('用法: run --id <taskId> --arm a|b [--regression] [--profile <岗位档案名>] [--seat <模型坐标>] [--no-hashline] [--no-hint] [--budget-ms <ms>]  (后四个仅 arm b; budget-ms 仅 arm a)'); process.exit(2); }
    const t = loadTasks().find((x) => x.id === id);
    if (!t) { log(`没有这道题: ${id}`); process.exit(2); }
    const dir = makeCandidateWorld(t);
    // --budget-ms: A 臂等待环 deadline, 默认 30 分钟(2026-09-01 实测首题 6h47m 卡死的止血线)。
    const budgetMs = Number(opt('budget-ms') ?? '1800000');
    log(`题 ${t.id} · 臂 ${arm} · 世界 ${dir} · 预算 ${budgetMs}ms`);
    try {
      const cost = await runArm(t, arm, dir, { budgetMs });
      const run = runCommand(t.command, dir);
      const touched = touchedProtected(t, dir);
      // 回归**默认不跑**(全量测试很慢); 没跑就记 null, **不记通过**(仓规 NULL≠0)。
      const regressionGreen = argv.includes('--regression') ? runCommand('bun test', dir, 900_000).exitCode === 0 : null;
      const { scoreCandidate } = await import('../src/eval/bench/task');
      const verdict = scoreCandidate({ task: t, run, protectedPathsTouched: touched, regressionGreen });
      const out = join(REPO, '.omd', 'eval', 'omd-bench');
      mkdirSync(out, { recursive: true });
      const stamp = `${t.id}-${arm}-${Date.now()}`;
      // profile: null = 没用档案 (生产全工具面), 不是"空档案" —— 事后比读数要分得开这两件事。
      writeFileSync(join(out, `${stamp}.json`), JSON.stringify({ task: t.id, arm, profile: opt('profile') ?? null, seatPinned: opt('seat') ?? null, hashlineEdit: !argv.includes('--no-hashline'), hinted: !argv.includes('--no-hint'), verdict, run, touched, regressionGreen, cost }, null, 1));
      console.log(`${verdict.verdict === 'pass' ? '✅' : verdict.verdict === 'invalid' ? '⚠' : '✘'} ${t.id} [臂 ${arm}] ${verdict.verdict}`);
      console.log(`   ${verdict.reason}`);
      console.log(`   墙钟 ${(cost.wallMs / 1000).toFixed(0)}s · 判分命令 exit ${run.exitCode} · 存盘 ${join(out, `${stamp}.json`)}`);
    } finally {
      dropWorld(dir);
    }
    return;
  }

  if (cmdName === 'extract') {
    const limit = Number(opt('limit') ?? '300');
    const max = Number(opt('max') ?? '8');
    mkdirSync(TASKS_DIR, { recursive: true });
    const cands = candidates(limit);
    log(`扫了 ${limit} 个 commit, 形状干净的候选 ${cands.length} 个; 逐个跑合约, 最多收 ${max} 道…\n`);
    let kept = 0;
    const rejected: string[] = [];
    for (const c of cands) {
      if (kept >= max) break;
      const t = taskOf(c);
      if (existsSync(join(TASKS_DIR, `${t.id}.json`))) { log(`  · ${t.id} 已存在, 跳过`); kept++; continue; }
      // 合约跑不起来 (文件在 fixSha 上不存在 = 重命名/删除的候选, `git show` status 128) →
      // **跳过并留证**, 不让整轮扫描死在一个坏候选上 (2026-08-18 实测: 扫到第 49 个候选时崩,
      // 前面收下的题还在盘上, 但后面的一个都没试)。
      let ev: ReturnType<typeof proveContract>;
      try {
        ev = proveContract(t);
      } catch (e) {
        const why = (e as Error).message.split('\n')[0] ?? String(e);
        rejected.push(`${t.id}: 合约跑不起来 — ${why}`);
        log(`  ✘ ${t.id}  合约跑不起来 — ${why}`);
        continue;
      }
      const v = judgeContract(ev);
      if (v.ok) {
        writeFileSync(join(TASKS_DIR, `${t.id}.json`), JSON.stringify(t, null, 1));
        kept++;
        log(`  ✅ ${t.id}  RED exit ${ev.red.exitCode} → GREEN exit 0  (${(ev.red.durationMs + ev.green.durationMs) / 1000 | 0}s)`);
        log(`     ${t.title.slice(0, 78)}`);
      } else {
        rejected.push(`${t.id}: ${v.failures.join('+')}`);
        log(`  ✘ ${t.id}  ${v.failures.join('+')}`);
      }
    }
    // **拒了什么必须留证**(仓规: fail-open 可以吞异常, 不许吞证据)。
    log(`\n收 ${kept} 道 · 拒 ${rejected.length} 道`);
    for (const r of rejected) log(`  拒: ${r}`);
    return;
  }

  if (cmdName === 'list') {
    const ts = loadTasks();
    console.log(`题库 ${ts.length} 道 (${TASKS_DIR})`);
    for (const t of ts) console.log(`  ${t.id}\n    ${t.title}\n    cmd: ${t.command}  ·  受保护: ${t.testPaths.join(',')}`);
    return;
  }

  /**
   * 端到端自检:**证明防作弊闸真的会红**。
   *
   * 单元测试证的是判据逻辑,证不了「起世界 → 读文件 → 比字节」这条管子接对了。
   * 而这条闸平时永远沉默(正常候选不改测试),沉默与失灵长得一模一样 ——
   * 本仓栽过的正是这个形态(采集器自己撒谎)。所以做成可随时重跑的自检。
   */
  if (cmdName === 'selftest') {
    const t = loadTasks()[0];
    if (!t) { log('题库为空(先跑 extract)'); process.exit(2); }
    const { scoreCandidate } = await import('../src/eval/bench/task');
    const dir = makeCandidateWorld(t);
    try {
      const clean = touchedProtected(t, dir);
      // 扮演一个作弊候选: 把受保护的测试文件改成永远绿。
      writeFileSync(join(dir, t.testPaths[0]!), 'import { test, expect } from "bun:test";\ntest("绿", () => expect(1).toBe(1));\n');
      const dirty = touchedProtected(t, dir);
      const cheated = scoreCandidate({
        task: t,
        run: { command: t.command, exitCode: 0, durationMs: 1, tail: '\n 1 pass\n 0 fail\n' },
        protectedPathsTouched: dirty,
        regressionGreen: true,
      });
      const ok = clean.length === 0 && dirty.length === 1 && cheated.verdict === 'invalid';
      console.log(`${ok ? '✅' : '✘'} 防作弊闸端到端自检(题 ${t.id})`);
      console.log(`   未改动时: touched=${JSON.stringify(clean)}(应为 [])`);
      console.log(`   改了测试并让命令变绿后: touched=${JSON.stringify(dirty)} → 判 ${cheated.verdict}(应为 invalid, **不是 pass**)`);
      if (!ok) process.exit(1);
    } finally {
      dropWorld(dir);
    }
    return;
  }

  if (cmdName === 'validate') {
    const id = opt('id');
    const ts = loadTasks().filter((t) => !id || t.id === id);
    if (ts.length === 0) { log('题库为空(先跑 extract)'); process.exit(2); }
    let bad = 0;
    for (const t of ts) {
      const v = judgeContract(proveContract(t));
      console.log(`${v.ok ? '✅' : '✘'} ${t.id}`);
      if (!v.ok) { console.log(`   ${v.reason.replace(/\n/g, '\n   ')}`); bad++; }
    }
    // 题库体检红了要非 0 退出 —— 它得能进 CI 当闸, 不能只打印。
    if (bad > 0) { log(`\n${bad} 道题的合约现在不成立(环境漂了或题坏了)`); process.exit(1); }
    return;
  }

  log('用法: omd-bench extract [--limit 300] [--max 8] | list | validate [--id X]');
  process.exit(2);
}

await main();
