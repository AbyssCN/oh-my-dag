/**
 * src/tui/components/dialog —— **对话框四样**:notify / select / confirm / input(2026-08-07)。
 *
 * ## 为什么现在做
 *
 * 静态体检读数(`docs/plan/2026-08-07-pi-ext-surface-scan.md`):16 个已装 pi extension 里
 * **13 个要对话框 UI**,而 omd 一个都没建。但它同时也是 omd **自己**要的东西 ——
 * `/seat` `/session` 现在全是文本命令,得先知道 id 才敢敲。
 *
 * ⇒ 先按 omd 自己的需求建(有真消费者,过可达性闸),扩展宿主将来把 `ctx.ui.*` 映到它上面。
 *
 * ## 换 editor 内容,不用 overlay(SDD §7.1 已裁决)
 *
 * pi 与 openclaw 在这一点上做法不同。取 pi 的:**0.84 新增了 overlay 焦点恢复状态机** ——
 * overlay 开着时 `setFocus(editor)` 不再稳定,下一次按键会被 overlay 自动夺回焦点,
 * 必须走 `handle.unfocus({target})`。换 container 内容没有这个状态机,更简单也更好测。
 *
 * ## 一次只开一个
 *
 * 对话框开着时再开一个 → **拒绝并说明**,不是叠上去。叠加之后"哪个在收键"就说不清了,
 * 而 Esc 会关掉哪一个也说不清。
 */
