/**
 * scripts/probes/large-repo-e2e-probe —— **端到端:omd 对话位能不能在一个陌生大仓里自己找到答案**
 * (2026-08-08,填 `docs/plan/2026-08-08-独立-agent-大仓能力核验.md` §4 那一格空白)。
 *
 * ## 四要素(动手前写死,不许事后编)
 *
 * - **假设**:对话位靠自己的工具面就能在一个它没见过的大仓里定位到一个指定事实,
 *   不需要人给路径。
 * - **单一变量**:仓的规模。`talous-v2`(约 19.2k 非跳过文件)vs `oh-my-dag`(约 6.7k)。
 *   ⚠ 任务**文字完全相同**(见 `TASK`),所以变的只有仓 —— 这是这个实验能做到的最强控制。
 * - **预先声明的成败信号**:最终回答里出现 `ORACLE.path` **且**行数 `ORACLE.lines`(±0)。
 *   少一个都算不成,并且要记**卡在哪一跳**。oracle 由确定性命令先算好(见 `ORACLE` 注释)。
 * - **要收的数据**:工具调用序列(名字 + 入参前 120 字)· 轮数 · 墙上时间 · token ·
 *   审批被拒次数 · 最终回答原文。不塌与塌都写。
 *
 * ## 为什么写死不许让它改仓
 *
 * 目标仓之一是 **talous-v2 —— 一个真项目**。所以:
 * ① 会话改道到临时目录 —— ⚠ **`OMD_DATA_HOME` 一个变量不够**,必须连 `setActiveProject` 一起
 *    (`project-scope.ts:117`:没激活 scope 就退回**相对**路径 `.omd/chat`,落进程 cwd);
 * ② 装一个**只读审批闸**:凡是分类到 read 档以上的一律 `deny`。
 *    这不是"相信它不会写",是**结构上写不了**。被拒次数一并记 ——
 *    如果它是因为被我的闸拒了才失败,那是**我的闸的读数**,不是 omd 的缺陷,得分得开。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 任务文字**两个仓完全一样** —— 单一变量靠这个成立。 */
const TASK =
  '这个仓里被 git 追踪的 TypeScript 文件(*.ts)当中, 行数最多的是哪一个? ' +
  '请给出它相对仓根的路径, 以及它的行数。最后一行用 `答案: <路径> <行数>` 的格式回答。';

/**
 * oracle:确定性命令先算好的真值。
 *
 * ```bash
 * git ls-files -z '*.ts' | xargs -0 wc -l | sort -rn | sed -n 2p
 * ```
 */
const ORACLE: Record<string, { path: string; lines: number }> = {
  '/home/nick/repos/oh-my-dag': { path: 'src/harness/dag/engine.ts', lines: 3349 },
  '/home/nick/repos/talous-v2': { path: 'src/types/supabase.ts', lines: 12421 },
};

interface Reading {
  repo: string;
  ok: boolean;
  why: string;
  toolCalls: string[];
  denied: number;
  ms: number;
  usage: unknown;
  messages: number;
  answerTail: string;
}

