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
import { type Component, SelectList, Text } from '@earendil-works/pi-tui';
import { StatusLine } from './status-line';
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

/** Esc 的所有常见编码。只认一种的话某些终端上就关不掉 —— 那是个开着出不来的框。 */
const ESC = new Set(['\x1b', '\x1b\x1b']);
/** 回车。 */
const ENTER = new Set(['\r', '\n']);

/**
 * 选择框。**返回 `null` = 用户按了 Esc**(与"选了一个空值"分得开)。
 *
 * @param maxVisible 一屏几行;超出由 `SelectList` 自己滚。
 */
export function select(
  host: DialogHost,
  theme: OmdTuiTheme,
  opts: { title: string; options: readonly SelectOption[]; maxVisible?: number; search?: boolean },
): Promise<string | null> {
  return new Promise((resolve) => {
    if (opts.options.length === 0) {
      // 没有可选项时**不开框** —— 开一个空框让人按 Esc 是耍人。
      resolve(null);
      return;
    }
    const list = new SelectList(
      opts.options.map((o) => ({ value: o.value, label: o.label, ...(o.description ? { description: o.description } : {}) })),
      opts.maxVisible ?? 10,
      theme.editor.selectList,
    );
    /**
     * S-7:**可搜索**。四十个模型里靠上下箭头找一个是不能用的。
     *
     * ⚠ 只收**可打印字符**。控制序列(方向键是 `\x1b[A` 这样的多字节)必须原样交给
     * `SelectList` —— 把它们当成查询串会出现"按一下下箭头, 搜索框里多了个 `[A`"。
     */
    let query = '';
    const titleOf = (): string => {
      const hint = opts.search ? '打字搜索, ↑↓ 选, Enter 确认, Esc 取消' : '↑↓ 选, Enter 确认, Esc 取消';
      const q = opts.search && query ? `  「${query}」` : '';
      return `${opts.title}${q}  (${hint})`;
    };
    const box = new DialogBox(theme, titleOf(), list, (data) => {
      if (ESC.has(data)) return finish(null);
      if (ENTER.has(data)) return finish(list.getSelectedItem()?.value ?? null);
      if (opts.search && (data === '\x7f' || data === '\b')) {
        query = query.slice(0, -1);
        list.setFilter(query);
        box.setTitle(titleOf());
        host.requestRender();
        return undefined;
      }
      // 可打印 ASCII + 非控制的多字节(中文)都算查询串;`\x1b` 开头的一律不是。
      if (opts.search && data.length > 0 && !data.startsWith('\x1b') && !/^[\x00-\x1f]/.test(data)) {
        query += data;
        list.setFilter(query);
        box.setTitle(titleOf());
        host.requestRender();
        return undefined;
      }
      list.handleInput(data);
      host.requestRender();
      return undefined;
    });
    const finish = (v: string | null): void => {
      host.close();
      resolve(v);
    };
    if (!host.open(box, box)) resolve(null);
    else host.requestRender();
  });
}

/** 确认框。`null` = Esc(**与"选了否"分得开** —— 取消和拒绝是两回事)。 */
export function confirm(host: DialogHost, theme: OmdTuiTheme, message: string): Promise<boolean | null> {
  return select(host, theme, {
    title: message,
    options: [
      { value: 'yes', label: '是' },
      { value: 'no', label: '否' },
    ],
  }).then((v) => (v === null ? null : v === 'yes'));
}

/** 单行输入框。`null` = Esc;空串是**合法输入**,不折算成 null。 */
export function input(host: DialogHost, theme: OmdTuiTheme, opts: { title: string; initial?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = opts.initial ?? '';
    const line = new StatusLine('');
    const paint = (): void => line.setText(`> ${buf}`);
    paint();
    const box = new DialogBox(theme, `${opts.title}  (Enter 确认, Esc 取消)`, line, (data) => {
      if (ESC.has(data)) return finish(null);
      if (ENTER.has(data)) return finish(buf);
      if (data === '\x7f' || data === '\b') buf = buf.slice(0, -1);
      else {
        // 只收可打印的:控制码/方向键进来会画出 `[A` 这种看起来像用户真打了字的假回显。
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端输入本来就是控制码
        const printable = data.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '').replace(/[\x00-\x1f\x7f]/g, '');
        if (!printable) return undefined;
        buf += printable;
      }
      paint();
      host.requestRender();
      return undefined;
    });
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

  render(width: number): string[] {
    return [this.theme.chrome.accent(fitLine(this.title, width)), ...this.body.render(width)];
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
