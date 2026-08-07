/**
 * L1 判据:多会话切换(2026-08-07)。
 *
 * 数据面(`listSessions` / `loadHistory` / `ChatStore` 按 id 分文件)从 S10 起就在,
 * 缺的只是入口 —— 于是"多会话"**技术上成立、用户上不存在**。这一片补的是入口。
 */
import { describe, expect, test } from 'bun:test';
import type { TuiSessionMeta } from './backend';
import { ChatLog } from './components/chat-log';
import { formatSessions, newSessionId, parseSessionCommand } from './sessions';
import { createTheme } from './theme';

describe('parseSessionCommand', () => {
  test('不是 /session 的不接管', () => {
    expect(parseSessionCommand('帮我看看')).toBeNull();
    expect(parseSessionCommand('/sessionx')).toBeNull();
  });

  test('/session 与 /sessions 都列表', () => {
    expect(parseSessionCommand('/session')).toEqual({ kind: 'list' });
    expect(parseSessionCommand('/sessions')).toEqual({ kind: 'list' });
  });

  test('给 id 就切', () => {
    expect(parseSessionCommand('/session s-123')).toEqual({ kind: 'switch', id: 's-123' });
  });

  test('new 新开;带 id 用给的,不带则自动生成', () => {
    expect(parseSessionCommand('/session new')).toEqual({ kind: 'new', id: null });
    expect(parseSessionCommand('/session new mine')).toEqual({ kind: 'new', id: 'mine' });
  });

  test('★ 非法 id **先拦一次**并给人话 —— 不然是 ChatStore 抛一个栈出来', () => {
    // ChatStore 的白名单是防路径穿越的, 抛得对; 但对用户来说"非法会话 id"比一个栈有用。
    for (const bad of ['/session ../逃逸', '/session 有中文', '/session -起头']) {
      const r = parseSessionCommand(bad);
      expect(r?.kind).toBe('usage');
      expect((r as { reason: string }).reason).toContain('非法');
    }
  });

  test('new 的 id 也过同一条白名单', () => {
    expect(parseSessionCommand('/session new ../x')?.kind).toBe('usage');
  });
});

describe('formatSessions', () => {
  const s = (id: string, title: string, updatedAt = 1_760_000_000_000): TuiSessionMeta => ({ id, title, updatedAt });

  test('★ 当前那条要标出来 —— 不标的话切完不知道切没切成', () => {
    const out = formatSessions([s('a', 'A'), s('b', 'B')], 'b');
    expect(out).toMatch(/\*\s+b\b/);
    expect(out).not.toMatch(/\*\s+a\b/);
  });

  test('★ 一条都没有时说真话(还没说过话), 不画一张空表', () => {
    const out = formatSessions([], 'tui');
    expect(out).toContain('还没有已存会话');
    expect(out).toContain('tui');
  });

  test('没有标题画 (无标题), 不留空', () => {
    expect(formatSessions([s('a', '')], 'a')).toContain('(无标题)');
  });

  test('updatedAt 为 0 画破折号(不是 1970)', () => {
    expect(formatSessions([s('a', 'A', 0)], 'a')).toContain('—');
  });
});

describe('newSessionId', () => {
  test('★ 用时间戳不用随机串 —— 列表里读得出先后', () => {
    expect(newSessionId(() => 1_760_000_000_000)).toBe('s-1760000000');
  });

  test('生成的 id 过得了自己的白名单', () => {
    expect(parseSessionCommand(`/session ${newSessionId(() => 1_760_000_000_000)}`)?.kind).toBe('switch');
  });
});

describe('★ ChatLog.replay —— 切过去要看到那条会话的历史', () => {
  const theme = createTheme({ color: false });
  const log = () => new ChatLog(theme);
  const text = (l: ChatLog) => l.render(80).join('\n');

  test('user / assistant 都回放', () => {
    const l = log();
    l.replay([{ role: 'user', content: '第一问' }, { role: 'assistant', content: [{ type: 'text', text: '第一答' }] }]);
    const out = text(l);
    expect(out).toContain('第一问');
    expect(out).toContain('第一答');
  });

  test('★ replay 先清空 —— 不清的话上一条会话的消息会冒充这一条的上下文', () => {
    const l = log();
    l.appendUser('上一条会话的话');
    l.replay([{ role: 'user', content: '新会话' }]);
    const out = text(l);
    expect(out).not.toContain('上一条会话');
    expect(out).toContain('新会话');
  });

  test('★ 回放的每条都**定型** —— 否则下一轮的第一片会续到最后一条上', () => {
    const l = log();
    l.replay([{ role: 'assistant', content: [{ type: 'text', text: '旧回复' }] }]);
    l.appendAssistantChunk('新回复');
    expect(l.length).toBe(2); // 两条, 不是粘成一条
  });

  test('★ 认不出的角色跳过 —— 把工具结果画成助手发言 = 模型说了它没说过的话', () => {
    const l = log();
    l.replay([
      { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] },
      { role: 'user', content: '真的用户话' },
    ]);
    const out = text(l);
    expect(out).not.toContain('工具输出');
    expect(out).toContain('真的用户话');
  });

  test('空内容跳过, 不画空气泡', () => {
    const l = log();
    l.replay([{ role: 'user', content: '   ' }, { role: 'assistant', content: [] }]);
    expect(l.length).toBe(0);
  });

  test('空历史 → 空记录(新会话就该是空的)', () => {
    const l = log();
    l.appendUser('x');
    l.replay([]);
    expect(l.length).toBe(0);
  });
});
