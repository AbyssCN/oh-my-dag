/**
 * src/tui/sessions —— **多会话切换**(2026-08-07)。
 *
 * ## 数据一直都有,只是没画界面
 *
 * `OmdBackend.listSessions()` / `loadHistory()` 从 S10 起就在(`backend.ts` 的契约里),
 * `ChatStore` 也一直在按 id 分文件存。缺的只是一个入口 —— 于是"多会话"这件事
 * **技术上成立、用户上不存在**。
 *
 * ## 切会话要清屏,不清就是撒谎
 *
 * 切过去之后屏上必须是**那条会话的历史**。不清空的话上一条的消息会留着冒充这一条的上下文,
 * 而模型看到的(`ChatStore` 里那条)和人看到的(屏上这堆)是两回事 ——
 * 那是本仓 S-1 那一族里最难查的一种:两边都"有内容",只是不是同一份。
 */
import type { TuiSessionMeta } from './backend';

/** `/session` 的解析。四态。 */
export type SessionCommand =
  | { kind: 'list' }
  | { kind: 'switch'; id: string }
  | { kind: 'new'; id: string | null }
  | { kind: 'usage'; reason: string }
  | null;

/** `ChatStore` 的 id 白名单(防路径穿越)。这里**先拦一次**,好给出人话而不是一个抛栈。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseSessionCommand(text: string): SessionCommand {
  const t = text.trim();
  if (t !== '/session' && t !== '/sessions' && !t.startsWith('/session ')) return null;
  if (t === '/session' || t === '/sessions') return { kind: 'list' };
  const parts = t.split(/\s+/).slice(1);
  const first = parts[0] as string;
  if (first === 'new') {
    const id = parts[1];
    if (id && !ID_RE.test(id)) return { kind: 'usage', reason: `会话 id 非法: ${id}(只许字母数字 _ -,≤64 字符)` };
    return { kind: 'new', id: id ?? null };
  }
  if (!ID_RE.test(first)) return { kind: 'usage', reason: `会话 id 非法: ${first}(只许字母数字 _ -,≤64 字符)` };
  return { kind: 'switch', id: first };
}

/**
 * 会话列表渲染。
 *
 * @param current 当前会话 id —— **标出来**。不标的话切完不知道切没切成。
 */
export function formatSessions(list: readonly TuiSessionMeta[], current: string): string {
  if (list.length === 0) {
    // 灰常量即真值:一条都没有是真的(还没说过话)。不画一张空表。
    return `还没有已存会话(当前 ${current},说第一句话时才建)。\n用法: /session <id> 切换 · /session new [id] 新开`;
  }
  const rows = list.map((s) => {
    const mark = s.id === current ? '*' : ' ';
    const when = s.updatedAt > 0 ? new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
    return `  ${mark} ${s.id}  ${when}  ${s.title || '(无标题)'}`;
  });
  return `会话(\`*\` = 当前):\n${rows.join('\n')}\n用法: /session <id> 切换 · /session new [id] 新开`;
}

/** 新会话 id:`s-<秒级时间戳>`。**不用随机串** —— 列表里按时间读得出先后。 */
export function newSessionId(now: () => number = Date.now): string {
  return `s-${Math.floor(now() / 1000)}`;
}
