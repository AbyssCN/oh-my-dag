/**
 * src/mcp/progress —— **长跑工具的心跳**(2026-08-07)。
 *
 * ## 它修的是一个真实的、量到的失败
 *
 * `dag_research` 连续两次被 MCP 客户端判死:「sent no response or progress for 1800s; aborting」。
 * 查下来**不是引擎慢或坏** —— 是它的 handler 写成 `async (args) => ...`,
 * **第二个参数 `extra` 根本没接**,而 `sendNotification` 和 `_meta.progressToken` 就在那里。
 * 于是它在长跑期间对客户端**完全静默**,客户端只能按超时处理。
 *
 * 同一个洞在所有长跑工具上都有(`solve` / `dag_run`)。
 *
 * ## 为什么是心跳而不是"真进度"
 *
 * 真进度要给 `researchFanout` 之类加回调口,那是改引擎。而客户端要的其实只有一件事:
 * **这条请求还活着吗**。心跳答得了这个,且**零侵入** —— 引擎一个字不用改。
 * 将来引擎真有阶段信号了,再把 `message` 换成阶段名即可,这一层的接口不用动。
 *
 * ## 三条不显然的
 *
 * 1. **没有 `progressToken` 就什么都不发。** token 是客户端在请求里给的 —— 没给 = 它不想收进度,
 *    硬发是往协议通道里塞它没订阅的东西。
 * 2. **定时器必须 `unref`。** 不 unref 会吊住事件循环,短命进程(`omd mcp` 之外的脚本)跑完不退出。
 * 3. **发送失败一律吞掉。** 心跳是观察面,观察者不许扰动被观察者 —— 通知发不出去
 *    (客户端断了/传输忙)绝不能让正在跑的研究任务挂掉。
 */

/** MCP `RequestHandlerExtra` 里我们用到的那两格。不 import SDK 类型 —— 这一片要能被单测直接喂假货。 */
export interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification?: ((n: unknown) => Promise<void>) | undefined;
}

/** 默认心跳间隔。客户端的 idle timeout 通常以分钟计,25 秒有足够余量。 */
export const HEARTBEAT_MS = 25_000;

/**
 * 跑 `run()`,期间按 `everyMs` 往客户端发 `notifications/progress`。
 *
 * @param label 进度消息里的人话(如 `dag_research`)——客户端会把它显示给人看。
 * @returns `run()` 的结果;`run()` 抛就原样抛(心跳不改变任何行为)。
 */
export async function withHeartbeat<T>(
  extra: ProgressCapableExtra | undefined,
  label: string,
  run: () => Promise<T>,
  everyMs: number = HEARTBEAT_MS,
  timer: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (h: unknown) => void;
  } = { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) },
): Promise<T> {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  // 没订阅进度 → 一个字都不发, 直接跑。
  if (token === undefined || typeof send !== 'function') return run();

  const started = Date.now();
  let beats = 0;
  const handle = timer.set(() => {
    beats += 1;
    const sec = Math.round((Date.now() - started) / 1000);
    void Promise.resolve(
      send({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: beats,
          message: `${label} 仍在跑 (${sec}s)`,
        },
      }),
      // 观察者不许扰动被观察者:通知发不出去绝不能让任务挂掉。
    ).catch(() => undefined);
  }, everyMs);
  // 不 unref 会吊住事件循环 —— 短命进程跑完不退出。
  (handle as { unref?: () => void })?.unref?.();

  try {
    return await run();
  } finally {
    timer.clear(handle);
  }
}
