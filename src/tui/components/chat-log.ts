/**
 * src/tui/components/chat-log —— **对话记录**(TUI SDD 切片 S8)。
 *
 * ## 三种条目,三种画法,理由不同
 *
 * - `user` —— 用户打的原文。**不当 markdown 渲染**:用户打的 `*` `#` 是他打的字符,
 *   不是排版指令,渲染掉等于篡改回显。
 * - `assistant` —— 走 pi-tui 的 `Markdown`(内部 `marked`)。代码高亮是 S7 从 theme 挂进来的,
 *   这里不认识 highlight 这回事。
 * - `thinking` —— 模型的思维链(2026-08-13)。**纯文本 + dim**,不当 markdown 渲染:
 *   思考里的 `#` `*` 是它在打草稿,不是排版意图;而且 dim 之后再叠 markdown 的
 *   粗体/标题色,思考区会比正文还显眼 —— 那正好是反的。
 * - `notice` —— 引擎/后端说的话(含**断链说明卡**:后端拒绝时的原因句)。
 *   刻意与 assistant 分开:一句"引擎没接通"被画成助手发言,读起来就像模型在回答。
 *
 * ## 流式:一条消息,不是一堆消息
 *
 * `appendAssistantChunk` 往**同一条**消息里追加。写成"每个 chunk 一条消息"会让
 * 64 个 token 变成 64 条记录 —— 屏幕上看着像在动,其实是错的。判据就是
 * "整段文本恰好出现一次"(`chat-log.test.ts`)。
 */
import { type Component, Box, Markdown, Text, visibleWidth } from '@earendil-works/pi-tui';
import { card, rule } from '../design/tokens';
import type { OmdTuiTheme } from '../theme';

export type ChatRole = 'user' | 'assistant' | 'thinking' | 'notice' | 'tool' | 'divider';

/**
 * 工具行的可选料。`id` = pi 的 `toolCallId`;`detail` = 参数里那半句(由 `render/tool-arg` 挑);
 * `result` = 结果那半句(由 `render/tool-result` 挑,只有 `toolEnd` 给得出)。
 */
export interface ToolLineOpts {
  id?: string | undefined;
  detail?: string | null | undefined;
  /**
   * 结果摘要(`8 in 3 files` / `120 lines` / `exit 0`)。**只在 `toolEnd` 有意义** ——
   * 开跑那一刻还不知道搜到了什么。`null`/省略 = 这个工具挑不出结果那一格,不画。
   */
  result?: string | null | undefined;
}

interface Entry {
  role: ChatRole;
  /** tool 条目的键 —— `toolEnd` 靠它**原地更新**而不是再追加一条。 */
  toolKey?: string;
  /** 工具行不含标记的正文(`read config.txt`)。end 复用它, 免得把参数擦掉。 */
  toolText?: string;
  /** 欢迎屏字标 (appendBanner)。有对话之后**让位不画** —— 但条目留着, hasDialogue 判据不受它影响。 */
  banner?: boolean;
  /** toolStart 的 now() —— toolEnd 算耗时秒的左端(契约 I6)。 */
  toolStartMs?: number;
  /** 工具名上色函数 —— toolEnd/toolUpdate 沿用 start 那次, 名字换了颜色不漂。 */
  toolColor?: (t: string) => string;
  /** assistant 用 Markdown,其余用 Text —— 两者都实现 `Component`。 */
  component: Component;
  /** 流式累积缓冲;只有 assistant 用得上。 */
  buffer: string;
  /** 还在流式追加中?**收尾之后不许再往里追加**,否则两轮回复会粘成一条。 */
  open: boolean;
}

/** 从 pi 的消息 content 取纯文本。取不出 → `null`(**不编一个占位**)。 */
function plainText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const t = content
    .map((c) => (c as { type?: string; text?: string }).text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return t || null;
}
/**
 * 工具名 → 颜色分类(契约逐字):`read grep find` 蓝、`write edit bash` 黄。
 * 未在表里的工具默认蓝 — 读类默认比"任意猜"诚实,工具卡也是这套色。
 */
const READ_TOOLS = new Set(['read', 'grep', 'find']);
const WRITE_TOOLS = new Set(['write', 'edit', 'bash']);

/**
 * 角色前缀。字形全在 S6 白名单里(`✓ ✗ ·` 由 2026-08-07 的真终端读数解锁)。
 *
 * ⚠ 三种角色三种前缀不是装饰:一条工具输出被画成助手发言,读起来就像模型说了它没说过的话。
 */
