/**
 * L2 判据:对话框四样(2026-08-07)。
 *
 * 静态体检读数:16 个已装 pi extension 里 **13 个要对话框 UI**,而 omd 一个都没建。
 * 这一片先按 omd 自己的需求建(`/seat` `/session` 用它),扩展宿主将来把 `ctx.ui.*` 映过来。
 *
 * `DialogHost` 走替身 —— 真宿主要 `TuiMainScreen` + 终端,而这里要测的是**交互语义**:
 * Esc 与"选了空值"分不分得开 · 一次只开一个 · 关掉之后 editor 回不回来。
 */
import type { Component } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, test } from 'bun:test';
import { type DialogBox, type DialogHost, confirm, input, inputComponent, select } from './dialog';
import { createTheme } from '../theme';
import { installOmdKeybindings } from '../keys';

const theme = createTheme({ color: false });

/** 假宿主:记下开了什么、关了几次,并把按键喂给当前焦点。 */
function fakeHost() {
  let current: Component | null = null;
  const log: string[] = [];
  const host: DialogHost = {
    get busy() {
      return current !== null;
    },
    open(component) {
      if (current) return false;
      current = component;
      log.push('open');
      return true;
    },
    close() {
      if (!current) return;
      current = null;
      log.push('close');
    },
    requestRender() {},
  };
  const key = (data: string): void => {
    (current as unknown as { handleInput?: (d: string) => void })?.handleInput?.(data);
  };
  return { host, key, log, render: (w = 60) => (current?.render(w) ?? []).join('\n'), get open() { return current !== null; } };
}

const OPTIONS = [
  { value: 'a', label: '第一个', description: '说明 A' },
  { value: 'b', label: '第二个' },
];

describe('select', () => {
  test('Enter 选中当前项', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'Pick one', options: OPTIONS });
    h.key('\r');
    expect(await p).toBe('a');
    expect(h.log).toEqual(['open', 'close']);
  });

  test('★ Esc 返回 null —— 与"选了一个空值"分得开', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'Pick one', options: OPTIONS });
    h.key('\x1b');
    expect(await p).toBeNull();
    expect(h.open).toBe(false);
  });

  test('★ 没有可选项时**不开框** —— 开一个空框让人按 Esc 是耍人', async () => {
    const h = fakeHost();
    expect(await select(h.host, theme, { title: 'x', options: [] })).toBeNull();
    expect(h.log).toEqual([]);
  });

  test('★ 已经有框开着 → 第二个直接返回 null, 不叠加', async () => {
    const h = fakeHost();
    const first = select(h.host, theme, { title: '第一个', options: OPTIONS });
    expect(await select(h.host, theme, { title: '第二个', options: OPTIONS })).toBeNull();
    h.key('\x1b');
    await first;
  });

  test('标题写清怎么操作(否则用户不知道能 Esc)', () => {
    const h = fakeHost();
    void select(h.host, theme, { title: 'Pick one', options: OPTIONS });
    const out = h.render();
    expect(out).toContain('Pick one');
    expect(out).toContain('Esc cancel');
  });

  test('方向键交给 SelectList,不当成取消', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'x', options: OPTIONS });
    h.key('\x1b[B'); // ↓
    h.key('\r');
    expect(await p).toBe('b');
  });
});

describe('confirm', () => {
  test('是 / 否', async () => {
    const h1 = fakeHost();
    const p1 = confirm(h1.host, theme, '要不要?');
    h1.key('\r');
    expect(await p1).toBe(true);

    const h2 = fakeHost();
    const p2 = confirm(h2.host, theme, '要不要?');
    h2.key('\x1b[B');
    h2.key('\r');
    expect(await p2).toBe(false);
  });

  test('★ Esc 是 null 不是 false —— 取消与拒绝是两回事', async () => {
    const h = fakeHost();
    const p = confirm(h.host, theme, '要不要?');
    h.key('\x1b');
    expect(await p).toBeNull();
  });
});

describe('input', () => {
  test('打字 + Enter', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: '输入' });
    for (const c of 'hej') h.key(c);
    h.key('\r');
    expect(await p).toBe('hej');
  });

  test('★ Esc 返回 null;空串是**合法输入**不折算成 null', async () => {
    const h1 = fakeHost();
    const p1 = input(h1.host, theme, { title: 'x' });
    h1.key('\x1b');
    expect(await p1).toBeNull();

    const h2 = fakeHost();
    const p2 = input(h2.host, theme, { title: 'x' });
    h2.key('\r');
    expect(await p2).toBe('');
  });

  test('退格', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x', initial: 'abc' });
    h.key('\x7f');
    h.key('\r');
    expect(await p).toBe('ab');
  });

  test('★ 方向键不许画出 `[A` 那种假回显', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x' });
    h.key('\x1b[A');
    h.key('\r');
    expect(await p).toBe('');
  });

  test('initial 预填', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x', initial: '预填' });
    h.key('\r');
    expect(await p).toBe('预填');
  });
});

