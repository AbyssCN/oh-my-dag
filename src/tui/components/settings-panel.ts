/**
 * src/tui/components/settings-panel —— **设置面板**,用 pi-tui `SettingsList` 托管
 * (2026-08-08,P1 第 3 件;owner 定的原则:「pi-tui 有的一律引用,不手搓」)。
 *
 * ## 换掉的是什么
 *
 * 上一版是 `dialog.ts select()` 手拼一个选择框:一行里塞 `标签: 值`,`detail` 塞进
 * `SelectList` 的 `description` —— 而 `SelectList` 把 description 画在**同一行**,
 * 于是 `审批 token TTL` 那条说明被截断成 `重启才生效(`(2026-08-08 帧库实测抓到)。
 *
 * `SettingsList` 一次解决三件:
 * 1. `标签 | 值` **两列对齐**(标签列同宽),说明**单独一行**只给焦点项 → 不再截断。
 * 2. `item.submenu` = **常驻父层托管子态** → 换掉 `ac8d92d` 那个 `for(;;)` 重开循环。
 *    差别不是好看:重开会把选中行位置丢掉,`closeSubmenu()` 会把它还原
 *    (`settings-list.js:164-170`)。
 * 3. `updateValue` → **写盘失败/被规整时照真值回显**,不照用户选的那个。
 *
 * ## 一项只能是一种形状(`shapeOf`)
 *
 * omd 的设置项是**异质**的,而 `SettingsList` 原生只认两种(`values[]` 循环 /
 * `submenu` 子层)。剩下两类是这里补的:
 *
 * - **只读现状行**(`ctx` / `theme` / `glyphs`):既不给 `values` 也不给 `submenu`
 *   → `activateItem()` 走完两个 if 什么都不做(`settings-list.js:139-160`)。
 *   **这正是我们要的**:上一版按 Enter 会返回空串再重开整页,读起来像"我按错了什么"。
 * - **跳去另一条流程**(`session` / `扩展` / `provider 凭证`):它不是"改一个值"。
 *   `SettingsList` 没有 `onActivate`,所以这里借**单元素 `values`**当激活回调 ——
 *   `activateItem` 会算出 `nextIndex = (0+1) % 1 = 0`,值原地不动而 `onChange` 照样触发
 *   (`settings-list.js:153-159`)。⚠ 别把它改成两元素:那会让值在屏幕上跳变。
 */
import { type Component, type SettingItem as PiSettingItem, SettingsList } from '@earendil-works/pi-tui';
import { DialogBox, type InputOpts, type SelectOpts, inputComponent, selectComponent } from './dialog';
import { MANUAL_COORD } from '../model-picker';
import type { SettingItem } from '../settings';
import type { OmdTuiTheme } from '../theme';

/** 一项的归类。**一项只能是一种** —— 两种都给的话 `submenu` 会吃掉 `values`。 */
export type SettingShape =
  | { kind: 'inert' }
  /** Enter 在候选表里循环。 */
  | { kind: 'cycle'; values: readonly string[] }
  /** Enter 开子层;子层的取消**只关子层**。 */
  | { kind: 'submenu'; sub: 'seat' | 'text' }
  /** Enter 不是改值,是跳走。 */
  | { kind: 'activate' };

/**
 * 归类。**纯函数** —— 这是这一片唯一有分支的地方,单测直接钉它,不靠 PTY 看颜色。
 *
 * ⚠ 判据:`action` 为空 ⇔ `inert`。这个双向蕴含是 `settings.ts` 的契约
 * (「`action` 为空 = 只读的现状行」),两边不许各自解释。
 */
export function shapeOf(item: SettingItem, ctx: { painters: readonly string[] }): SettingShape {
  switch (item.action) {
    case undefined:
      return { kind: 'inert' };
    case 'seat':
      return { kind: 'submenu', sub: 'seat' };
    case 'approval-ttl':
      return { kind: 'submenu', sub: 'text' };
    case 'ui-sidebar':
      // 值就是「开」/「关」两个字(`settings.ts:107`)。循环表必须与它逐字一致,
      // 否则 `values.indexOf(currentValue)` 是 -1,第一下 Enter 会跳到 values[0] 而不是翻转。
      return { kind: 'cycle', values: ['开', '关'] };
    case 'ui-painter':
      return { kind: 'cycle', values: ctx.painters };
    case 'session':
    case 'extensions':
    case 'login':
      return { kind: 'activate' };
  }
}