const PREFIX: Record<ChatRole, string> = { user: '> ', assistant: '', thinking: '', notice: '! ', tool: '', divider: '' };
/** 工具行三态。**跑着的与跑完的必须看得出区别** —— 否则你不知道它是在忙还是卡住了。 */
export const TOOL_MARK = { running: '·', ok: '✓', fail: '✗' } as const;

/** `HH:MM`。秒不画 —— 对话不是日志, 秒只增加噪音。 */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 回合分界线:一整行 `─`,**时间戳嵌在右端**。
 *
 * ⚠ 分界与时间戳合成一行是刻意的。两件事各占一行的话,一屏 40 行里光分隔就吃掉 1/5 ——
 * 而 transcript 的每一行都在跟对话内容抢位置。
 *
 * 宽度由 `render(width)` 现算:状态行那套"算死一个宽度"的做法在这里会在改窗口时错位。
 */
export class TurnDivider implements Component {
  constructor(
    private label: string,
    private paint: (t: string) => string,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const label = this.label ? ` ${this.label}` : '';
    const dashes = Math.max(0, width - visibleWidth(label));
    return [this.paint(rule(dashes) + label)];
  }

  invalidate(): void {}
}

export class ChatLog implements Component {
  private entries: Entry[] = [];
  /** 思维链展开态。默认展开 —— owner 2026-08-13 点名"思维链也看不到", 默认收起会复发同一条。 */
  private thinkingExpanded = true;
  /** 关色下 `chrome.dim` 是 identity(0 字节);开色下是 ANSI 包裹(非 0)。契约冻结用同一闸。 */
  private readonly colorOn: boolean;

  /** 时钟从外面给 —— 时间戳要可测, 不能靠在测试里 sleep 出一个不确定的读数。 */
  constructor(
    private theme: OmdTuiTheme,
    private now: () => number = Date.now,
  ) {
    this.colorOn = theme.chrome.dim('') !== '';
  }

  /** @returns 条目数 —— 测试用它区分"追加进同一条"与"新开一条"。 */
  get length(): number {
    return this.entries.length;
  }

  /**
   * **人有没有真开口说话** —— 判据是有没有 `user` 角色的条目,不是 `length > 0`。
   *
   * ⚠ 两者不是一回事:欢迎屏字标走 `appendBanner`,它也进 `entries`。
   * 拿 `length > 0` 当"有对话"的话,首屏一起来就是真 —— 那正是本仓最怕的那种判据
   * (读起来对、量的是另一件事)。
   *
   * 消费者:侧栏 pathfinder 摘要**有对话之后就收起**(P3 件3 轮1 的 critic 判词)。
   */
  get hasDialogue(): boolean {
    return this.entries.some((e) => e.role === 'user');
  }

  /** 最后一条的完整文本(测试与流式收尾用)。没有条目时返回 `null`,不是空串。 */
  get lastText(): string | null {
    return this.entries.at(-1)?.buffer ?? null;
  }

  /** 清空(切会话时用)。**不清的话上一条会话的消息会留在屏上冒充这一条的历史。** */
  clear(): void {
    this.entries = [];
  }

  /**
   * 工具开跑 —— **一个工具一行**,`toolEnd` 原地改这一行。
   *
   * ⚠ 此前 start/end 各追加一条 notice:一轮十次调用就是二十行噪音,
   * 把真正的回复挤出屏幕。transcript 是用来读对话的,不是流水账。
   */
  toolStart(name: string, opts: ToolLineOpts = {}): void {
    this.closeStreaming();
    const text = opts.detail ? `${name} ${opts.detail}` : name;
    const startMs = this.now();
    const colorFn = READ_TOOLS.has(name)
      ? this.theme.chrome.toolRead
      : WRITE_TOOLS.has(name)
        ? this.theme.chrome.toolWrite
        : this.theme.chrome.toolRead;
    /**
     * 标记 `dim` + 名字 `toolRead/toolWrite` —— **关色下两路都是 identity**,
     * 拼出来的串与旧 `chrome.dim(\`· ${text}\`)` 逐字同 (I1)。
     */
    const painted = `${this.theme.chrome.dim(`${TOOL_MARK.running} `)}${colorFn(text)}`;
    this.entries.push({
      role: 'tool',
      toolKey: opts.id ?? name,
      toolText: text,
      toolStartMs: startMs,
      toolColor: colorFn,
      component: new Text(painted, 1, 0),
      buffer: text,
      open: false,
    });
  }

