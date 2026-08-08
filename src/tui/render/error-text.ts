/**
 * src/tui/render/error-text —— 把 provider 抛上来的错**压成一行人话**再进对话区。
 *
 * ## 起因是一张真帧,不是设想
 *
 * P3 件3 轮3 的盲比里,三跑有两跑点同一件事:
 * 「403 报错把整段原始 JSON(含 type/message/长 URL)原文倾倒进对话区,占 4 行还没折行截断,
 * 用户要的关键信息(配额用尽、何时刷新)被埋在第 2 行中段」。帧在
 * `docs/bars/refs/omd/` 那一轮的 `08-streaming`(现已重采,缺陷仍在实装里)。
 *
 * 屏上原来长这样(4 行):
 * ```
 * ! 这一轮发不出去: [chat-agent] provider 错误: 403 {"error":{"type":"permission_error",
 * "message":"You've reached your usage limit for this billing cycle. Your quota will be
 * refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan:
 * https://www.kimi.com/code/#pricing"},"type":"error"}
 * ```
 *
 * ## 纪律:**压的是呈现,不是证据**
 *
 * 原文**照旧进日志**(调用点的 `logger.warn` 一个字没动),这里只管进屏的那一行。
 * 本仓的规矩是「fail-open 可以吞异常,不许吞证据」—— 所以:
 * - 认得出的结构 → 取 `error.message`(人话)+ 保留 URL(那是"怎么解决"的唯一线索)+ 保留状态码;
 * - **认不出的 → 原样返回**(不猜、不截断成半句);
 * - 太长 → 截断并**标出还有多少字**(不静默吞掉尾巴)。
 */

/** 一行最多多少个字符 —— 超了截断并标注。110 列终端下留出前缀与边距。 */
export const ERROR_LINE_MAX = 150;

const URL_RE = /https?:\/\/[^\s"'}]+/;

/**
 * 从 provider 错误原文里取出可读的一行。
 *
 * @param raw 抛上来的整条 message(可能形如 `前缀: 403 {json}`,也可能是纯文本)
 */
export function humanizeProviderError(raw: string): string {
  const braceAt = raw.indexOf('{');
  if (braceAt === -1) return cap(raw);

  const head = raw.slice(0, braceAt).trimEnd(); // `[chat-agent] provider 错误: 403`
  const body = raw.slice(braceAt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // ⚠ 认不出就原样返回 —— 半截 JSON 里也可能有唯一有用的那句话。
    return cap(raw);
  }
  const msg = pickMessage(parsed);
  if (msg === null) return cap(raw);

  const url = URL_RE.exec(body)?.[0];
  /**
   * ⚠ **URL 永远留着, 截的是正文** —— 第一版是先拼好再整条 `cap()`,
   * 结果那条真实的 403 恰好在 150 字处被切断, **URL 正好被吃掉**:
   * 而 URL 是这条错误里唯一告诉人"怎么解决"的东西。是那条闸红出来的。
   */
  const bare = url && msg.includes(url) ? msg.replace(url, '').replace(/\s+$/, '').replace(/[::]\s*$/, '') : msg;
  const tail = url ? ` ${url}` : '';
  const fixed = `${head} `.length + tail.length;
  const room = Math.max(24, ERROR_LINE_MAX - fixed);
  const flat = bare.replace(/\s+/g, ' ').trim();
  const shown = flat.length <= room ? flat : `${flat.slice(0, room)}…(还有 ${flat.length - room} 字, 全文在日志里)`;
  return `${head} ${shown}${tail}`.replace(/\s+/g, ' ').trim();
}

/** 逐层找 `message`:`{error:{message}}` / `{message}` / `{error:"…"}` 三种都见过。 */
function pickMessage(o: unknown): string | null {
  if (typeof o === 'string') return o;
  if (o === null || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  if (typeof rec.message === 'string' && rec.message.trim() !== '') return rec.message.trim();
  if (rec.error !== undefined) return pickMessage(rec.error);
  return null;
}

/** 截断并**说清还有多少字**(静默截断会让人以为错误信息就这么短)。 */
function cap(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= ERROR_LINE_MAX) return one;
  return `${one.slice(0, ERROR_LINE_MAX)}…(还有 ${one.length - ERROR_LINE_MAX} 字, 全文在日志里)`;
}
