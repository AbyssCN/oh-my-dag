/**
 * src/tui/components/settings-panel.test —— 设置面板的闸。
 *
 * ## 为什么这些断言值得写(每条都带证伪方式)
 *
 * 迁到 `SettingsList` 之前,这一片的判据全在 PTY 里(SET-8/9/10/11)。PTY 能证明
 * "键路径通了",但它**读不出**两件真正的目标:说明有没有单独占一行、退回子层之后
 * 选中行还在不在。所以这些用组件直驱(`handleInput` + `render`),PTY 只留守键路径。
 *
 * 逐条的证伪方式:
 * - 「说明单独一行不被截断」→ 把 `description` 塞回 label 里 → 当场红。
 * - 「只读项 Enter 什么都不做」→ 给它一个 `values` → 当场红。
 * - 「子层 Esc 只关子层」→ 把子层的 `done()` 换成调 `onCancel()` → 当场红
 *   (这正是交接 40 §4.4 要的那个反测)。
 * - 「选中行不丢」→ 把 `closeSubmenu` 的还原去掉(等价于回到重开父层的老做法)→ 当场红。
 * - 「回显真值」→ 让 `apply` 的返回值被忽略 → 当场红。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, test } from 'bun:test';
import { installOmdKeybindings } from '../keys';
import { MANUAL_COORD } from '../model-picker';
import type { SettingItem } from '../settings';
import { createTheme } from '../theme';
import { type SettingsPanelDeps, createSettingsPanel, shapeOf, toPiItems } from './settings-panel';

/**
 * ★ 照 boot 期做一遍(`tui.ts` 里 `new TuiAltScreen` 之后第一件事)。
 *
 * ⚠ **这不是仪式**:键位是**全局单例**,不在本文件装一遍的话,「双 ESC 也收工」那条
 * 只在 `keys.test.ts` 先跑过的时候才绿 —— 单独跑本文件就红,而合并跑是绿的。
 * 第一版正是这样(单跑 21/1,合并跑全绿)。那种绿是**跨文件顺序**给的,不是实装给的。
 */
beforeAll(() => installOmdKeybindings());

const THEME = createTheme({ color: false }); // 关色 = 恒等函数, 断言里不用剥 ANSI
const PAINTERS = ['树', '泳道甘特', '分层依赖'];
const W = 110;

/** 真实形状的一小撮项:一个座位 · 一个循环 · 一个文本子层 · 一个跳走 · 一个只读。 */
function sampleItems(): SettingItem[] {
  return [
    { key: 'seat:conductor', label: '座位 conductor', value: 'deepseek:v4-flash', action: 'seat' },
    { key: 'ui-sidebar', label: '左栏 DAG 默认', value: '开', detail: '写进 .omd/config.json 的 tui.ui.sidebar; 本程立即生效', action: 'ui-sidebar' },
    {
      key: 'approval-ttl',
      label: '审批 token TTL',
      value: '900s',
      detail: '「a 批准同档」的免审窗口; 写进 tui.approvals.tokenTtlSec, 重启才生效(闸启动时读一次)',
      action: 'approval-ttl',
    },
    { key: 'providers', label: 'provider 凭证', value: '2 已配 / 3 未配', detail: '选中进 /login', action: 'login' },
    { key: 'glyphs', label: '字形白名单', value: '94 可用 / 0 待量 / 11 不用', detail: '已在真终端量过' },
  ];
}

interface Calls {
  applied: [string, string][];
  activated: string[];
  cancelled: number;
}