  /**
   * ★ **工具跑着的中途读数**(2026-08-14)——**原地更新同一行**,不追加。
   *
   * 治的是「在跑」与「卡死」在屏上长得一样这一族:一条跑 120 秒的命令,
   * 此前 120 秒里那一行是静止的 `· bash bun test`,而一个真卡住的命令长得**逐像素相同**。
   * 2026-08-13 那次 3h48m 全机停摆,屏幕上什么都看不见,一半原因就是这里。
   *
   * ⚠ 画的是**进度不是全文**:`N lines · <末行>`。把整段输出往对话记录里灌会做两件坏事——
   * 挤掉真正的回复,以及让同一段文字在 transcript 里出现几百遍(每次 update 一遍)。
   * 末行是"现在到哪了"最便宜的答案。
   *
   * ⚠ 找不到对应行**什么都不做**(与 `toolEnd` 相反):update 早于 start 到达是
   * 不可能的事件序,补一条只会造出一条永远不会被 end 收掉的孤儿行。
   */
  toolUpdate(name: string, opts: { id?: string | undefined; lines: number; tail?: string | undefined }): void {
    const key = opts.id ?? name;
    const hit = [...this.entries].reverse().find((e) => e.role === 'tool' && e.toolKey === key);
    if (!hit) return;
    const tail = opts.tail?.trim() ? ` · ${opts.tail.trim()}` : '';
    const progress = `${opts.lines} line${opts.lines === 1 ? '' : 's'}${tail}`;
    const body = hit.toolText ?? name;
    const colorFn = hit.toolColor
      ?? (READ_TOOLS.has(name)
        ? this.theme.chrome.toolRead
        : WRITE_TOOLS.has(name)
          ? this.theme.chrome.toolWrite
          : this.theme.chrome.toolRead);
    const rest = `${body} → ${progress}`;
    /** 同 toolStart:标记 dim, 名字上色。关色下逐字同旧 `chrome.dim(\`· ${body} → ${progress}\`)`。 */
    const painted = `${this.theme.chrome.dim(`${TOOL_MARK.running} `)}${colorFn(rest)}`;
    (hit.component as Text).setText(painted);
  }

  /**
   * 工具跑完 —— **原地更新**那一行。找不到对应行就补一条(总比丢掉强)。
   *
   * ⚠ 对回哪一行看 `opts.id`(pi 的 `toolCallId`)。**只按工具名对是错的**:
   * 同一个工具连调两次时,先跑完的那个会去更新最后一条同名行 ——
   * 屏上标记落在错的行上,而两行长得一样,看不出来。
   */
  toolEnd(name: string, ok: boolean, opts: ToolLineOpts = {}): void {
    const key = opts.id ?? name;
    const mark = ok ? TOOL_MARK.ok : TOOL_MARK.fail;
    const hit = [...this.entries].reverse().find((e) => e.role === 'tool' && e.toolKey === key);
    // 参数那半句以 start 那一行为准 —— end 事件不带 args, 拿不到就别把已经画对的擦掉。
    const body = hit?.toolText ?? (opts.detail ? `${name} ${opts.detail}` : name);
    const colorFn = hit?.toolColor
      ?? (READ_TOOLS.has(name)
        ? this.theme.chrome.toolRead
        : WRITE_TOOLS.has(name)
          ? this.theme.chrome.toolWrite
          : this.theme.chrome.toolRead);
    /**
     * 耗时秒(契约 I6):`toolEnd` 的 now() 减 `toolStart` 的 now()。
     * **≤ 1s 一字不加** —— 显式门控,不是靠 fmt 短路;持续几百毫秒就跑出 `0.5s` 没意义。
     */
    const dur = hit?.toolStartMs !== undefined ? this.now() - hit.toolStartMs : 0;
    const suffix = dur > 1000 ? ` ${(dur / 1000).toFixed(1)}s` : '';
    const rest = opts.result ? `${body} → ${opts.result}${suffix}` : `${body}${suffix}`;
    /**
     * 标记 `toolOk/toolFail` + 名字 `toolRead/toolWrite` —— **关色下两路都是 identity**,
     * 拼出来的串与旧 `chrome.dim(text)` / `chrome.warn(text)` 逐字同 (I1)。
     */
    const markColor = ok ? this.theme.chrome.toolOk : this.theme.chrome.toolFail;
    const painted = `${markColor(`${mark} `)}${colorFn(rest)}`;
    if (hit) {
      (hit.component as Text).setText(painted);
      return;
    }
    this.entries.push({
      role: 'tool',
      toolKey: key,
      toolText: body,
      toolColor: colorFn,
      component: new Text(painted, 1, 0),
      buffer: body,
      open: false,
    });
  }

