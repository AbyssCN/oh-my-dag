/**
 * src/tui/commands —— **命令清单与 `/help`**(2026-08-07)。
 *
 * ## 补的是我自己造的一个洞
 *
 * S12/S14/S15 各自加了一条斜杠命令,而**没有任何地方列出它们**:
 * 启动提示只说"打字后回车发一轮",用户不读源码就永远不知道 `/seat` `/runs` `/resume` `/skill`
 * 存在。装了四条发现不了的命令,等于没装 —— 这是交付的不完整,不是新需求。
 *
 * ## 一张表,不是一个注册表
 *
 * ⚠ 这里**只是一张给人看的清单**,不是命令注册表(那个方案 SDD L117 已裁决撤回)。
 * 分发仍然是 `tui.ts` 里那几个前缀判断。两者会不会漂?会 —— 所以
 * `commands.test.ts` 有一条闸:**清单里的每条命令,`tui.ts` 里都要真的有人接**。
 */

export interface CommandDoc {
  /** 命令本身(含斜杠)。 */
  name: string;
  /** 参数形状;无参数为 `null`。 */
  args: string | null;
  /** 一句话说清它**干什么**,以及有没有副作用。 */
  what: string;
  /**
   * `tui.ts` 里**真正分发它**的那个标识符(解析器或处理函数)。
   *
   * ⚠ 这一格是接线闸的钥匙。第一版没有它,闸靠"命令名在 tui.ts 里出现过"来判 ——
   * 而 `/seat` `/skill` 的解析器住在别的文件里,它们只在**注释**里出现过。
   * 于是那条闸是靠注释蒙混过关的:把 handler 删掉、注释留着,它照样绿。
   * (加 `/session` 时它终于红了 —— 因为那条命令还没来得及写进任何注释。)
   */
  handler: string;
}

/**
 * ★ **全部命令。加一条命令就加一行,否则它发现不了。**
 *
 * 顺序 = 显示顺序,按"多久用一次"排,不按字母。
 */
export const COMMANDS: readonly CommandDoc[] = [
  { handler: 'parseHelpCommand', name: '/help', args: null, what: 'show this table' },
  { handler: 'handleSkill', name: '/skill', args: '[name] [notes]', what: 'list skills by group; a name arms it for the **next** message' },
  { handler: 'handleHud', name: '/hud', args: null, what: 'toggle the DAG sidebar. Ctrl+G fullscreen, Tab cycles tree/gantt/layers' },
  { handler: 'handleModels', name: '/models', args: null, what: 'switch the chat seat model (type to filter, current one marked ✓)' },
  { handler: 'handleSeat', name: '/seat', args: '[role] [provider:model] | advisor <seat> <coord|none>', what: 'list tunable seats; with arguments it writes `.omd/config.json` (**side effect**)' },
  { handler: 'handleSettings', name: '/settings', args: null, what: 'settings panel: seats / ui / approval / providers / session / extensions' },
  { handler: 'handleStatus', name: '/status', args: null, what: 'one screen: seat, session id, context pressure, usage today (read-only)' },
  { handler: 'handleLogin', name: '/login', args: '[provider]', what: 'store an API key for a provider (echo masked, **side effect**)' },
  { handler: 'handleLogout', name: '/logout', args: '[provider]', what: 'delete a stored credential for one provider (**side effect**)' },
  { handler: 'handleSession', name: '/session', args: '[id | new [id]]', what: 'list sessions; with an id, switch and replay it; `new` starts a fresh one' },
  { handler: 'parseNewForkCommand', name: '/new', args: '[id]', what: 'start a fresh session (alias of /session new)' },
  // ⚠ `/fork` 与 `/tree` **不是重复的两条**, 两句 what 要把分野说清(2026-08-11 §1.3 裁决):
  //    /fork 复制出**第二条会话**(两条都能活, 同一段历史两份); /tree 在**同一份文件**里换分支
  //    (一份真值, 同时只有一个活分支)。说不清分野时人会随便点一个, 而两者的产物完全不同。
  { handler: 'parseNewForkCommand', name: '/fork', args: '[id]', what: 'copy this session into a second one and switch to it (alias of /session fork)' },
  { handler: 'handleTree', name: '/tree', args: null, what: 'browse this session tree; branch from an earlier entry - the abandoned branch becomes a [branch summary] node in the same file (**side effect**)' },
  { handler: 'handleSearch', name: '/search', args: '<text>', what: 'full-text search across all sessions; pick a hit to switch to that session' },
  { handler: 'handleThink', name: '/think', args: '[off|low|medium|high|xhigh]', what: 'show or set the thinking level for chat turns (persisted to .omd/config.json)' },
  { handler: 'handleRuns', name: '/runs', args: null, what: 'list DAG runs (registry + on-disk checkpoints)' },
  { handler: 'handleRuns', name: '/resume', args: '<runId>', what: 'resume a broken run from its checkpoint (**side effect**)' },
  { handler: 'handleCompact', name: '/compact', args: null, what: 'compress the current session context (**side effect**)' },
  { handler: 'handleReload', name: '/reload', args: null, what: 'reload extensions from .omd/extensions.json - restarts their subprocesses (**side effect**)' },
  { handler: 'handleExport', name: '/export', args: '[path]', what: 'write this transcript to a markdown file (**side effect**)' },
  { handler: 'requestCleanExit', name: '/quit', args: null, what: 'exit cleanly (same as Ctrl+C twice)' },
];

