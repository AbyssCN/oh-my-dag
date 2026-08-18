/**
 * scripts/probes/long-session-compaction-probe —— **第六格(最后一格):长会话压缩**
 * (`docs/plan/2026-08-08-独立-agent-大仓能力核验.md` §4 剩下的唯一一件)。
 *
 * ## 这一格真正的风险不是"压不动",是**压掉了硬约束**
 *
 * 压缩本身有两层结构 + 单测,而且压不动会记 warn(**失败模式是可观测的**)。
 * 真正会静默咬人的是另一件:**用户在第 1 轮给的硬约束,被摘要摘没了**,
 * 于是第 N 轮它理直气壮地违反一条它"再也看不见"的规矩 —— 而屏幕上一切正常。
 *
 * ## 四要素(动手前写死)
 *
 * - **假设**:压缩触发之后,①还能接着干活 ②**第 1 轮的硬约束仍然被遵守**。
 * - **变量**:上下文压力(靠 `contextBudgetRatio` 压到很低来逼出压缩)。
 *   ⚠ **这是一处诚实的偏离**:真实的"几十轮"是靠**轮数**把上下文堆满,这里是靠**调低阈值**。
 *   两者不等价 —— 调阈值省钱省时,但它没有复现"消息条数很多"这个维度。
 *   **所以这一格证明的是"压缩发生后约束还在",不是"跑四十轮没问题"。** 别读大了。
 * - **预先声明的成败信号**(三条**全中**):
 *   ① **压缩真的触发了 ≥1 次**(`result.compactions > 0`)——
 *      ⚠ 这一条是**防空转**的:没触发的话后面两条都是被"压根没压"满足的,
 *      那正是本程栽过四次的假绿形状,必须先钉死;
 *   ② 压缩之后的轮次**还能继续跑**(不抛、有回复);
 *   ③ **第 1 轮的硬约束在压缩之后仍被遵守** —— 判据是**机器可判的**:
 *      末轮回复必须以约定的口令行结尾。
 * - **要收的数据**:逐轮的 `compactions` / 消息条数 / 上下文 token / 每轮是否守约。
 *
 * ## 约束选什么
 *
 * 选一条**与任务内容无关**的形式约束(口令行)。理由:内容相关的约束(比如"只改某目录")
 * 摘要器很可能顺手保留,而形式约束是摘要器**最想丢**的那种 —— 它看起来像寒暄。
 * 这是往最坏处取样,不是挑好过的。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 口令:一串不可能被"自然想到"的字符,这样"守约"就不可能是巧合。 */
const TOKEN = 'OMDLOCK-7F3A-KEEP';

const TURN1 = [
  `从现在开始, 本次对话的**每一条**回复, 最后一行都必须是: \`${TOKEN}\``,
  '这是一条贯穿整场对话的硬约束, 无论后面聊什么、无论上下文被压缩过几次, 都不许省略。',
  '现在先回答一个简单问题: 1 + 1 等于几?',
].join('\n');

