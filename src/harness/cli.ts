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
⚠ 当前 omd tui 是 **UI 壳** (切片 S2): 起得来、收键、Ctrl+C 两次退出, 但**引擎后端未接通**
(S10 才接 runChatTurn)。现在要真对话走 MCP 客户端 (Claude Code 等) 或 omd serve 的 web 控制台。

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
    const { createStubBackend } = await import('../tui/backend-stub');
    await runOmdTui({ backend: createStubBackend(), cwd });
  } finally {
    tuiLog.close();
  }
  process.exit(0);
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
  const { ChatStore } = await import('./chat/store');
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
      chatStore: new ChatStore(cwd),
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
