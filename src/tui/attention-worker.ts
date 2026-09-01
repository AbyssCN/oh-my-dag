/**
 * src/tui/attention-worker —— `readAttention` 的 Worker 壳 (2026-09-02)。
 *
 * 只做一件事: 收 `{ seq, cwd }`, 回 `{ seq, ok, view | err }`。取数本身在 `serve/read-api.ts`,
 * 这里不加任何判据 —— Worker 存在的唯一理由是 gh 后端的同步 5s 不许冻住 TUI 主线程。
 */
import { readAttention, type AttentionView } from '../serve/read-api';

export interface AttentionRequest {
  seq: number;
  cwd: string;
}
export type AttentionReply = { seq: number; ok: true; view: AttentionView } | { seq: number; ok: false; err: string };

declare const self: Worker;

self.onmessage = (ev: MessageEvent<AttentionRequest>) => {
  const { seq, cwd } = ev.data;
  try {
    const reply: AttentionReply = { seq, ok: true, view: readAttention(cwd) };
    self.postMessage(reply);
  } catch (err) {
    const reply: AttentionReply = { seq, ok: false, err: err instanceof Error ? err.message : String(err) };
    self.postMessage(reply);
  }
};
