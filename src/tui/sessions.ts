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

/** `/session` 的解析。五态(切片⑦ 加 fork)。 */
export type SessionCommand =
  | { kind: 'list' }
  | { kind: 'switch'; id: string }
  | { kind: 'new'; id: string | null }
  | { kind: 'fork'; id: string | null }
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
  if (first === 'new' || first === 'fork') {
    const id = parts[1];
    if (id && !ID_RE.test(id)) return { kind: 'usage', reason: `Invalid session id: ${id} (letters, digits, _ and - only, <=64 chars)` };
    return { kind: first, id: id ?? null };
  }
  if (!ID_RE.test(first)) return { kind: 'usage', reason: `Invalid session id: ${first} (letters, digits, _ and - only, <=64 chars)` };
  return { kind: 'switch', id: first };
}

/**
 * `/new` / `/fork` 的解析 —— `/session new|fork [id]` 的直达别名。
 * 人想开新会话时想的是 `new`,不是 `session` 子命令。五态与 `parseSessionCommand`
 * 共用(SessionCommand),id 白名单同 `ID_RE`;`/newx` 这类前缀撞车不拦,
 * 返回 null 让主分发回落成普通文本 —— 与 `/sessionx` 回落同纪律。
 */
export function parseNewForkCommand(text: string): SessionCommand {
  const m = /^\/(new|fork)(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  const kind = m[1] as 'new' | 'fork';
  const rest = m[2] ?? '';
  if (rest === '') return { kind, id: null };
  const id = rest.split(/\s+/)[0] as string; // 多余参数同 parseSessionCommand: 静默忽略
  if (!ID_RE.test(id)) return { kind: 'usage', reason: `Invalid session id: ${id} (letters, digits, _ and - only, <=64 chars)` };
  return { kind, id };
}

/**
 * 会话列表渲染。
 *
 * @param current 当前会话 id —— **标出来**。不标的话切完不知道切没切成。
 */
export function formatSessions(list: readonly TuiSessionMeta[], current: string): string {
  if (list.length === 0) {
    // 灰常量即真值:一条都没有是真的(还没说过话)。不画一张空表。
    return `No stored sessions yet (current ${current}, created when you say something).\nUsage: /session <id> to switch · /session new [id] to start one`;
  }
  const rows = list.map((s) => {
    const mark = s.id === current ? '*' : ' ';
    const when = s.updatedAt > 0 ? new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
    // fork 的 lineage 画在行尾 (切片⑦): 树的边是数据不是装饰, 有 parent 才画。
    const lineage = s.parent ? `  <- forked from ${s.parent}` : '';
    return `  ${mark} ${s.id}  ${when}  ${s.title || '(no title)'}${lineage}`;
  });
  return `Sessions (\`*\` = current):\n${rows.join('\n')}\nUsage: /session <id> to switch · /session new [id] to start one · /session fork [id] to branch`;
}

/**
 * 相对时间(`2h 前` / `3d 前`)。
 *
 * ⚠ **NULL ≠ 0**:`updatedAt === 0` 是「没记时间」不是「刚刚」,返回 `—`
 * (与同文件 `formatSessions` 那一列逐字一致)。写成 `0s 前` 会把「没记」冒充成「刚发生」。
 */
export function relTime(updatedAt: number, now: number): string {
  if (!(updatedAt > 0)) return '—';
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * `/session` 选择器的选项 —— **纯函数**,逻辑不留在 `tui.ts` 里(可测)。
 *
 * ## 为什么改这一处
 *
 * 选择器本来就有(`tui.ts` 的 `handleSession`),但三处让它形同虚设,owner 2026-08-21 点名:
 *   ① **主标签是裸 id**(`s-1787309805-834625`),标题被降到第二列 —— 于是整屏是一列
 *      认不出来的时间戳,而人是靠"那次聊的是什么"找会话的;
 *   ② **没传 `search: true`** —— 而同一个 `dialogSelect` 在 `/models` / `/tree` 那两处都开了;
 *   ③ **没传 `maxVisible`** —— 走默认 10 行,会话一多就翻不到。
 *
 * 于是这里把 **title 提成主标签**,id 与相对时间降到副列。
 * ⚠ 硬约束:pi-tui 的 `SelectList` **一个 item 只画一行**(`description` 被压成单行放右列),
 * 所以副列是 `id · 时间 · 来源` 拼成的一行,不是第二行卡片。
 */
export function sessionPickerOptions(
  list: readonly TuiSessionMeta[],
  current: string,
  now: number,
): { value: string; label: string; description: string }[] {
  return list.map((s) => ({
    value: s.id,
    // `*` 标当前 —— 与 formatSessions 同一个记号。不标的话切完不知道切没切成。
    label: `${s.id === current ? '* ' : '  '}${s.title || '(no title)'}`,
    description: [s.id, relTime(s.updatedAt, now), ...(s.parent ? [`forked from ${s.parent}`] : [])].join(' · '),
  }));
}

/** 新会话 id:`s-<秒级时间戳>`。**不用随机串** —— 列表里按时间读得出先后。 */
export function newSessionId(now: () => number = Date.now): string {
  return `s-${Math.floor(now() / 1000)}`;
}

/**
 * ★ **一个 TUI 进程的默认会话 id**(2026-08-09)—— 不再是写死的 `'tui'`。
 *
 * owner 的日常用法是**同一个仓开多个 TUI 窗口**。写死 `'tui'` 时两个窗口写的是同一条会话:
 * 今天(`ChatStore`)是 last-write-wins **静默丢轮次**;换到新存储层之后是第二个窗口
 * 第一次说话就被跨进程写锁**响亮拒绝** —— 对这个用法是倒退。每个进程起来开自己的会话
 * 就**根本不撞**,锁降级成兜底(只有显式 `/session switch` 到同一条时才可能撞)。
 *
 * 带 `pid`:`s-<秒>` 在同一秒起两个窗口会撞成同一条 —— 秒级时间戳区分不开脚本/tmux
 * 布局恢复那种"一起起来"的场景,而那正是多开最常见的来法。
 *
 * ⚠ **不在这里建会话文件**:空会话不写进磁盘那条老纪律靠"首条消息才 create"保住,
 * 这个函数只产 id。
 */
export function defaultTuiSessionId(now: () => number = Date.now, pid: number = process.pid): string {
  return `${newSessionId(now)}-${pid}`;
}

/** fork 分支的默认 id:`<源>-f<秒级时间戳>` —— 名字自带 lineage, 列表里一眼读得出从哪长出来。 */
export function forkSessionId(fromId: string, now: () => number = Date.now): string {
  const base = `${fromId}-f${Math.floor(now() / 1000)}`;
  // id 白名单上限 64: 源 id 很长时截头保尾 (尾部是时间戳, 是区分度所在)。
  return base.length <= 64 ? base : base.slice(base.length - 64);
}