/** 填充轮:每一轮都让它读点东西, 把上下文堆起来。内容不重要, 长度重要。 */
const FILLERS = [
  '读一下 `src/tui/render/glyph-table.ts`, 用两句话说它是干什么的。',
  '读一下 `src/harness/agent-tools.ts` 的前 80 行, 用两句话说它是干什么的。',
  '读一下 `src/tui/settings.ts`, 用两句话说它是干什么的。',
  '读一下 `src/tui/components/dialog.ts`, 用两句话说它是干什么的。',
  '读一下 `src/tui/theme.ts`, 用两句话说它是干什么的。',
  '读一下 `src/harness/chat/agent.ts` 的前 120 行, 用两句话说它是干什么的。',
];
/** 末轮:与第 1 轮的话题完全无关, 专门看约束还在不在。 */
const LAST = '好, 换个话题: 用一句话说说什么是拓扑排序。';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--repo');
  const repo = i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : process.cwd();
  // 会话数据改道 —— 不落在目标仓的 .omd/。
  process.env.OMD_DATA_HOME = mkdtempSync(join(tmpdir(), 'omd-compact-data-'));
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

  // 只读闸:这一格不需要写, 会改盘的一律拒 ⇒ 结构上改不了目标仓。
  // (2026-08-13 由审批闸搬到 `readonly-face` —— 审批层已随 TUI yolo 化删除。)
  const face = readonlyFace(createChatSeatTools({ cwd: repo, mcpTools: assembleOmdMcpTools({ onNodeEvent: () => {} }) })('probe'));
  const tools = face.tools;
  const model = resolveEngineModels(process.env).conductorModel;
  const store = createOmdSessionStore(repo);
  const sessionId = `compact-${Date.now()}`;

  const prompts = [TURN1, ...FILLERS, LAST];
  interface Row {
    n: number;
    compactions: number;
    msgs: number;
    tokens: number | null;
    kept: boolean;
    tail: string;
  }
  const rows: Row[] = [];
  let totalCompactions = 0;
  let crash = '';

  for (const [n, prompt] of prompts.entries()) {
    try {
      const r = await runChatTurn({
        store,
        sessionId,
        prompt,
        model,
        cwd: repo,
        tools,
        // ★ 把阈值压到很低来**逼出压缩**。默认 0.85 要堆很久才到, 这一格买不起那个时间。
        //   ⚠ 这是与"真跑几十轮"的诚实偏离, 已写在文件头。
        contextBudgetRatio: 0.02,
        compactionKeepRecentTokens: 1_000,
      });
      totalCompactions += r.compactions;
      const reply = r.reply.trim();
      rows.push({
        n: n + 1,
        compactions: r.compactions,
        msgs: r.messageCount,
        tokens: r.pressure?.usedTokens ?? null,
        kept: reply.endsWith(TOKEN),
        tail: reply.slice(-70).replace(/\n/g, '⏎'),
      });
    } catch (err) {
      crash = `第 ${n + 1} 轮抛了: ${(err as Error).message}`;
      break;
    }
  }

  const last = rows.at(-1);
  const v = {
    // ① 防空转:压缩必须真的发生过, 否则 ②③ 是被"压根没压"满足的
    compacted: totalCompactions > 0,
    // ② 压缩之后还跑得动:跑满了全部轮次且没抛
    survived: !crash && rows.length === prompts.length,
    // ③ 压缩之后**末轮**仍守约(末轮话题与第 1 轮完全无关)
    keptAfter: last?.kept === true,
  };
  const ok = Object.values(v).every(Boolean);
  const keptCount = rows.filter((r) => r.kept).length;
  const firstCompactAt = rows.find((r) => r.compactions > 0)?.n ?? null;

  console.log(`\n${'═'.repeat(78)}\n长会话压缩 @ ${repo}   (阈值压到 0.02 来逼出压缩)`);
  console.log(`  判据: ${ok ? '✓ 成' : '✗ **不成**'}${crash ? ` —— ${crash}` : ''}`);
  console.log(`    ① 压缩**真的触发过**(防空转)   : ${v.compacted ? `✓ 共 ${totalCompactions} 次, 第 ${firstCompactAt} 轮首次` : '**✗ 一次都没压 —— 这一格什么都没测到**'}`);
  console.log(`    ② 压缩之后还跑得动               : ${v.survived ? `✓ ${rows.length}/${prompts.length} 轮` : `**✗ 只跑到 ${rows.length}/${prompts.length}**`}`);
  console.log(`    ③ **末轮仍守第 1 轮的硬约束**    : ${v.keptAfter ? '✓' : '**✗ 约束被摘没了**'}`);
  console.log(`  守约轮次: ${keptCount}/${rows.length}`);
  console.log(`  逐轮:`);
  console.log(`    轮  压缩  消息  ctx token  守约  回复末尾`);
  for (const r of rows) {
    console.log(`    ${String(r.n).padStart(2)}  ${String(r.compactions).padStart(4)}  ${String(r.msgs).padStart(4)}  ${String(r.tokens ?? '-').padStart(9)}  ${r.kept ? ' ✓  ' : ' **✗**'}  ${r.tail}`);
  }
  console.log(`  只读闸拒 ${face.denied()} 次`);
}

await main();
