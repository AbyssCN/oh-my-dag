/**
 * 长跑心跳的判据。**每条都带反向自检** —— 一条永远绿的闸不是闸。
 *
 * 起因是量到的失败:`dag_research` 连续两次被客户端判死
 * (「sent no response or progress for 1800s」), 根因是 handler 没接 `extra`。
 */
import { describe, expect, test } from 'bun:test';
import { withHeartbeat } from './progress';

/** 假定时器:手动推进,单测零等待。 */
function fakeTimer() {
  const fns: (() => void)[] = [];
  let cleared = 0;
  return {
    fns,
    cleared: () => cleared,
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const f of [...fns]) f();
    },
    impl: {
      set: (fn: () => void) => {
        fns.push(fn);
        return { id: fns.length, unref: () => undefined };
      },
      clear: () => {
        cleared += 1;
        fns.length = 0;
      },
    },
  };
}

describe('withHeartbeat', () => {
  // ★ 反向自检: 把 withHeartbeat 里的 send 调用删掉 → 这条当场红。
  test('★ 有 progressToken 就发心跳, 带 token 与递增序号', async () => {
    const sent: Record<string, unknown>[] = [];
    const t = fakeTimer();
    const extra = {
      _meta: { progressToken: 'tok-1' },
      sendNotification: async (n: unknown) => {
        sent.push(n as Record<string, unknown>);
      },
    };
    await withHeartbeat(extra, 'dag_research', async () => {
      t.tick(3);
      return 'done';
    }, 1, t.impl);
    expect(sent).toHaveLength(3);
    const p = (sent[0] as { params: { progressToken: string; progress: number; message: string } }).params;
    expect(p.progressToken).toBe('tok-1');
    expect(p.progress).toBe(1);
    expect(p.message).toContain('dag_research');
    expect((sent[2] as { params: { progress: number } }).params.progress).toBe(3);
  });

  // ★ 没订阅就一个字都不发 —— 硬发是往协议通道塞客户端没要的东西。
  test('★ 没有 progressToken → 一条都不发, 也不装定时器', async () => {
    const sent: unknown[] = [];
    const t = fakeTimer();
    const r = await withHeartbeat(
      { sendNotification: async (n) => void sent.push(n) },
      'x',
      async () => 'ok',
      1,
      t.impl,
    );
    expect(r).toBe('ok');
    expect(sent).toEqual([]);
    expect(t.fns).toHaveLength(0);
  });

  test('extra 整个缺席也照跑(旧调用点不会因此挂)', async () => {
    expect(await withHeartbeat(undefined, 'x', async () => 42)).toBe(42);
  });

  // ★★ 观察者不许扰动被观察者:通知发不出去绝不能让任务挂掉。
  //    反向自检: 把 .catch(() => undefined) 去掉 → 这条会变成 unhandled rejection。
  test('★★ sendNotification 抛错被吞, 任务照常返回', async () => {
    const t = fakeTimer();
    const r = await withHeartbeat(
      {
        _meta: { progressToken: 1 },
        sendNotification: async () => {
          throw new Error('传输断了');
        },
      },
      'x',
      async () => {
        t.tick(2);
        return 'still-ok';
      },
      1,
      t.impl,
    );
    expect(r).toBe('still-ok');
  });

  test('★ run 抛错原样抛, 且定时器被清掉(不泄漏)', async () => {
    const t = fakeTimer();
    await expect(
      withHeartbeat({ _meta: { progressToken: 1 }, sendNotification: async () => undefined }, 'x', async () => {
        throw new Error('引擎自己挂了');
      }, 1, t.impl),
    ).rejects.toThrow('引擎自己挂了');
    expect(t.cleared()).toBe(1);
  });

  test('正常结束也清定时器', async () => {
    const t = fakeTimer();
    await withHeartbeat({ _meta: { progressToken: 1 }, sendNotification: async () => undefined }, 'x', async () => 1, 1, t.impl);
    expect(t.cleared()).toBe(1);
  });
});
