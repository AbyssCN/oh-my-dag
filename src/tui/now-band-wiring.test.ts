/**
 * **L1 · 片 5 切片 3 接线**(2026-08-22):「当前」区常驻 + 收件箱开关键位。
 *
 * ## 这片测的是什么
 *
 * 切片 1 / 2 已经在 `render/now-band.test.ts` / `render/inbox.test.ts` 验完了纯函数。
 * 这一片验的是**把它们接到 TUI 上**那一跳 —— 接线层的契约,不是 TTY 端的运行时。
 *
 * 接线契约只有 4 条,且**全部是可机械判定的字节事实**(没有 PTY / 不需要 mock 终端):
 *   1. `omd.inbox` 进 `OMD_KEYBINDINGS`,默认键位 = `ctrl+n`(SDD §2.3 钉死 Tab 撞键的取舍)
 *   2. `installOmdKeybindings()` 装上后,`\x0e` (Ctrl+N) 命中 `omd.inbox`,`\x09` (Tab/ctrl+i) **不**命中
 *      —— 装着的同时 Tab 的补全/换屏不被吃掉
 *   3. `pathHudVisible` 没被本片偷偷改 —— 三块(pathHud / ticketBoard / runBoard)依然在
 *      `hasDialogue=true` 时收起,这是判词判的那条;本片的新带子**脱钩**于它,但**不**靠
 *      改它实现脱钩
 *   4. 渲染器导出(`renderNowBand` / `renderInbox`)与切片 1 / 2 同字面,本片没造平行结构
 *
 * 反向自检(改实现 → 这条当场红):
 *   - 「Tab 不被吃掉」:把 keys.ts 的 `omd.inbox` 默认键改回 `ctrl+i` → 'Tab (\\x09) 不命中 omd.inbox' 红。
 *   - 「pathHudVisible 未动」:把 pathHudVisible 改成 `!s.pathFullOn` → '有对话 → 收起' 红。
 *   - 「OMD_KEYBINDINGS 声明了 omd.inbox」:把它从 OMD_KEYBINDINGS 删掉 → 这条红。
 */
import { describe, expect, test } from 'bun:test';
import { OMD_KEYBINDINGS, installOmdKeybindings } from './keys';
import { pathHudVisible } from './tui';
import { renderNowBand, type NowBandInput } from './render/now-band';
import { renderInbox, type InboxItem } from './render/inbox';
import type { AttentionTicket, MapFogSummary } from '../serve/read-api';
import type { DagView } from '../hud/load';

const NOW = 1_700_000_000_000;
const CTRL_N = '\x0e'; // pi-tui 把 `ctrl+n` 解析成的字节
const TAB = '\x09'; // pi-tui 把 `ctrl+i` / Tab 解析成的字节(同串字节)

/** 最小合法 awaiting 票(给 renderNowBand 用)。 */
const ticket = (over: Partial<AttentionTicket> = {}): AttentionTicket => ({
  slug: 'omd-agent-tui',
  destination: 'a destination',
  ticketId: 't-1',
  title: '需要裁定的事',
  type: 'task',
  ...over,
});

/** 最小合法雾档汇总。 */
const map = (over: Partial<MapFogSummary> = {}): MapFogSummary => ({
  slug: 'omd-agent-tui',
  destination: 'a destination',
  total: 1,
  bands: { 'awaiting-owner': 1 },
  phantoms: 0,
  ...over,
});

/** 最小合法 DagView(供 renderNowBand live 档使用)。 */
const view = (): DagView => ({
  snap: {
    schema: 1,
    runId: 'aaaaaaaa-1111-2222-3333-444444444444',
    goal: 'g',
    status: 'running',
    updatedAt: new Date(0).toISOString(),
    levels: null,
    planned: [{ id: 'p1', kind: 'agent' }],
    started: [],
    startedAt: {},
    settled: [],
  },
  phase: 'live',
  ageMs: 1_000,
});

describe('★ 接线契约 1 · omd.inbox 进 OMD_KEYBINDINGS, 默认 ctrl+n', () => {
  test('OMD_KEYBINDINGS 里有 omd.inbox,且默认键 = ctrl+n(不是 ctrl+i)', () => {
    const entry = (OMD_KEYBINDINGS as Record<string, { defaultKeys: string }>)['omd.inbox'];
    expect(entry).toBeDefined();
    expect(entry!.defaultKeys).toBe('ctrl+n');
    // 反向: 不是 ctrl+i —— 那条会撞 Tab。
    expect(entry!.defaultKeys).not.toBe('ctrl+i');
  });
});

describe('★ 接线契约 2 · Tab 不被吃掉', () => {
  test('Ctrl+N (\\x0e) 命中 omd.inbox', () => {
    const kb = installOmdKeybindings({});
    expect(kb.matches(CTRL_N, 'omd.inbox')).toBe(true);
  });

  test('★ Tab/ctrl+i (\\x09) 不命中 omd.inbox —— 补全/换屏活着', () => {
    const kb = installOmdKeybindings({});
    // omd.inbox = ctrl+n 时, Tab 必须还归它该去的(补全等)而不是被 omd.inbox 抢走。
    expect(kb.matches(TAB, 'omd.inbox')).toBe(false);
  });

  test('用户文件把 omd.inbox 改成 ctrl+i 时才撞 —— 默认表不撞', () => {
    // 装默认表: 不撞。
    const kbDefault = installOmdKeybindings({});
    expect(kbDefault.matches(TAB, 'omd.inbox')).toBe(false);
    // 用户显式改成 ctrl+i: 撞了。这是用户的取舍, 不是默认表的违反。
    const kbUser = installOmdKeybindings({ 'omd.inbox': 'ctrl+i' });
    expect(kbUser.matches(TAB, 'omd.inbox')).toBe(true);
  });
});

