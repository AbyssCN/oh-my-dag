/**
 * src/tui/attention-reader —— 主线程侧: 把 `readAttention` 放进 Worker 异步取 (2026-09-02)。
 *
 * ## 为什么
 *
 * `readAttention` 经 PathBackend 端口读全部开放地图; gh 后端实测 5 图 5.4s **同步** (execFileSync 调 gh)。
 * TUI 在启动 / 每轮收尾 / 裁完票都刷一次 —— 同步读等于每次冻屏 5s。Worker 让主线程先用上一次的票画,
 * 数回来再重画。
 *
 * ## 纪律
 *
 *   - 同一 cwd 只允许一个在飞请求, 后来的复用它 (合并), 不排队打 gh。
 *   - Worker 起不来 (打包环境 / 权限) → **同步兜底** `readAttention`, 不让 inbox 因为线程模型缺席而空。
 *     兜底走过一次就固定走兜底 (日志留一行证据), 别每次刷新都试一次失败的 Worker。
 *   - Worker 报 error → 拒绝所有在飞 promise, 丢掉这个 Worker, 下次刷新重建。
 *   - `unref()`: Worker 不许拖住进程退出 (Ctrl+C 两次要干净退)。
 */
import { logger } from '../logger';
import { readAttention, type AttentionView } from '../serve/read-api';
import type { AttentionReply, AttentionRequest } from './attention-worker';

export type AttentionReader = (cwd: string) => Promise<AttentionView>;

export function createAttentionReader(): AttentionReader {
  let worker: Worker | null = null;
  let fallbackSync = false;
  let seq = 0;
  const inflight = new Map<number, { cwd: string; resolve: (v: AttentionView) => void; reject: (e: Error) => void }>();

  function failAll(reason: string): void {
    for (const [, p] of inflight) p.reject(new Error(reason));
    inflight.clear();
  }

  function ensureWorker(): Worker | null {
    if (worker) return worker;
    if (fallbackSync) return null;
    try {
      const w = new Worker(new URL('./attention-worker.ts', import.meta.url));
      w.onmessage = (ev: MessageEvent<AttentionReply>) => {
        const p = inflight.get(ev.data.seq);
        if (!p) return;
        inflight.delete(ev.data.seq);
        if (ev.data.ok) p.resolve(ev.data.view);
        else p.reject(new Error(ev.data.err));
      };
      w.onerror = (ev: ErrorEvent) => {
        const msg = ev.message || 'attention worker error';
        logger.warn({ err: msg }, '[omd/tui] attention worker died -> rebuilt on next refresh');
        failAll(msg);
        worker = null;
      };
      (w as unknown as { unref?: () => void }).unref?.(); // bun 有 unref, DOM 类型表里没有
      worker = w;
      return w;
    } catch (err) {
      fallbackSync = true;
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] attention worker unavailable -> sync readAttention from now on');
      return null;
    }
  }

  return (cwd) => {
    for (const [, p] of inflight) {
      if (p.cwd === cwd) {
        // 合并: 已有同 cwd 在飞 → 挂到它上面, 不再发第二个
        return new Promise<AttentionView>((resolve, reject) => {
          const orig = { resolve: p.resolve, reject: p.reject };
          p.resolve = (v) => { orig.resolve(v); resolve(v); };
          p.reject = (e) => { orig.reject(e); reject(e); };
        });
      }
    }
    const w = ensureWorker();
    if (!w) {
      try {
        return Promise.resolve(readAttention(cwd));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    const id = ++seq;
    return new Promise<AttentionView>((resolve, reject) => {
      inflight.set(id, { cwd, resolve, reject });
      const req: AttentionRequest = { seq: id, cwd };
      w.postMessage(req);
    });
  };
}
