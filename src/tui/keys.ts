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
import { getKeybindings } from '@earendil-works/pi-tui';

/**
 * 取消键的全表。前两个是 pi-tui 默认值(**原样保留**),第三个是补上的双 ESC。
 *
 * `ctrl+alt+[` 就是 `\x1b\x1b` 这两个字节 —— 不是另一个键,是同一串字节的另一种叫法,
 * 所以不存在"抢了别人的键位"这回事。
 */
export const SELECT_CANCEL_KEYS = ['escape', 'ctrl+c', 'ctrl+alt+['] as const;

/**
 * 装上。**幂等** —— `setUserBindings` 是整体替换,同样的入参调几次结果一样。
 *
 * ⚠ 它替换的是**整份** user bindings。omd 目前只覆盖这一条;将来要覆盖第二条,
 * 必须加进同一个对象里,不能再调一次(第二次会把第一次的抹掉)。
 */
export function installOmdKeybindings(): void {
  getKeybindings().setUserBindings({ 'tui.select.cancel': [...SELECT_CANCEL_KEYS] });
}
