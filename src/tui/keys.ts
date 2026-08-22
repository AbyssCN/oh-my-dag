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
  /**
   * ★ **`ctrl+k` 是从 pi 手里抢来的**(2026-08-22)—— 记在这里,因为它不会有别的痕迹。
   *
   * pi 默认表里 `ctrl+k` = `tui.editor.deleteToLineEnd`(实读
   * `dist/keybindings.js:67-70`),而 omd 五键由 input listener **在焦点分派之前**
   * 收并 `consume`(`tui.ts` 那一段)⇒ 装上之后编辑器里的「删到行尾」**静默消失**。
   *
   * 而 `findKeyClashes` 抓不到这一条:它的判据是「同键 ≥2 命令**且至少一条是用户改的**」
   * (下面那段的原话),这里两条都是默认值。⇒ 判据本身是对的(默认表天然有 9 处
   * 跨上下文同键),抓不到不是它的漏 —— 所以这条记录就是唯一的痕迹。
   *
   * **取舍说清楚**:换来的是一个跨工具通用的去处选单(VS Code / Claude Code 同键),
   * 付掉的是聊天输入框里的 `ctrl+k`。`ctrl+u`(删到行首)/ `ctrl+w`(删词)都还在,
   * 而且这一条**可改** —— `.omd/keybindings.json` 里写 `{"omd.palette": "ctrl+e"}` 就还回去。
   */
  'omd.palette': { defaultKeys: 'ctrl+k', description: 'Go to: session / live graph / map (takes ctrl+k from tui.editor.deleteToLineEnd)' },
  /**
   * ★ **片 5 切片 3**(2026-08-22): 收件箱开关。**实测见 `now-band-wiring.test.ts`** ——
   * `ctrl+i` 与 `Tab` 是同一字节(`\x09`),而 Tab 是**上下文粘合键**(补全/换屏),
   * 重绑会把那两条路静默吃掉。**取舍**:`ctrl+i` 留给系统(终端里与 Tab 互换),omd 改用
   * `ctrl+n`(next)。Claude Code / dsh-TUI 沿用 `ctrl+i` 是因为它们的编辑器没有常驻补全
   * —— omd 有(`CombinedAutocompleteProvider` 在输入框里),抢键会咬补全。
   */
  'omd.inbox': { defaultKeys: 'ctrl+n', description: 'Open the inbox (one-thing-needing-you)' },
} as const;

declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'omd.quit': true;
    'omd.interrupt': true;
    'omd.thinkingToggle': true;
    'omd.dagFull': true;
    'omd.pathFull': true;
    'omd.palette': true;
    'omd.inbox': true;
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
 * **生效后的键位冲突** —— 2026-08-21 补。
 *
 * ## 为什么不能直接用 pi 的 `getConflicts()`
 *
 * 它**只比用户绑定之间**的冲突(`dist/keybindings.js:137-151` 的 `userClaims`),
 * **不拿用户绑定去比默认绑定**。而真实场景恰恰是后者:用户把 `omd.dagFull` 绑成 `ctrl+o`,
 * 而 `ctrl+o` 是 `omd.thinkingToggle` 的**默认**键 —— 实测 `getConflicts()` 对这条返回 `[]`。
 * ⇒ 照抄那个 API 是白接。这里用 `getResolvedBindings()`(生效后的全表)自己算。
 *
 * ## 判据:同键 ≥2 命令 **且至少一条是用户改的**
 *
 * 默认表里天然有 **9 处**同键多命令(实测),全是跨上下文的 ——
 * `up` 归 `tui.editor.cursorUp` 与 `tui.select.up`、`ctrl+c` 归三家、`escape` 归两家……
 * 不同焦点态各自拥有该键,**是设计不是冲突**,报出来是纯噪音。
 * 而用户一旦把某条挪到已被占用的键上,就必然有一条无声死掉 —— 尤其 `omd.*` 五键由
 * **同一个 input listener 在焦点分派之前**处理(`tui.ts` 那一段),先匹配到的赢。
 *
 * ⇒ 默认态返回空数组(**无源恒缺席**,不画空表);用户一动就说话。
 */
export interface KeyClash {
  key: string;
  /** 抢这个键的全部命令 id(按登记序)。 */
  ids: string[];
}

export function findKeyClashes(kb: KeybindingsManager, user: KeybindingsConfig): KeyClash[] {
  const byKey = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(kb.getResolvedBindings())) {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (typeof k !== 'string' || !k) continue; // 空表/未定义键位不算占用
      byKey.set(k, [...(byKey.get(k) ?? []), id]);
    }
  }
  const out: KeyClash[] = [];
  for (const [key, ids] of byKey) {
    if (ids.length < 2) continue;
    if (!ids.some((id) => id in user)) continue; // 天然重复(跨上下文)不报
    out.push({ key, ids });
  }
  return out;
}

/** 冲突 → 一行人话。没冲突返回 `null`(调用方据此整条不画)。 */
export function formatKeyClashes(clashes: readonly KeyClash[]): string | null {
  if (clashes.length === 0) return null;
  const rows = clashes.map((c) => `  ${c.key} → ${c.ids.join(' / ')}`);
  return [
    `${KEYBINDINGS_FILE}: ${clashes.length} 个键位被多个命令抢占, 每个键只有一条会生效:`,
    ...rows,
    '  (改掉其中一条, 或删掉该行回到默认)',
  ].join('\n');
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
