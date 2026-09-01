/**
 * L1 判据:多会话切换(2026-08-07)。
 *
 * 数据面(`listSessions` / `loadHistory` / `ChatStore` 按 id 分文件)从 S10 起就在,
 * 缺的只是入口 —— 于是"多会话"**技术上成立、用户上不存在**。这一片补的是入口。
 */
import { describe, expect, test } from 'bun:test';
import type { TuiSessionMeta } from './backend';
import { ChatLog } from './components/chat-log';
import { defaultTuiSessionId, forkSessionId, formatSessions, newSessionId, parseNewForkCommand, parseSessionCommand, relTime, sessionPickerOptions } from './sessions';
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
      expect((r as { reason: string }).reason).toContain('Invalid session id');
    }
  });

  test('new 的 id 也过同一条白名单', () => {
    expect(parseSessionCommand('/session new ../x')?.kind).toBe('usage');
  });
});

describe('parseNewForkCommand —— /new /fork 是 /session new|fork 的直达别名', () => {
  test('不是 /new /fork 的不接管; 前缀撞车(/newx)回落成普通文本', () => {
    expect(parseNewForkCommand('帮我看看')).toBeNull();
    expect(parseNewForkCommand('/newx')).toBeNull();
    expect(parseNewForkCommand('/forky')).toBeNull();
    // /session 是 parseSessionCommand 的地盘, 别名不抢
    expect(parseNewForkCommand('/session new')).toBeNull();
  });

  test('无参 → id null(交给默认 id 生成); 尾随空格不碍事', () => {
    expect(parseNewForkCommand('/new')).toEqual({ kind: 'new', id: null });
    expect(parseNewForkCommand('/fork')).toEqual({ kind: 'fork', id: null });
    expect(parseNewForkCommand('/new ')).toEqual({ kind: 'new', id: null });
  });

  test('/clear = /new 的语义别名 (Claude Code /clear 心智); /clearx 前缀撞车照旧回落', () => {
    expect(parseNewForkCommand('/clear')).toEqual({ kind: 'new', id: null });
    expect(parseNewForkCommand('/clearx')).toBeNull();
  });

  test('给合法 id 就用给的, 与 /session 同一条白名单口径', () => {
    expect(parseNewForkCommand('/new mine')).toEqual({ kind: 'new', id: 'mine' });
    expect(parseNewForkCommand('/fork b1')).toEqual({ kind: 'fork', id: 'b1' });
    expect(parseNewForkCommand('/new my-sess_1')).toEqual({ kind: 'new', id: 'my-sess_1' });
  });

  test('★ 非法 id 先拦一次并给人话(与 parseSessionCommand 同文案)', () => {
    for (const bad of ['/new ../逃逸', '/new 有中文', '/fork -起头', '/new ../x']) {
      const r = parseNewForkCommand(bad);
      expect(r?.kind).toBe('usage');
      expect((r as { reason: string }).reason).toContain('Invalid session id');
    }
  });

  test('多余参数静默忽略 —— 与 parseSessionCommand 同纪律, 不抛栈', () => {
    expect(parseNewForkCommand('/new mine extra words')).toEqual({ kind: 'new', id: 'mine' });
  });

  test('legacy 解析不受影响: /session new|fork 走 parseSessionCommand, 别名不入侵', () => {
    expect(parseSessionCommand('/new')).toBeNull();
    expect(parseSessionCommand('/session new')).toEqual({ kind: 'new', id: null });
    expect(parseSessionCommand('/session fork b1')).toEqual({ kind: 'fork', id: 'b1' });
  });

  test('生成的默认 id 过得了别名自己的白名单', () => {
    expect(parseNewForkCommand(`/new ${newSessionId(() => 1_760_000_000_000)}`)).toEqual({ kind: 'new', id: 's-1760000000' });
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
    expect(out).toContain('No stored sessions yet');
    expect(out).toContain('tui');
  });

  test('没有标题画 (无标题), 不留空', () => {
    expect(formatSessions([s('a', '')], 'a')).toContain('(no title)');
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

describe('★ defaultTuiSessionId —— 多开 TUI 不许撞进同一条会话', () => {
  test('★ 同一秒起的两个进程也不撞(秒级时间戳分不开, pid 分得开)', () => {
    const at = () => 1_760_000_000_000;
    // 证伪:把 pid 从实现里去掉 → 这两个当场相等, 而相等就是"两个窗口写同一条会话"。
    expect(defaultTuiSessionId(at, 111)).not.toBe(defaultTuiSessionId(at, 222));
    expect(defaultTuiSessionId(at, 111)).toBe('s-1760000000-111');
  });

  test('生成的 id 过得了会话 id 白名单(不然多开第一句话就被路径闸拒)', () => {
    expect(parseSessionCommand(`/session ${defaultTuiSessionId(() => 1_760_000_000_000, 4242)}`)?.kind).toBe('switch');
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

describe('切片⑦: fork 解析与 lineage', () => {
  test('/session fork [id] 解析; 非法 id 给人话', () => {
    expect(parseSessionCommand('/session fork')).toEqual({ kind: 'fork', id: null });
    expect(parseSessionCommand('/session fork b1')).toEqual({ kind: 'fork', id: 'b1' });
    expect(parseSessionCommand('/session fork ../x')?.kind).toBe('usage');
  });

  test('列表画 lineage(有 parent 才画)', () => {
    const out = formatSessions(
      [
        { id: 'tui', title: '', updatedAt: 0 },
        { id: 'tui-f9', title: '', updatedAt: 0, parent: 'tui' },
      ],
      'tui-f9',
    );
    expect(out).toContain('<- forked from tui');
    expect(out.split('\n')[1]).not.toContain('forked from'); // 根会话那行没有
  });

  test('forkSessionId 名字自带 lineage 且不超 id 白名单上限', () => {
    expect(forkSessionId('tui', () => 9_000)).toBe('tui-f9');
    const long = forkSessionId('x'.repeat(80), () => 9_000);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith('-f9')).toBe(true);
  });
});

/**
 * 会话选择器的选项(2026-08-21)。
 *
 * 它要杀死的失效形态(owner 点名):选择器**本来就有**,但主标签是裸 id
 * (`s-1787309805-834625`),标题被降到第二列 —— 于是整屏是一列认不出来的时间戳,
 * 而人是靠「那次聊的是什么」找会话的。加上没搜索、只 10 行,结果是"有等于没有"。
 *
 * 证伪方式:把 `label` 换回 `${mark}${s.id}` → 第一条测红;
 * 把 `relTime` 的 `updatedAt <= 0` 分支删掉 → 「没记时间」那条红(会画成 `0s 前`)。
 */
describe('sessionPickerOptions', () => {
  const now = Date.parse('2026-08-21T12:00:00Z');
  const meta = (over: Partial<TuiSessionMeta> & { id: string }): TuiSessionMeta => ({
    title: '', updatedAt: now - 7200_000, ...over,
  });

  test('★ main label is the title, not id - finding a session by topic, not by timestamp', () => {
    const [o] = sessionPickerOptions([meta({ id: 's-1787309805', title: 'about outputstyle and omd-plain' })], 'other', now);
    expect(o!.label).toBe('  about outputstyle and omd-plain');
    expect(o!.value).toBe('s-1787309805');
    // id 与时间降到副列, 一行装下 (pi-tui 的 SelectList 一个 item 只画一行)。
    expect(o!.description).toBe('s-1787309805 · 2h ago');
  });

  test('当前会话带 `*` —— 不标的话切完不知道切没切成', () => {
    const [a, b] = sessionPickerOptions([meta({ id: 'x', title: 'A' }), meta({ id: 'y', title: 'B' })], 'y', now);
    expect(a!.label.startsWith('  ')).toBe(true);
    expect(b!.label.startsWith('* ')).toBe(true);
  });

  test('没标题 → `(no title)`, 不画空白标签', () => {
    const [o] = sessionPickerOptions([meta({ id: 'z' })], 'z', now);
    expect(o!.label).toBe('* (no title)');
  });

  test('fork 的来源画在副列 (树的边是数据不是装饰)', () => {
    const [o] = sessionPickerOptions([meta({ id: 'c', title: 'T', parent: 'p1' })], 'c', now);
    expect(o!.description).toBe('c · 2h ago · forked from p1');
  });

  test('★ NULL ≠ 0: 没记时间画 `—`, 不画 `0s ago`', () => {
    const [o] = sessionPickerOptions([meta({ id: 'n', title: 'T', updatedAt: 0 })], 'n', now);
    expect(o!.description).toBe('n · —');
    expect(o!.description).not.toContain('0s');
  });

  test('relTime 四档', () => {
    expect(relTime(now - 30_000, now)).toBe('30s ago');
    expect(relTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relTime(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(relTime(now - 2 * 86400_000, now)).toBe('2d ago');
  });
});