import { type Component, Input, SelectList, Text, decodeKittyPrintable, getKeybindings, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { StatusLine } from './status-line';
import { card } from '../design/tokens';
import { fitLine } from '../render/line';
import type { OmdTuiTheme } from '../theme';

/** 一个开着的对话框:它占住 editor 那一格,直到 `close()` 把 editor 放回去。 */
export interface DialogHost {
  /** 用 `component` 顶替输入区,焦点给 `focus`。已经有对话框开着 → 返回 `false`。 */
  open(component: Component, focus: Component): boolean;
  /** 关掉当前对话框,把 editor 放回去。**幂等**。 */
  close(): void;
  /** 有没有对话框开着(调用方据此拒绝第二个)。 */
  readonly busy: boolean;
  requestRender(): void;
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * ★ **取消键 / 确认键的判定,换成 pi-tui 的键位表**(2026-08-08,还台账最后一笔欠账)。
 *
 * ## 为什么不是"手列表换成 `matchesKey`"那么简单
 *
 * 台账原文写的是「换成 `matchesKey(data, Key.escape)`」,而本程实测把那条更正了
 * (台账 §1.1):**两张表各缺对方一种** —— omd 手列的认 `\x1b\x1b`(双 ESC)而 pi-tui 不认;
 * pi-tui 认 kitty 的 `\x1b[27u` 而 omd 不认。**照原文直接换会静默丢掉双 ESC。**
 *
 * 现在能换,是因为缺的那一种**已经用 pi-tui 自己的机制补进去了**:
 * `src/tui/keys.ts` 的 `installOmdKeybindings()` 把 `ctrl+alt+[`(= `\x1b\x1b` 这两个字节)
 * 加进了 `tui.select.cancel`。⇒ 走键位表**三种编码全认**,而且只剩一处真源。
 *
 * ⚠ `tui.select.cancel` 里还有 `ctrl+c`。对话框收不到它 —— Ctrl+C 由 input listener
 * **先于焦点分派**截走(`tui.ts` 焦点那一段)。所以"两次 Ctrl+C 退出"那条路不受影响。
 * ⚠ 这两个判定**必须在 `installOmdKeybindings()` 之后**才认双 ESC。生产里 `runOmdTui`
 * 开头就装;测试里各自 `beforeAll` 装(踩过一次:靠跨文件顺序变绿)。
 */
function isCancel(data: string): boolean {
  return getKeybindings().matches(data, 'tui.select.cancel');
}
function isConfirm(data: string): boolean {
  return getKeybindings().matches(data, 'tui.select.confirm');
}

/**
 * Esc 判定。**export 给审批单等自绘键位的框用** —— 同一处判据,不抄第二份。
 *
 * ⚠ 从 `Set` 换成函数是有意的:`Set.has` 只能比裸字节,而 kitty 协议下 Esc 是
 * `\x1b[27u` 这样的多字节序列 —— 用集合永远收不齐。
 */
export const ESC = { has: isCancel };
const ENTER = { has: isConfirm };

export interface SelectOpts {
  title: string;
  options: readonly SelectOption[];
  maxVisible?: number;
  search?: boolean;
}

/**
 * ★ **选择框组件**(不开框、不返 Promise)。2026-08-08 从 `select()` 里分出来。
 *
 * 分出这一层的唯一理由是 `SettingsList.submenu` —— 它要的是一个 `Component`,
 * 而**一次性 Promise 撑不住"父层留在栈里"**(交接 40 §7.4:确认时就 `host.close()`,
 * 子层打开时父层已经不在了)。于是同一份构造给两个消费者:
 * `select()` 把它开进 host;设置面板的子菜单直接把它当子组件返回。
 *
 * 选项为空 → 返回 `null`,调用方自己决定退路(**不开空框** —— 那是把人锁在一个
 * 只能按 Esc 的界面里)。
 */
export function selectComponent(
  theme: OmdTuiTheme,
  opts: SelectOpts,
  done: (value: string | null) => void,
  requestRender: () => void,
): DialogBox | null {
  if (opts.options.length === 0) return null;
  const toItem = (o: SelectOption) => ({ value: o.value, label: o.label, ...(o.description ? { description: o.description } : {}) });
  /**
   * ★ **第四个参数 `SelectListLayoutOptions` 此前没传**(2026-08-21 补)。
   *
   * pi 的默认值是 `min = max = DEFAULT_PRIMARY_COLUMN_WIDTH = 32`
   * (`dist/components/select-list.js:3, 125-126`), 于是 `clamp(widest, 32, 32)` ⇒
   * **主列恒定 32 列** —— 不随内容, 也不随终端宽。短候选表白留一大片, 长标题被切。
   *
   * 更糟的是默认截断:`truncateToWidth(displayValue, maxWidth, "")`
   * (`select-list.js:141`)—— **省略号是空串**, 标题在第 30 列处**无声**断掉,
   * 读起来像"这条就叫这个名字"。这违反本仓「剪掉了就得说剪了多少」那条。
   *
   * 这里给 24–48 的弹性区间 + 带 `…` 的截断。
   */
  const mkList = (rows: readonly SelectOption[]): SelectList =>
    new SelectList(rows.map(toItem), opts.maxVisible ?? 10, theme.editor.selectList, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
      truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, '…'),
    });
  let list = mkList(opts.options);
  /**
   * S-7:**可搜索**。四十个模型里靠上下箭头找一个是不能用的。
   *
   * ⚠ 只收**可打印字符**。控制序列(方向键是 `\x1b[A` 这样的多字节)必须原样交给
   * `SelectList` —— 把它们当成查询串会出现"按一下下箭头, 搜索框里多了个 `[A`"。
   */
  let query = '';
  let hits = opts.options.length;
  const titleOf = (): string => {
    const hint = opts.search ? 'type to search · ↑↓ select · Enter ok · Esc cancel' : '↑↓ select · Enter ok · Esc cancel';
    // 命中数画在标题上 —— 0 命中必须**看得见**, 否则「搜不到」与「没这条」长得一样。
    const q = opts.search && query ? `  "${query}" ${hits}` : '';
    return `${opts.title}${q}  (${hint})`;
  };
  /**
   * **omd 自己过滤 —— 不用 `SelectList.setFilter`。**
   *
   * ⚠ pi 那个的实现是(`dist/components/select-list.js:25-29` 实读):
   *   `items.filter((it) => it.value.toLowerCase().startsWith(filter.toLowerCase()))`
   * 也就是 **`value` 上的前缀匹配** —— 既不是模糊也不是子串, 而且匹的是 `value` **不是 `label`**。
   *
   * 后果在 omd 这边是致命的:七个 `search: true` 的选择框里, `value` 全是 id / 坐标
   * (session id、run id、`provider:model`), 而人看见并想去搜的是 **label 里的标题**。
   * 于是「看得见的搜不到,搜得到的看不见」。2026-08-21 把 `/session` 的主标签换成标题之后,
   * 这个坑从「难用」变成了**「标题就在眼前, 打进去 0 命中」** —— 同一次改动把它踩实了。
   *
   * 这里改成:**三字段(label / value / description)子串 + 多词 AND**, 大小写不敏感。
   * 不用 pi 的 `fuzzyFilter`(子序列)是因为短 CJK 串上子序列会给出很意外的命中。
   */
  const matching = (q: string): readonly SelectOption[] => {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (toks.length === 0) return opts.options;
    return opts.options.filter((o) => {
      const hay = `${o.label} ${o.value} ${o.description ?? ''}`.toLowerCase();
      return toks.every((t) => hay.includes(t));
    });
  };
  /** 重建候选表并换进框里(`SelectList` 没有 `setItems`)。 */
  const refilter = (): void => {
    const rows = matching(query);
    hits = rows.length;
    list = mkList(rows);
    box.setBody(list);
    box.setTitle(titleOf());
    requestRender();
  };

  const box = new DialogBox(theme, titleOf(), list, (data) => {
    if (ESC.has(data)) return done(null);
    if (ENTER.has(data)) return done(list.getSelectedItem()?.value ?? null);
    if (opts.search && (data === '\x7f' || data === '\b')) {
      query = query.slice(0, -1);
      refilter();
      return undefined;
    }
    if (opts.search) {
      // ★ **Kitty 键盘协议先解**(2026-08-21)。`ProcessTerminal` 启动即协商该协议
      // (`dist/terminal.js:13` flags=7 / `:101` queryAndEnableKittyProtocol), 之后**连普通字母
      // 都以 CSI-u 序列到达** —— 而 CSI-u 里含 `\x1b`, 会被下面那条「`\x1b` 开头的一律不是」
      // 拒掉。⇒ Kitty/Ghostty/WezTerm 下**打字搜索整个静默失效**, 而标题还写着 `type to search`。
      // pi 自己的 `Input` 就防了这一手, 注释原话:「Decode before the control-char check
      // since CSI-u sequences contain \x1b which would be rejected」(`dist/components/input.js:158-164`)。
      // 认不出 → `undefined` → 回落到下面的老判据, 所以这是**纯加法**。
      const kitty = decodeKittyPrintable(data);
      if (kitty !== undefined) {
        query += kitty;
        refilter();
        return undefined;
      }
      // 可打印 ASCII + 非控制的多字节(中文)都算查询串;`\x1b` 开头的一律不是。
      if (data.length > 0 && !data.startsWith('\x1b') && !/^[\x00-\x1f]/.test(data)) {
        query += data;
        refilter();
        return undefined;
      }
    }
    list.handleInput(data);
    requestRender();
    return undefined;
  });
  return box;
}

