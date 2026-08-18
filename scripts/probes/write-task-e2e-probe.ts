/**
 * scripts/probes/write-task-e2e-probe —— **端到端第二格:真改代码 + 自己跑测试验证**
 * (2026-08-08,`docs/plan/2026-08-08-独立-agent-大仓能力核验.md` §4 的第二格)。
 *
 * ## 四要素(动手前写死)
 *
 * - **假设**:对话位能在一个**真仓**里改对一处既有代码,并**自己跑测试**确认,不用人告诉它怎么验。
 * - **变量**:**任务难度**(第一格是只读聚合查询 → 这一格是写 + 自验)。
 *   ⚠ **不是规模** —— 修掉 venv 漏跳之后本机最大的仓只有 7,273 个文件,与 oh-my-dag 的
 *   6,815 差 7%,**没有能撑起"规模"这个变量的仓**(见报告 §0.0 的更正)。硬拿 talous-v2
 *   当"大仓"是上一版犯过的错,不再犯。
 * - **预先声明的成败信号**(三条**全中**才算成,少一条都不算):
 *   ① 我**独立**跑 oracle:`shouldSkipDir` 对 `.mypy_cache` / `.pytest_cache` 返回 true,
 *      且对 `mypy_cache_utils`(正常目录形状)仍返回 false;
 *   ② `bun test src/harness/agent-tools.test.ts` 在改完之后**退出码 0**;
 *   ③ 工具序列里**真的出现过一次跑测试的 bash 调用** —— 只写完就说"应该能过"不算自验。
 * - **要收的数据**:工具调用序列 · 轮数 · 墙上时间 · token · 审批档位与放行/拒绝次数 ·
 *   `git status` 动了哪些文件。不塌与塌都写。
 *
 * ## 隔离
 *
 * 跑在 **`git worktree` 副本**里(`--worktree <路径>`),`node_modules` 软链回主仓。
 * 主仓一个字节都不动。`OMD_DATA_HOME` 改到临时目录 ⇒ 会话也不落在副本的 `.omd/`。
 *
 * ## 审批怎么配(与第一格不同,这里必须放行写)
 *
 * 第一格是只读闸全拒。这一格**write 档自动放行、admin 档一律拒** ——
 * 相当于"一个配合的用户一路按 y,但不可逆操作仍然拒"。两个数都记:
 * 放行几次、拒了几次。**如果它是被 admin 档拒了才失败,那是闸的读数,不是能力的读数。**
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ★ **单一变量就是最后那一句**(`--no-verify-hint` 去掉它)。
 *
 * 前两格(§2.4 / §2.4b)我都在任务里写了「自己跑 `bun test …`」——**判据是我给的,不是它找的**。
 * 而"能不能独立干活"的核心恰恰是**它自己知不知道该怎么验**。
 * 这是本仓能做出的最干净的一次对照:**有/无一句话**,其余(仓/座位/审批/工具面)全同。
 */
const TASK_BASE = [
  '本仓 `src/harness/agent-tools.ts` 里有一个 `shouldSkipDir(name)`,它决定 grep 遍历时跳过哪些目录。',
  '现在请让它**同时跳过 Python 的缓存目录 `.mypy_cache` 与 `.pytest_cache`**。',
  '要求:',
  '1. 改 `shouldSkipDir` 本身(别去改调用方);',
  '2. 在 `src/harness/agent-tools.test.ts` 里加**一条新测试**证明这两个目录真的被跳过;',
  '3. ⚠ 不许误伤:像 `mypy_cache_utils` 这种正常源码目录名**必须仍然不被跳过**,请一并断言;',
];
/** 被删掉的那一句 —— 唯一的变量。 */
const VERIFY_HINT = [
  '4. 改完**自己跑一遍** `bun test src/harness/agent-tools.test.ts`,确认全绿再回复。',
  '最后告诉我你跑测试的结果。',
];
const NO_HINT = process.argv.includes('--no-verify-hint');
const TASK = [...TASK_BASE, ...(NO_HINT ? [] : VERIFY_HINT)].join('\n');

interface Verdict {
  oracleSkips: boolean;
  oracleNoFalseSkip: boolean;
  testsGreen: boolean;
  selfRanTests: boolean;
}