  /**
   * 用户说的话。**前面先插一条回合分界线**(S-5)——
   * 此前两条消息之间只有一个空行, 一屏滚下来读不出"这是第几轮"。
   */
  appendUser(text: string): void {
    this.closeStreaming();
    this.entries.push({
      role: 'divider',
      component: new TurnDivider(hhmm(this.now()), this.theme.chrome.dim),
      buffer: '',
      open: false,
    });
    this.entries.push({
      role: 'user',
      component: new Text(this.theme.chrome.user(PREFIX.user + text), 1, 0),
      buffer: text,
      open: false,
    });
  }

  /**
   * **原样进屏,不加前缀、不套语义色**(S-3:欢迎屏字标走这条)。
   *
   * 为什么不复用 `appendNotice`:那条会加 `!` 前缀并整块染成警告黄 —— 一个黄色的、
   * 前面还挂着感叹号的字标,读起来像"出事了"。前缀与颜色由调用方自己定,
   * 是因为**这一类内容本来就不属于任何一种消息角色**,它是 chrome。
   */
  appendBanner(text: string): void {
    this.closeStreaming();
    this.entries.push({ role: 'notice', banner: true, component: new Text(text, 1, 0), buffer: text, open: false });
  }

  /**
   * 后端/引擎说的话。`reason` 那一类(断链说明卡)走这里。
   */
  appendNotice(text: string): void {
    this.closeStreaming();
    this.entries.push({
      role: 'notice',
      component: new Text(this.theme.chrome.warn(PREFIX.notice + text), 1, 0),
      buffer: text,
      open: false,
    });
  }

  /**
   * 流式追加。第一个 chunk 开一条新消息,后续 chunk 进**同一条**。
   *
   * ⚠ 追加之后必须由调用方 `tui.requestRender()` —— 组件改了内容**不会自己重绘**
   * (实读 `components/text.js:20-25`;S2 的 PTY lane 第一次跑就死在这条上)。
   */
  appendAssistantChunk(chunk: string): void {
    const last = this.entries.at(-1);
    if (last?.role === 'assistant' && last.open) {
      last.buffer += chunk;
      (last.component as Markdown).setText(last.buffer);
      return;
    }
    this.entries.push({
      role: 'assistant',
      component: new Markdown(chunk, 1, 0, this.theme.markdown),
      buffer: chunk,
      open: true,
    });
  }

  /**
   * **思维链**的流式追加(2026-08-13)。与 `appendAssistantChunk` 同构,只有三处不同:
   * 角色是 `thinking`、组件是 `Text` 不是 `Markdown`、整块 dim。
   *
   * ## 为什么这是一条独立的方法而不是一个参数
   *
   * 因为**收尾判据不同**:空正文的 assistant 气泡要丢掉(`closeStreaming` 那条),
   * 而思考区为空本来就不该开条目 —— 两者压进一个带 flag 的方法之后,
   * 那条 `if (last.role === 'assistant' && !last.buffer.trim())` 就得再长一个分支。
   *
   * ⚠ 这个方法此前**根本不存在**:`backend-embedded` 的 `mapAgentEvent` 只映射
   * `text_delta`,pi 的 `thinking_delta` 被整个丢掉了(「转不过来的不发」那条注释
   * 掩盖了它 —— 它转得过来,只是没人写)。owner 2026-08-13 的原话是「思维链也看不到」。
   */
  appendThinkingChunk(chunk: string): void {
    const last = this.entries.at(-1);
    if (last?.role === 'thinking' && last.open) {
      last.buffer += chunk;
      (last.component as Text).setText(this.theme.chrome.dim(last.buffer));
      return;
    }
    this.entries.push({
      role: 'thinking',
      component: new Text(this.theme.chrome.dim(chunk), 1, 0),
      buffer: chunk,
      open: true,
    });
  }

  /**
   * 收尾当前流式消息。**幂等** —— 没有开着的消息时什么都不做。
   *
   * ⚠ **一个字都没收到的气泡直接丢掉**(S-5)。模型在一轮里只发工具调用、不发文字时,
   * 流式会开出一条空的 assistant 条目 —— 它画出来什么都没有,却仍占一个条目位,
   * 于是"连续工具行不空行"那条规则被它从中间劈开:实测截图里
   * `✓ read config.txt` 与 `✓ ls` 之间就多了一行空。
   * 丢掉是安全的:没有正文的助手消息本来就不该占位置。
   */
  closeStreaming(): void {
    const last = this.entries.at(-1);
    if (!last?.open) return;
    last.open = false;
    // 空气泡直接丢 —— 思考区同理(模型开了 thinking 块却一个字都没吐时会留一条空条目)。
    if ((last.role === 'assistant' || last.role === 'thinking') && !last.buffer.trim()) this.entries.pop();
  }