async function runOne(repo: string): Promise<Reading> {
  const oracle = ORACLE[repo];
  if (!oracle) throw new Error(`没给 ${repo} 的 oracle —— 先算 oracle 再跑, 不许反过来`);

  // ① 会话数据改道到临时目录:目标仓的 .omd/ 一个字节都不许动。
  process.env.OMD_DATA_HOME = mkdtempSync(join(tmpdir(), 'omd-e2e-data-'));
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
  const { readonlyFace } = await import('./readonly-face');
  const { createOmdSessionStore } = await import('../../src/harness/chat/session-store');
  const { runChatTurn } = await import('../../src/harness/chat/agent');

  // ② 只读闸(2026-08-13 由审批闸搬到 `readonly-face`: 审批层已随 TUI yolo 化删除)。
  //    工具面形状不变 —— 会改盘的那几只仍在面上, 被拒是调用时抛错。
  const mcpTools = assembleOmdMcpTools({ onNodeEvent: () => {} });
  const face = readonlyFace(createChatSeatTools({ cwd: repo, mcpTools })('probe'));
  const tools = face.tools;
  // 座位走**生产的同一条解析**(env + .omd/config.json)。探针里另指一个模型的话,
  // 量的就不是生产装配了。
  const model = resolveEngineModels(process.env).conductorModel;

  const toolCalls: string[] = [];
  const t0 = Date.now();
  let out = '';
  let thinking = '';
  let usage: unknown = null;
  let messages = 0;
  let crash = '';
  try {
    const r = await runChatTurn({
      store: createOmdSessionStore(repo),
      sessionId: `e2e-${Date.now()}`,
      prompt: TASK,
      model,
      cwd: repo,
      tools,
      
      onEvent: (e: { type: string } & Record<string, unknown>) => {
        if (e.type === 'tool_execution_start') {
          const args = JSON.stringify(e.args ?? {}).slice(0, 120);
          toolCalls.push(`${String(e.toolName)} ${args}`);
        }
        /**
         * ★ **只收"交付给用户的正文"** —— 事件名照 `backend-embedded.ts:113` 那一条,
         * 不是顶层的 `text_delta`(第一版写错成顶层, 于是 `out` 恒空、恒走兜底)。
         *
         * ⚠ 并且**判据不许碰 thinking**:第一版兜底捞的是会话最后一条消息,
         * 而 talous-v2 那一跑最后一条是 `thinking` 块 —— 判据于是匹配上了模型的
         * **内心独白**("Answer: src/types/supabase.ts, 12421 lines"), 报了个假绿。
         * thinking 单独收一份只为了看, 不进判据。
         */
        if (e.type === 'message_update') {
          const ev = (e as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') out += ev.delta;
          if (ev?.type === 'thinking_delta' && typeof ev.delta === 'string') thinking += ev.delta;
        }
      },
    });
    usage = r.usage;
    messages = r.messageCount;
    /**
     * 流式一个字都没收到 → 从会话里捞,但**只捞 `type === 'text'` 的块**。
     * ⚠ 不许 `JSON.stringify(整条 content)`:那会把 `thinking` 与那条 3848 字的
     * `thinkingSignature` 一起倒进判据,于是判据匹配的是内心独白(2026-08-08 实测的假绿)。
     */
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

  // ③ 判据:路径与行数**都**要对。预先声明过的,这里一个字不改。
  const hasPath = out.includes(oracle.path);
  const hasLines = new RegExp(`\\b${oracle.lines}\\b`).test(out);
  const ok = !crash && hasPath && hasLines;
  const why = crash
    ? `抛异常: ${crash}`
    : ok
      ? '路径与行数都对'
      : `路径${hasPath ? '对' : '**错/缺**'} · 行数${hasLines ? '对' : '**错/缺**'}`;

  // ★ 全文写盘。**只看尾部会看错**:2026-08-08 实测 talous-v2 那一跑判据说"成"而尾部
  //   是一段 base64 —— 不把全文摊开看就会把一个没读懂的结果当成通过
  //   (本仓「oracle 绿 ≠ 语义对」)。
  const dump = join(process.env.OMD_DATA_HOME as string, 'answer.txt');
  writeFileSync(dump, `=== ${repo} ===\n--- 交付正文 (判据只看这一段) ---\n${out}\n--- thinking (只为看, 不进判据) ---\n${thinking}\n`);
  console.log(`  [全文已写 ${dump}]`);
  return { repo, ok, why, toolCalls, denied: face.denied(), ms, usage, messages, answerTail: out.trim().slice(-400) };
}

const repos = process.argv.slice(2);
if (repos.length === 0) {
  console.error('用法: bun run scripts/probes/large-repo-e2e-probe.ts <仓路径> [更多…]');
  console.error(`已有 oracle 的仓: ${Object.keys(ORACLE).join(' · ')}`);
  process.exit(2);
}
for (const repo of repos) {
  const r = await runOne(repo);
  console.log(`\n${'═'.repeat(78)}\n${r.repo}`);
  console.log(`  判据: ${r.ok ? '✓ 成' : '✗ **不成**'} —— ${r.why}`);
  console.log(`  oracle: ${ORACLE[repo]?.path} ${ORACLE[repo]?.lines} 行`);
  console.log(`  工具调用 ${r.toolCalls.length} 次:`);
  for (const [i, c] of r.toolCalls.entries()) console.log(`    ${String(i + 1).padStart(2)}. ${c}`);
  console.log(`  只读闸拒 ${r.denied} 次 · 消息 ${r.messages} 条 · ${(r.ms / 1000).toFixed(1)}s`);
  console.log(`  usage: ${JSON.stringify(r.usage)}`);
  console.log(`  回答末尾: ${JSON.stringify(r.answerTail)}`);
}