/**
 * 选择框。**返回 `null` = 用户按了 Esc**(与"选了一个空值"分得开)。
 *
 * @param maxVisible 一屏几行;超出由 `SelectList` 自己滚。
 */
export function select(host: DialogHost, theme: OmdTuiTheme, opts: SelectOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const box = selectComponent(theme, opts, (v) => finish(v), () => host.requestRender());
    const finish = (v: string | null): void => {
      host.close();
      resolve(v);
    };
    // 没有可选项时**不开框** —— 开一个空框让人按 Esc 是耍人。
    if (box === null) {
      resolve(null);
      return;
    }
    if (!host.open(box, box)) resolve(null);
    else host.requestRender();
  });
}

/** 确认框。`null` = Esc(**与"选了否"分得开** —— 取消和拒绝是两回事)。 */
export function confirm(host: DialogHost, theme: OmdTuiTheme, message: string): Promise<boolean | null> {
  return select(host, theme, {
    title: message,
    options: [
      { value: 'yes', label: 'yes' },
      { value: 'no', label: 'no' },
    ],
  }).then((v) => (v === null ? null : v === 'yes'));
}

export interface InputOpts {
  title: string;
  initial?: string;
  mask?: boolean;
}

/**
 * ★ **输入框组件**(不开框、不返 Promise)。与 `selectComponent` 同一条理由:
 * `SettingsList.submenu` 要 `Component`,而 `审批 token TTL` 那一项改的是一个**数**,
 * 没有候选表可选,只能给一个自持输入的子层。
 */
