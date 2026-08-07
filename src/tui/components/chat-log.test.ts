/**
 * L2 判据:对话记录(TUI SDD §9 第二层,切片 S8)—— `render(width)` 返回数组,不起终端。
 *
 * 关色跑(`createTheme({ color: false })`):断言的是**归一化可见文本**,
 * 永不做 ANSI 快照(§9:快照会因任何布局微调全红,等于没有测试)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { createTheme } from '../theme';
import { ChatLog } from './chat-log';

const theme = createTheme({ color: false });
const text = (log: ChatLog, w = 60) => log.render(w).join('\n');

describe('ChatLog —— 三种条目', () => {
  test('user 原样回显, 带 ASCII 前缀', () => {
    const log = new ChatLog(theme);
    log.appendUser('hej');
    expect(text(log)).toContain('> hej');
  });

  test('★ user 的内容不当 markdown 渲染 —— 他打的 * 是他打的字符', () => {
    const log = new ChatLog(theme);
    log.appendUser('*not italic* # not heading');
    expect(text(log)).toContain('*not italic* # not heading');
  });

  test('notice 与 assistant 分开画 —— 一句"没接通"被画成助手发言就读成模型在回答', () => {
    const log = new ChatLog(theme);
    log.appendNotice('引擎尚未接通');
    expect(text(log)).toContain('! 引擎尚未接通');
  });

  test('assistant 走 markdown(标题不再带 # 号)', () => {
    const log = new ChatLog(theme);
    log.appendAssistantChunk('# 标题\n\n正文');
    const out = text(log);
    expect(out).toContain('标题');
    expect(out).toContain('正文');
    expect(out).not.toContain('# 标题');
  });
});

describe('★ 流式:一条消息, 不是一堆消息', () => {
  // 反向自检 (2026-08-07 实跑): 把 appendAssistantChunk 里"追加进同一条"的分支删掉
  // (每个 chunk 都 push 新条目) → 下面「恰好一条」「恰好出现一次」两条当场红。
  test('64 个 token 分两批进来 → 仍然只有一条 assistant 消息', () => {
    const log = new ChatLog(theme);
    const tokens = Array.from({ length: 64 }, (_, i) => `t${i} `);
    for (const t of tokens.slice(0, 32)) log.appendAssistantChunk(t);
    for (const t of tokens.slice(32)) log.appendAssistantChunk(t);
    expect(log.length).toBe(1);
  });

  test('★ 每个 token 恰好出现一次(不是每来一片就重画一遍前缀)', () => {
    const log = new ChatLog(theme);
    for (const t of ['abc ', 'def ', 'ghi']) log.appendAssistantChunk(t);
    const out = text(log);
    for (const t of ['abc', 'def', 'ghi']) {
      expect(out.split(t).length - 1, `${t} 出现次数`).toBe(1);
    }
  });

  test('★ 收尾之后再来的 chunk 另开一条 —— 否则两轮回复会粘成一条', () => {
    const log = new ChatLog(theme);
    log.appendAssistantChunk('第一轮');
    log.closeStreaming();
    log.appendAssistantChunk('第二轮');
    expect(log.length).toBe(2);
  });

  test('user 消息也会收尾流式 —— 用户插话之后模型不该续到旧气泡里', () => {
    const log = new ChatLog(theme);
    log.appendAssistantChunk('前半');
    log.appendUser('打断');
    log.appendAssistantChunk('后半');
    expect(log.length).toBe(3);
  });

  test('closeStreaming 幂等, 空记录上调也不炸', () => {
    const log = new ChatLog(theme);
    expect(() => {
      log.closeStreaming();
      log.closeStreaming();
    }).not.toThrow();
    expect(log.lastText).toBeNull(); // 没有条目时是 null, 不是空串
  });
});

describe('宽度约束', () => {
  test('★ 任意窄屏下每一行都不超宽(含 CJK 与长 URL)', () => {
    const log = new ChatLog(theme);
    log.appendUser('你好世界'.repeat(10));
    log.appendNotice(`后端拒绝了这一轮 (embedded://deepseek:deepseek-v4-flash)`);
    log.appendAssistantChunk('```ts\nconst x = "一段很长的中文字符串, 用来把代码块顶出边界";\n```');
    for (const w of [20, 40, 80]) {
      for (const line of log.render(w)) {
        expect(visibleWidth(line), `w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('条目之间空一行, 首条前面不空', () => {
    const log = new ChatLog(theme);
    log.appendUser('a');
    log.appendUser('b');
    const lines = log.render(40);
    expect(lines[0]).not.toBe('');
    expect(lines).toContain('');
  });
});
