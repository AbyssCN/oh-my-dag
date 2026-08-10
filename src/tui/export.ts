/**
 * src/tui/export —— `/export` 的**纯函数半边**(SDD 切片, 与 tui.ts 的 handleExport 同片进仓)。
 *
 * 本文件**零 IO**:markdown 成形与缺省路径都是纯计算,写盘/建目录在调用方
 * (`handleExport`) —— 契约要求「文件系统副作用在纯格式化之外」,这样 L1 测试
 * 不用碰磁盘就能钉死形状与路径格式。
 *
 * 数据来源约定:`backend.loadHistory({sessionId})` 返回 `AgentMessage[]`,这里只消费,
 * 不新造存储。sessionId 已过 ChatStore 白名单(见 backend-embedded 的打开闸),
 * 缺省路径因此可以直接拼 —— 但拼出来仍是**相对 cwd 的路径**,绝对化与 mkdir -p
 * 是写盘方的活。
 */
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * 消息 → 可读文本块。
 *
 * `AgentMessage` 是 `Message | CustomAgentMessages` 的联合,自定义成员没有 content ——
 * 这里像 `harness/dream/extract-chat.ts:entryText` 一样按弱边界取:
 * content 是 string 直接用;是块数组则逐块取 text / thinking,其余块给 `[type]` 占位
 * (导出是**完整记录**,静默丢块比占位更糟);再退到自定义消息的 `summary`。
 * 全都没有 → 空串,由调用方落 `(no text)` 真话,不编。
 */
function messageText(msg: AgentMessage): string {
  const m = msg as { content?: unknown; summary?: unknown };
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c) {
      if (typeof p !== 'object' || p === null) continue;
      const block = p as { type?: unknown; text?: unknown; thinking?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
      else parts.push(`[${String(block.type ?? 'unknown')}]`);
    }
    return parts.join('\n');
  }
  return typeof m.summary === 'string' ? m.summary : '';
}

/**
 * 会话历史 → markdown 转录。形状冻结(契约 §5):
 *
 * ```
 * # Session <id>
 *
 * ## <role> · <iso ts>
 *
 * <文本块>
 * ```
 *
 * 空历史 → 只有表头,不编消息。角色与时间戳原样落盘,不做美化。
 */
export function exportTranscriptMarkdown(messages: AgentMessage[], meta: { sessionId: string }): string {
  const lines: string[] = [`# Session ${meta.sessionId}`, ''];
  for (const msg of messages) {
    lines.push(`## ${msg.role} · ${new Date(msg.timestamp).toISOString()}`, '');
    const text = messageText(msg);
    lines.push(text === '' ? '(no text)' : text, '');
  }
  return lines.join('\n');
}

/**
 * 缺省导出路径:`.omd/exports/<sessionId>-<ts>.md`(相对 cwd)。
 *
 * ts 取 ISO 但剥掉冒号与点 —— 冒号在 Windows 文件名非法,点号让扩展名糊掉;
 * 剩下的 `2024-01-01T12-34-56-789Z` 仍是字典序 = 时间序,可直接按名排序。
 * sessionId 由白名单保证安全(见文件头),这里不重复消毒。
 */
export function defaultExportPath(sessionId: string, now: number): string {
  const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
  return join('.omd', 'exports', `${sessionId}-${ts}.md`);
}