export function inputComponent(
  theme: OmdTuiTheme,
  opts: InputOpts,
  done: (value: string | null) => void,
  requestRender: () => void,
): DialogBox {
  /**
   * ★ **遮蔽档保留手搓**(2026-08-08 换 pi-tui `Input` 时的例外)。
   *
   * 理由是**核实过的**,不是懒:`Input` **不支持遮蔽** ——
   * `mask` / `password` / `echo` 在 `dist/components/input.js` 里 **0 命中**,
   * 它的 `render()` 直接把 `this.value` 切片画出去(`input.js:316-367`)。
   * 而凭证输入**一个字符都不许上屏**(屏幕会进截图、进 scrollback)。
   * ⇒ `/login` 落 key 这一条路继续走下面这个只有 buf + 退格的实现。
   * **代价说清楚**:这一档没有光标移动 / 粘贴 / undo / 按词删。凭证一般是整串粘,
   * 而粘贴在这里会被逐字符收下 —— 可以接受;真要改, 得先给 `Input` 提遮蔽支持。
   */
  if (opts.mask) {
    let buf = opts.initial ?? '';
    const line = new StatusLine('');
    const paint = (): void => line.setText(`> ${'*'.repeat(buf.length)}`);
    paint();
    return new DialogBox(theme, `${opts.title}  (Enter ok · Esc cancel)`, line, (data) => {
      if (ESC.has(data)) return done(null);
      if (ENTER.has(data)) return done(buf);
      if (data === '\x7f' || data === '\b') buf = buf.slice(0, -1);
      else {
        // ★ 同 selectComponent 那条: Kitty 协议下普通字母以 CSI-u 到达, 会被下面那条
        // 剥离正则**整段吃掉** ⇒ 敲/粘 API key 时 `*` 一个都不涨, 零报错。认不出回落, 纯加法。
        const kitty = decodeKittyPrintable(data);
        if (kitty !== undefined) {
          buf += kitty;
          paint();
          requestRender();
          return undefined;
        }
        // 只收可打印的:控制码/方向键进来会画出 `[A` 这种看起来像用户真打了字的假回显。
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端输入本来就是控制码
        const printable = data.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '').replace(/[\x00-\x1f\x7f]/g, '');
        if (!printable) return undefined;
        buf += printable;
      }
      paint();
      requestRender();
      return undefined;
    });
  }

  /**
   * ★ **非遮蔽档走 pi-tui `Input`**(还上台账里最大的那笔欠账)。
   *
   * 换来的不是省事,是手搓那版**根本没有**的东西:光标移动 · 横向滚动 · 粘贴缓冲 ·
   * kill-ring · undo 栈 · 按词删除/移动。手搓版只有"往后加字符"和"退一格" ——
   * 在里面改一个打错的字要把后面全删掉重打。
   *
   * ⚠ 键**全部原样转给它**:`Input` 自己认 Enter/Esc(`onSubmit`/`onEscape`,
   * `input.js:68-80`),这里再拦一道 `ESC`/`ENTER` 就会**抢在它前面**,
   * 于是 `ctrl+-`(undo)之类它认得的键反而进不去。
   * ⚠ `focused` 必须设:不设的话它不画光标(`input.js:367` 靠这个字段决定)。
   */
  const editor = new Input();
  editor.setValue(opts.initial ?? '');
  /**
   * ★ **`setValue` 之后光标停在开头, 必须显式移到末尾。**
   *
   * 实测(不是猜):`new Input(); setValue('abc'); handleInput('\x7f')` → 值仍是 `'abc'` ——
   * 光标在 0 位, 退格没得删。而这些框**几乎都是带初值开的**(`审批 TTL` 预填 `600`、
   * 手输坐标预填当前坐标), 于是症状是**"打开框按退格没反应"** —— 一个很难往这上面想的 bug。
   * 换 `Input` 那一版就踩了, 是既有的「退格」单测红出来的。
   *
   * `\x05` = `ctrl+e` = `tui.editor.cursorLineEnd`(pi-tui 默认表, 已核实)。
   */
  editor.handleInput('\x05');
  editor.focused = true;
  editor.onSubmit = (v: string) => done(v);
  editor.onEscape = () => done(null);
  return new DialogBox(theme, `${opts.title}  (Enter ok · Esc cancel)`, editor, (data) => {
    editor.handleInput(data);
    requestRender();
    return undefined;
  });
}

