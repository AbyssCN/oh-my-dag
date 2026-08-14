/**
 * 切片②:**底栏那一行**(L1)。2026-08-09 从两行减到一行, owner 定的口径:
 * **「测不到的取消, 只保留有效信息。」**
 *
 * 三条硬规矩仍在, 只是形态变了:
 * - 订阅制不折算美元 → 订阅 provider **整段不画**(原来画「本地N+ 额度未知」);
 * - 拿不到就不画, 不画 0% → 窗口拿不到时 `ctx` **整段不画**;
 * - **词元 ≤ 12** —— 这是 gauntlet 那 5 跑判词唯一说得出的可测量量, 做成会红的闸。
 *
 * 逐条证伪方式(都实跑过):
 * - 「词元 ≤ 12」→ 把 `ctx` 段改回 `used/window pct` 三词元并把 cache 绝对数加回来 → 红;
 * - 「订阅段不画」→ 把 provider 过滤去掉 → 红;
 * - 「两个花费相同只画一个」→ 去掉相等判断 → 红;
 * - 「窗口未知不画 ctx」→ 去掉 `ratio !== null` → 红。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { WindowSummary } from '../usage/ledger';
import { fitLine } from './line';
import { FOOTER_MAX_TOKENS, countTokens, fmtUsd, formatStatusLine } from './statusbar';

const win = (over: Partial<WindowSummary> = {}): WindowSummary => ({
  since: 0,
  calls: 3,
  in: 312_000,
  out: 18_400,
  cacheHit: 276_000,
  costUsd: 0.42,
  unpriced: false,
  byProvider: [],
  ...over,
});

describe('fmtUsd', () => {
  test('未计价在场 → 后缀 + (下界, 不冒充真值)', () => {
    expect(fmtUsd(0.83, false)).toBe('$0.83');
    expect(fmtUsd(0.83, true)).toBe('$0.83+');
    expect(fmtUsd(12.34, false)).toBe('$12.3');
  });
});

describe('行① formatStatusLine —— segment 模型: 没数据的段不画', () => {
  test('全量样张(v5 形状)', () => {
    const line = formatStatusLine({
      ws: { repo: 'oh-my-dag', branch: 'main', dirty: 2, worktree: 'fanin' },
      seat: 'kimi-coding:k3',
      pressure: { systemTokens: 12_000, harnessTokens: 8000, historyTokens: 34_000, usedTokens: 46_000, windowTokens: 200_000, ratio: 0.23, source: 'estimate' },
      session: { costUsd: 0.83, unpriced: false, calls: 3 },
      win: win(),
    });
    // 会话 $0.83 与 5h $0.42 **不同** ⇒ 两个都画;相同的情形另有一条闸。
    expect(line).toBe('oh-my-dag main+2 wt:fanin │ kimi-coding:k3 │ ctx 23% │ $0.83/$0.42 3x │ ↑312k ↓18k cache88%');
    expect(countTokens(line)).toBeLessThanOrEqual(FOOTER_MAX_TOKENS);
  });

  test('★ 没跑过一轮: 无 pressure/session/win 段(不画 0, 不画 $0)', () => {
    const line = formatStatusLine({
      ws: { repo: 'x', branch: 'main', dirty: 0, worktree: null },
      seat: 'a:b',
      pressure: null,
      session: null,
      win: null,
    });
    expect(line).toBe('x main │ a:b');
    expect(line).not.toContain('$');
    expect(line).not.toContain('ctx');
  });

  test('★ 窗口未知 → 不画百分比(编分母算出的百分比比不画更坏)', () => {
    const line = formatStatusLine({
      ws: null,
      seat: 'a:b',
      pressure: { systemTokens: 4000, harnessTokens: 0, historyTokens: 1000, usedTokens: 5000, windowTokens: 0, ratio: null, source: 'estimate' },
      session: null,
      win: null,
    });
    // ★ 口径变了:窗口拿不到 ⇒ **整段不画**(原来画「ctx 5.0k 窗口未知」)。
    //   一个自己说"不知道"的段占 3 个词元, 却不能拿它做任何决定 —— AGENTS.md §4 第一条。
    expect(line).not.toContain('ctx');
    expect(line).not.toContain('未知');
  });

  test('非 git 仓: 工作区段整个不画', () => {
    expect(formatStatusLine({ ws: null, seat: 'a:b', pressure: null, session: null, win: null })).toBe('a:b');
  });

  /**
   * ★ 隔离档 run 的 worktree —— **omd 自己生成的分支名不许把其余段挤出屏幕**。
   *
   * 实测(2026-08-14,run1 的 worktree 里跑 L3 PTY):工作区段 94 列 + 分隔符 = 97/100,
   * 座位 / ctx / 花费 / token 四段全在屏外 ⇒ `SB-1` `SB-2` `SB-5` 同时红,而它们守的
   * 东西一个都没坏。病根是同一个 36 位 uuid 画了两遍(分支 `omd/run/<id>` + `wt:<id>`)。
   *
   * 反向自检(实跑):把 `shortenIds` 换成恒等函数 → 末尾那条长度断言当场红
   * (97 > 60)。只断言"含前 8 位"是不够的 —— 全长里也含前 8 位,那样会假绿。
   */
  test('★ omd/run/<uuid> 分支 + 同 uuid 的 worktree: id 缩到 8 位, 工作区段不吃满一行', () => {
    const line = formatStatusLine({
      ws: { repo: 'oh-my-dag', branch: 'omd/run/c02ac67d-3c28-4feb-8215-248bd38f89f1', dirty: 0, worktree: 'c02ac67d-3c28-4feb-8215-248bd38f89f1' },
      seat: 'kimi-coding:k3',
      pressure: { systemTokens: 12_000, harnessTokens: 0, historyTokens: 0, usedTokens: 12_000, windowTokens: 200_000, ratio: 0.06, source: 'usage' },
      session: null,
      win: null,
    });
    // id 缩到 8 位, 且**同一个 id 不画两遍**(分支里已经有了)。
    expect(line).toBe('oh-my-dag omd/run/c02ac67d │ kimi-coding:k3 │ ctx 6%');
    // 后面几段真的还在屏上 —— 这才是这条闸买的东西(缩 id 只是手段)。
    expect(line).toContain('kimi-coding:k3');
    expect(line).toContain('ctx 6%');
    expect(line.split('│')[0]!.length).toBeLessThan(60); // 恒等函数下这里是 97
  });

  /**
   * ★ **去重只在真重复时发生** —— 名字不同的 worktree,`wt:` 仍要画。
   * 少了这条,上面那条会诱导下一程把 `wt:` 整个删掉,而那会让"我在哪棵树上"从屏上消失。
   * 反向自检:把去重条件改成无条件跳过 → 这条当场红。
   */
  test('★ worktree 名不在分支里 → wt: 照画(去重不是删段)', () => {
    const line = formatStatusLine({
      ws: { repo: 'oh-my-dag', branch: 'feature/x', dirty: 0, worktree: 'fanin-swarm' },
      seat: 'a:b',
      pressure: null,
      session: null,
      win: null,
    });
    expect(line).toBe('oh-my-dag feature/x wt:fanin-swarm │ a:b');
  });
});