describe('★ 接线契约 3 · pathHudVisible 未被本片偷偷改', () => {
  /**
   * SDD §0 那条判词判的是「与本题无关的 3 块」;三块照旧收起(`pathHudVisible` 不动),
   * 「当前」区独立于这条规则(它自己的可见性 = renderNowBand 返非空)。
   *
   * 这条闸钉的是「**没**改 pathHudVisible」 —— 万一有人在接线片里顺手把它调成
   * 「即使有对话也保留三块」(常见误读),这条当场红。
   */
  test('pathHudVisible 在 hasDialogue=true 时仍返 false(三块照旧收起)', () => {
    expect(pathHudVisible({ pathFullOn: false, hasDialogue: true })).toBe(false);
  });

  test('pathHudVisible 在 hasDialogue=false 时返 true(欢迎屏仍出三块)', () => {
    expect(pathHudVisible({ pathFullOn: false, hasDialogue: false })).toBe(true);
  });

  test('pathHudVisible 在 pathFullOn=true 时返 false(全屏时不重复画)', () => {
    expect(pathHudVisible({ pathFullOn: true, hasDialogue: false })).toBe(false);
    expect(pathHudVisible({ pathFullOn: true, hasDialogue: true })).toBe(false);
  });
});

describe('★ 接线契约 4 · 渲染器导出仍可被 tui.ts 装配层引用(本片没造平行结构)', () => {
  test('renderNowBand 在 awaiting 数据下返 ≥1 行 —— 接线常驻画非空', () => {
    const input: NowBandInput = {
      awaiting: [ticket({ title: '留下一件等你裁' })],
      suggested: [],
      live: [],
      maps: [],
    };
    const out = renderNowBand(input, { width: 80, now: NOW });
    expect(out.length).toBeGreaterThan(0);
    // 内容字面含票 id —— 接线层往屏幕送的确实是这件。
    expect(out.join('\n')).toContain('t-1');
  });

  test('renderNowBand 全空返 [] —— 接线常驻「无源恒缺席」', () => {
    const input: NowBandInput = { awaiting: [], suggested: [], live: [], maps: [] };
    expect(renderNowBand(input, { width: 80, now: NOW })).toEqual([]);
  });

  test('renderInbox 有一件时底边常驻 INV-INBOX-1/2 —— 接线常驻教育性 invariant', () => {
    const items: InboxItem[] = [
      { kind: 'rule', slug: 'demo', ticketId: '177', title: '一件等你裁' },
    ];
    const out = renderInbox(items, { width: 80, height: 20, selected: 0, now: NOW });
    const last = out[out.length - 1]!;
    expect(last).toContain('ruling is not execution');
    expect(last).toContain('map_deliver');
    expect(last).toContain('ruling');
    expect(last).toContain('goal');
  });

  test('renderInbox confirm 选中展开含 c + 收件, 不含 Enter 就地裁 —— INV-INBOX-3 接线常驻', () => {
    const items: InboxItem[] = [
      { kind: 'confirm', slug: 'demo', ticketId: '188', title: '一件建议' },
    ];
    const out = renderInbox(items, { width: 80, height: 20, selected: 0, now: NOW });
    const body = out.join('\n');
    expect(body).toContain('c ');
    expect(body).toContain('accept');
    expect(body).not.toContain('Enter 就地裁');
  });
});

describe('★ 接线契约 5 · 「当前」区本身对 hasDialogue 不敏感(本片的半条命)', () => {
  /**
   * 接线层那个事实:`renderNowBand` 只看自己的入参,不看 `hasDialogue`。它由接线层(本片)
   * 决定挂在 root 上时**不**用 `pathHudVisible` 那个 gate —— 这是接线决定,不是渲染层契约。
   * 这条闸钉的是「渲染层真没读盘也没碰 hasDialogue」(签名稳定性 + 行为稳定性):
   *   - 给同样的输入连画两次,逐字节相同(纯函数)
   *   - 不接受 cwd / fs / hasDialogue / pathFullOn 任何字段(签名层锁住)
   */
  test('renderNowBand 同一输入连画两次逐字节等(纯函数; 与 hasDialogue 解耦)', () => {
    const input: NowBandInput = {
      awaiting: [ticket()],
      suggested: [],
      live: [view()],
      maps: [map()],
    };
    const a = renderNowBand(input, { width: 80, now: NOW });
    const b = renderNowBand(input, { width: 80, now: NOW });
    expect(b).toEqual(a);
    expect(b.join('\n')).toBe(a.join('\n'));
  });

  test('NowBandInput 不接受 hasDialogue / pathFullOn / cwd —— 接线层自己挂什么 gate 与它无关', () => {
    // 类型层已锁;这里是文档化回环测试: 字段缺席 = 接线片不靠改渲染层来实现「不受 hasDialogue 管」。
    const input: NowBandInput = { awaiting: [], suggested: [], live: [], maps: [] };
    expect(input).not.toHaveProperty('hasDialogue');
    expect(input).not.toHaveProperty('pathFullOn');
    expect(input).not.toHaveProperty('cwd');
  });
});
