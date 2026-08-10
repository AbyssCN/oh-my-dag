/**
 * src/mcp/server —— omd MCP server 纯组装 (SDD 2026-07-19 omd-mcp-server, D-1/D-9)。
 * Server + StdioServerTransport + 工具注册; 唯一例外是 **S1 陈旧自检** (SDD 2026-08-10 §2 S1):
 * 文件面裁决把 bootSha 捕获 + wrapStaleCheck 钉在本文件, 故 git 比对逻辑住这里 (见下方 S1 段),
 * 工具处理器仍在 src/mcp/tools/*.ts (纯函数 + 注入接缝), 其余保持零逻辑。
 * stdout 是 MCP 协议通道 —— 本模块不写 stdout; 入口 (tui.ts `omd mcp`) 负责静默 logger。
 */
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { logger } from '../logger';

/** 注册面工具定义。D-11: description 一行 ≤120 字符 (说明书住 SKILL/CLAUDE.md, 客户端每轮付 description 税)。 */
export interface OmdMcpTool {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  handler: ToolCallback<ZodRawShapeCompat>;
}
// ===========================================================================
// S1 陈旧自检 (SDD 2026-08-10 §2 S1 / T3): server 代码落后于盘上时, 每次工具调用
// 在输出**头部**注入一行警告 —— 不许静默 (§0 的教训: 修了但没修, 且无任何灯)。
//
// 判据与 HUD 新鲜度闸 (docs/architecture/omd-hud.md) **同源, 不发明第二套**: HUD 按 updatedAt 龄
// 30s 分 live/stalled, 这里以同一 30s 档做重查节流 (窗口内复用上次比对; git spawn 每次
// ~5ms, 但时间常数取既有档, 不另立)。分级:
//   clean  HEAD == bootSha 且工作区干净              → 不注入
//   dirty  HEAD == bootSha 但工作区脏 (porcelain 非空) → 降级档 (裁决): 只 debug 不注入
//          (脏工作区是日常开发常态, 每调用注入=噪音; §0 病根是「commit 了没重启」, 那才响)
//   stale  HEAD != bootSha                          → 注入 SDD §2 原文警告行
// 读不到 git (非仓环境) → bootSha=null, fail-open 不注入不报错, 构造时打一条 debug, 永不再查。
//
// **反向自检 (SDD §2 S1 闸, 证伪方式)**: 把下方 `nowSha !== this.bootSha` 改成恒 true →
// src/mcp/server.test.ts 的「同 sha 必无」测试当场红; 改成恒 false → 「假 sha 必现」当场红。
// ===========================================================================

/** S1 git 读数接缝 —— 测试注入假 sha/假脏/假时钟, 生产用真实 git (Bun.spawnSync, 见 runGit)。 */
export interface StaleGitDeps {
  /** 当前 HEAD 全 sha; 读不到 → null (fail-open)。 */
  headSha?: () => string | null;
  /** 工作区是否有未提交改动 (git status --porcelain 非空)。 */
  worktreeDirty?: () => boolean;
  /** bootSha 之后领先的提交数; 数不出 (历史重写等) → null, 警告行省略 (+N commits)。 */
  commitsAhead?: (bootSha: string) => number | null;
  /** 时钟 (ms)。 */
  now?: () => number;
  /** 重查节流 ms —— 同源 HUD 新鲜度闸的 30s 档。 */
  throttleMs?: number;
}

/** S1 分级: clean / dirty (工作区脏, 降级) / stale (HEAD 漂移)。 */
export type StaleStatus = 'clean' | 'dirty' | 'stale';

/** 一次比对的结果 (节流窗口内复用)。 */
export interface StaleState {
  status: StaleStatus;
  bootSha: string | null;
  nowSha: string | null;
  /** bootSha..HEAD 提交数; 数不出 → null。 */
  ahead: number | null;
  checkedAt: number;
}