function harness(over: Partial<SettingsPanelDeps> = {}): { panel: ReturnType<typeof createSettingsPanel>; calls: Calls; deps: SettingsPanelDeps } {
  const calls: Calls = { applied: [], activated: [], cancelled: 0 };
  const deps: SettingsPanelDeps = {
    theme: THEME,
    items: sampleItems(),
    painters: PAINTERS,
    maxVisible: 12,
    seatChoices: (role, current) => ({
      title: `${role} 换成哪个模型?`,
      options: [
        { value: 'deepseek:v4-flash', label: `v4-flash  [deepseek]${current === 'deepseek:v4-flash' ? ' ✓' : ''}` },
        { value: 'kimi:k3', label: 'k3  [kimi]' },
      ],
    }),
    seatManual: (role) => ({ title: `${role} 换成哪个坐标? (provider:model)` }),
    textPrompt: () => ({ title: '审批 token TTL(秒)', initial: '900' }),
    apply: (id, value) => {
      calls.applied.push([id, value]);
      return value;
    },
    activate: (id) => {
      calls.activated.push(id);
    },
    onCancel: () => {
      calls.cancelled += 1;
    },
    requestRender: () => {},
    ...over,
  };
  return { panel: createSettingsPanel(deps), calls, deps };
}

const text = (panel: { render: (w: number) => string[] }): string => panel.render(W).join('\n');
/** 某个子串在这一行里的**起始列**(不是码元下标 —— 中文一个码元两列)。 */
const startCol = (line: string, needle: string): number => visibleWidth(line.slice(0, line.indexOf(needle)));
/**
 * 焦点行 = 带 `→ ` 光标的那一行(关色下光标就是这两个字符)。
 *
 * ⚠ 用 `includes` 不用 `startsWith` —— 主表画在卡片框里, 每行前面还有 `│ `。
 */
const focusedLine = (panel: { render: (w: number) => string[] }): string => panel.render(W).find((l) => l.includes('→ ')) ?? '';

describe('shapeOf —— 一项只能是一种形状', () => {
  test('action 为空 ⇔ inert(与 settings.ts 的契约同一句话)', () => {
    expect(shapeOf({ key: 'x', label: 'x', value: 'v' }, { painters: PAINTERS })).toEqual({ kind: 'inert' });
  });
  test('座位 → 子层;TTL → 文本子层', () => {
    expect(shapeOf({ key: 'seat:leaf', label: 'l', value: 'v', action: 'seat' }, { painters: PAINTERS })).toEqual({ kind: 'submenu', sub: 'seat' });
    expect(shapeOf({ key: 'approval-ttl', label: 'l', value: 'v', action: 'approval-ttl' }, { painters: PAINTERS })).toEqual({ kind: 'submenu', sub: 'text' });
  });
  test('★ 循环表与 settings.ts 写的值逐字一致 —— 差一个字第一下 Enter 就不是翻转', () => {
    // `settings.ts:107` 写的是 `i.ui.sidebar ? '开' : '关'`。这条钉的就是那两个字。
    expect(shapeOf({ key: 'ui-sidebar', label: 'l', value: '开', action: 'ui-sidebar' }, { painters: PAINTERS })).toEqual({
      kind: 'cycle',
      values: ['开', '关'],
    });
    expect(shapeOf({ key: 'ui-painter', label: 'l', value: '树', action: 'ui-painter' }, { painters: PAINTERS })).toEqual({
      kind: 'cycle',
      values: PAINTERS,
    });
  });
  test('三条跳走的项归 activate', () => {
    for (const action of ['session', 'extensions', 'login'] as const) {
      expect(shapeOf({ key: 'k', label: 'l', value: 'v', action }, { painters: PAINTERS }).kind).toBe('activate');
    }
  });
});

describe('映到 pi-tui SettingItem', () => {
  test('只读项两样都不给(既没 values 也没 submenu)—— 那就是它动不了的机制', () => {
    const pi = toPiItems({ items: sampleItems(), painters: PAINTERS }, () => undefined);
    const ro = pi.find((x) => x.id === 'glyphs');
    expect(ro?.values).toBeUndefined();
    expect(ro?.submenu).toBeUndefined();
    expect(ro?.label).toContain('(只读)');
  });
  test('跳走项拿到的是**单元素** values —— 两元素会让值在屏幕上跳变', () => {
    const pi = toPiItems({ items: sampleItems(), painters: PAINTERS }, () => undefined);
    expect(pi.find((x) => x.id === 'providers')?.values).toEqual(['2 已配 / 3 未配']);
  });
  test('detail 进 description(不再拼进 label)', () => {
    const pi = toPiItems({ items: sampleItems(), painters: PAINTERS }, () => undefined);
    const ttl = pi.find((x) => x.id === 'approval-ttl');
    expect(ttl?.label).toBe('审批 token TTL');
    expect(ttl?.currentValue).toBe('900s');
    expect(ttl?.description).toContain('重启才生效');
  });
});