describe('★ 减法这件事本身要有闸(否则下一程会把字段加回来)', () => {
  const base = {
    ws: { repo: 'oh-my-dag', branch: 'main', dirty: 86, worktree: null },
    seat: 'kimi-coding:k3',
    pressure: { systemTokens: 1, harnessTokens: 0, historyTokens: 1, usedTokens: 6400, windowTokens: 1_049_000, ratio: 0.006, source: 'estimate' },
    session: { costUsd: 0, unpriced: false, calls: 10 },
  } as const;

  test('★★ 词元 ≤ 12(竞品 6–7;原来两行合计 25)', () => {
    const line = formatStatusLine({ ...base, win: win({ calls: 10 }) });
    expect(countTokens(line)).toBeLessThanOrEqual(FOOTER_MAX_TOKENS);
  });

  test('★ 订阅制 provider **整段不画** —— 测不到的额度不占词元', () => {
    const line = formatStatusLine(
      { ...base, win: win({ byProvider: [
        { provider: 'kimi-coding', calls: 3, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false },
        { provider: 'anthropic', calls: 1, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false },
      ] }) },
      { billing: { 'kimi-coding': 'subscription', anthropic: 'subscription' } },
    );
    expect(line).not.toContain('额度未知');
    expect(line).not.toContain('本地');
  });

  test('按量制 ≥2 个 provider 才拆分, 且带 $(单个不画 —— 与座位坐标重复)', () => {
    const two = formatStatusLine({ ...base, win: win({ byProvider: [
      { provider: 'deepseek', calls: 2, in: 1, out: 1, cacheHit: 0, costUsd: 1.2, unpriced: false },
      { provider: 'nobody', calls: 1, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: true },
    ] }) });
    expect(two).toContain('deepseek $1.20');
    expect(two).toContain('nobody $0.00+');
    const one = formatStatusLine({ ...base, win: win({ byProvider: [
      { provider: 'deepseek', calls: 2, in: 1, out: 1, cacheHit: 0, costUsd: 1.2, unpriced: false },
    ] }) });
    expect(one).not.toContain('deepseek $');
  });

  test('★ 会话花费与 5h 花费**相同** ⇒ 只画一个(两个 $0.00 说的是同一件事)', () => {
    const same = formatStatusLine({ ...base, session: { costUsd: 0, unpriced: false, calls: 10 }, win: win({ costUsd: 0, calls: 10 }) });
    expect(same).toContain('$0.00 10x');
    expect(same).not.toContain('/$'); // 相同时不画第二个数
    // 不同的时候两个都在, 但仍是**一个词元**
    const diff = formatStatusLine({ ...base, session: { costUsd: 0, unpriced: false, calls: 10 }, win: win({ costUsd: 0.42, calls: 10 }) });
    expect(diff).toContain('$0.00/$0.42');
    expect(countTokens(diff)).toBeLessThanOrEqual(FOOTER_MAX_TOKENS);
  });

  test('★ token 段用 ↑↓(都在字形白名单)且**不画绝对 cache 数**, 只留命中率', () => {
    const line = formatStatusLine({ ...base, win: win() });
    expect(line).toContain('↑312k ↓18k cache88%');
    expect(line).not.toContain('276k'); // 绝对 cache 数与命中率重复
    expect(line).not.toContain('in ');
    expect(line).not.toContain('out ');
  });

  test('cache 为 0 ⇒ cache那格不画(不画 0%)', () => {
    expect(formatStatusLine({ ...base, win: win({ cacheHit: 0 }) })).not.toContain('cache');
  });

  test('窗口空 ⇒ token 段与次数都不画(与"跑了但全是 0"分得开)', () => {
    const line = formatStatusLine({ ...base, session: null, win: null });
    expect(line).not.toContain('↑');
    expect(line).not.toMatch(/\d+x/); // 次数段整段不画(`ctx` 里那个 x 不算)
  });

  test('ssh/tmux:有才画', () => {
    expect(formatStatusLine({ ...base, win: win() }, { ssh: 'ms02', tmux: true })).toContain('ssh ms02 tmux');
    expect(formatStatusLine({ ...base, win: win() })).not.toContain('ssh');
  });

  test('走 fitLine 截断后不超宽(窄屏)', () => {
    const line = formatStatusLine({ ...base, win: win() }, { ssh: 'ms02', tmux: true });
    for (const w of [20, 40, 80]) expect(visibleWidth(fitLine(line, w))).toBeLessThanOrEqual(w);
  });
});
