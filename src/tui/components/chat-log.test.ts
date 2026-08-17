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

  /**
   * ★ Ctrl+O 折叠(2026-08-17)。
   * 反向自检(实跑):把 render 里 `!this.thinkingExpanded` 那条分支删掉 →
   * 「折叠后正文不画」当场红;把行数换成写死的 1 → 「行数照报」当场红。
   */
  test('★ Ctrl+O 折叠: 正文收起、行数照报、正文条目不受累; 再按展开回来', () => {
    const log = new ChatLog(theme);
    log.appendThinkingChunk('line1\nline2\nline3');
    log.closeStreaming();
    log.appendAssistantChunk('answer');
    expect(log.toggleThinking()).toBe(false); // 默认展开 → 切成收起
    const collapsed = text(log);
    expect(collapsed).not.toContain('line2'); // 思考正文收起
    expect(collapsed).toContain('thinking (3 lines)'); // 行数是真数, 不是装饰
    expect(collapsed).toContain('answer'); // 正文条目不受累
    expect(log.toggleThinking()).toBe(true);
    expect(text(log)).toContain('line2'); // 展开回来, 一个字不丢
  });

  test('折叠态流式追加, 行数还在涨 —— "收起"不许变成"看不出它在想"', () => {
    const log = new ChatLog(theme);
    log.toggleThinking(); // 收起
    log.appendThinkingChunk('a\nb');
    expect(text(log)).toContain('(2 lines)');
    log.appendThinkingChunk('\nc');
    expect(text(log)).toContain('(3 lines)');
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

describe('★ 欢迎屏字标让位 (W3a V5)', () => {
  // 反向自检 (实跑): 把 render 里 hasDialogue 的 banner 过滤删掉 → 第 1 条当场红。
  test('★ 有对话之后字标不再画; 开口之前照画', () => {
    const log = new ChatLog(theme);
    log.appendBanner('OMD-BANNER-MARK');
    expect(text(log)).toContain('OMD-BANNER-MARK');
    log.appendUser('第一句');
    expect(text(log)).not.toContain('OMD-BANNER-MARK');
    expect(text(log)).toContain('> 第一句');
  });

  test('让位不影响 hasDialogue 判据, 普通 notice 不受牵连', () => {
    const log = new ChatLog(theme);
    log.appendBanner('BANNER');
    log.appendNotice('普通通告');
    log.appendUser('hi');
    expect(log.hasDialogue).toBe(true);
    expect(text(log)).toContain('普通通告'); // 只有 banner 让位, notice 是内容不是装饰
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
/**
 * ★ 中途读数(2026-08-14)。治的是「在跑」与「卡死」在屏上逐像素相同这一族。
 *
 * 反向自检(实跑):把 `toolUpdate` 里 `setText` 那行去掉 → 第 1 条当场红;
 * 把 `if (!hit) return` 改成补一条 → 第 3 条当场红(多出一条永不被 end 收掉的孤儿行)。
 */
describe('★ 工具行的中途读数', () => {
  test('★ 原地更新同一行 —— 不追加(否则一条命令能刷出几百行)', () => {
    const log = new ChatLog(theme);
    log.toolStart('bash', { id: 'u1', detail: 'bun test' });
    const before = log.length;
    log.toolUpdate('bash', { id: 'u1', lines: 12, tail: '12 pass' });
    log.toolUpdate('bash', { id: 'u1', lines: 40, tail: '40 pass' });
    expect(log.length).toBe(before);
    expect(text(log)).toContain(`${TOOL_MARK.running} bash bun test → 40 lines · 40 pass`);
    expect(text(log)).not.toContain('12 lines');
  });

  test('末行为空时只画行数 —— 不画一个空的 `· `', () => {
    const log = new ChatLog(theme);
    log.toolStart('bash', { id: 'u2', detail: 'x' });
    log.toolUpdate('bash', { id: 'u2', lines: 1, tail: '   ' });
    expect(text(log)).toContain('→ 1 line');
    expect(text(log)).not.toContain('1 line ·');
  });

  test('★ 对不上 start 的 update **什么都不做** —— 补一条会造出永不被 end 收掉的孤儿', () => {
    const log = new ChatLog(theme);
    log.toolUpdate('bash', { id: 'ghost', lines: 3 });
    expect(log.length).toBe(0);
  });

  test('update 之后 end 仍然原地收尾, 结果覆盖掉进度', () => {
    const log = new ChatLog(theme);
    log.toolStart('bash', { id: 'u3', detail: 'bun test' });
    log.toolUpdate('bash', { id: 'u3', lines: 40, tail: 'running' });
    log.toolEnd('bash', true, { id: 'u3', result: 'exit 0' });
    expect(log.length).toBe(1);
    expect(text(log)).toContain(`${TOOL_MARK.ok} bash bun test → exit 0`);
    expect(text(log)).not.toContain('40 lines');
  });
});

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

/**
 * ★ 工具卡升级 (W2 V2) —— 先红:连续工具行的卡片化 + 耗时秒 + 降级保命绳 (I1)。
 *
 * 上游契约:`docs/plan/2026-08-17-tui-视觉-w2-执行契约.md` §I1/I3/I5/I6 + 片1 改法。
 * 此刻三条断言全部指向**尚未实装**的行为 —— 改方落地之前必须红。
 * 改既有的 728 条断言来迁就新代码 = 废片 (I1 反向)。
 */
describe('★ 工具卡升级 (W2 V2)', () => {
  /**
   * ★ ① color 开时,连续工具行组被 Box 卡界包裹 —— 角字形出现。
   *
   * 卡界字形只来自 `design/tokens.BORDER`(`┌┐└┘─│`)。本测试只调 `toolStart`/`toolEnd`,
   * 不出 `divider`,所以 `─` 若出现也只能来自卡顶/卡底 —— 角字 `┌┐└┘` 则是卡片独有,
   * 永远不会从其他组件冒出来。
   *
   * 证伪方式:把 `render` 里"连续 tool 行合成 Box 卡"那段去掉(回退成 flatMap 单行) →
   * 输出里不再有 `┌┐└┘` 角字,这条当场红。
   */
  test('color 开: 连续工具行组被 Box 卡界包裹 (角字形出现)', () => {
    const on = createTheme({ color: true });
    const log = new ChatLog(on);
    log.toolStart('read', { id: 't1', detail: 'config.txt' });
    log.toolStart('bash', { id: 't2', detail: 'bun test' });
    const out = text(log);
    // 四个角字形至少出现一个 —— 卡片独有, 与既有 `─` 分界、`│` 树形不冲突。
    expect(out).toMatch(/[┌┐└┘]/);
  });

  /**
   * ★ ② 耗时秒后缀只挂在 >1s 的工具行;≤1s 一字不加 (I6 时钟外给)。
   *
   * 注入 `now()` 控制 start/end 差值 —— `Date.now` 在测试里是禁区 (I6)。
   * `fmtDur(500)` 本来会输出 `0.5s`,所以"≤1s 不含秒后缀"必须靠**显式门控**
   * (`diff > 1000` 才挂后缀),不是靠格式化函数自己短路。
   *
   * 证伪方式:把 `toolEnd` 里 `if (diff > 1000)` 那道门删掉(总是挂 suffix) →
   * 「≤1s 不含秒后缀」当场红(屏上冒出 `0.5s`)。
   */
  test('★ 耗时秒: >1s 才挂秒后缀, ≤1s 一字不加 (注入 now, 禁 Date.now)', () => {
    const seq = (...ts: number[]) => {
      let i = 0;
      return () => ts[i++] as number;
    };
    // (a) diff = 500ms (≤1s) → 不应出现 `\d+\.?\d*s` 形态的秒后缀。
    const short = new ChatLog(theme, seq(1_000, 1_500));
    short.toolStart('bash', { id: 's', detail: 'bun test' });
    short.toolEnd('bash', true, { id: 's', result: 'exit 0' });
    expect(text(short)).not.toMatch(/\d+\.?\d*s/);

    // (b) diff = 1500ms (>1s) → 应出现 `\d+\.?\d*s` 形态的秒后缀。
    const long = new ChatLog(theme, seq(2_000, 3_500));
    long.toolStart('bash', { id: 'l', detail: 'bun test' });
    long.toolEnd('bash', true, { id: 'l', result: 'exit 0' });
    expect(text(long)).toMatch(/\d+\.?\d*s/);
  });

  /**
   * ★ ③ color:false 降级保命绳 (I1 正向) —— 同批工具条目逐字同既有单行三态。
   *
   * I1 是最高优先契约:「三片改动处的渲染输出与改前逐字相同 —— 全部既有测试天然是这条的闸」。
   * 关色跑时,卡片/色彩/耗时秒**全部退场**,屏上只剩 `· ✓ ✗` 三态 + 参数 + 结果。
   * 本条是该契约的正向断言(反向:728 条既有测试天然就是这条的闸 —— 我们不动它们)。
   *
   * 证伪方式:在 `render` 里给 tool 行无条件加 Box 卡界 →
   * 输出里冒出 `┌┐└┘─│` 卡片字形,「无卡角」当场红;
   * 在 `toolEnd` 里给 ≤1s 也挂 `0.5s` → 「无秒后缀」当场红 (同时 ② 也红)。
   */
  test('★ color:false: 同批工具条目降级为单行三态, 一字不差 (I1 正向)', () => {
    const log = new ChatLog(theme); // theme = createTheme({ color: false })
    log.toolStart('read', { id: 'r', detail: 'config.txt' });
    log.toolEnd('read', true, { id: 'r', result: '120 lines' });
    log.toolStart('bash', { id: 'b', detail: 'bun test' });
    log.toolEnd('bash', false, { id: 'b', result: 'exit 1' });
    log.toolStart('grep', { id: 'g', detail: 'foo in src/' });
    log.toolEnd('grep', true, { id: 'g', result: '8 in 3 files' });
    const out = text(log);
    // 三个终态行与既有单行三态逐字同 —— `· ✓ ✗` + 参数 + 结果。
    expect(out).toContain(`${TOOL_MARK.ok} read config.txt → 120 lines`);
    expect(out).toContain(`${TOOL_MARK.fail} bash bun test → exit 1`);
    expect(out).toContain(`${TOOL_MARK.ok} grep foo in src/ → 8 in 3 files`);
    // 关键:零卡角、零秒后缀 —— 卡片 / 耗时秒全部退场 (I1)。
    expect(out).not.toMatch(/[┌┐└┘─│]/);
    expect(out).not.toMatch(/\d+\.?\d*s/);
    // 行数上限:三条工具在 pi-tui `Text` 默认 padding 下 = 9 行;卡片不得**新增**行
    // (I3:卡界用既有空行位画,不挤额外行)。保留 ≤ 9 的上界,给 impl 留 padding 调整余地。
    const lines = log.render(60);
    expect(lines.length).toBeLessThanOrEqual(9);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
});