describe('渲染 —— 这一片真正要修的那两件', () => {
  test('★ 标签 | 值 两列对齐:值那一列的起始列所有行都一样', () => {
    const { panel } = harness();
    const rows = panel.render(W);
    // 拿两行有值的:座位行与只读行。值前面是"标签 + 补空格 + 两个空格分隔"。
    const seat = rows.find((l) => l.includes('座位 conductor'));
    const glyph = rows.find((l) => l.includes('字形白名单'));
    expect(seat).toBeDefined();
    expect(glyph).toBeDefined();
    // ⚠ 量的必须是**列宽**不是 `indexOf` —— 中文一个码元占两列, 两行的码元偏移本来就不等
    //   (实测 19 vs 14), 拿 indexOf 比会红在一个假问题上。第一版就踩了这个。
    expect(startCol(seat as string, 'deepseek:v4-flash')).toBe(startCol(glyph as string, '94 可用'));
  });

  test('★ 说明**单独一行**且不被截断 —— 修的就是帧上那个 `重启才生效(`', () => {
    const { panel } = harness();
    panel.handleInput('\x1b[B'); // ↓ 到 `左栏 DAG 默认`
    panel.handleInput('\x1b[B'); // ↓ 到 `审批 token TTL`
    const out = text(panel);
    expect(focusedLine(panel)).toContain('审批 token TTL');
    // 说明整句都在, 且**不在**焦点那一行上。
    expect(out).toContain('重启才生效(闸启动时读一次)');
    expect(focusedLine(panel)).not.toContain('重启才生效');
  });

  test('说明只给焦点项 —— 没被选中的项的说明不上屏', () => {
    const { panel } = harness();
    // 焦点在第一项(座位, 没有 detail)→ 别的项的说明一句都不该出现。
    expect(text(panel)).not.toContain('重启才生效');
    expect(text(panel)).not.toContain('tui.ui.sidebar');
  });
});

describe('外壳', () => {
  test('★ pi-tui 那行硬编码英文键位提示**不上屏** —— pi-tui 改措辞这条当场红', () => {
    const { panel } = harness();
    const out = text(panel);
    expect(out).not.toContain('Esc to cancel');
    expect(out).not.toContain('Enter/Space to change');
  });

  test('主表有中文标题(SET-2 的判据锚就在这句上)', () => {
    expect(text(harness().panel)).toContain('改哪一项?');
  });

  test('★ 子层开着时**不画**主表标题 —— 否则屏上同时挂两个标题, 且 PTY 的顺序判据会失效', () => {
    const { panel } = harness();
    panel.handleInput('\r');
    expect(text(panel)).toContain('换成哪个模型?');
    expect(text(panel)).not.toContain('改哪一项?');
  });
});

