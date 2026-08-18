/**
 * 心跳闸**滚动性**的契约测试 (2026-08-18, run 14b49f79 四节点全停摆的根因网)。
 *
 * ## 这份网钉的是什么
 *
 * `leaf-watchdog.test.ts` 测的是一个**重写的假类** (`class Watchdog` 就写在那个文件里),
 * 不是 `agent-leaf.ts` 的真闸。于是"窗口到底滚不滚"从来没被真代码验过 —— 而 2026-08-17
 * 的 #169 (b87196e) 在 `armIdle()` 那行下面多留了一个 `armIdle();`, 第一个 timer 从此
 * **无人持有、永不 clear**, 在 startedAt + idleTimeoutMs 处无条件开刀。
 *
 * 盘上的代价 (run 14b49f79 / .omd/continuity/…/tests.__r3.json): 叶子每 2–3 秒一次工具调用、
 * 48 次、烧掉 1.73M input token, 最后一次工具事件在 177.8s —— 在 180.4s 被判「停摆: 疑
 * provider 挂起」。按滚动窗口它该活到 357.8s。三个节点全是这个形状 (死在 191/194/180s,
 * 而各自的窗口分别该到 256/282/358s)。
 *
 * ## 反向自检 (本仓惯例: 一条永远绿的闸不是闸)
 *
 * 把 agent-leaf.ts 的 `armIdle()` 恢复成连写两次 (或把 armIdle 里的 clearTimeout 删掉) →
 * 本条必红: 假 SDK 流每 60ms 吐一次、总共 ~720ms, 而窗口是 200ms —— 孤儿 timer 在 200ms
 * 处开刀, `stalled` 读到 true。这正是今天线上读到的那个错值。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from './agent-leaf';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MODEL = 'claude-code:claude-sonnet-5';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-wd-roll-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

/**
 * **一直在动**的假叶: 每 gapMs 吐一条消息, 共 n 条。任何一次静默都远短于 idle 窗口,
 * 而总时长是窗口的数倍 —— 「窗口滚不滚」与「跑了多久」在这份替身上被分开了。
 */
const busyQuery = (gapMs: number, n: number) => {
  return async function* () {
    for (let i = 0; i < n; i++) {
      await sleep(gapMs);
      yield asst(`第 ${i + 1} 拍`);
    }
    yield success();
  };
};

describe('心跳闸滚动窗口 (agent-leaf 真闸, 非重写替身)', () => {
  test('★ 每 60ms 有活动、跑满 3.6 倍窗口 → 不判停摆 (窗口每次事件都重置)', async () => {
    const cwd = freshRoot();
    const run = createAgentLeafRunner({ cwd, idleTimeoutMs: 200, sdkQueryFn: busyQuery(60, 12) as never });
    const res = await run({ prompt: '一直在动的叶', model: MODEL });
    // 这一条是全网的重心: 活着的叶子不许被判死。
    expect(res.stalled).toBe(false);
    expect(res.watchdog?.stalled).toBe(false);
    // 真跑满了窗口的数倍才有意义 —— 若替身提前结束, 上面那条会变成廉价绿。
    expect(res.text).toContain('第 12 拍');
  });

  test('★ 同一 runner 形状下真静默 (一次 5 倍窗口的沉默) 仍判停摆 —— 闸没被修松', async () => {
    const cwd = freshRoot();
    const quietThenTalk = async function* () {
      yield asst('开头');
      await sleep(1000);
      yield asst('结尾');
      yield success();
    };
    const run = createAgentLeafRunner({ cwd, idleTimeoutMs: 200, sdkQueryFn: quietThenTalk as never });
    const res = await run({ prompt: '真停摆的叶', model: MODEL });
    expect(res.stalled).toBe(true);
  });
});