describe('★ 输入框换成 pi-tui `Input`(2026-08-08,还台账最大的那笔欠账)', () => {
  /**
   * 每条钉的都是**手搓那版根本做不到**的事 —— 所以这一组的证伪方式统一是:
   * 把 `inputComponent` 的非遮蔽分支改回手搓的 buf 版 → **前四条全红**。
   * (遮蔽那条相反:它钉的是"这一档**仍然**是手搓的",改成走 `Input` 会红。)
   */
  const THEME = createTheme({ color: false });
  const drive = (opts: { initial?: string; mask?: boolean }, keys: string[]): { value: string | null; box: DialogBox } => {
    let value: string | null = null;
    let settled = false;
    const box = inputComponent(THEME, { title: 't', ...opts }, (v) => {
      value = v;
      settled = true;
    }, () => {});
    for (const k of keys) {
      if (settled) break;
      box.handleInput(k);
    }
    return { value, box };
  };
  const shown = (box: DialogBox): string => box.render(60).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  test('★ 光标能往回移, 在中间插字(手搓版做不到 —— 它只能往后加)', () => {
    // 打 abc → ← ← → 在 a 与 b 之间插 X → 期望 aXbc
    const { value } = drive({}, ['a', 'b', 'c', '\x1b[D', '\x1b[D', 'X', '\r']);
    expect(value).toBe('aXbc');
  });

  test('★ 按词删除(ctrl+w)—— 手搓版只有退一格', () => {
    const { value } = drive({}, ['h', 'e', 'j', ' ', 'd', 'u', '\x17', '\r']);
    expect(value).toBe('hej ');
  });

  test('★ undo(ctrl+-)撤掉刚打的', () => {
    const { value } = drive({}, ['a', 'b', 'c', '\x1f', '\r']);
    // 撤掉之后不该还是 abc —— 具体撤到哪由 Input 的 undo 栈定, 这里只钉"它真的变了"。
    expect(value).not.toBe('abc');
  });

  test('Esc 仍然返回 null(与"输入了空串"分得开)', () => {
    const { value } = drive({}, ['a', '\x1b']);
    expect(value).toBeNull();
  });

  test('initial 会被带进去, 直接回车原样返回', () => {
    expect(drive({ initial: '900' }, ['\r']).value).toBe('900');
  });

  test('★ 遮蔽档**仍然是手搓的**, 且真的打星(`Input` 不支持遮蔽, 已核实)', () => {
    const { box } = drive({ mask: true }, ['s', 'k', '-', 'x']);
    const out = shown(box);
    expect(out).toContain('****');
    expect(out).not.toContain('sk-x'); // ★ 一个字符都不许上屏
  });
});

describe('★ 取消/确认键走 pi-tui 键位表(2026-08-08,还台账最后一笔欠账)', () => {
  /**
   * 判据钉的是**三种编码全认** —— 而这正是换之前做不到的:
   * 手列的 `Set` 认 `\x1b` 与 `\x1b\x1b`,**不认 kitty 的 `\x1b[27u`**(多字节序列, 集合收不齐)。
   *
   * **证伪方式**:把 `isCancel` 改回 `new Set(['\x1b','\x1b\x1b']).has` → kitty 那条当场红。
   * ⚠ 双 ESC 那条能绿, 靠的是 `installOmdKeybindings()` 把 `ctrl+alt+[` 加进了
   * `tui.select.cancel`(`keys.ts`)—— 所以这里**必须先装**, 否则是在量别的东西。
   */
  beforeAll(() => installOmdKeybindings());

  const cancelWith = async (key: string): Promise<string | null> => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'x', options: [{ value: 'a', label: 'A' }] });
    h.key(key);
    return p;
  };

  test('裸 ESC 关得掉', async () => {
    expect(await cancelWith('\x1b')).toBeNull();
  });

  test('★ 双 ESC 关得掉(pi-tui 默认表不认它 —— 靠 keys.ts 补的)', async () => {
    expect(await cancelWith('\x1b\x1b')).toBeNull();
  });

  test('★ kitty 协议的 ESC 关得掉(手列 Set **收不齐**的那一种)', async () => {
    expect(await cancelWith('\x1b[27u')).toBeNull();
  });

  test('确认键:回车与换行都认', async () => {
    for (const k of ['\r', '\n']) {
      const h = fakeHost();
      const p = select(h.host, theme, { title: 'x', options: [{ value: 'a', label: 'A' }] });
      h.key(k);
      expect(await p).toBe('a');
    }
  });
});

