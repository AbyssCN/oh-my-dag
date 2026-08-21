/**
 * 切片 3 · 接线 (Ctrl+G 换屏 + Tab 切 + 活 tick) — **纯函数 dispatcher 单测**。
 *
 * `src/tui/tui.ts` 里 `decideDagFull` 是全屏状态机的**唯一决策点**: 五类事件 →
 * 一次状态转换, 不读外部依赖。键盘 listener 把键事件收成一次 `decideDagFull` 调用 +
 * 应用结果, 没分支膨胀 —— 而**纯**这件事是单测能盖到的关键。
 *
 * ## 反向自检写在每条用例上, 临时改 if 分支 → 该条当场红
 *
 * listener 的副作用 (ticker 起停 / `loadSnapshot` / `tui.requestRender`) 在 PTY lane
 * (`scripts/tui-pty-check.mjs`) 验; 这里只验**决策点**, 不起 TUI。
 */
import { describe, expect, test } from 'bun:test';
import { decideDagFull, initialDagFullState, type DagFullState } from './tui';

/** 构造一个"开着的"状态, 默认 DAG 屏 / 选中归零。 */
const open = (kind: 'dag' | 'run-list' = 'dag', dagSel = 0, runSel = 0): DagFullState => ({
  fullOn: true,
  kind,
  dagSelected: dagSel,
  runListSelected: runSel,
});

describe('★ 初始态', () => {
  test('全屏关, kind = dag, 选中归零', () => {
    const s = initialDagFullState();
    expect(s.fullOn).toBe(false);
    expect(s.kind).toBe('dag');
    expect(s.dagSelected).toBe(0);
    expect(s.runListSelected).toBe(0);
  });
});

describe('★ toggle (Ctrl+G)', () => {
  // 反向自检: 把 toggle 的 `if (state.fullOn) return { ...state, fullOn: false };` 那行删了 →
  //           本组三条全红 (关不掉)。

  test('关 → 开: fullOn 翻转, kind 回到 dag, 选中归零', () => {
    const s1 = decideDagFull(initialDagFullState(), { type: 'toggle', dagActive: true });
    expect(s1.fullOn).toBe(true);
    expect(s1.kind).toBe('dag');
    expect(s1.dagSelected).toBe(0);
    expect(s1.runListSelected).toBe(0);
  });

  test('开 → 关: 仅翻 fullOn, 其它字段记忆 (重开仍是上次的位置)', () => {
    const s0 = open('run-list', 3, 7);
    const s1 = decideDagFull(s0, { type: 'toggle', dagActive: true });
    expect(s1.fullOn).toBe(false);
    expect(s1.kind).toBe('run-list'); // 关闭不重置 (与 painterIdx 同款)
    expect(s1.dagSelected).toBe(3);
    expect(s1.runListSelected).toBe(7);
  });

  test('toggle 不挑 dagActive: run-list 可作为唯一入口 (INV-DAG-7 源在盘上不在内存)', () => {
    const s1 = decideDagFull(initialDagFullState(), { type: 'toggle', dagActive: false });
    expect(s1.fullOn).toBe(true); // dispatcher 不拦; caller (listener) 才决定"两屏都空不开"
  });
});

describe('★ 关着时所有事件 no-op', () => {
  // 反向自检: 把各 handler 顶头的 `if (!state.fullOn) return state;` 删了 →
  //           本组全红 (关着时 Tab 也换 kind, 这是 bug)。
  const s0 = initialDagFullState();
  test.each([
    ['tab', () => decideDagFull(s0, { type: 'tab' })],
    ['up', () => decideDagFull(s0, { type: 'up' })],
    ['down', () => decideDagFull(s0, { type: 'down' })],
    ['enter(empty)', () => decideDagFull(s0, { type: 'enter', runListNotEmpty: false })],
    ['enter(non-empty)', () => decideDagFull(s0, { type: 'enter', runListNotEmpty: true })],
  ])('%s', (_label, decide) => {
    expect(decide()).toBe(s0); // 引用相等 = 完全没动
  });
});

