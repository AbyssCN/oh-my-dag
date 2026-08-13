/**
 * L2 判据:对话记录(TUI SDD §9 第二层,切片 S8)—— `render(width)` 返回数组,不起终端。
 *
 * 关色跑(`createTheme({ color: false })`):断言的是**归一化可见文本**,
 * 永不做 ANSI 快照(§9:快照会因任何布局微调全红,等于没有测试)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { createTheme } from '../theme';
import { ChatLog, TOOL_MARK } from './chat-log';
import { findRiskyGlyphs } from '../render/glyphs';

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

  /**
   * ★ 思维链(2026-08-13)。owner 原话「思维链也看不到」——
   * 根因在 `backend-embedded` 少映射了 `thinking_delta`,而这一层此前**根本没有**画它的口子。
   *
   * 反向自检(实跑):把 `appendThinkingChunk` 的"追加进同一条"分支删掉 → 第 1 条当场红
   * (两片各成一条);把 `closeStreaming` 里 thinking 那半删掉 → 第 3 条当场红(正文续进思考区)。
   */
  test('★ 思考分片追加进同一条 —— 与正文同构', () => {
    const log = new ChatLog(theme);
    for (const t of ['weighing ', 'A vs B']) log.appendThinkingChunk(t);
    expect(log.length).toBe(1);
    expect(log.lastText).toBe('weighing A vs B');
    expect(text(log)).toContain('weighing A vs B');
  });

  test('★ 思考与正文是**两条** —— 压成一条就等于把草稿当答案发了', () => {
    const log = new ChatLog(theme);
    log.appendThinkingChunk('draft');
    log.closeStreaming();
    log.appendAssistantChunk('answer');
    expect(log.length).toBe(2);
    expect(log.lastText).toBe('answer');
  });

  test('★ 不收尾也不会串 —— 角色一换就另开一条(正文不许落进思考区)', () => {
    const log = new ChatLog(theme);
    log.appendThinkingChunk('draft');
    log.appendAssistantChunk('answer');
    expect(log.lastText).toBe('answer');
    expect(log.length).toBe(2);
  });

  test('空思考条目在收尾时丢掉 —— 开了 thinking 块却一个字没吐, 不该占一行', () => {
    const log = new ChatLog(theme);
    log.appendThinkingChunk('');
    log.closeStreaming();
    expect(log.length).toBe(0);
  });

  test('user 消息也会收尾流式 —— 用户插话之后模型不该续到旧气泡里', () => {
    const log = new ChatLog(theme);
    log.appendAssistantChunk('前半');
    log.appendUser('打断');
    log.appendAssistantChunk('后半');
    // ⚠ 判据是**内容**不是条数。原来断言 length===3, 而 S-5 加了回合分界线之后条数变 4 ——
    //   一条会被无关排版件改红的判据是脆的。"续没续到旧气泡里"只有看最后一条的正文才答得了:
    //   真续进去了的话 lastText 会是 '前半后半'。
    expect(log.lastText).toBe('后半');
    expect(log.length).toBe(4); // 前半 · 分界线 · 打断 · 后半
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

/**
 * ★ 结果那半句(2026-08-13,owner 点名「工具结果也进屏」)。
 *
 * 反向自检(实跑):把 `toolEnd` 里 `opts.result ? … : …` 那个三元退回原来的模板串 →
 * 第 1 条当场红(屏上只剩 `✓ grep foo in src/`,搜到了什么仍然看不见)。
 */
describe('★ 工具行的结果半句', () => {
  test('★ end 时把结果接在参数后面, 用 → 分开', () => {
    const log = new ChatLog(theme);
    log.toolStart('grep', { id: 't1', detail: 'foo in src/' });
    log.toolEnd('grep', true, { id: 't1', result: '8 in 3 files' });
    expect(text(log)).toContain(`${TOOL_MARK.ok} grep foo in src/ → 8 in 3 files`);
  });

  test('挑不出结果就不画箭头 —— 不编一个 `→ ?` 占位', () => {
    const log = new ChatLog(theme);
    log.toolStart('omd_run', { id: 't2' });
    log.toolEnd('omd_run', true, { id: 't2', result: null });
    expect(text(log)).toContain(`${TOOL_MARK.ok} omd_run`);
    expect(text(log)).not.toContain('→');
  });

  test('★ 失败的工具也带结果 —— 失败时最需要知道它做到哪一步', () => {
    const log = new ChatLog(theme);
    log.toolStart('bash', { id: 't3', detail: 'bun test' });
    log.toolEnd('bash', false, { id: 't3', result: 'exit 1' });
    expect(text(log)).toContain(`${TOOL_MARK.fail} bash bun test → exit 1`);
  });

  test('对不上 start 的 end 也画得出结果(补一条总比丢掉强)', () => {
    const log = new ChatLog(theme);
    log.toolEnd('grep', true, { id: 'orphan', detail: 'x in y', result: 'no match' });
    expect(text(log)).toContain('grep x in y → no match');
  });
});

describe('★ 工具行:一个工具一行, 原地更新', () => {
  // 反向自检 (2026-08-07 实跑): 把 toolEnd 的"找到就原地改"分支去掉(改成恒追加)
  // → 「跑完不新增一行」当场红。那正是改之前的样子: 一轮十次调用二十行噪音。
  test('★ start 一行, end **不新增行**只改标记', () => {
    const log = new ChatLog(theme);
    log.toolStart('run');
    expect(log.length).toBe(1);
    expect(text(log)).toContain(`${TOOL_MARK.running} run`);
    log.toolEnd('run', true);
    expect(log.length).toBe(1); // ← 关键: 还是一行
    expect(text(log)).toContain(`${TOOL_MARK.ok} run`);
    expect(text(log)).not.toContain(`${TOOL_MARK.running} run`);
  });

  test('★ 跑着的与跑完的看得出区别(否则不知道是在忙还是卡住)', () => {
    expect(TOOL_MARK.running).not.toBe(TOOL_MARK.ok);
    expect(TOOL_MARK.ok).not.toBe(TOOL_MARK.fail);
  });

  test('失败用另一个标记', () => {
    const log = new ChatLog(theme);
    log.toolStart('run');
    log.toolEnd('run', false);
    expect(text(log)).toContain(`${TOOL_MARK.fail} run`);
  });

  test('★ 没有对应 start 的 end 也补一行 —— 丢掉比多一行更糟', () => {
    const log = new ChatLog(theme);
    log.toolEnd('orphan', true);
    expect(text(log)).toContain(`${TOOL_MARK.ok} orphan`);
  });

  test('同名工具跑两次 → 两行, end 只改**最近**那一行', () => {
    const log = new ChatLog(theme);
    log.toolStart('run');
    log.toolEnd('run', true);
    log.toolStart('run');
    expect(log.length).toBe(2);
    log.toolEnd('run', false);
    expect(log.length).toBe(2);
    const out = text(log);
    expect(out).toContain(`${TOOL_MARK.ok} run`); // 第一次仍是成功
    expect(out).toContain(`${TOOL_MARK.fail} run`); // 第二次是失败
  });

  test('★ 连续的工具行**不空行** —— 一串工具是一组, 插空会拆成十件不相关的事', () => {
    const log = new ChatLog(theme);
    log.toolStart('a');
    log.toolStart('b');
    log.toolStart('c');
    expect(log.render(60).filter((l) => l === '')).toHaveLength(0);
  });

  test('工具行与消息之间**要**空行', () => {
    const log = new ChatLog(theme);
    log.appendUser('q');
    log.toolStart('a');
    expect(log.render(60)).toContain('');
  });

  test('★ 工具行用到的字形都在白名单里', () => {
    for (const m of Object.values(TOOL_MARK)) expect(findRiskyGlyphs(m)).toEqual([]);
  });

  test('工具行带参数 —— 只画名字的话, 改对文件和改错文件长得一模一样', () => {
    const log = new ChatLog(theme);
    log.toolStart('read', { id: 't1', detail: 'config.txt' });
    expect(text(log)).toContain('read config.txt');
  });

  // ★ 反向自检 (实跑): 把 toolEnd 里的 `hit?.toolText ??` 去掉 → 这条当场红 (参数被擦成光名字)。
  test('★ end 保住 start 那半句参数 —— end 事件不带 args', () => {
    const log = new ChatLog(theme);
    log.toolStart('read', { id: 't1', detail: 'config.txt' });
    log.toolEnd('read', true, { id: 't1' });
    expect(text(log)).toContain(`${TOOL_MARK.ok} read config.txt`);
    expect(log.length).toBe(1); // 原地更新, 不是再追加一条
  });

  // ★ 这条钉的是一个**潜伏 bug**:原来按工具名对回去, 同一个工具连调两次时
  //   先跑完的那个会去更新最后一条同名行 —— 两行长得一样, 屏上看不出标记落错了。
  test('★ 同名工具并发时按 toolCallId 对回各自那一行', () => {
    const log = new ChatLog(theme);
    log.toolStart('read', { id: 'a', detail: '甲.ts' });
    log.toolStart('read', { id: 'b', detail: '乙.ts' });
    log.toolEnd('read', true, { id: 'a' });
    const out = text(log);
    expect(out).toContain(`${TOOL_MARK.ok} read 甲.ts`);
    expect(out).toContain(`${TOOL_MARK.running} read 乙.ts`);
  });

  // ★ 反向自检 (实跑): 把 closeStreaming 里的 pop 去掉 → 这条当场红。
  //   起因是实测截图: 模型那一轮只发工具调用不发文字, 开出一条空气泡, 它画出来什么都没有
  //   却占着条目位, 把"连续工具行不空行"从中间劈开。
  test('★ 一个字都没收到的助手气泡不占位 —— 否则它把连续工具行劈开', () => {
    const log = new ChatLog(theme);
    log.toolStart('read', { id: '1', detail: 'a.ts' });
    log.toolEnd('read', true, { id: '1' });
    log.appendAssistantChunk(''); // 只发了工具调用的那一轮
    log.toolStart('ls', { id: '2' });
    expect(log.length).toBe(2);
    expect(log.render(60).filter((l) => l === '')).toHaveLength(0);
  });

  test('有正文的助手消息照常留着 —— 丢的只是空的那种', () => {
    const log = new ChatLog(theme);
    log.appendAssistantChunk('有话说');
    log.closeStreaming();
    expect(log.length).toBe(1);
  });
});

describe('回合分界线 (S-5)', () => {
  const at = (hhmmStr: string) => {
    const [h, m] = hhmmStr.split(':').map(Number);
    const d = new Date(2026, 7, 7, h as number, m as number, 30);
    return () => d.getTime();
  };

  test('★ user 消息前面有一条分界线, 右端带时间', () => {
    const log = new ChatLog(theme, at('09:05'));
    log.appendUser('你好');
    expect(text(log)).toContain('09:05');
    expect(log.length).toBe(2); // 分界线 + 用户消息
  });

  test('★ 分界线**恰好占满宽度**, 不多不少 —— 超一列就换行, 少一列就有豁口', () => {
    const log = new ChatLog(theme, at('09:05'));
    log.appendUser('你好');
    for (const w of [20, 40, 80, 120]) {
      const line = log.render(w)[0] as string;
      expect(visibleWidth(line)).toBe(w);
    }
  });

  test('分界线与紧随的 user 之间不空行 —— 它标的是下一轮的头, 不是上一轮的尾', () => {
    const log = new ChatLog(theme, at('09:05'));
    log.appendUser('你好');
    expect(log.render(60).filter((l) => l === '')).toHaveLength(0);
  });

  test('★ 分界线字形在白名单里', () => {
    const log = new ChatLog(theme, at('09:05'));
    log.appendUser('x');
    expect(findRiskyGlyphs((log.render(40)[0] as string))).toEqual([]);
  });
});

describe('★ hasDialogue —— "人开口了"与"屏上有东西"是两件事(P3 件3 轮1)', () => {
  /**
   * 消费者:侧栏 pathfinder 摘要有对话之后收起。这条判据错一格的代价是**首屏就把摘要藏了**
   * (欢迎屏字标也进 `entries`)⇒ 判据必须是 `user` 条目而不是条目数。
   *
   * 证伪方式(实跑过):把 `hasDialogue` 改成 `this.entries.length > 0` → 「只有欢迎屏字标」那条当场红。
   */
  test('空的 → 假', () => {
    expect(new ChatLog(theme).hasDialogue).toBe(false);
  });

  test('★ 只有欢迎屏字标(appendBanner)→ 仍然是假', () => {
    const log = new ChatLog(theme);
    log.appendBanner('OH MY DAG');
    expect(log.length).toBeGreaterThan(0); // 屏上有东西
    expect(log.hasDialogue).toBe(false); // 但人还没开口
  });

  test('appendUser 之后 → 真', () => {
    const log = new ChatLog(theme);
    log.appendUser('hej');
    expect(log.hasDialogue).toBe(true);
  });

  test('切会话 clear 之后 → 回到假(不然新会话一起来就把摘要藏了)', () => {
    const log = new ChatLog(theme);
    log.appendUser('hej');
    log.clear();
    expect(log.hasDialogue).toBe(false);
  });
})