/**
 * ★ 搜索过滤(2026-08-21)—— **不用 pi 的 `SelectList.setFilter`**。
 *
 * ## 它要杀死的失效形态
 *
 * pi 那个的实现是(`dist/components/select-list.js:25-29` 实读):
 * `items.filter((it) => it.value.toLowerCase().startsWith(filter.toLowerCase()))`
 * —— **`value` 上的前缀匹配**,既不是模糊也不是子串,而且匹的是 `value` **不是 `label`**。
 *
 * omd 的七个 `search: true` 选择框里,`value` 全是 id / 坐标(session id、run id、
 * `provider:model`),而人看见并想去搜的是 label 里的标题。⇒「看得见的搜不到」。
 * 2026-08-21 把 `/session` 主标签换成标题之后,这个坑被**踩实**:标题就在眼前,打进去 0 命中。
 *
 * 证伪方式:把 `refilter()` 里的 `matching(query)` 换回 `list.setFilter(query)` →
 * 「按标题搜」「按描述搜」「子串不是前缀」三条当场红。
 */
describe('★ 选择框搜索:按 label / description 子串, 不是 pi 的 value 前缀', () => {
  beforeAll(() => installOmdKeybindings());
  const ROWS = [
    { value: 's-1787309805', label: '了解 outputstyle 和 omd-plain 输出格式', description: '2h 前 · 81KB' },
    { value: 's-1787223401', label: '审查 omd 的交付和修复 continuity 缺陷', description: '1d 前 · 3.1MB' },
    { value: 's-1787140022', label: '调查为什么任务状态仍为 open', description: '2d 前 · 454KB' },
  ];
  const openIt = (): ReturnType<typeof fakeHost> => {
    const h = fakeHost();
    void select(h.host, createTheme({ color: false }), { title: '切到哪个会话?', options: ROWS, search: true });
    return h;
  };

  test('★ 按标题搜 —— pi 的前缀匹配下这条永远 0 命中', () => {
    const h = openIt();
    for (const c of '审查') h.key(c);
    const body = h.render(90);
    expect(body).toContain('审查 omd 的交付');
    expect(body).not.toContain('了解 outputstyle');
  });

  test('★ 按描述搜 (pi 根本不看 description)', () => {
    const h = openIt();
    for (const c of '3.1MB') h.key(c);
    expect(h.render(90)).toContain('审查 omd 的交付');
  });

  test('★ 子串不是前缀 —— 打中间那段也要命中', () => {
    const h = openIt();
    for (const c of 'plain') h.key(c);
    expect(h.render(90)).toContain('了解 outputstyle');
  });

  test('多词 AND: 两个词都命中才留', () => {
    const h = openIt();
    for (const c of 'omd 交付') h.key(c);
    const body = h.render(90);
    expect(body).toContain('审查 omd 的交付');
    expect(body).not.toContain('了解 outputstyle'); // 有 omd 没有「交付」
  });

  test('★ 0 命中要在标题上看得见 —— 否则「搜不到」与「没这条」长得一样', () => {
    const h = openIt();
    for (const c of 'zzz') h.key(c);
    expect(h.render(90)).toContain('"zzz" 0');
  });

  test('退格回退查询串, 命中数跟着回来', () => {
    const h = openIt();
    for (const c of 'zzz') h.key(c);
    h.key('\x7f'); h.key('\x7f'); h.key('\x7f');
    expect(h.render(90)).toContain('了解 outputstyle');
    expect(h.render(90)).toContain('审查 omd 的交付');
  });

  test('value 仍然能搜 (id 前缀那条老路不许丢)', () => {
    const h = openIt();
    for (const c of '1787140022') h.key(c);
    expect(h.render(90)).toContain('调查为什么任务状态');
  });
});