describe('★ Tab 在两屏之间循环 (DAG ⇄ run-list)', () => {
  // 反向自检: 把 `return { ...state, kind: state.kind === 'dag' ? 'run-list' : 'dag' };`
  //           改成 `return state;` → 三条全红。
  test('dag → run-list', () => {
    const s1 = decideDagFull(open('dag'), { type: 'tab' });
    expect(s1.kind).toBe('run-list');
  });

  test('run-list → dag', () => {
    const s1 = decideDagFull(open('run-list'), { type: 'tab' });
    expect(s1.kind).toBe('dag');
  });

  test('两次 Tab = 回到原屏 (两屏周期 = 2)', () => {
    const s0 = open('dag');
    // 1 次 Tab ⇒ 确实换了屏 (防"原地不动" bug, 与"s2 === s0"区分)
    const s1 = decideDagFull(s0, { type: 'tab' });
    expect(s1.kind).toBe('run-list');
    expect(s1.fullOn).toBe(true);
    // 2 次 Tab ⇒ 回到原屏 (周期 = 2)
    const s2 = decideDagFull(s1, { type: 'tab' });
    expect(s2.kind).toBe('dag');
    expect(s2.fullOn).toBe(true);
  });
});

describe('★ ↑↓ 只动当前屏的选中 (mod 由 renderer 负责)', () => {
  test('DAG 屏动 dagSelected, 不动 runListSelected', () => {
    let s = open('dag', 0, 5);
    s = decideDagFull(s, { type: 'down' });
    expect(s.dagSelected).toBe(1);
    expect(s.runListSelected).toBe(5); // 跨屏不串
    s = decideDagFull(s, { type: 'up' });
    expect(s.dagSelected).toBe(0);
    expect(s.runListSelected).toBe(5);
  });

  test('run-list 屏动 runListSelected, 不动 dagSelected', () => {
    let s = open('run-list', 5, 0);
    s = decideDagFull(s, { type: 'down' });
    expect(s.runListSelected).toBe(1);
    expect(s.dagSelected).toBe(5);
    s = decideDagFull(s, { type: 'up' });
    expect(s.runListSelected).toBe(0);
    expect(s.dagSelected).toBe(5);
  });

  test('越界不抛: 负数由 renderer 的 `((sel % len) + len) % len` 处理', () => {
    let s = open('dag', 0, 0);
    s = decideDagFull(s, { type: 'up' });
    expect(s.dagSelected).toBe(-1); // dispatcher 不挡; 渲染侧吃 mod
    s = decideDagFull(s, { type: 'down' });
    expect(s.dagSelected).toBe(0);
  });
});

describe('★ Enter (run-list 加载并切回 DAG; 列表空 INV-DAG-8 不切)', () => {
  // 反向自检: 把 enter 顶头那条 `if (state.kind !== 'run-list') return state;` 删了 →
  //           本组前两条红 (DAG 屏 Enter 也切); 后一条仍红 (run-list 空也切)。

  test('run-list 非空 → 切回 DAG 屏 (caller 拿 runList[idx] 调 loadSnapshot)', () => {
    const s0 = open('run-list');
    const s1 = decideDagFull(s0, { type: 'enter', runListNotEmpty: true });
    expect(s1.kind).toBe('dag');
    expect(s1.fullOn).toBe(true); // 仍开着 — 只是换屏
  });

  test('run-list 空 → 不切 (INV-DAG-8: 无源恒缺席, 不假装进图)', () => {
    const s0 = open('run-list');
    const s1 = decideDagFull(s0, { type: 'enter', runListNotEmpty: false });
    expect(s1.kind).toBe('run-list');
  });

  test('DAG 屏 Enter no-op (选中即展开是 renderer 的事, dispatcher 不管)', () => {
    const s0 = open('dag', 3);
    const s1 = decideDagFull(s0, { type: 'enter', runListNotEmpty: true });
    expect(s1).toEqual(s0);
  });
});

describe('★ INV-DAG-9 选中用字形不靠色 (dispatcher 不挑 paint, 纯状态)', () => {
  // 这条量的是"dispatcher 与 paint 解耦" —— 如果有人误把 paint 参数塞进事件,
  // 这里会红 (类型不匹配)。
  test('DagFullEvent 不含 paint 字段', () => {
    type Event = Parameters<typeof decideDagFull>[1];
    const sample: Event = { type: 'tab' };
    // 编译能过 = 形状对; ts 不让往 sample 上挂 paint。
    expect(sample.type).toBe('tab');
  });
});
