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
  { handler: 'parseHelpCommand', name: '/help', args: null, what: '列出这张表' },
  { handler: 'handleSkill', name: '/skill', args: '[name] [补充]', what: '按组列出 skill(包内 + ~/.claude/skills);`/skill all` 全表;给名字则挂到**下一句**上' },
  { handler: 'handleHud', name: '/hud', args: null, what: '开关左栏 DAG 树(fan-out 分裂看得见;窄终端自动收起)。Ctrl+G 全屏,全屏里 Tab 切 树/甘特/分层' },
  { handler: 'handleModels', name: '/models', args: null, what: '给对话位换模型:列出已配 provider 的全部模型(可打字搜索,当前项带 ✓)' },
  { handler: 'handleSeat', name: '/seat', args: '[role] [provider:model]', what: '列出可调座位;给参数则改 `.omd/config.json`(**有副作用**,立刻生效)' },
  { handler: 'handleSettings', name: '/settings', args: null, what: '设置面板:座位 / 界面 / 审批 / provider / 会话 / 扩展(只读项会标出来;可改项写 `.omd/config.json`)' },
  { handler: 'handleLogin', name: '/login', args: '[provider]', what: '给 provider 落 API key(auth.json / .env 自动路由;回显打星,**有副作用**)' },
  { handler: 'handleSession', name: '/session', args: '[id | new [id]]', what: '列出会话;给 id 则切过去并回放它的历史;`new` 新开一条' },
  { handler: 'handleRuns', name: '/runs', args: null, what: '列出 DAG run(内存注册表 + 磁盘 checkpoint 合并)' },
  { handler: 'handleRuns', name: '/resume', args: '<runId>', what: '续跑一个断掉的 run —— 从 checkpoint 重载,跳过已绿节点(**有副作用**)' },
];

/** 清单里出现过的命令名 —— 接线闸拿它跟 `tui.ts` 对表。 */
export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

export function parseHelpCommand(text: string): boolean {
  const t = text.trim();
  return t === '/help' || t === '/?' || t === '/h';
}

export function formatHelp(): string {
  const rows = COMMANDS.map((c) => `  ${c.name}${c.args ? ` ${c.args}` : ''}\n      ${c.what}`);
  return `命令(直接打字则是发一轮对话):\n${rows.join('\n')}\n\n输入框里打 @ 或一段路径可以模糊补全文件名。
HUD 节点多时:Alt+↑ / Alt+↓ 滚动,Alt+Home 回到跟随。`;
}

/** 启动提示 —— **必须提到 `/help`**,否则命令仍然发现不了。 */
export const STARTUP_HINT = '打字后回车发一轮;`/help` 看命令;Ctrl+C 两次退出。';

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
    description: `${g.count} 条 ${g.name}-* skill —— 不给成员则列出它们`,
    argumentHint: '[成员] [补充说明]',
  }));
  return [...base, ...groupCmds];
}