/**
 * ★ Kitty 键盘协议下的可打印字符(2026-08-21)。
 *
 * ## 它要杀死的失效形态
 *
 * `ProcessTerminal` **启动即协商 Kitty 协议**(`dist/terminal.js:13` flags=7 →
 * disambiguate|report-event-types|report-alternates,`:101` `queryAndEnableKittyProtocol()`)。
 * 协议开着时,**连普通字母都以 CSI-u 序列到达** —— 而 CSI-u 里含 `\x1b`。
 * omd 两处手搓的「可打印」判据都以「`\x1b` 开头的一律不是」为前提,于是:
 *   · 选择框:Kitty/Ghostty/WezTerm 下**打字搜索整个静默失效**,标题却写着 `type to search`;
 *   · 遮蔽输入框:敲/粘 API key 时 `*` 一个都不涨,零报错。
 *
 * pi 自己的 `Input` 就防了这一手,注释原话(`dist/components/input.js:158-164`):
 * 「Decode before the control-char check since CSI-u sequences contain \x1b which would be rejected」。
 *
 * ⚠ **这一条是照 pi 的编码契约构造的输入,不是在真 Kitty 终端量的。**
 *   要坐实,在 Ghostty 里跑 `bun run scripts/tui-key-probe.ts` 看字母到达时的字节。
 *
 * 证伪方式:把两处的 `decodeKittyPrintable` 分支删掉 → 本组两条当场红。
 */
describe('★ Kitty CSI-u 下的可打印字符', () => {
  beforeAll(() => installOmdKeybindings());
  /** `a` 的 CSI-u:codepoint 97,无修饰键(mod=1)。 */
  const CSI_U_a = '\x1b[97u';
  const CSI_U_b = '\x1b[98u';

  test('★ 选择框: CSI-u 的字母进得了查询串 (此前被 `\\x1b` 那条拒掉)', () => {
    const h = fakeHost();
    void select(h.host, createTheme({ color: false }), {
      title: 'pick', search: true,
      // ⚠ 候选要选**互不含对方查询字符**的 —— 第一版用了 alpha/beta, 而 `beta` 里也有 `a`,
      //   子串匹配理应两条都命中, 是断言写错不是代码错。
      options: [{ value: 'x1', label: 'alpha' }, { value: 'x2', label: 'zulu' }],
    });
    h.key(CSI_U_a); // 'a'
    const body = h.render(80);
    expect(body).toContain('"a" 1');
    expect(body).toContain('alpha');
    expect(body).not.toContain('zulu');
  });

  test('★ 遮蔽输入框: CSI-u 的字母进得了缓冲 (此前 `*` 一个都不涨)', () => {
    const h = fakeHost();
    void input(h.host, createTheme({ color: false }), { title: 'key', mask: true });
    h.key(CSI_U_a);
    h.key(CSI_U_b);
    expect(h.render(60)).toContain('**');
  });

  test('方向键仍然不当字符收 (CSI-u 只认可打印那一档)', () => {
    const h = fakeHost();
    void select(h.host, createTheme({ color: false }), {
      title: 'pick', search: true,
      options: [{ value: 'x1', label: 'alpha' }, { value: 'x2', label: 'zulu' }],
    });
    h.key('\x1b[A'); // 上箭头
    expect(h.render(80)).not.toContain('「');
  });
});

/**
 * ★ 主列宽度与截断(2026-08-21)—— pi 的第四个构造参数此前没传。
 *
 * pi 默认 `min = max = 32`(`dist/components/select-list.js:3,125-126`)⇒ 主列**恒定 32 列**;
 * 截断走 `truncateToWidth(v, maxWidth, "")` —— **省略号是空串**,标题无声断掉,
 * 读起来像「这条就叫这个名字」。本仓的纪律是「剪掉了就得说剪了多少」。
 *
 * 证伪方式:把 `mkList` 的第四个参数删掉 → 本组两条红。
 */
describe('★ 选择框主列: 弹性宽度 + 截断要看得见', () => {
  beforeAll(() => installOmdKeybindings());
  const LONG = '了解 outputstyle 和 omd-plain 输出格式并且还要更长一点让它必须被截断';

  test('★ 长标题被截时带 `…`, 不是无声切掉', () => {
    const h = fakeHost();
    void select(h.host, createTheme({ color: false }), {
      title: 'pick', options: [{ value: 'v1', label: LONG, description: 'd' }],
    });
    const body = h.render(100);
    expect(body).toContain('…');
    expect(body).not.toContain(LONG); // 确实截了
  });

  test('短标题不被撑到 32 列 —— 描述列拿得回空间', () => {
    const h = fakeHost();
    void select(h.host, createTheme({ color: false }), {
      title: 'pick',
      options: [{ value: 'v1', label: 'ab', description: '这是描述' }, { value: 'v2', label: 'cd', description: '另一个' }],
    });
    const line = h.render(100).split('\n').find((l) => l.includes('ab'))!;
    // 主列下限 24 —— 描述不该被推到第 32 列开外。
    expect(line.indexOf('这是描述')).toBeLessThan(32);
  });
});