/** 单行输入框。`null` = Esc;空串是**合法输入**,不折算成 null。
 * `mask` = 回显打星(凭证输入 —— key 一个字符都不许上屏,屏幕会进截图与 scrollback)。 */
export function input(host: DialogHost, theme: OmdTuiTheme, opts: InputOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const box = inputComponent(theme, opts, (v) => finish(v), () => host.requestRender());
    const finish = (v: string | null): void => {
      host.close();
      resolve(v);
    };
    if (!host.open(box, box)) resolve(null);
    else host.requestRender();
  });
}

/**
 * 框本体:标题行 + 内容。**自己收键**(它拿焦点),把不认识的转给内容组件。
 *
 * 标题走 `fitLine` 截断不折行 —— 折了的话下面内容的行号会移位。
 */
export class DialogBox implements Component {
  constructor(
    private theme: OmdTuiTheme,
    private title: string,
    private body: Component,
    private onKey: (data: string) => void | undefined,
  ) {}

  /** 改标题(搜索态把查询串与命中计数画在标题上 —— 不另占一行)。 */
  setTitle(title: string): void {
    this.title = title;
  }

  /**
   * 换内容组件。搜索态重建 `SelectList` 用 —— pi 的 `SelectList` **没有 `setItems`**,
   * 换一批候选只能新建一个再塞进来。
   */
  setBody(body: Component): void {
    this.body = body;
  }

  render(width: number): string[] {
    // 卡片框形 (v5 审批单那张图的形): ┌─ 标题 ─…┐ / │ 内容 │ / └──┘。全部字形在白名单。
    // 窄到画不下框 (<16 列) 时退回无框 —— 框吃掉 4 列, 窄屏里内容比框重要。
    if (width < 16) return [this.theme.chrome.accent(fitLine(this.title, width)), ...this.body.render(width)];
    const innerW = width - 4;
    const t = fitLine(this.title, innerW - 2);
    return [
      this.theme.chrome.accent(fitLine(card.top(t, width, visibleWidth(t)), width)),
      ...this.body.render(innerW).map((l) => fitLine(card.side(l, innerW - visibleWidth(l)), width)),
      this.theme.chrome.dim(card.bottom(width)),
    ];
  }

  handleInput(data: string): void {
    this.onKey(data);
  }

  invalidate(): void {
    this.body.invalidate();
  }
}

/** `notify` 没有交互 —— 它就是"往记录里写一条"。留一个显式函数是为了让宿主映射有落点。 */
export function notify(append: (text: string) => void, message: string): void {
  append(message);
}

/** 让 `Text` 也能当对话框内容(纯展示型框)。 */
export function textBody(s: string): Component {
  return new Text(s);
}
