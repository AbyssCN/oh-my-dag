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
  omd touch <path> --op read|write [--hash <h>] --session <id>   碰撞台账写面 (SDD S3 只记不拦; 锚 cwd 的 git toplevel/.omd/touch.db)
  omd touches [--pairs|--findings]   碰撞台账查询面 (pairs 与 findings 分开读)
  omd config dump   打印本仓生效配置全叠加结果 (座位/渠道/池/MCP/ext, 每值标来源层 + 结构化 issues)
  omd pack add <本地目录|git URL> | remove <name> | list   数据插件包 (agents/playbooks/skills; 装包过质量闸, 账在 .omd/packs.json)

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
  // S1 判据 1 (SDD 2026-08-09 远程指挥接缝): MCP 路的调用也要进账本。emitModelUsage 是观察者
  // 钩子, 无订阅者 = 逐条通知进真空 —— 此前只有 tui 分支订阅, mcp 分支零订阅, 于是这条生产
  // 路径上「账本有本轮 usage」结构性不可能 (「机制在、生产零生效」形态, seat-wiring 同族)。
  // 账本复用 tui 那份 (.omd/tui-usage.jsonl): 一个仓一本账, 两本账才分不清。source 由 emit 侧
  // 第三参带 (2026-08-09): 对话轮 emit 'chat', gateway callModel emit 'engine' —— 订阅侧照抄,
  // 不再自己编一个恒定标签 (那样两类调用在账上分不开)。
  const { createTuiUsageLedger } = await import('../tui/usage/ledger');
  const { observeModelUsage } = await import('../model/accounting');
  const { join: joinPath } = await import('node:path');
  const mcpUsage = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || joinPath(process.cwd(), '.omd') });
  observeModelUsage((u, model, origin) => mcpUsage.record(u, model, origin));
  const { runOmdMcpServer } = await import('../mcp/server');
  const { assembleOmdMcpTools } = await import('../mcp/assemble');
  const { loadExtTools } = await import('./ext-tools');
  await runOmdMcpServer(assembleOmdMcpTools({ extTools: await loadExtTools(process.cwd()) }));
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

    // L3 接缝 (SDD §9): PTY lane 要证明 UI 循环通, 但**不能**因此去打真模型。
    // 只有显式设了这个环境变量才装 fixture; 它自报家门 (footer 上写着 fixture://l3-test)。
    let backend: import('../tui/backend').OmdBackend;
    // 扩展加载结果要传给 UI(设置面板), 所以声明在 if/else 之外。
    let extStatus: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[] = [];
    // D3 `/reload`: 重载入口同样跨 if/else —— fixture 那条 lane 没有扩展宿主, 于是**不给**
    // 这个键(TUI 那边就画「这条 backend 没有这个能力」, 不画一个点了没反应的命令)。
    let reloadExtensions: (() => Promise<import('../tui/ext/session').ExtReloadResult>) | undefined;
    // 2026-08-13 owner 裁: 审批闸删了, 默认 yolo。安全 = **围栏 + 黑名单** 两层, 都不打断人。
    // 这里只探一次 bwrap 起不起得来 —— 起不来是**降级裸跑 + 顶栏红字**, 不是静默。
    const { loadSandboxConfig } = await import('./hooks/command-policy');
    const { probeShellSandbox } = await import('./hooks/shell-sandbox');
    const sandboxCfg = loadSandboxConfig(cwd);
    const sandboxStatus = sandboxCfg.enabled ? probeShellSandbox() : { ok: false, reason: 'disabled in .omd/config.json (tui.sandbox.enabled=false)' };
    // 切片②: 调用账本。**两侧统一走 emitModelUsage 钩子** —— gateway 的 callModel 与对话轮
    // (`runChatTurn` 逐条 emit) 都从这一个订阅进账, 来源由 emit 侧第三参带。
    // ⚠ 2026-08-09 修: 此前 chat 轮由 backend 在轮末**再补记一笔合计**, 而 8-07 起 agent.ts
    // 已经逐条 emit —— 同一轮记两遍 (生产账本上留下 10 对 in/out 相同、相差 1-5ms 的孪生行)。
    const { createTuiUsageLedger } = await import('../tui/usage/ledger');
    const { observeModelUsage } = await import('../model/accounting');
    const { join: joinPath } = await import('node:path');
    // OMD_TUI_USAGE_DIR: 测试接缝 —— PTY lane 的 fixture 记账不许污染真仓的 5h 窗口。
    const usage = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || joinPath(cwd, '.omd') });
    observeModelUsage((u, model, origin) => usage.record(u, model, origin));
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
      backend = createFixtureBackend({ usage });
    } else {
      // 与 `omd serve` 同一条路: 同一个 runChatTurn、同一批 chatTools、同一条座位解析。
      const { bootstrapModelRuntime } = await import('../model/bootstrap');
      bootstrapModelRuntime(); // 不引导则注册表空, 一句话都发不出去
      const { assembleOmdMcpTools, resolveEngineModels } = await import('../mcp/assemble');
      const { createChatSeatTools } = await import('../tui/tools/chat-seat');
      // S15a 扩展宿主: 每个扩展一个子进程 (bwrap 在就沙箱)。**加载期硬失败** ——
      // 碰了没实现的 API 就拒绝并逐条列出, 不半残地跑起来。
      // D3 `/reload`(2026-08-11): 持有者住在 `tui/ext/session.ts` —— 重载要动的那份状态
      // (当前活着的子进程)此前长在这个内联块里, 谁都够不着。装配这一段只剩两句。
      const { createExtSession } = await import('../tui/ext/session');
      const extSession = createExtSession(cwd);
      // 加载结果**也要给 UI** —— 被拒的缺什么, 藏在日志里等于加载期硬失败白做了。
      const { tools: extTools, status: st } = await extSession.load();
      const { createOmdSessionStore } = await import('./chat/session-store');
      const { createEmbeddedBackend } = await import('../tui/backend-embedded');
      // ⚠ 先有工具面才有 backend (工具要交给 runChatTurn), 而节点事件要灌回 backend ——
      // 所以这里用一个**延迟指针**接环, 不是循环依赖。装配完成前引擎不可能发事件。
      let sink: { pushDagEvent(runId: string, e: unknown): void } | null = null;
      const { loadExtTools } = await import('./ext-tools');
      const tools = assembleOmdMcpTools({ onNodeEvent: (runId, e) => sink?.pushDagEvent(runId, e), extTools: await loadExtTools(cwd) });
      // ⚠ **不传 memory** (owner 2026-08-18): 传了 = `agent.ts` 挂 `transformContext`,
      // 每一轮请求前自动召回一次。实测读数 (`~/.omd/recall-events.jsonl` 当天 8 次注入,
      // 每次 hits:1, 屏上重复同一条) 与 memory-hub 每-prompt 注入被关掉 (NOTES.md M1,
      // 2026-08-18) 是同一条判据: **召回按需调, 不每轮塞**。对话位的 `memory_recall` 工具
      // 仍在工具面里 (`serve/chat-tools.ts`), 模型想查随时能查; 写记忆照旧不给对话位。
      // 顺带修掉一处不一致: SDK 通道本就不吃 `transformContext` —— 此前同一个 TUI 换个座位
      // 就换一套隐性上下文 (pi 座每轮有召回, claude-code 座一次都没有)。
      const embedded = createEmbeddedBackend({
        cwd,
        store: createOmdSessionStore(cwd),
        // S-4: 对话位的工具面(含六只手)。装配在 `tui/tools/chat-seat`, 那里有闸盯着 ——
        // 长在这个内联块里的话, "对话位到底拿到了哪些工具"没有任何测试看得见(坑 #7 同族)。
        // 切片①: 审批闸包住整个工具面; 六只手的内层危险命令闸随之交给 admin 档 (闸永远有一层)。
        // ★ `ask_user`(2026-08-08):UI 走**惰性取** —— 工具面装在 TUI 之前, 那时 dialogs
        //   还不存在(同上面那个"延迟指针接环"的理由)。`runOmdTui` 起来后把它填上。
        tools: createChatSeatTools({ cwd, mcpTools: tools, extTools, sandbox: sandboxCfg, askUser: () => askUserUi }),
        // 多个扩展**串起来**追加(串接在 session 里, 每轮现取当前扩展)。
        // ⚠ 钩子**无条件挂**: 挂不挂此前按启动那一刻的扩展数决定, 而 `/reload` 能把
        //   0 个变成 N 个 —— 按启动数决定的话, 空仓里装上第一个扩展再重载, 工具进来了
        //   但 `before_agent_start` 永远不跑, 而且没有任何症状。零扩展时它原样返回。
        systemPromptHook: (p0: string) => extSession.systemPromptHook(p0),
        // S14: UI 自己直调 dag_runs / dag_resume (不经模型)。给了才有那两个能力。
        mcpTools: tools,
        // 座位每轮现解 (INV-MODEL-3): omd_set_role / `/seat` 改完, 下一句就换座。
        resolveModel: () => resolveEngineModels(process.env).conductorModel,
        // ⚠ 不传 usage: chat 轮的账走上面那条 observeModelUsage 订阅 (agent.ts 逐条 emit)。
      });
      extStatus = st;
      reloadExtensions = () => extSession.reload();
      sink = embedded;
      backend = embedded;
    }
    await runOmdTui({
      backend,
      cwd,
      sandbox: sandboxStatus,
      usage,
      // 延迟指针的另一端:UI 就绪即填, `ask_user` 从此问得出来。
      onUi: (ui) => {
        askUserUi = ui;
      },
      ...(extStatus.length > 0 ? { extensions: extStatus } : {}),
      ...(reloadExtensions ? { reloadExtensions } : {}),
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
  const { loadExtTools } = await import('./ext-tools');
  const tools = assembleOmdMcpTools({ extTools: await loadExtTools(cwd) });
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
} else if (userArgs[0] === 'touch') {
  await runTouch(userArgs.slice(1));
  process.exit(process.exitCode ?? 0);
} else if (userArgs[0] === 'touches') {
  await runTouches(userArgs.slice(1));
  process.exit(process.exitCode ?? 0);
} else if (userArgs[0] === 'pack') {
  // A3 数据插件包: 装/卸/列。质量闸在 addPack 内 (staging 世界全校验, 拒绝零残留)。
  const { addPack, removePack, listPacks } = await import('./pack/pack');
  const sub = userArgs[1];
  const arg = userArgs[2];
  const r =
    sub === 'add' && arg
      ? await addPack(process.cwd(), arg)
      : sub === 'remove' && arg
        ? removePack(process.cwd(), arg)
        : sub === 'list'
          ? listPacks(process.cwd())
          : { ok: false, message: '用法: omd pack add <本地目录|git URL> | remove <name> | list' };
  (r.ok ? process.stdout : process.stderr).write(`${r.message}\n`);
  process.exit(r.ok ? 0 : 1);
} else if (userArgs[0] === 'config' && userArgs[1] === 'dump') {
  // C3 (dsh --dump-config 的可见性承诺): 打印生效配置全叠加, 每值标来源层。
  // 与 mcp/tui 同款引导: 不 bootstrap 的话 provider 注册表是空的, dump 出来全是假"未配"。
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime();
  const { renderConfigDump } = await import('./config-dump');
  process.stdout.write(`${renderConfigDump({ cwd: process.cwd() })}\n`);
  process.exit(0);
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

// omd touch / omd touches 的 helper —— SDD S3 碰撞台账写入面 (只记不拦, 第一刀; jcode 总账 §6.1)。
// 锚定 (总账 §3.6 已裁): 台账锚 **cwd 的 git toplevel** (找不到就 cwd) 下的 `.omd/touch.db`;
// ⚠ 不用 omdRepoRoot() 的 worktree→主仓归并 —— 隔离档下两个 worktree 各写各的, 不算撞。
// fail-open 不吞证据: 台账读写失败 → logger.warn 留痕, CLI 不因此崩 (记录失败 ≠ 工具失败)。

/** 台账锚点 = cwd 的 git toplevel, 找不到 → cwd。判据与 project-scope 同一条 git 调用 (不新抄一份)。 */
async function touchLedgerRoot(): Promise<string> {
  const { gitToplevel } = await import('./project-scope');
  return gitToplevel(process.cwd()) ?? process.cwd();
}

/** 取 `--name <v>` 的 v; 缺 flag 或缺值 → undefined。 */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * 写面: `omd touch <path> --op read|write [--hash <h>] --session <id>`。
 * 参数错误 = 用法错误 (exit 1); 台账自身失败 = fail-open (warn 留痕 + exit 0 —— hook 链路上
 * 工具调用已成功, 记录失败不能反过来把工具判失败)。
 */
async function runTouch(args: string[]): Promise<void> {
  const pathArg = args[0];
  const op = flagValue(args, '--op');
  const session = flagValue(args, '--session');
  const hash = flagValue(args, '--hash');
  if (!pathArg || !op || !session) {
    process.stderr.write('用法: omd touch <path> --op read|write [--hash <h>] --session <id>\n');
    process.exitCode = 1;
    return;
  }
  if (op !== 'read' && op !== 'write') {
    process.stderr.write(`--op 必须是 read 或 write, 收到: ${op}\n`);
    process.exitCode = 1;
    return;
  }
  const root = await touchLedgerRoot();
  const { resolve } = await import('node:path');
  const absPath = resolve(process.cwd(), pathArg);
  try {
  const { openTouchLedger } = await import('./touch-ledger');
  const ledger = openTouchLedger({ root });
  // hash 缺省落 NULL (没算 hash ≠ 空串, NULL≠0 纪律) —— 这里不传 ''。
  // ledger.recordTouch 自带 fail-open (内部 warn 留痕), ts 由 ledger 自己打, 调用方不传。
  ledger.recordTouch({ path: absPath, session, op, hash: hash ?? null, source: 'cli' });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), root, absPath, session, op },
      '[omd/touch] 台账记录失败 (fail-open: 不阻断调用, 证据留 warn)',
    );
  }
}

/**
 * 查询面: `omd touches [--pairs|--findings]`。pairs 与 findings 分开读、分开打印;
 * 无 flag = 两个都打 (长期 0 也是读数, SDD §1-S3)。
 */
async function runTouches(args: string[]): Promise<void> {
  const wantPairs = args.includes('--pairs');
  const wantFindings = args.includes('--findings');
  const showPairs = wantPairs || (!wantPairs && !wantFindings);
  const showFindings = wantFindings || (!wantPairs && !wantFindings);
  const root = await touchLedgerRoot();
  try {
  const { openTouchLedger } = await import('./touch-ledger');
  const ledger = openTouchLedger({ root });
  if (showPairs) {
    const pairs = ledger.crossSessionPairs();
    process.stdout.write(`pairs (${pairs.length}):\n`);
    for (const p of pairs) process.stdout.write(`  ${JSON.stringify(p)}\n`);
  }
  if (showFindings) {
    const fs = ledger.findings();
    process.stdout.write(`findings (${fs.length}):\n`);
    for (const f of fs) process.stdout.write(`  ${JSON.stringify(f)}\n`);
  }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), root },
      '[omd/touches] 台账读取失败 (fail-open: 不崩, 证据留 warn)',
    );
  }
}
