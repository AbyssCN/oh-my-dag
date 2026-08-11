/**
 * notify-gh 测试 (O-1 终裁 2026-08-11: waiting_human 提醒的 gh 通道)。
 *
 * 这条通道的两个职责各有一条闸:
 *  ① 人读那半 —— 提醒里必须够人**当场**决定下一步 (等了多久 · 自何时 · 手机上按得动的把手);
 *  ② 机器读那半 —— `**stale-at**` 锚是"同一轮不重复提醒"的幂等键, 必须**写读往返**成立。
 *
 * gh 全程注入 fixture, **永不真调 gh**。
 */
import { describe, expect, test } from 'bun:test';
import { createGhWaitingNotifier, ghWaitingReminderBody, parseStaleAt } from './notify-gh';
import type { GhResult, GhRunner } from './backend';
import type { WaitingLogEntry } from './types';

const ENTRY: WaitingLogEntry = {
  ticketId: '#31',
  waitingSince: '2026-08-08T00:00:00.000Z',
  waitedMs: 73 * 3_600_000,
  at: '2026-08-11T01:00:00.000Z',
};

describe('notify-gh — 提醒正文 (人读那半)', () => {
  test('含等了多久 / 自何时 / 手机上按得动的下一步把手', () => {
    const body = ghWaitingReminderBody(ENTRY);
    expect(body).toContain('已等 73h');
    expect(body).toContain('自 2026-08-08T00:00:00.000Z');
    // 把手必须是**评论指令**: 收到 GitHub 通知的人在手机上, path_rule 那条路他按不到。
    expect(body).toContain('/rule');
    expect(body).toContain('/confirm accept|reject');
    // 反向自检: 若把正文写成只有 `path_rule` 一条路 (删掉 /rule 那行), 上面两条当场红 ——
    // 而"提醒发出去了"这件事本身仍是绿的, 所以内容闸必须单独存在。
    expect(body).toContain('唯一真源'); // INV-1: 别让人以为手改 issue 状态就算裁了
  });
});

describe('notify-gh — stale-at 锚 (机器读那半, 幂等键)', () => {
  test('写读往返: 正文里的锚 = entry.at', () => {
    expect(parseStaleAt(ghWaitingReminderBody(ENTRY))).toBe(ENTRY.at);
  });

  test('★反向自检: 无锚的正文 → undefined (幂等键读不出来 = 每轮重发, 这条红才说明它在管事)', () => {
    expect(parseStaleAt('**waiting-human**: 这张票在等人裁\n\n- 已等 73h')).toBeUndefined();
    // 证伪方式 (实跑过): 把 ghWaitingReminderBody 尾行的 `**stale-at**: …` 删掉 → 上一条测试红。
  });

  test('锚只认整行形状: 行内提到 stale-at 的散文不算 (免得人随口一句就把幂等键伪造了)', () => {
    expect(parseStaleAt('我看了下 **stale-at**: 2026-01-01 这个字段')).toBeUndefined();
  });
});

describe('notify-gh — 发送 (fail-loud)', () => {
  const okr = (stdout = ''): GhResult => ({ stdout, exitCode: 0, stderr: '' });

  test('评论落到对的 issue number 上 (#31 → 31)', () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return okr();
    };
    createGhWaitingNotifier(gh)(ENTRY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'comment', '31']);
    expect(calls[0]![calls[0]!.indexOf('--body') + 1]).toBe(ghWaitingReminderBody(ENTRY));
  });

  test('票 id 不是 issue 号 (md 的 g1) → throw 且零 gh 调用 (不对着不存在的 issue 乱发)', () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return okr();
    };
    expect(() => createGhWaitingNotifier(gh)({ ...ENTRY, ticketId: 'g1' })).toThrow(/不是 issue 号/);
    expect(calls).toEqual([]);
  });

  test('gh 非零退出 → throw 带 stderr (静默失败 = 提醒没发出去却当发了)', () => {
    const gh: GhRunner = () => ({ stdout: '', exitCode: 1, stderr: 'HTTP 403' });
    expect(() => createGhWaitingNotifier(gh)(ENTRY)).toThrow(/403/);
  });
});