export interface SettingsPanelDeps {
  theme: OmdTuiTheme;
  items: readonly SettingItem[];
  /** 全屏画法的名字表(`ui-painter` 的循环表)。真源在 tui.ts 的 `PAINTERS`,这里不抄第二份。 */
  painters: readonly string[];
  maxVisible?: number;
  /** 主表的标题(键位提示画在标题上, 与其它对话框一致)。默认那句就是 SET-2 的判据锚。 */
  title?: string;
  /** 座位子层列什么。返回 `null` = 目录空 → 子层**退回手输框**(不开空框)。 */
  seatChoices: (role: string, current: string) => SelectOpts | null;
  /** 手输坐标那条退路 —— 不是所有 provider 都在 models.json 里登记过。 */
  seatManual: (role: string, current: string) => InputOpts;
  /** 文本子层(目前只有 `审批 token TTL`)。 */
  textPrompt: (id: string, current: string) => InputOpts;
  /**
   * 值真的改了。**返回改完之后的真值** —— 面板照它回显。
   * 写盘失败时返回旧值,于是屏幕上不会留下一个"改好了"的假象。
   */
  apply: (id: string, value: string) => string;
  /** 跳去另一条流程。要不要关掉本面板由调用方定(它才拿得到 host)。 */
  activate: (id: string) => void;
  /** Esc 在**主表**这一层:收工。 */
  onCancel: () => void;
  requestRender: () => void;
}

/**
 * 子层根:**一格,可换内容**。
 *
 * `submenu` 只收一个 `Component`,而座位子层有两条路(目录里挑 / 手输坐标),
 * 第二条要**换掉**第一条而不是叠上去。pi-tui 的 `Container` 不转按键
 * (`tui.js:39-67` 只有 `addChild/removeChild/clear/invalidate/render`,没有 `handleInput`),
 * 而 `SettingsList` 是靠 `submenuComponent.handleInput?.(data)` 喂键的
 * (`settings-list.js:110-114`)—— 所以这里补的是**转键**那一件事,不是又造一个容器。
 */
class SwapSlot implements Component {
  private child: Component | null = null;
  set(child: Component): void {
    this.child = child;
  }
  render(width: number): string[] {
    return this.child?.render(width) ?? [];
  }
  handleInput(data: string): void {
    this.child?.handleInput?.(data);
  }
  invalidate(): void {
    this.child?.invalidate();
  }
}

/**
 * 把 omd 的设置项映成 pi-tui 的。**纯函数**(`submenu` 只是闭包,不在这里跑),
 * 于是"哪一项能激活、哪一项动不了"这件事能被单测钉住。
 */
export function toPiItems(
  ctx: { items: readonly SettingItem[]; painters: readonly string[] },
  subFactory: (item: SettingItem, sub: 'seat' | 'text') => PiSettingItem['submenu'],
): PiSettingItem[] {
  /**
   * ★ **只读现状行一律排到末尾**(2026-08-08,P3 件2 轮1 的 critic 判词)。
   *
   * 盲比判词:「'改哪一项?' 菜单里混入 3 个只读项(上下文/配色/字形白名单),
   * 与可改项并列同级,干扰'改'这一动作的目标」。核过帧(`07-settings` 行 18-20):
   * 那三行确实**夹在**可改项中间 —— `(只读)` 标记有,但位置没分开。
   * 标题问的是"改哪一项",于是先给能改的,只读的沉到底下。
   *
   * ⚠ 只动**顺序**,不动内容、不删项:那三行是唯一能看到字形白名单读数的地方。
   * ⚠ PTY 的 SET-10 是"↓ 最多 16 下直到光标落在那一行",不锚固定下移次数 ⇒ 重排不动它。
   */
  const ordered = [...ctx.items].sort((x, y) => {
    const inert = (i: SettingItem): number => (shapeOf(i, { painters: ctx.painters }).kind === 'inert' ? 1 : 0);
    return inert(x) - inert(y);
  });
  return ordered.map((item) => {
    const shape = shapeOf(item, { painters: ctx.painters });
    const base: PiSettingItem = {
      id: item.key,
      // 只读行的标记留在**标签**上:值那一列是信息主体,不该被标记挤掉。
      label: shape.kind === 'inert' ? `(只读) ${item.label}` : item.label,
      currentValue: item.value,
      ...(item.detail ? { description: item.detail } : {}),
    };
    if (shape.kind === 'cycle') return { ...base, values: [...shape.values] };
    if (shape.kind === 'submenu') return { ...base, submenu: subFactory(item, shape.sub) };
    // ★ 单元素 values = 借 onChange 当激活回调(见文件头)。值原地不动。
    if (shape.kind === 'activate') return { ...base, values: [item.value] };
    return base; // inert:两样都不给 → Enter 什么都不做
  });
}

/**
 * `SettingsList` 那两行**硬编码英文**的键位提示(`settings-list.js:169-174`:
 * `Enter/Space to change · Esc to cancel`,前面还垫一个空行)。
 *
 * ## 为什么是滤掉而不是翻译
 *
 * omd 的对话框把键位提示画在**标题上**(`dialog.ts` 的 `titleOf`),整仓一致。
 * 留着这两行等于同一句话说两遍,而且一句中文一句英文。翻译要在渲染后改串,
 * 与滤掉是同一个动作、多一份要维护的译文。
 *
 * ⚠ pi-tui 改了这句话的措辞 → 这里就滤不掉了,**症状是英文重新上屏**(fail-open,
 * 看得见)。所以配了一条闸钉住"渲染结果里不该有英文键位提示"
 * (`settings-panel.test.ts`),pi-tui 一改措辞它当场红。
 */