/** 清单里出现过的命令名 —— 接线闸拿它跟 `tui.ts` 对表。 */
export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

/**
 * `/search <词>` 的解析。`/search`(裸)也认 —— 词交空串,由处理层画用法;
 * 解析层只认形状不判语义(`parseSeatCommand` 同款分工)。
 */
export function parseSearchCommand(text: string): { text: string } | null {
  const t = text.trim();
  if (t !== '/search' && !t.startsWith('/search ')) return null;
  return { text: t.slice('/search'.length).trim() };
}

export function parseHelpCommand(text: string): boolean {
  const t = text.trim();
  return t === '/help' || t === '/?' || t === '/h';
}

export function formatHelp(): string {
  // ★ **一行一条**(2026-08-09):换纯英文之后两行一条的排法把整屏顶穿了 ——
  //   `/help` 的前几条直接滚出屏幕, L3 的 HELP-1 当场红(那不是假红, 是真看不到了)。
  //   一行一条同时也是密度上的改善:同一屏能读完。
  const w = Math.max(...COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ''}`.length));
  const rows = COMMANDS.map((c) => `  ${`${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(w)}  ${c.what}`);
  return `Commands (plain text sends a chat turn):\n${rows.join('\n')}\n\nType @ or part of a path in the editor to fuzzy-complete file names.
!<cmd> runs a local shell command in the repo; its output joins the session context.
Esc interrupts a running turn; Esc twice (when idle) rewinds to before an earlier message.
Ctrl+O collapses/expands thinking sections. Mouse wheel scrolls; drag to select text.
When the HUD has many nodes: Alt+↑ / Alt+↓ scrolls, Alt+Home follows again.`;
}

/** 启动提示 —— **必须提到 `/help`**,否则命令仍然发现不了。 */
/**
 * 首屏一次性提示。
 *
 * ★ **2026-08-08 去掉了 `Ctrl+C 两次退出`**(P1 密度):它在**常驻**的行③ 里一直挂着,
 * 而这一行是**一次性**的。同一屏说两遍的代价是首屏更挤 —— 实测这一串一屏出现 2 次。
 * ⚠ 砍的是**重复**不是能力:"怎么退出"这条信息一秒都没丢, 它在行③ 常驻,
 * 而人需要它的时刻(想退却退不掉)恰恰是**看着行③**的那一刻,不是启动那一刻。
 */
export const STARTUP_HINT = 'Type and press Enter to send a turn; `/help` lists the commands.';

/**
 * 给 pi-tui 的 `CombinedAutocompleteProvider` 用的形状。
 *
 * ⚠ **这一段是补一个真 bug**:此前输入框只挂了自写的文件补全,于是打 `/settings`
 * 弹出来的是一堆**文件名**(`wt-settings-full.json`、`.claude/settings.json.bak-*`)——
 * owner 的截图里就是这个。斜杠开头本该出**命令**。
 *
 * pi-tui 本来就有这件事的现成件(行首 `/` 走命令、其余走文件),我却自己写了一份文件补全 ——
 * 那 140 行本可以不写。记在这儿:**先翻依赖再动手**。
 */
export interface SlashGroup {
  /** 组名(裸名, 不带斜杠)。 */
  name: string;
  count: number;
}

/**
 * @param groups S-6 的 skill 组(`/omd` `/lark` …)。**运行时扫出来的**, 不是写死的清单 ——
 *   owner 要的是"下载了 skill 自动发现", 写死等于每装一条 skill 都要改代码。
 *
 * ⚠ 这份清单在**启动时**算一次(补全要的是一个静态数组)。装了新 skill 之后补全里看不到它,
 *   但**打全了照样能用**(分发是每次现扫的)。两者不一致是刻意取舍:
 *   每敲一个字符扫一遍一百多个目录不值当。
 */
export function slashCommands(groups: readonly SlashGroup[] = []): { name: string; description: string; argumentHint?: string }[] {
  const base = COMMANDS.map((c) => ({
    // pi-tui 那边自己补前导 `/`,这里给裸名。
    name: c.name.replace(/^\//, ''),
    description: c.what,
    ...(c.args ? { argumentHint: c.args } : {}),
  }));
  const groupCmds = groups.map((g) => ({
    name: g.name,
    description: `${g.count} ${g.name}-* skills - without a member name it lists them`,
    argumentHint: '[member] [notes]',
  }));
  return [...base, ...groupCmds];
}