async function main(): Promise<void> {
  const wtArg = process.argv.indexOf('--worktree');
  if (wtArg < 0 || !process.argv[wtArg + 1]) {
    console.error('用法: bun run scripts/probes/write-task-e2e-probe.ts --worktree <git worktree 路径>');
    console.error('⚠ **必须**给 worktree 副本 —— 这个探针会让模型真的改文件, 不许指向主仓。');
    process.exit(2);
  }
  const repo = process.argv[wtArg + 1] as string;

  process.env.OMD_DATA_HOME = mkdtempSync(join(tmpdir(), 'omd-write-data-'));
  // ★ **只设 `OMD_DATA_HOME` 是不够的**(2026-08-08 实测):`session-store` 的 `sessionsRootFor()` 在这个变量
  //   有值时走 `dataPath('chat')`,而 `dataPath` 只有在 **project scope 被激活过**时才认它
  //   (`project-scope.ts:117-119`)—— 没激活就退回**相对路径** `.omd/chat`,于是会话
  //   落在**进程 cwd**(= 主仓)下。11 个探针会话就是这么进主仓 `.omd/chat/` 的。
  //   目标仓当时没被写,靠的是"cwd 恰好是主仓"这个巧合,**不是这行代码**。
  const { setActiveProject, resolveProject } = await import('../../src/harness/project-scope');
  setActiveProject(resolveProject(process.env.OMD_DATA_HOME));

  const { bootstrapModelRuntime } = await import('../../src/model/bootstrap');
  bootstrapModelRuntime();
  const { assembleOmdMcpTools, resolveEngineModels } = await import('../../src/mcp/assemble');
  const { createChatSeatTools } = await import('../../src/tui/tools/chat-seat');
  const { createOmdSessionStore } = await import('../../src/harness/chat/session-store');
  const { runChatTurn } = await import('../../src/harness/chat/agent');

  // 2026-08-13: 审批闸删了。原来是「write 档放行 · admin 档拒」—— 与新默认
  // (黑名单硬拒不可逆命令, 其余在 bwrap 围栏里直接跑) **语义相同**。
  // ⚠ 少掉的读数是"档位分布"那一列; 它量的是审批层, 而审批层已经不存在了。
  const mcpTools = assembleOmdMcpTools({ onNodeEvent: () => {} });
  const tools = createChatSeatTools({ cwd: repo, mcpTools })('probe');
  const model = resolveEngineModels(process.env).conductorModel;

  const toolCalls: string[] = [];
  let out = '';
  let thinking = '';
  let crash = '';
  let messages = 0;
  let usage: unknown = null;
  const t0 = Date.now();
  try {
    const r = await runChatTurn({
      store: createOmdSessionStore(repo),
      sessionId: `write-${Date.now()}`,
      prompt: TASK,
      model,
      cwd: repo,
      tools,
      
      onEvent: (e: { type: string } & Record<string, unknown>) => {
        if (e.type === 'tool_execution_start') {
          toolCalls.push(`${String(e.toolName)} ${JSON.stringify(e.args ?? {}).slice(0, 160)}`);
        }
        if (e.type === 'message_update') {
          const ev = (e as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') out += ev.delta;
          if (ev?.type === 'thinking_delta' && typeof ev.delta === 'string') thinking += ev.delta;
        }
      },
    });
    usage = r.usage;
    messages = r.messageCount;
    // 判据不许碰 thinking —— 第一格那次假绿就是判据匹配上了内心独白。
    if (!out.trim()) {
      for (const m of r.newMessages) {
        const c = (m as { role?: string; content?: unknown }).content;
        if ((m as { role?: string }).role !== 'assistant' || !Array.isArray(c)) continue;
        for (const part of c as { type?: string; text?: string }[]) {
          if (part.type === 'text' && typeof part.text === 'string') out += `${part.text}\n`;
        }
      }
    }
  } catch (err) {
    crash = (err as Error).message;
  }
  const ms = Date.now() - t0;

  // ── 判据:**我自己去量**,不看它怎么说 ────────────────────────────────────
  const sh = async (cmd: string): Promise<{ code: number; text: string }> => {
    const p = Bun.spawn(['bash', '-lc', cmd], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, text: `${o}${e}`.trim() };
  };

  // ① 行为 oracle:直接 import 改完的实装问它三个名字。**不读它的代码,读它的行为。**
  const oracleSrc = `
import { shouldSkipDir } from ${JSON.stringify(join(repo, 'src/harness/agent-tools.ts'))};
const r = {
  mypy: shouldSkipDir('.mypy_cache'),
  pytest: shouldSkipDir('.pytest_cache'),
  falsePos: shouldSkipDir('mypy_cache_utils'),
};
console.log(JSON.stringify(r));
`;
  const oraclePath = join(process.env.OMD_DATA_HOME as string, 'oracle.ts');
  writeFileSync(oraclePath, oracleSrc);
  const oracleRun = await sh(`bun run ${JSON.stringify(oraclePath)}`);
  let parsed: { mypy?: boolean; pytest?: boolean; falsePos?: boolean } = {};
  try {
    parsed = JSON.parse(oracleRun.text.split('\n').pop() ?? '{}');
  } catch {
    /* 解析不了就是三个 undefined —— 下面的判据自然算不成, 不编一个值 */
  }

  // ② 测试真的绿吗(我自己跑, 不信它的回执)
  const testRun = await sh('bun test src/harness/agent-tools.test.ts 2>&1 | tail -5');
  // ③ 它自己跑过测试没有
  // ★ 判据 ③:它**自己**跑了验证没有。
  //   ⚠ 只认这个仓**真正的**验收命令(`bun test`)—— 自己编一个 `node -e` 冒充验证不算
  //   (那是"看起来验了"而不是"验了", 本仓最怕的那一族)。
  const selfRanTests = toolCalls.some((c) => c.startsWith('bash') && /bun\s+test/.test(c));
  const fakeVerify = toolCalls.some((c) => c.startsWith('bash') && /node\s+-e|bun\s+-e|bun\s+run\s+-e/.test(c));
  const status = await sh('git status --short');
  const diffstat = await sh('git diff --stat');

  const v: Verdict = {
    oracleSkips: parsed.mypy === true && parsed.pytest === true,
    oracleNoFalseSkip: parsed.falsePos === false,
    testsGreen: testRun.code === 0,
    selfRanTests,
  };
  const ok = !crash && v.oracleSkips && v.oracleNoFalseSkip && v.testsGreen && v.selfRanTests;

  writeFileSync(join(process.env.OMD_DATA_HOME as string, 'answer.txt'), `--- 正文 ---\n${out}\n--- thinking ---\n${thinking}\n`);

  console.log(`\n${'═'.repeat(78)}\n写任务 @ ${repo}   [验收提示: ${NO_HINT ? '**已删掉** (4.1c 条件)' : '给了 (基线条件)'}]`);
  console.log(`  判据: ${ok ? '✓ 成' : '✗ **不成**'}${crash ? ` (抛异常: ${crash})` : ''}`);
  console.log(`    ① .mypy_cache/.pytest_cache 真被跳过 : ${v.oracleSkips ? '✓' : '**✗**'}  (量到 ${JSON.stringify(parsed)})`);
  console.log(`    ② mypy_cache_utils 没被误伤          : ${v.oracleNoFalseSkip ? '✓' : '**✗**'}`);
  console.log(`    ③ 测试真的绿(我自己跑)             : ${v.testsGreen ? '✓' : '**✗**'}`);
  console.log(`    ④ 它自己跑过**本仓真正的**验收命令   : ${v.selfRanTests ? '✓' : '**✗ 只写没验**'}${fakeVerify ? '  ⚠ 但它跑过 node -e/bun -e —— 自造的验证不算' : ''}`);
  console.log(`  工具调用 ${toolCalls.length} 次:`);
  for (const [i, c] of toolCalls.entries()) console.log(`    ${String(i + 1).padStart(2)}. ${c}`);
  console.log(`  消息 ${messages} 条 · ${(ms / 1000).toFixed(1)}s · usage ${JSON.stringify(usage)}`);
  console.log(`  git status:\n${status.text || '    (干净 —— 一个文件都没改)'}`);
  console.log(`  git diff --stat:\n${diffstat.text || '    (无)'}`);
  console.log(`  我跑测试的输出尾部:\n${testRun.text.split('\n').map((l) => `    ${l}`).join('\n')}`);
  console.log(`  它的回复末尾: ${JSON.stringify(out.trim().slice(-500))}`);
}

await main();