const PI_HINTS = ['Enter/Space to change', 'Type to search'];

class HintStripped implements Component {
  constructor(private inner: Component) {}
  render(width: number): string[] {
    const lines = this.inner.render(width);
    const cut = lines.findIndex((l) => PI_HINTS.some((h) => l.includes(h)));
    if (cut < 0) return lines;
    // 提示行前面那个空行也一起去掉 —— 留着就是一行凭空的空白(首屏密度正是 P1 在治的)。
    return lines.slice(0, cut > 0 && lines[cut - 1]?.trim() === '' ? cut - 1 : cut);
  }
  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }
  invalidate(): void {
    this.inner.invalidate();
  }
}

/**
 * 面板。同时也是**焦点目标**(它自己收键,再往 `SettingsList` 转)。
 *
 * ## 两个视图,只画一个标题
 *
 * 主表画在 omd 的卡片框里(与其它对话框同一个外壳,标题带中文键位提示);
 * 子层**原样交给它自己**画 —— 子层本身就是一个 `DialogBox`,自带框与标题。
 *
 * ⚠ 不这么分的代价是实测过的:主表外面套一层 `DialogBox` 之后,子层开着时
 * 外框的标题**还在画** `改哪一项?`,而框里写着 `conductor 换成哪个模型?` ——
 * 屏幕上同时挂两个标题,而且 PTY 那几条"锚 lastIndexOf 先后"的判据会因为
 * `改哪一项` 一直在重画而失效(那正是本仓那一族假绿的形状)。
 */
export class SettingsPanel implements Component {
  private main: DialogBox;
  constructor(
    private list: SettingsList,
    theme: OmdTuiTheme,
    title: string,
    /** 子层开着没有?由 `submenu` 工厂与 `done` 两头置位 —— `SettingsList` 不对外报这件事。 */
    private isSubmenuOpen: () => boolean,
  ) {
    // ⚠ 这个 `DialogBox` 只用来**画框** —— 键从来不走它(焦点在本组件上),所以 onKey 空着。
    this.main = new DialogBox(theme, title, new HintStripped(list), () => undefined);
  }
  render(width: number): string[] {
    return this.isSubmenuOpen() ? this.list.render(width) : this.main.render(width);
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
  invalidate(): void {
    this.list.invalidate();
  }
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const shapes = new Map(deps.items.map((it) => [it.key, shapeOf(it, { painters: deps.painters })] as const));
  let submenuOpen = false;

  const seatSubmenu = (item: SettingItem): PiSettingItem['submenu'] => (currentValue, rawDone) => {
    const done = (v?: string): void => {
      submenuOpen = false;
      rawDone(v);
    };
    submenuOpen = true;
    const role = item.key.slice('seat:'.length);
    // `(未配)` / `(解析不到)` 这类不是坐标 —— 当"没有当前值"处理,别拿它去预填手输框。
    const current = currentValue.startsWith('(') ? '' : currentValue;
    const slot = new SwapSlot();
    const manual = (): void => {
      slot.set(inputComponent(deps.theme, deps.seatManual(role, current), (v) => done(v ?? undefined), deps.requestRender));
      deps.requestRender();
    };
    const opts = deps.seatChoices(role, current);
    const list = opts === null ? null : selectComponent(deps.theme, opts, (v) => (v === MANUAL_COORD ? manual() : done(v ?? undefined)), deps.requestRender);
    if (list === null) manual();
    else slot.set(list);
    return slot;
  };

  const textSubmenu = (item: SettingItem): PiSettingItem['submenu'] => (currentValue, rawDone) => {
    submenuOpen = true;
    return inputComponent(
      deps.theme,
      deps.textPrompt(item.key, currentValue),
      (v) => {
        submenuOpen = false;
        rawDone(v ?? undefined);
      },
      deps.requestRender,
    );
  };

  const piItems = toPiItems(deps, (item, sub) => (sub === 'seat' ? seatSubmenu(item) : textSubmenu(item)));

  const list = new SettingsList(
    piItems,
    deps.maxVisible ?? 12,
    deps.theme.settingsList,
    (id, value) => {
      if (shapes.get(id)?.kind === 'activate') {
        deps.activate(id);
        return;
      }
      const real = deps.apply(id, value);
      // ★ 真值与用户选的不一样 → 回显真值。这是"屏幕上说改好了而其实没改"的唯一拦法。
      if (real !== value) list.updateValue(id, real);
      deps.requestRender();
    },
    deps.onCancel,
    // 搜索**不开**:13 项一屏装得下, 而搜索框要吃掉 2 行(输入行 + 空行,
    // `settings-list.js:47-50`), 而首屏密度正是 P1 在治的读数(62% 非空行)。
    // 项数涨过一屏再开 —— 那时它换回来的是 `(n/N)` 计数,现在换不回任何东西。
    { enableSearch: false },
  );
  return new SettingsPanel(list, deps.theme, deps.title ?? '改哪一项?  (↑↓ 选, Enter 改, Esc 取消)', () => submenuOpen);
}