describe('激活语义', () => {
  test('★ 只读项按 Enter:apply / activate / onCancel 一个都不该被调', () => {
    const { panel, calls } = harness();
    for (let i = 0; i < 4; i++) panel.handleInput('\x1b[B'); // ↓ 到最后一项(只读)
    expect(focusedLine(panel)).toContain('字形白名单');
    panel.handleInput('\r');
    expect(calls).toEqual({ applied: [], activated: [], cancelled: 0 });
  });

  test('循环项按 Enter:值翻转并把新值交给 apply', () => {
    const { panel, calls } = harness();
    panel.handleInput('\x1b[B'); // → 左栏 DAG 默认(现在是「开」)
    panel.handleInput('\r');
    expect(calls.applied).toEqual([['ui-sidebar', '关']]);
    expect(focusedLine(panel)).toContain('关');
  });

  test('★ 写盘没成 → 屏幕回显**真值**, 不回显用户选的那个', () => {
    // apply 返回旧值 = "拒了/写失败"。这条钉的是"屏幕上说改好了而盘上没改"这一族。
    const { panel, calls } = harness({ apply: (id) => (id === 'ui-sidebar' ? '开' : 'x') });
    panel.handleInput('\x1b[B');
    panel.handleInput('\r');
    expect(focusedLine(panel)).toContain('开');
    expect(calls.applied).toEqual([]); // 覆盖掉的 apply 不记账, 这里只看回显
  });

  test('跳走项按 Enter:走 activate, **不走** apply', () => {
    const { panel, calls } = harness();
    for (let i = 0; i < 3; i++) panel.handleInput('\x1b[B'); // → provider 凭证
    expect(focusedLine(panel)).toContain('provider 凭证');
    panel.handleInput('\r');
    expect(calls.activated).toEqual(['providers']);
    expect(calls.applied).toEqual([]);
  });

  test('Esc 在主表这一层:收工', () => {
    const { panel, calls } = harness();
    panel.handleInput('\x1b');
    expect(calls.cancelled).toBe(1);
  });

  test('★ 双 ESC 也收工 —— pi-tui 默认表认不出它, `keys.ts` 补的那一格', () => {
    const { panel, calls } = harness();
    panel.handleInput('\x1b\x1b');
    expect(calls.cancelled).toBe(1);
  });
});

describe('★ 子层:退一级不退到底(交接 40 §4.3/§4.4)', () => {
  test('Enter 开出模型选单(选单顶到面板整格上)', () => {
    const { panel } = harness();
    panel.handleInput('\r');
    expect(text(panel)).toContain('conductor 换成哪个模型?');
    // 主表已经不画了 —— 子层是**顶替**不是叠加(`settings-list.js:41-45`)。
    expect(text(panel)).not.toContain('字形白名单');
  });

  test('★★ 子层 Esc → 回主表, 且 onCancel **一次都没被调**(这就是那个反测)', () => {
    const { panel, calls } = harness();
    panel.handleInput('\r');
    panel.handleInput('\x1b');
    expect(text(panel)).toContain('字形白名单'); // 主表回来了
    expect(calls.cancelled).toBe(0); // ★ 没有漏到"关整个设置页"
    expect(calls.applied).toEqual([]); // 取消什么都不改
  });

  test('★ 选中行不丢 —— 从第 3 行开的子层, 退回来还在第 3 行', () => {
    const { panel } = harness();
    for (let i = 0; i < 2; i++) panel.handleInput('\x1b[B'); // → 审批 token TTL(第 3 行)
    expect(focusedLine(panel)).toContain('审批 token TTL');
    panel.handleInput('\r'); // 开文本子层
    expect(text(panel)).toContain('审批 token TTL(秒)');
    panel.handleInput('\x1b'); // 退回来
    expect(focusedLine(panel)).toContain('审批 token TTL'); // ← 老做法(重开父层)这里会回到第 1 行
  });

  test('子层确认 → 值交给 apply 并回显', () => {
    const { panel, calls } = harness();
    panel.handleInput('\r'); // 座位子层
    panel.handleInput('\x1b[B'); // ↓ 到 kimi:k3
    panel.handleInput('\r'); // 确认
    expect(calls.applied).toEqual([['seat:conductor', 'kimi:k3']]);
    expect(focusedLine(panel)).toContain('kimi:k3');
  });

  test('目录空 → 子层是**手输框**, 不是空选单', () => {
    const { panel } = harness({ seatChoices: () => null });
    panel.handleInput('\r');
    expect(text(panel)).toContain('换成哪个坐标? (provider:model)');
  });

  test('子层里选「手动输入坐标…」→ 换成手输框(同一格里换, 不是叠一层)', () => {
    const { panel } = harness({
      seatChoices: (role) => ({
        title: `${role} 换成哪个模型?`,
        // 哨兵值从 `model-picker` 取 —— 抄一份字面量的话, 哪天它改了这条测试会假绿。
        options: [
          { value: 'a:b', label: 'a:b' },
          { value: MANUAL_COORD, label: '手动输入坐标…' },
        ],
      }),
    });
    panel.handleInput('\r');
    panel.handleInput('\x1b[B'); // ↓ 到手动那一行
    panel.handleInput('\r');
    expect(text(panel)).toContain('换成哪个坐标? (provider:model)');
    expect(text(panel)).not.toContain('换成哪个模型?');
  });
});

