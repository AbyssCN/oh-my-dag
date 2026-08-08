/**
 * src/tui/components/chat-log —— **对话记录**(TUI SDD 切片 S8)。
 *
 * ## 三种条目,三种画法,理由不同
 *
 * - `user` —— 用户打的原文。**不当 markdown 渲染**:用户打的 `*` `#` 是他打的字符,
 *   不是排版指令,渲染掉等于篡改回显。
 * - `assistant` —— 走 pi-tui 的 `Markdown`(内部 `marked`)。代码高亮是 S7 从 theme 挂进来的,
 *   这里不认识 highlight 这回事。
 * - `notice` —— 引擎/后端说的话(含**断链说明卡**:后端拒绝时的原因句)。
 *   刻意与 assistant 分开:一句"引擎没接通"被画成助手发言,读起来就像模型在回答。
 *
 * ## 流式:一条消息,不是一堆消息
 *
 * `appendAssistantChunk` 往**同一条**消息里追加。写成"每个 chunk 一条消息"会让
 * 64 个 token 变成 64 条记录 —— 屏幕上看着像在动,其实是错的。判据就是
 * "整段文本恰好出现一次"(`chat-log.test.ts`)。
 */
import { type Component, Markdown, Text, visibleWidth } from '@earendil-works/pi-tui';
import { rule } from '../design/tokens';
import type { OmdTuiTheme } from '../theme';

export type ChatRole = 'user' | 'assistant' | 'notice' | 'tool' | 'divider';

/** 工具行的可选料。`id` = pi 的 `toolCallId`;`detail` = 参数里那半句(由 `render/tool-arg` 挑)。 */
export interface ToolLineOpts {
  id?: string | undefined;
  detail?: string | null | undefined;
}

interface Entry {
  role: ChatRole;
  /** tool 条目的键 —— `toolEnd` 靠它**原地更新**而不是再追加一条。 */
  toolKey?: string;
  /** 工具行不含标记的正文(`read config.txt`)。end 复用它, 免得把参数擦掉。 */
  toolText?: string;
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
 * 角色前缀。字形全在 S6 白名单里(`✓ ✗ ·` 由 2026-08-07 的真终端读数解锁)。
 *
 * ⚠ 三种角色三种前缀不是装饰:一条工具输出被画成助手发言,读起来就像模型说了它没说过的话。
 */
const PREFIX: Record<ChatRole, string> = { user: '> ', assistant: '', notice: '! ', tool: '', divider: '' };
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

  /** 时钟从外面给 —— 时间戳要可测, 不能靠在测试里 sleep 出一个不确定的读数。 */
  constructor(
    private theme: OmdTuiTheme,
    private now: () => number = Date.now,
  ) {}

  /** @returns 条目数 —— 测试用它区分"追加进同一条"与"新开一条"。 */
  get length(): number {
    return this.entries.length;
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
    this.entries.push({
      role: 'tool',
      toolKey: opts.id ?? name,
      toolText: text,
      component: new Text(this.theme.chrome.dim(`${TOOL_MARK.running} ${text}`)),
      buffer: text,
      open: false,
    });
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
    const text = `${mark} ${body}`;
    const paint = (t: string) => (ok ? this.theme.chrome.dim(t) : this.theme.chrome.warn(t));
    if (hit) {
      (hit.component as Text).setText(paint(text));
      return;
    }
    this.entries.push({ role: 'tool', toolKey: key, toolText: body, component: new Text(paint(text)), buffer: body, open: false });
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
      component: new Text(this.theme.chrome.user(PREFIX.user + text)),
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
    this.entries.push({ role: 'notice', component: new Text(text), buffer: text, open: false });
  }

  /**
   * 后端/引擎说的话。`reason` 那一类(断链说明卡)走这里。
   */
  appendNotice(text: string): void {
    this.closeStreaming();
    this.entries.push({
      role: 'notice',
      component: new Text(this.theme.chrome.warn(PREFIX.notice + text)),
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
      component: new Markdown(chunk, 0, 0, this.theme.markdown),
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
    if (last.role === 'assistant' && !last.buffer.trim()) this.entries.pop();
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

  render(width: number): string[] {
    // 条目之间空一行:没有分隔的话两条消息读起来是一段。
    // ⚠ 例外:**连续的工具行不空行** —— 一串工具本来就是一组,每行之间插空会把它们
    //   拆成看起来互不相关的十件事。首条前面也不空。
    return this.entries.flatMap((e, i) => {
      const prev = this.entries[i - 1];
      // 连续工具行不空行(一串工具是一组);分界线与紧随的 user 之间也不空 ——
      // 空了的话分界线看起来像是属于上一轮的尾巴, 而它标的是下一轮的头。
      const glued = (e.role === 'tool' && prev?.role === 'tool') || (e.role === 'user' && prev?.role === 'divider');
      const gap = i > 0 && !glued;
      return gap ? ['', ...e.component.render(width)] : e.component.render(width);
    });
  }

  invalidate(): void {
    for (const e of this.entries) e.component.invalidate();
  }
}
