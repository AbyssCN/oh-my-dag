/**
 * src/tui/tools/chat-seat —— **对话位的工具面装配**(S-4,2026-08-07)。
 *
 * ## 为什么要抽出来
 *
 * 这段装配原本长在 `cli.ts` 的一个内联异步块里,于是**没有任何闸看得见它**:
 * 想测"对话位到底拿到了哪些工具",要么起整个 CLI,要么去 grep 源码字符串。
 * 交接 37 坑 #7 记过同族的事故(`dag_run` 与 `dag_run_plan` 两处各组一份 config,
 * 只接一处 = 完全没接),而当时的闸正是没盯住装配点。抽成一个函数之后,
 * `chat-seat.test.ts` 直接对着它断言。
 *
 * ## 这一面为什么有"手"
 *
 * `serve/chat-tools.ts` 的白名单收窄写着"chat 位是指挥位不是执行位",于是文件工具
 * 只发给 DAG 叶子 —— 结果是**在 omd tui 里读一个文件都得派一个 DAG**。
 * owner 2026-08-07 把判据抬到「能不能替掉 claude code 在一个仓里干活」之后那条不再成立,
 * 故翻掉(记在 `docs/plan/2026-08-07-omd-tui-daily-driver-goal.md` §4)。
 *
 * ⚠ 派遣没有消失:分野写在 system prompt 的 `<hands>` 段 —— 小活自做,真能分片的才派 DAG。
 */
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdAgentTools } from '../../harness/agent-tools';
import type { OmdMcpTool } from '../../mcp/server';
import { createConductorChatTools } from '../../serve/chat-tools';
import { createCodegraphTools } from './codegraph';

/**
 * ★ **对话位必须有的六只手。**
 *
 * 这个清单是 `chat-seat.test.ts` 的判据来源 —— 少一只,交付闸 G-A/G-B 就不成立
 * (不能写 = 改不了代码;不能跑命令 = 验不了自己改的东西)。
 */
export const HAND_TOOLS: readonly string[] = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];

export interface ChatSeatToolsOpts {
  /** 工作根。手全部 scope 到它。 */
  cwd: string;
  /** omd MCP 装配面 —— 指挥类工具从它里面按白名单挑。 */
  mcpTools: readonly OmdMcpTool[];
  /** 扩展带进来的工具(S15a)。没有扩展就省略。 */
  extTools?: readonly AnyOmdTool[];
}

/**
 * 装配对话位的工具面。**顺序即 system prompt 里的列举顺序**:
 * 手在最前(最常用),然后指挥面,再符号面,最后扩展。
 */
export function createChatSeatTools(o: ChatSeatToolsOpts): AnyOmdTool[] {
  return [
    ...createOmdAgentTools({ cwd: o.cwd }),
    ...createConductorChatTools(o.mcpTools),
    // S17: 符号能力是**探测式**的 —— 探不到就一个工具都不挂(不是挂了、调了才失败)。
    ...createCodegraphTools({ cwd: o.cwd }),
    ...(o.extTools ?? []),
  ];
}
