/**
 * scripts/probes/crossfile-refactor-probe —— **第五格:跨文件重构**
 * (`docs/plan/2026-08-08-独立-agent-大仓能力核验.md` §4 剩下的两格之一)。
 *
 * ## 为什么这一格值得单独做
 *
 * 前四格的任务都是**单文件、单概念**的。跨文件重构考的是另一件事:
 * **改完知不知道还有谁受影响** —— 而那正是"能不能替掉别的 agent 在仓里干活"的分水岭。
 *
 * ## 四要素(动手前写死)
 *
 * - **假设**:对话位能改一处**被多处引用**的签名,并自己找出并改完**全部**调用方。
 * - **变量**:任务的跨文件性(单文件 → 4 个文件 15 处引用)。其余(仓/座位/审批/工具面)全同。
 * - **预先声明的成败信号**(**五条全中**才算成):
 *   ① `tsc --noEmit` 退出码 0 —— **这是这一格的天然 oracle**:漏改任何一个调用方它就红,
 *      而"漏改一个"正是这一格要考的失败模式;
 *   ② `bun test` 退出码 0;
 *   ③ diff 里**非测试文件 ≥ 3 个** —— 证明它真的跨了文件,不是只改一处;
 *   ④ **旧名字零残留** —— 留一个兼容包装就等于没重构(而且 tsc 照样绿,所以必须单独查);
 *   ⑤ **没有用 `any` / `@ts-ignore` / `as unknown` / `as never` 绕过** ——
 *      那是"让 tsc 闭嘴"而不是"改对了",是本仓最怕的那一族。判据只看**新增行**。
 * - **要收的数据**:工具调用序列 · 轮数 · 时间 · token · 审批放行/拒绝 · 改了哪些文件。
 *
 * ## 任务标的
 *
 * `humanTokens(n)` → `formatTokens(n, style)`:**改名 + 加一个必填参数**。
 * 两者都是**破坏性**的 —— 只加可选参数的话 tsc 不会红,判据 ① 就白给了。
 * 实测引用面(2026-08-08):`render/pressure.ts` 1 · `render/statusbar.ts` 4 ·
 * `settings.ts` 4 · `render/pressure.test.ts` 6 = **4 个文件 15 处**。
 *
 * ## 隔离
 *
 * `git worktree` 副本 + `node_modules` 软链。主仓一个字节不动。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TASK = [
  '本仓 `src/tui/render/pressure.ts` 里导出了 `humanTokens(n: number): string`。',
  '请把它重构成 `formatTokens(n: number, style: "short" | "exact"): string`:',
  '- `style: "short"` 保持现在的行为(1000 以下给整数, 以上给 `k`);',
  '- `style: "exact"` 给带千位分隔符的完整数字(例如 `12,421`);',
  '- **改名是破坏性的**: 全仓所有调用方都要跟着改, 一个都不许漏;',
  '- **不许留兼容包装**(别保留一个 `humanTokens` 转调新函数), 旧名字要彻底消失;',
  '- ⚠ **不许用 `any` / `@ts-ignore` / `as unknown` 绕过类型检查** —— 那是让 tsc 闭嘴, 不是改对。',
  '现有调用点原来的行为**保持不变**(也就是都传 `"short"`)。',
].join('\n');

async function main(): Promise<void> {
  const i = process.argv.indexOf('--worktree');
  if (i < 0 || !process.argv[i + 1]) {
    console.error('用法: bun run scripts/probes/crossfile-refactor-probe.ts --worktree <git worktree 路径>');
    console.error('⚠ **必须**给 worktree 副本 —— 这个探针会让模型真的改文件。');
    process.exit(2);
  }
  const repo = process.argv[i + 1] as string;
  process.env.OMD_DATA_HOME = mkdtempSync(join(tmpdir(), 'omd-xfile-data-'));
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
  const { createApprovalGate } = await import('../../src/tui/approval/gate');
  const { createOmdSessionStore } = await import('../../src/harness/chat/session-store');
  const { runChatTurn } = await import('../../src/harness/chat/agent');
  const { loadConductorContext } = await import('../../src/tui/context');

  let allowed = 0;
  let denied = 0;
  const approvals = createApprovalGate();
  approvals.setAsk(async (req: { tier?: string }) => {
    if (req.tier === 'admin') {
      denied++;
      return 'deny';
    }
    allowed++;
    return 'once';
  });

  const tools = createChatSeatTools({ cwd: repo, mcpTools: assembleOmdMcpTools({ onNodeEvent: () => {} }), approvals });
  const model = resolveEngineModels(process.env).conductorModel;
  const toolCalls: string[] = [];
  let out = '';
  let crash = '';
  let messages = 0;
  let usage: unknown = null;
  const t0 = Date.now();
  try {
    const r = await runChatTurn({
      store: createOmdSessionStore(repo),
      sessionId: `xfile-${Date.now()}`,
      prompt: TASK,
      model,
      cwd: repo,
      tools,
      contextFiles: loadConductorContext(repo),
      onEvent: (e: { type: string } & Record<string, unknown>) => {
        if (e.type === 'tool_execution_start') toolCalls.push(`${String(e.toolName)} ${JSON.stringify(e.args ?? {}).slice(0, 130)}`);
        if (e.type === 'message_update') {
          const ev = (e as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') out += ev.delta;
        }
      },
    });
    usage = r.usage;
    messages = r.messageCount;
    if (!out.trim()) {
      for (const m of r.newMessages) {
        const c = (m as { role?: string; content?: unknown }).content;
        if ((m as { role?: string }).role !== 'assistant' || !Array.isArray(c)) continue;
        for (const part of c as { type?: string; text?: string }[]) if (part.type === 'text' && part.text) out += `${part.text}\n`;
      }
    }
  } catch (err) {
    crash = (err as Error).message;
  }
  const ms = Date.now() - t0;

  const sh = async (cmd: string): Promise<{ code: number; text: string }> => {
    const p = Bun.spawn(['bash', '-lc', cmd], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, text: `${o}${e}`.trim() };
  };

  // ── 判据:五条,全部我自己量 ─────────────────────────────────────────────────
  const tsc = await sh('bun run tsc --noEmit 2>&1 | tail -8');
  const tests = await sh('bun test src/tui/ 2>&1 | tail -4');
  const names = await sh("git diff --name-only | grep -v node_modules || true");
  const nonTest = names.text.split('\n').filter((l) => l.trim() && !l.includes('.test.')).length;
  // ④ 旧名字零残留。⚠ 连注释里的也算 —— 留一句"原 humanTokens"是可以的, 所以只查**代码**行:
  //    用 `\bhumanTokens\s*\(` 找调用/定义, 不找散文里的提及。
  const leftover = await sh("grep -rn 'humanTokens[[:space:]]*(' src/ --include='*.ts' | grep -v node_modules || true");
  // ⑤ 新增行里有没有绕过类型检查的痕迹(只看 `+` 行)
  const cheat = await sh("git diff -U0 -- src/ | grep '^+' | grep -v '^+++' | grep -nE ': *any\\b|as any\\b|@ts-ignore|@ts-expect-error|as unknown|as never' || true");
  // 行为抽查:short 保持老行为, exact 给千位分隔符
  const behSrc = `
import { formatTokens } from ${JSON.stringify(join(repo, 'src/tui/render/pressure.ts'))};
console.log(JSON.stringify({ short1: formatTokens(999, 'short'), short2: formatTokens(1500, 'short'), exact: formatTokens(12421, 'exact') }));
`;
  const behPath = join(process.env.OMD_DATA_HOME as string, 'beh.ts');
  writeFileSync(behPath, behSrc);
  const beh = await sh(`bun run ${JSON.stringify(behPath)} 2>&1 | tail -1`);

  const v = {
    tscGreen: tsc.code === 0,
    testsGreen: tests.code === 0,
    crossedFiles: nonTest >= 3,
    noLeftover: leftover.text === '',
    noCheat: cheat.text === '',
  };
  const ok = !crash && Object.values(v).every(Boolean);

  writeFileSync(join(process.env.OMD_DATA_HOME as string, 'answer.txt'), out);
  console.log(`\n${'═'.repeat(78)}\n跨文件重构 @ ${repo}`);
  console.log(`  判据: ${ok ? '✓ 成' : '✗ **不成**'}${crash ? ` (抛异常: ${crash})` : ''}`);
  console.log(`    ① tsc --noEmit 绿(漏改任何调用方它就红) : ${v.tscGreen ? '✓' : '**✗**'}`);
  console.log(`    ② bun test src/tui 绿                    : ${v.testsGreen ? '✓' : '**✗**'}`);
  console.log(`    ③ 真的跨了文件(非测试文件 ≥3)          : ${v.crossedFiles ? `✓ (${nonTest})` : `**✗ (${nonTest})**`}`);
  console.log(`    ④ 旧名字零残留(没留兼容包装)          : ${v.noLeftover ? '✓' : `**✗**\n${leftover.text.split('\n').map((l) => `        ${l}`).join('\n')}`}`);
  console.log(`    ⑤ 没用 any/@ts-ignore 绕过              : ${v.noCheat ? '✓' : `**✗**\n${cheat.text}`}`);
  console.log(`  行为抽查: ${beh.text}`);
  console.log(`  工具调用 ${toolCalls.length} 次:`);
  for (const [n, c] of toolCalls.entries()) console.log(`    ${String(n + 1).padStart(2)}. ${c}`);
  console.log(`  审批 放行 ${allowed} / 拒 ${denied} · 消息 ${messages} 条 · ${(ms / 1000).toFixed(1)}s · usage ${JSON.stringify(usage)}`);
  console.log(`  改了哪些文件:\n${names.text.split('\n').map((l) => `    ${l}`).join('\n')}`);
  if (!v.tscGreen) console.log(`  tsc 输出:\n${tsc.text}`);
  console.log(`  回复末尾: ${JSON.stringify(out.trim().slice(-400))}`);
}

await main();
