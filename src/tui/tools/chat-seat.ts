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
 *
 * ## 闸:两层,不是一层(2026-08-13 owner 裁,替掉四档审批)
 *
 * 旧装配把整个工具面包一层四档审批,判据是 `COMMAND_RISK_TIER` —— 而那张表只登记了
 * 25 个 bin,**未登记一律弹框**。实测(owner 截图)一轮 6 条调用全停在等人按键上:
 * `which omd` 被判 `risk tier never`。审批闸因此不是安全措施,是打断器。
 *
 * 现在:
 *   · **围栏**(`hooks/shell-sandbox`)—— bash 每条命令进 bwrap,工作根 + `/tmp` 可写,
 *     其余全只读;`write`/`edit` 越界即拒。挡的是**越界**。
 *   · **黑名单**(`hooks/command-policy`)—— `rm -rf /`、`DROP TABLE`、`git push --force`
 *     一族硬拒。挡的是**工作根之内的不可逆**(围栏盖不住的那一半)。
 *
 * **不变量仍是「闸永远有一层」**,只是那一层不再是人:黑名单 `dangerousCommandGuard`
 * 现在**恒开**(不再因为装了审批就关掉)。`chat-seat.test.ts` 钉这条。
 */
import type { AnyOmdTool } from '../../harness/agent-tools';
import { createOmdAgentTools } from '../../harness/agent-tools';
import { loadSandboxConfig } from '../../harness/hooks/command-policy';
import { createInspectTool } from '../../harness/inspect-tool';
import { createMcpClientTools } from '../../mcp/client/meta-tools';
import { createHistoryTools } from '../../mcp/tools/history';
import { createOmdSessionStore } from '../../harness/chat/session-store';
import type { OmdMcpTool } from '../../mcp/server';
import { createConductorChatTools } from '../../serve/chat-tools';
import { type AskUserResolver, createAskUserTool } from './ask-user';
import { createCodegraphTools } from './codegraph';
import { createSkillTools } from './skill-tool';

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
  /**
   * 围栏 + 黑白名单(2026-08-13)。**测试接缝** —— 省略 = 现读 `.omd/config.json`
   * 的 `tui.sandbox` 段(生产路径)。传进来是为了让"装了什么闸"可直测,
   * 而不是靠在测试里现造一个 config 文件。
   */
  sandbox?: import('../../harness/hooks/command-policy').SandboxConfig;
  /**
   * `ask_user` 的 UI 取法(**惰性** —— 工具面装在 TUI 之前, 见 `ask-user.ts` 的说明)。
   * **省略 = 这条装配路径没有 `ask_user` 这个能力**(工具列表里根本没这个名字)——
   * `omd serve` / `mcp` 那两条路没有对话框, 挂上去只会是个必然问不出来的工具。
   */
  askUser?: AskUserResolver;
  /**
   * 会话持久层(D-8,2026-08-18)。`history_read` / `history_search` 是**按会话绑定**的,
   * 而对话位支持多会话并发 —— 所以它们不能在装配期建、也不能靠一个「当前会话」取值器
   * (并发下会串台)。本工厂返回的函数按每轮的 sessionId 现建这两件。
   *
   * 省略 = 按 `cwd` 现建一个。**安全**:单写者表 `SESSIONS` 是模块级的
   * (`session-store.ts:180`),同一份会话文件在一个进程里只会有一个 `Session` 实例,
   * 拿到几个 store 对象都不改变这一点。生产路径仍显式传同一个实例(读起来不必推)。
   */
  store?: import('../../harness/chat/session-store').OmdSessionStore;
}

/**
 * 装配对话位的工具面。**顺序即 system prompt 里的列举顺序**:
 * 手在最前(最常用),然后指挥面,再符号面,最后扩展。
 *
 * ## 为什么返回**工厂**而不是数组(D-8,2026-08-18)
 *
 * `history_read` / `history_search` 绑到具体会话,而工具面在 TUI 起来之前就装好了
 * (`cli.ts` 那一处,同 `ask_user` 惰性取 UI 的理由)。**多会话并发**下,「当前会话」
 * 这种取值器会串台,所以走与 MCP 位(`mcp/tools/chat.ts`)同一条解法:
 * **持资源的静态部分建一次,只有指挥面每轮按 sessionId 重建。**
 *
 * 静态部分包含 `createOmdAgentTools`(持 `NodeExecutionEnv`)、codegraph 探测、skill 读盘 ——
 * 每轮重建它们会给每次对话加 I/O,那正是这里要避开的。
 */
export function createChatSeatTools(o: ChatSeatToolsOpts): (sessionId: string) => AnyOmdTool[] {
  // 2026-08-13 owner 裁: 默认 yolo —— 不弹审批框, 安全靠 **围栏 + 黑名单** 两层。
  // 配置逐仓读 (`tui.sandbox`); `enabled:false` 只关围栏, 黑名单永远在。
  const sandboxCfg = o.sandbox ?? loadSandboxConfig(o.cwd);
  const store = o.store ?? createOmdSessionStore(o.cwd);
  // ── 一次性:持资源 / 要探测 / 要读盘的那些 ──
  const hands = createOmdAgentTools({
    cwd: o.cwd,
    commandPolicy: sandboxCfg,
    ...(sandboxCfg.enabled ? { sandbox: { root: o.cwd, writable: sandboxCfg.writable } } : {}),
  });
  const tail = [
    // S17: 符号能力是**探测式**的 —— 探不到就一个工具都不挂(不是挂了、调了才失败)。
    ...createCodegraphTools({ cwd: o.cwd }),
    // S-6: 让模型自己取 skill 正文。一条 skill 都没有时不挂(同上:恒失败的工具比没有更糟)。
    ...createSkillTools({ cwd: o.cwd }),
    // 开放生态 S1: 外部 MCP 经双 meta-tool (find/call) 接入 —— 零注册不挂 (I-2),
    // 外部工具数不进冻结前缀 (schema 全走返回值, SDD D-2)。
    ...createMcpClientTools({ cwd: o.cwd }),
    // A2: 能力目录 (座位/原语/agent 卡/playbook/skills/外部 MCP)。恒定单工具, 动态清单
    // 全走返回值 —— 冻结前缀零字节 (inspect-tool.test.ts 钉)。恒挂载: 空仓也有座位/原语可报。
    ...createInspectTool({ cwd: o.cwd }),
    // ★ `ask_user`(2026-08-08):让它能反问一句。**没有 host 就不挂** ——
    //   能力探测面靠"工具在不在", 挂一个必然问不出来的工具比没有更糟(同 codegraph 那条)。
    ...(o.askUser ? createAskUserTool(o.askUser) : []),
    ...(o.extTools ?? []),
  ];
  // ── 每轮:指挥面 + 本轮会话的两件回捞工具 ──
  return (sessionId: string): AnyOmdTool[] => [
    ...hands,
    ...createConductorChatTools([...o.mcpTools, ...createHistoryTools({ store, sessionId })]),
    ...tail,
  ];
}