  /**
   * 把一段已存会话**回放**进记录(切会话 / 启动时恢复)。
   *
   * ⚠ 回放的是**历史不是新消息**:每条都直接定型(`open: false`),
   * 不走流式追加 —— 否则最后一条会是"开着的",下一轮的第一片会续到它后面。
   *
   * 认不出的角色(toolResult 等)**跳过不画**:把一条工具结果画成助手发言,
   * 读起来就像模型说过它没说过的话。
   */
  replay(messages: readonly { role?: string; content?: unknown }[]): void {
    this.clear();
    for (const m of messages) {
      const text = plainText(m.content);
      if (!text) continue;
      if (m.role === 'user') this.appendUser(text);
      else if (m.role === 'assistant') {
        this.appendAssistantChunk(text);
        this.closeStreaming();
      }
    }
  }

  /**
   * Ctrl+O:思维链折叠/展开(dsh-TUI / claude code 同款键)。
   * @returns 切换后的状态(true = 展开)—— 调用方拿它写回执。
   */
  toggleThinking(): boolean {
    this.thinkingExpanded = !this.thinkingExpanded;
    return this.thinkingExpanded;
  }

  render(width: number): string[] {
    // 欢迎屏字标有对话之后**让位不画** (W3a V5): 条目留着 (hasDialogue 判据不吃它),
    // 只是渲染跳过 —— 与贴底合用后, 对话开场即接管整个转录区。
    const entries = this.hasDialogue ? this.entries.filter((x) => !x.banner) : this.entries;
    const out: string[] = [];
    let i = 0;
    while (i < entries.length) {
      const e = entries[i];
      if (!e) {
        i++;
        continue;
      }
      // 找末尾:连续工具行组的右端。单条 tool 不进 Box。
      let j = i;
      while (j < entries.length) {
        const cur = entries[j];
        if (!cur || cur.role !== 'tool') break;
        j++;
      }
      const groupSize = j - i;
      if (groupSize >= 2 && this.colorOn) {
        /**
         * ★ 工具卡(I3):连续工具行组画进 pi-tui 现成的 Box, 卡界用既有空行位画 ——
         * Box `paddingX=1, paddingY=0` 不新增行, 单条工具行=Text 默认 padding=3 行不变。
         * 卡顶/卡底用 `card.top/bottom` 画 — 边框字形是 token 的事,不在组件里再开第二源。
         */
        const box = new Box(1, 0);
        for (let k = i; k < j; k++) {
          const entry = entries[k];
          if (entry) box.addChild(entry.component);
        }
        const lines = box.render(width);
        const top = this.theme.chrome.dim(card.top('', width, 0));
        const bot = this.theme.chrome.dim(card.bottom(width));
        if (lines.length > 0) {
          lines[0] = top;
          lines[lines.length - 1] = bot;
        } else {
          lines.push(top, bot);
        }
        // 连续工具行不空行(一串工具是一组);分界线与紧随的 user 之间也不空 ——
        // 空了的话分界线看起来像是属于上一轮的尾巴, 而它标的是下一轮的头。
        const prev = i > 0 ? entries[i - 1] : undefined;
        const gap = i > 0 && prev?.role !== 'tool';
        if (gap) out.push('');
        out.push(...lines);
        i = j;
      } else {
        const prev = i > 0 ? entries[i - 1] : undefined;
        const glued = (e.role === 'tool' && prev?.role === 'tool') || (e.role === 'user' && prev?.role === 'divider');
        const gap = i > 0 && !glued;
        // 折叠态的思维链**一条一行**:行数照报且流式中还在涨 —— "收起"不许变成"看不出它在想"。
        // 字形全在白名单内('·' 由 TOOL_MARK.running 早已解锁, 其余 ASCII)。
        const lines =
          e.role === 'thinking' && !this.thinkingExpanded
            ? [this.theme.chrome.dim(`· thinking (${e.buffer.split('\n').length} lines) - Ctrl+O expands`)]
            : e.component.render(width);
        if (gap) out.push('');
        out.push(...lines);
        i++;
      }
    }
    return out;
  }

  invalidate(): void {
    for (const e of this.entries) e.component.invalidate();
  }
}