describe('★ 只读现状行排在末尾(P3 件2 轮1 的 critic 判词)', () => {
  /**
   * 判词原文:「'改哪一项?' 菜单里混入 3 个只读项(上下文/配色/字形白名单),与可改项并列同级」。
   * 判据钉的是**分区**(可改的一律在只读的前面),不是某几个 key 的固定位置 ——
   * 钉 key 的话以后加一项就得改判据,而分区才是这条判词要的那个不变量。
   *
   * 证伪方式(实跑过):把 `toPiItems` 里那个 `sort` 去掉 → 这一条当场红。
   */
  /**
   * ⚠ **夹具必须是交错的。** 第一版直接用 `sampleItems()`,而它本来就把唯一的只读项摆在末尾 ——
   * 于是去掉 `sort` 之后这条闸**照样 28 pass / 0 fail**(实跑过),空转。
   * 真实 `buildSettings` 是交错的(`07-settings` 帧行 18-20 夹在可改项中间),夹具照它的形。
   */
  const interleaved = (): SettingItem[] => [
    { key: 'seat:conductor', label: '座位 conductor', value: 'a:1', action: 'seat' },
    { key: 'ctx', label: '上下文', value: '(还没跑过一轮)' },
    { key: 'ui-sidebar', label: '左栏 DAG 默认', value: '开', action: 'ui-sidebar' },
    { key: 'theme', label: '配色', value: '16 色回退' },
    { key: 'approval-ttl', label: '审批 token TTL', value: '900s', action: 'approval-ttl' },
    { key: 'glyphs', label: '字形白名单', value: '94 可用 / 0 待量 / 11 不用' },
  ];

  const isReadonly = (id: string, items: readonly SettingItem[], painters: readonly string[]): boolean => {
    const it = items.find((x) => x.key === id);
    return it ? shapeOf(it, { painters }).kind === 'inert' : false;
  };

  test('可改项一律排在只读项之前', () => {
    const items = interleaved();
    const pi = toPiItems({ items, painters: PAINTERS }, () => undefined);
    const flags = pi.map((x) => isReadonly(x.id, items, PAINTERS));
    // 一旦出现只读, 后面不许再有可改的。
    const firstReadonly = flags.indexOf(true);
    expect(firstReadonly, '样例里得有只读项, 否则这条闸是空的').toBeGreaterThanOrEqual(0);
    expect(flags.slice(firstReadonly).some((f) => !f)).toBe(false);
  });

  test('一项都没丢(只重排, 不删)', () => {
    const items = interleaved();
    const pi = toPiItems({ items, painters: PAINTERS }, () => undefined);
    expect(pi.length).toBe(items.length);
    expect(new Set(pi.map((x) => x.id))).toEqual(new Set(items.map((x) => x.key)));
  });

  test('只读项仍带 (只读) 标记(重排不代替标记, 两样都要)', () => {
    const items = interleaved();
    const pi = toPiItems({ items, painters: PAINTERS }, () => undefined);
    for (const x of pi) if (isReadonly(x.id, items, PAINTERS)) expect(x.label).toContain('(只读)');
  });
});