/** 跑一条 git 命令; 非零退出/抛错 → {ok:false} (fail-open 语义, 不 throw)。 */
function runGit(args: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) return { ok: false, out: '' };
    return { ok: true, out: r.stdout.toString().trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

const realHeadSha = (): string | null => {
  const r = runGit(['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
};

const realWorktreeDirty = (): boolean => {
  const r = runGit(['status', '--porcelain']);
  return r.ok && r.out.length > 0;
};

const realCommitsAhead = (bootSha: string): number | null => {
  const r = runGit(['rev-list', '--count', `${bootSha}..HEAD`]);
  if (!r.ok) return null;
  const n = Number.parseInt(r.out, 10);
  return Number.isNaN(n) ? null : n;
};

export class StaleChecker {
  readonly bootSha: string | null;
  readonly bootedAt: number;
  private readonly deps: Required<StaleGitDeps>;
  private state: StaleState | null = null;

  constructor(deps: StaleGitDeps = {}) {
    this.deps = {
      headSha: realHeadSha,
      worktreeDirty: realWorktreeDirty,
      commitsAhead: realCommitsAhead,
      now: Date.now,
      throttleMs: 30_000, // 同源 HUD 30s 档, 不是新常数
      ...deps,
    };
    this.bootedAt = this.deps.now();
    this.bootSha = this.deps.headSha();
    if (this.bootSha === null) {
      // SDD §2 S1: 非仓环境 fail-open —— 不注入不报错, 只留一条 debug 留痕。
      logger.debug('[omd/stale] git HEAD 读不到 (非仓环境?) — 陈旧自检 fail-open, 不注入不报错');
    }
  }

  /** 节流比对: 30s 窗口内复用上次结果; bootSha=null (非仓) 永不再查。 */
  check(): StaleState {
    const now = this.deps.now();
    if (this.bootSha === null) {
      return { status: 'clean', bootSha: null, nowSha: null, ahead: null, checkedAt: now };
    }
    if (this.state !== null && now - this.state.checkedAt < this.deps.throttleMs) return this.state;
    this.state = this.checkLocked();
    return this.state;
  }

  private checkLocked(): StaleState {
    const now = this.deps.now();
    const nowSha = this.deps.headSha();
    if (nowSha === null) {
      // 运行中 git 读不到 (仓没了?) → fail-open 视为新鲜, 不注入 (无证据不指控)。
      logger.debug('[omd/stale] 当前 HEAD 读不到 — fail-open 视为新鲜, 不注入');
      return { status: 'clean', bootSha: this.bootSha!, nowSha: null, ahead: null, checkedAt: now };
    }
    // ← 反向自检锚点: 把 `!==` 改成恒 true/false, server.test.ts 的两条警告测试当场红。
    if (nowSha !== this.bootSha) {
      return {
        status: 'stale',
        bootSha: this.bootSha!,
        nowSha,
        ahead: this.deps.commitsAhead(this.bootSha!),
        checkedAt: now,
      };
    }
    if (this.deps.worktreeDirty()) {
      return { status: 'dirty', bootSha: this.bootSha!, nowSha, ahead: 0, checkedAt: now };
    }
    return { status: 'clean', bootSha: this.bootSha!, nowSha, ahead: 0, checkedAt: now };
  }

  /** 要注入工具输出头部的那一行; 无警告 → null。 */
  staleLine(): string | null {
    const s = this.check();
    if (s.status === 'stale') {
      const ahead = s.ahead === null ? '' : ` (+${s.ahead} commits)`;
      // SDD §2 S1 原文行 (英文, 契约文本, 不译)。
      return `⚠ omd server code is stale: started at ${s.bootSha!.slice(0, 7)}, disk is now ${s.nowSha!.slice(0, 7)}${ahead}. Long-lived runs use in-memory code; reconnect to refresh the shell.`;
    }
    if (s.status === 'dirty') {
      // 降级档 (裁决): 工作区脏但 HEAD 未动 → 只 debug 不注入。反向自检: 此档若改回注入,
      // server.test.ts 的「脏 → 不注入」测试当场红。
      logger.debug(`[omd/stale] 工作区脏但 HEAD 未动 (boot ${s.bootSha!.slice(0, 7)}) — 降级档, 不注入`);
    }
    return null;
  }
}

/** 工具调用包装: 调用前取一次节流后的陈旧行, 有则注入结果**头部** (第一个 content 块)。 */
export function wrapToolStale(tool: OmdMcpTool, stale: StaleChecker): OmdMcpTool {
  return {
    ...tool,
    handler: async (args, extra) => {
      const line = stale.staleLine();
      const result = await tool.handler(args, extra);
      if (!line) return result;
      return { ...result, content: [{ type: 'text' as const, text: `${line}\n` }, ...result.content] };
    },
  };
}

/** 组装 server + 注册工具面。info 由调用方给 (测试传固定值, 入口传包版本)。
 * 每个工具 handler 包一层 S1 陈旧自检 (wrapToolStale): 默认真 git 读数, 测试可注入假 StaleChecker。 */
export function createOmdMcpServer(
  tools: readonly OmdMcpTool[],
  info: Implementation,
  opts: { stale?: StaleChecker } = {},
): McpServer {
  const stale = opts.stale ?? new StaleChecker();
  const server = new McpServer(info);
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      wrapToolStale(t, stale).handler,
    );
  }
  // SDK 只在首次 registerTool 时才装 tools/list|tools/call 处理器 —— 空注册面 (骨架期) 下
  // tools/list 会吃 -32601。此处无条件初始化 (已装则 SDK 内部 early-return), 空面回 {tools: []}。
  (server as unknown as { setToolRequestHandlers(): void }).setToolRequestHandlers();
  return server;
}


/**
 * **客户端能力探针** (2026-07-31, MCP 2026-07-28 无状态化之后加的)。
 *
 * 要回答的那一位: **对齐 MCP 的 `Tasks` 扩展值不值**。SDK 1.29 已经带了服务端那半
 * (`server.experimental.tasks` / `taskSupport:'optional'` / `tasks/get|list|result|status|cancel`),
 * 而 `taskSupport:'optional'` 的语义是"客户端支持就走 task, 不支持就退回普通调用" —— **零回归**。
 * 但它有没有意义**完全取决于客户端声不声明这个能力**: 客户端不认, 我们实装的就是一个没有消费者
 * 的字段, 而且比空旋钮更坏 —— 它会分叉出两套 run 语义 (我们的 runId 三段式 + tasks),
 * 正是 `iterateExecutorDag` 那笔到今天还在还的债。
 *
 * 所以先探再改。这里只**如实打印一行**到 stderr (stdout 是协议通道), 不改任何行为。
 * ⚠ 读到 `undefined` **不等于**"客户端没能力": 2026-07-28 起协议无握手, 能力改成随每个请求走
 * `_meta` —— 那时这条探针本身就该换个问法。两种"看不见"要分得开, 故文案里写明。
 */
function logClientCapabilities(server: McpServer): void {
  try {
    const caps = server.server.getClientCapabilities();
    if (!caps) {
      process.stderr.write(
        '[omd/mcp] 客户端能力: 未声明 (旧握手下 = 客户端没给; 2026-07-28 无状态协议下 = 本探针问法已过时)\n',
      );
      return;
    }
    const keys = Object.keys(caps);
    const hasTasks = 'tasks' in caps || 'experimental' in caps;
    process.stderr.write(`[omd/mcp] 客户端能力: ${keys.join(', ') || '(空)'} · tasks=${hasTasks ? '有' : '无'}\n`);
  } catch {
    /* 探针永不阻断 server —— 它只是一行读数 */
  }
}

/** stdio 入口 (D-1): 防御式读包版本 (同 tui banner 范式, 失败不阻断) + 挂 stdio 传输。常驻, 生命周期客户端管 (D-9)。
 * 退出双保险 (审核实测: 客户端消失后僵尸 100% CPU 忙转): SDK StdioServerTransport 只挂 stdin data/error,
 * 不听 end/close —— stdin EOF 时 onclose 永不触发, Bun flowing-mode stdin 对已关 fd 空轮询 → 忙转。
 * 此处事件驱动零轮询: stdin 'end'/'close' 或 transport onclose (SDK 正常关闭路径) 任一触发即干净收尾。 */
export async function runOmdMcpServer(tools: readonly OmdMcpTool[]): Promise<void> {
  let version = '0.0.0';
  try {
    const pkg = (await import('../../package.json')) as unknown as {
      version?: string;
      default?: { version?: string };
    };
    version = pkg.version ?? pkg.default?.version ?? version;
  } catch { /* 版本读不到 → 兜底版本号, server 照起 */ }
  const server = createOmdMcpServer(tools, { name: 'omd', version });
  await server.connect(new StdioServerTransport());
  logClientCapabilities(server);
  // connect 在 transport start 后即 resolve —— 挂住直到客户端断开, 否则调用方继续执行 = server 被秒杀。
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('close', finish);
      resolve();
    };
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    server.server.onclose = finish;
    // EOF 竞态: connect 期间 stdin 已结束 → end/close 已发过, 直接收尾不等下一拍。
    if (process.stdin.readableEnded || process.stdin.destroyed) finish();
  });
  // 收尾断忙转源头: transport.close 摘 stdin data 监听 + pause; destroy 兜底已 EOF 的 fd。
  // server.close 会回触发 onclose → finish (已 settled, 幂等 no-op)。
  await server.close().catch(() => {});
  try { process.stdin.destroy(); } catch { /* 已销毁 */ }
}
