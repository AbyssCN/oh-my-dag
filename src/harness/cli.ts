#!/usr/bin/env bun
/**
 * omd CLI 入口 —— 两个子命令, 零 UI。
 *
 *   omd mcp     # stdio MCP server (**主入口**: Claude Code 等 MCP 客户端 spawn 它)
 *   omd init    # 首次配置向导 (纯 readline, 写 .env)
 *
 * ## 为什么这个文件只剩 60 行 (2026-08-01, 交接文 13)
 *
 * 此前它是**交互式 TUI 前端**: 包 `pi-coding-agent` 的 `main()`, 挂 21 个 `*-extension.ts`
 * (banner/theme/hashline/memory/mcp-router/code/cost/verify-gate/…)。owner 裁决 **omd 收成纯 MCP** ——
 * 对话前端归 Claude Code, omd 只当执行引擎。于是 TUI 外壳与它独占的能力件一起出局,
 * 只留 `pi-agent-core` (agent leaf 的 runAgentLoop) + `pi-ai` (provider 注册)。
 *
 * ⚠ `init` 分支不能删: 没有它, 用户配置 omd 的唯一办法是手改 JSON/.env。
 *   `init/` 是纯 readline 向导, **不依赖 pi-coding-agent** (已核)。
 *
 * ## 名字 (2026-08-02 从 `tui.ts` 改过来)
 *
 * 砍完 TUI 的那一轮我把文件名留作 `tui.ts`, 理由写的是「`bin` 指着它, 改名等于改发布契约」——
 * **那条理由是错的**: 发布契约是 `bin` 的**键**(`omd` / `oh-my-dag`, 用户敲的就是这个),
 * 值只是仓内路径, 换个路径对已安装的用户完全不可见。于是这里没有契约问题, 只有一个
 * 叫 `tui.ts` 却删光了 TUI 的文件 —— 本轮改名 `cli.ts`, 同目录, 相对 import 一个没动。
 */
import '../env-alias';
import { setCoreLogger } from './logger';
import { logger, setLoggerDestination } from '../logger';

// 核心引擎 logger 接缝: 把宿主 pino 注入 pi-agent-core 的 console-shell (INV-X3, 结构化日志)。
setCoreLogger(logger);

const userArgs = process.argv.slice(2);

const USAGE = `omd —— DAG 执行引擎 (纯 MCP + web 控制台)

  omd tui     交互式 conductor 前端 (自建 TUI)
  omd mcp     stdio MCP server (给 Claude Code 等 MCP 客户端 spawn)
  omd serve   web 控制台 daemon —— 引擎 API + conductor 对话 (127.0.0.1:4517; --port N 改端口)
  omd init    首次配置向导 (写 .env)

终端对话前端: 原 pi TUI 2026-08-01 撤除, 2026-08-07 以自建 TUI 回归。

裸 omd 打印本用法, 不直接进 TUI。
`;

// omd mcp: stdio MCP server 入口 (D-1) —— 零 UI, 不进 wizard。
// stdout 是 MCP 协议通道: pino 默认写 stdout 会腐蚀协议帧 → 日志改道 stderr (warn 级, 引擎尸检可见)。
// 常驻, 客户端管 spawn/kill (D-9)。工具面 = assembleOmdMcpTools 全装配。
if (userArgs[0] === 'mcp') {
  setLoggerDestination(2);
  logger.level = 'warn';
  // mcp 入口不走任何 boot → provider 注册需自带引导 (同 dag-* 短命进程), 否则引擎 leaf 因
  // 注册表空而全部静默秒败 (settle(null) 空 output, 客户端只见"节点未完成")。stderr 打点协议安全。
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime();
  // 客户端技能自装 (best-effort, 从不抛): 装了 omd MCP 的用户新会话即得 /omd-* 斜杠命令, 免手 cp。
  // 幂等 + 不覆盖用户改过的; opt-out OMD_INSTALL_SKILLS=0。stderr 记一行 (stdout 是协议通道, 不可污)。
  // ⚠ 装的是 `client-skills/` (Claude Code 侧那套), **不是**已删的 TUI `skills/`。
  try {
    const { installClientSkills, formatInstallSummary } = await import('./client-skills-install');
    const line = formatInstallSummary(installClientSkills());
    if (line) logger.warn(line);
  } catch { /* 自装是锦上添花, 失败绝不阻断 MCP server */ }
  const { runOmdMcpServer } = await import('../mcp/server');
  const { assembleOmdMcpTools } = await import('../mcp/assemble');
  await runOmdMcpServer(assembleOmdMcpTools());
  process.exit(0);
}

