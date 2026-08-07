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
}

/**
 * ★ **全部命令。加一条命令就加一行,否则它发现不了。**
 *
 * 顺序 = 显示顺序,按"多久用一次"排,不按字母。
 */
export const COMMANDS: readonly CommandDoc[] = [
  { name: '/help', args: null, what: '列出这张表' },
  { name: '/skill', args: '[name] [补充]', what: '列出 omd 方法论 skill;给名字则把它挂到**下一句**上(只管那一轮,不写进会话)' },
  { name: '/seat', args: '[role] [provider:model]', what: '列出可调座位;给参数则改 `.omd/config.json`(**有副作用**,立刻生效)' },
  { name: '/runs', args: null, what: '列出 DAG run(内存注册表 + 磁盘 checkpoint 合并)' },
  { name: '/resume', args: '<runId>', what: '续跑一个断掉的 run —— 从 checkpoint 重载,跳过已绿节点(**有副作用**)' },
];

/** 清单里出现过的命令名 —— 接线闸拿它跟 `tui.ts` 对表。 */
export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

export function parseHelpCommand(text: string): boolean {
  const t = text.trim();
  return t === '/help' || t === '/?' || t === '/h';
}

export function formatHelp(): string {
  const rows = COMMANDS.map((c) => `  ${c.name}${c.args ? ` ${c.args}` : ''}\n      ${c.what}`);
  return `命令(直接打字则是发一轮对话):\n${rows.join('\n')}\n\n输入框里打 @ 或一段路径可以模糊补全文件名。`;
}

/** 启动提示 —— **必须提到 `/help`**,否则命令仍然发现不了。 */
export const STARTUP_HINT = '打字后回车发一轮;`/help` 看命令;Ctrl+C 两次退出。';
