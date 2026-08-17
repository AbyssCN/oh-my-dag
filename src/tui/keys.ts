/**
 * src/tui/keys —— **键位:把 pi-tui 表里缺的那一种编码补上**(2026-08-08)。
 *
 * ## 实测把台账那条更正了:它是**一换一**,不是纯赢
 *
 * `docs/bars/pi-tui-模块台账.md` 把 `Key` / `matchesKey` 记成欠账,理由写的是
 * "手列编码表漏一种终端的编码"。逐字节量过之后(`parseKey` +
 * `KeybindingsManager.matches`,2026-08-08,`scripts/tui-key-probe.ts`):
 *
 * | 送进去的字节 | omd `dialog.ts` 的 `ESC` 表 | pi-tui `tui.select.cancel` 默认 |
 * |---|---|---|
 * | `\x1b`              | ✓ | ✓ |
 * | `\x1b\x1b`          | ✓ | **✗** —— `parseKey` 读成 `ctrl+alt+[` |
 * | `\x1b[27u`(kitty)  | **✗** | ✓ |
 *
 * ⇒ 两张表**各缺对方一种**。所以这里不是"把手搓的换掉",是把缺的那一种
 * **用 pi-tui 自己的机制**补齐(`setUserBindings`),于是冲突检测
 * (`getConflicts()`)一并生效,而不是再手搓第二张表。
 *
 * ## ⚠ `ctrl+c` 必须留着
 *
 * pi-tui 默认 `tui.select.cancel = ['escape', 'ctrl+c']`(实测,不是猜)。
 * 覆盖时漏掉 `ctrl+c` 就是**静默**删掉一个默认键位 —— omd 里 Ctrl+C 由 input listener
 * 先截走(`tui.ts` 焦点分派那一段),走不到列表;但"现在走不到"和"不该有"是两件事,
 * 而这行覆盖会在将来某天决定第二件。
 */
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, type KeybindingsConfig } from '@earendil-works/pi-tui';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 取消键的全表。前两个是 pi-tui 默认值(**原样保留**),第三个是补上的双 ESC。
 *
 * `ctrl+alt+[` 就是 `\x1b\x1b` 这两个字节 —— 不是另一个键,是同一串字节的另一种叫法,
 * 所以不存在"抢了别人的键位"这回事。
 */
export const SELECT_CANCEL_KEYS = ['escape', 'ctrl+c', 'ctrl+alt+['] as const;

/**
 * ★ omd 自己的键位名(W4③,2026-08-17)—— 此前这五个键写死在 `tui.ts` 的
 * input listener 里(`\x03` 之类的字节比较),**不可配置也不进冲突检测**。
 * 现在它们是一等键位:默认值 = 原字节的键名,用户文件可改。
 *
 * ⚠ **不在表里的**(刻意,记录防重议):Tab 视图轮换(上下文粘合键,重绑会把补全一起绑走)、
 * Alt 滚动三键(编码跨终端方言多,`HUD_SCROLL` 原始表覆盖了 parseKey 认不出的 ESC 前缀式 ——
 * 换成键名匹配会静默丢一种终端)。
 */
export const OMD_KEYBINDINGS = {
  'omd.quit': { defaultKeys: 'ctrl+c', description: 'Quit (press twice)' },
  'omd.interrupt': { defaultKeys: 'escape', description: 'Interrupt the running turn / arm double-Esc rewind' },
  'omd.thinkingToggle': { defaultKeys: 'ctrl+o', description: 'Collapse/expand thinking sections' },
  'omd.dagFull': { defaultKeys: 'ctrl+g', description: 'Toggle fullscreen DAG view' },
  'omd.pathFull': { defaultKeys: 'ctrl+p', description: 'Toggle fullscreen pathfinder view' },
} as const;

declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'omd.quit': true;
    'omd.interrupt': true;
    'omd.thinkingToggle': true;
    'omd.dagFull': true;
    'omd.pathFull': true;
  }
}

export const KEYBINDINGS_FILE = '.omd/keybindings.json';

/**
 * 用户键位文件(pi 的 `KeybindingsConfig` 平表:`{"omd.quit": "ctrl+q"}`)。
 * 缺席 = 没配置过,空表;坏 JSON fail-open 但**不吞证据**(diagnostic 带回去画屏)。
 */
export function loadUserKeybindings(cwd: string): { config: KeybindingsConfig; diagnostic: string | null } {
  const path = join(cwd, KEYBINDINGS_FILE);
  if (!existsSync(path)) return { config: {}, diagnostic: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as KeybindingsConfig;
    return { config: raw, diagnostic: null };
  } catch (err) {
    return { config: {}, diagnostic: `${KEYBINDINGS_FILE} is not valid JSON, using defaults: ${(err as Error).message}` };
  }
}

/**
 * 装上:全局 manager 换成「pi 全表 + omd 五键」的并集,user bindings =
 * select.cancel 补丁 + 用户文件(**用户文件在后,能覆盖包括补丁在内的一切**)。
 * **幂等** —— 同样入参调几次结果一样。
 *
 * ⚠ user bindings 是**整体替换**语义:将来要再加一条内置覆盖,必须并进这同一个
 * 对象,不能另调一次 setUserBindings(第二次会把第一次的抹掉)。
 */
export function installOmdKeybindings(user: KeybindingsConfig = {}): KeybindingsManager {
  const kb = new KeybindingsManager(
    { ...TUI_KEYBINDINGS, ...OMD_KEYBINDINGS },
    { 'tui.select.cancel': [...SELECT_CANCEL_KEYS], ...user },
  );
  setKeybindings(kb);
  return kb;
}