// omd tui: 自建交互前端 (TUI SDD 切片 S2 —— 目前只有 UI 壳, 引擎后端 S10 才接)。
// ⚠ 动态 import: TUI 那一坨 (pi-tui + 组件树) 不进 mcp/serve 两条常驻路径的内存。
if (userArgs[0] === 'tui') {
  const cwd = process.cwd();
  // S3 日志改道 —— **必须在 runOmdTui 之前**。TUI 独占终端, stdout 与 stderr 都会花屏,
  // 所以这里不是 mcp 那样的 setLoggerDestination(2), 而是整程改到文件 (src/tui/logging.ts)。
  const { redirectTuiLogs } = await import('../tui/logging');
  const tuiLog = redirectTuiLogs({ cwd });
  logger.info({ file: tuiLog.path }, '[omd/tui] 日志改道生效, 本程日志不进终端');
  try {
    const { runOmdTui } = await import('../tui/tui');
    const { loadConductorContext } = await import('../tui/context');
    // 上下文只装配一次, 同一个数组既进屏幕又进 system prompt —— 两处各读一份必漂 (S4)。
    const contextFiles = loadConductorContext(cwd);

    // L3 接缝 (SDD §9): PTY lane 要证明 UI 循环通, 但**不能**因此去打真模型。
    // 只有显式设了这个环境变量才装 fixture; 它自报家门 (footer 上写着 fixture://l3-test)。
    let backend: import('../tui/backend').OmdBackend;
    // 扩展加载结果要传给 UI(设置面板), 所以声明在 if/else 之外。
    let extStatus: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[] = [];
    // 切片①: 审批闸。两条装配路都建 —— fixture 那条也要能在 PTY 里弹真的审批单
    // (卡片 UI + 键位 + 拒绝则不改/批准则改, 全走与生产同一个 gate)。
    const { createApprovalGate } = await import('../tui/approval/gate');
    const { loadApprovalConfig } = await import('../tui/approval/policy');
    const approvals = createApprovalGate({ config: loadApprovalConfig(cwd) });
    // 切片②: 调用账本。engine 侧 (gateway callModel) 走观察者钩子; chat 侧由 backend 补记 ——
    // 两条路径不相交 (pi loop vs gateway), 不会重复计账。
    const { createTuiUsageLedger } = await import('../tui/usage/ledger');
    const { observeModelUsage } = await import('../model/accounting');
    const { join: joinPath } = await import('node:path');
    // OMD_TUI_USAGE_DIR: 测试接缝 —— PTY lane 的 fixture 记账不许污染真仓的 5h 窗口。
    const usage = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || joinPath(cwd, '.omd') });
    observeModelUsage((u, model) => usage.record(u, model, 'engine'));
    /**
     * `ask_user` 要的 UI(对话框宿主 / 主题 / 记录口)—— **延迟指针**。
     *
     * 声明在**分支之外**:填它的 `runOmdTui` 在分支外调用, 而用它的工具面装在
     * 非 fixture 分支里。⚠ fixture 分支不装对话位工具面, 所以那条路上它恒为 null ——
     * 那是对的:那条 lane 本来就没有 `ask_user`。
     */
    let askUserUi: import('../tui/tools/ask-user').AskUserUi | null = null;
    if (process.env.OMD_TUI_BACKEND === 'fixture') {
      const { createFixtureBackend } = await import('../tui/backend-fixture');
      backend = createFixtureBackend({ approvals, usage });
    } else {
      // 与 `omd serve` 同一条路: 同一个 runChatTurn、同一批 chatTools、同一条座位解析。
      const { bootstrapModelRuntime } = await import('../model/bootstrap');
      bootstrapModelRuntime(); // 不引导则注册表空, 一句话都发不出去
      const { assembleOmdMcpTools, resolveEngineModels } = await import('../mcp/assemble');
      const { createChatSeatTools } = await import('../tui/tools/chat-seat');
      // S15a 扩展宿主: 每个扩展一个子进程 (bwrap 在就沙箱)。**加载期硬失败** ——
      // 碰了没实现的 API 就拒绝并逐条列出, 不半残地跑起来。
      const { loadExtension, readExtensionList } = await import('../tui/ext/host');
      const { extTools, exts, extStatus: st } = await (async () => {
        const loaded: import('../tui/ext/host').LoadedExtension[] = [];
        const toolList: import('./agent-tools').AnyOmdTool[] = [];
        // 加载结果**也要给 UI** —— 被拒的缺什么, 藏在日志里等于加载期硬失败白做了。
        const status: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[] = [];
        for (const spec of readExtensionList(cwd)) {
          const r = await loadExtension(spec.name, spec.entry, { cwd });
          if (!r.ok) {
            logger.warn(
              { ext: spec.name, missing: r.rejected.missing, reason: r.rejected.reason },
              '[omd/ext] 扩展**拒绝加载**(缺的 API 已逐条列出, 不半残地跑)',
            );
            status.push({ name: spec.name, ok: false, missing: r.rejected.missing });
            continue;
          }
          status.push({ name: spec.name, ok: true, sandboxed: r.ext.sandboxed });
          loaded.push(r.ext);
          for (const t of r.ext.tools) {
            toolList.push({
              name: t.name,
              label: t.name,
              description: t.description,
              promptSnippet: t.promptSnippet ?? t.description,
              parameters: t.parameters,
              executionMode: 'sequential',
              async execute(_id: string, params: unknown) {
                return { content: [{ type: 'text', text: await (r.ext as import('../tui/ext/host').LoadedExtension).callTool(t.name, params) }], details: undefined };
              },
            } as import('./agent-tools').AnyOmdTool);
          }
          logger.info({ ext: spec.name, tools: r.ext.tools.length, sandboxed: r.ext.sandboxed }, '[omd/ext] 扩展已加载');
        }
        return { extTools: toolList, exts: loaded, extStatus: status };
      })();
      const { createOmdSessionStore } = await import('./chat/session-store');
      const { createEmbeddedBackend } = await import('../tui/backend-embedded');
      // ⚠ 先有工具面才有 backend (工具要交给 runChatTurn), 而节点事件要灌回 backend ——
      // 所以这里用一个**延迟指针**接环, 不是循环依赖。装配完成前引擎不可能发事件。
      let sink: { pushDagEvent(runId: string, e: unknown): void } | null = null;
      const tools = assembleOmdMcpTools({ onNodeEvent: (runId, e) => sink?.pushDagEvent(runId, e) });
      // S16: 自记忆与装配层共用同一个库 (D-5 共库) —— 两处各开一个会得到两份互不可见的记忆。
      const { createOmdMemory } = await import('./memory/store');
      const embedded = createEmbeddedBackend({
        cwd,
        store: createOmdSessionStore(cwd),
        memory: createOmdMemory(),
        // S-4: 对话位的工具面(含六只手)。装配在 `tui/tools/chat-seat`, 那里有闸盯着 ——
        // 长在这个内联块里的话, "对话位到底拿到了哪些工具"没有任何测试看得见(坑 #7 同族)。
        // 切片①: 审批闸包住整个工具面; 六只手的内层危险命令闸随之交给 admin 档 (闸永远有一层)。
        // ★ `ask_user`(2026-08-08):UI 走**惰性取** —— 工具面装在 TUI 之前, 那时 dialogs
        //   还不存在(同上面那个"延迟指针接环"的理由)。`runOmdTui` 起来后把它填上。
        tools: createChatSeatTools({ cwd, mcpTools: tools, extTools, approvals, askUser: () => askUserUi }),
        ...(exts.length > 0
          ? {
              // 多个扩展**串起来**追加:每个都只能在前一个的结果上追加, 顺序 = 清单顺序。
              systemPromptHook: async (p0: string) => {
                let out = p0;
                for (const e of exts) out = await e.beforeAgentStart(out);
                return out;
              },
            }
          : {}),
        // S14: UI 自己直调 dag_runs / dag_resume (不经模型)。给了才有那两个能力。
        mcpTools: tools,
        // 座位每轮现解 (INV-MODEL-3): omd_set_role / `/seat` 改完, 下一句就换座。
        resolveModel: () => resolveEngineModels(process.env).conductorModel,
        contextFiles,
        // 切片②: chat 轮补记进调用账本 (engine 侧走 observeModelUsage, 两路不相交)。
        usage,
      });
      extStatus = st;
      sink = embedded;
      backend = embedded;
    }
    await runOmdTui({
      backend,
      cwd,
      contextFiles,
      approvals,
      usage,
      // 延迟指针的另一端:UI 就绪即填, `ask_user` 从此问得出来。
      onUi: (ui) => {
        askUserUi = ui;
      },
      ...(extStatus.length > 0 ? { extensions: extStatus } : {}),
    });
  } catch (err) {
    // S-4b: 起不来的时候说人话。**实测撞出来的** —— 空仓里跑 `omd tui`, 第一屏是
    // `role-models.ts:433` 的行号和 `^` 指针(座位是逐仓配的, 所以除了 omd 自己这个仓,
    // 任何仓第一次跑都会撞上)。抛得对, 但那不是给人看的第一屏。原话原样带着, 只加一层翻译。
    const { formatBootFailure } = await import('../tui/boot');
    process.stderr.write(formatBootFailure(err, cwd));
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] 启动失败');
    process.exitCode = 1;
  } finally {
    tuiLog.close();
  }
  // ⚠ 不能写死 0:上面的 catch 刚把 exitCode 设成 1, 写死会把它盖掉 ——
  //   症状是"报了错但退出码是成功", 脚本里就再也判不出起没起来。
  process.exit(process.exitCode ?? 0);
}

// omd serve: web 控制台 daemon —— 与 mcp 同一装配面 (一个控制面, 两个传输), 外加读侧磁盘契约 + chat。
// 长驻进程, 不挂 stdio 自杀双保险 (那是 MCP 进程的设计; serve 由用户 Ctrl-C / kill 管生命周期)。
if (userArgs[0] === 'serve') {
  setLoggerDestination(2);
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime(); // 同 mcp 入口: 不引导则 leaf 因注册表空而静默秒败
  const { assembleOmdMcpTools, resolveEngineModels } = await import('../mcp/assemble');
  const { createConductorChatTools } = await import('../serve/chat-tools');
  const { startDaemon } = await import('../serve/daemon');
  const { createOmdSessionStore } = await import('./chat/session-store');
  const { createPlanLedger } = await import('./plan-ledger');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = process.cwd();
  const tools = assembleOmdMcpTools();
  const portFlag = userArgs.indexOf('--port');
  const staticDir = join(cwd, 'web', 'dist');
  startDaemon(
    {
      cwd,
      tools,
      chatStore: createOmdSessionStore(cwd),
      ledger: createPlanLedger({ path: join(cwd, '.omd', 'plan-ledger.db') }),
      // conductor 座每请求现解 (INV-MODEL-3): omd_set_role 改完, 下一句 chat 就换座。
      resolveChatModel: () => resolveEngineModels(process.env).conductorModel,
      chatTools: createConductorChatTools(tools),
      ...(existsSync(staticDir) ? { staticDir } : {}),
    },
    { ...(portFlag >= 0 && userArgs[portFlag + 1] ? { port: Number(userArgs[portFlag + 1]) } : {}) },
  );
  // Bun.serve 常驻 —— 不 process.exit; SIGINT 默认行为即优雅退。
} else if (userArgs[0] === 'init') {
  await runInit();
} else {
  // 其余一律打用法 (含裸 `omd`): 没有交互模式可落了。(mcp 分支在上方早退, 到不了这里)
  process.stderr.write(USAGE);
  process.exit(userArgs.length === 0 ? 0 : 1);
}

// omd init: 首次配置向导。wizard 写 .env, 配完即退出 (用户再正常起 MCP server)。
async function runInit(): Promise<void> {
  // headless/CI (无 TTY) 进不了交互 wizard (readline 会 hang) → fail-fast 提示, 别挂死。
  if (!process.stdin.isTTY) {
    logger.error('[omd/init] 非交互终端 — 请在终端跑 `omd init`, 或直接照 .env.example 填 .env');
    process.exit(1);
  }
  const { runInitWizard, createReadlineIO } = await import('./init');
  const ok = await runInitWizard({ io: createReadlineIO() });
  process.exit(ok ? 0 : 1);
}
