/**
 * `shellRuns` 的**真发射点**闸(2026-08-12,补 S1 埋点那次事故)。
 *
 * ## 它守的是什么
 *
 * `agent-leaf.ts` 的返回值里有一行 `...(shell.runs().length ? { shellRuns: shell.runs() } : {})`。
 * 下游 `plan/claimed-actions.ts` 的 `const runs = r.shellRuns ?? []` 拿它当**谎报完成闸(S-30)
 * 的证据面**。这一行没了,闸照常跑、照常判、什么都看不见 —— 而:
 *
 * - **`tsc` 不报**:`shellRuns?` 是可选字段,少发一个字段合法;
 * - **既有测试不报**:全仓所有 `shellRuns` 断言都在 `plan/honest-self-verification.test.ts`,
 *   而那份用的是**注入的 `agentRunner`**(`agentRunner: async () => ({ ..., shellRuns })`)——
 *   它自己喂 `shellRuns`,从来不经过 `agent-leaf.ts` 的真发射点。
 *
 * 2026-08-12 run `360405a5` 加 watchdog 埋点时,把这一行**替换**成了 watchdog 块。
 * 全绿交付,而生产链路已经断了。这条闸就是为了让下一次那么干时当场红。
 *
 * ## 为什么是源码面闸,不是行为闸
 *
 * 行为闸要让一个 `bash` 工具真的跑起来才能产出 `tool_execution_start/end` 事件:
 * SDK 通道的事件来自 SDK **真调 omd 桥**(`claude-sdk-loop.ts:70`),注入的 `sdkQueryFn`
 * 造不出来;pi 通道要起真 `runAgentLoop`。两条都不是单元测试的量级。
 * 所以退一档钉**源码结构**——本仓已有同形闸(`empty-knobs.test.ts` 查声明↔消费点、
 * `reachability.test.ts` 走 import 图)。它足以抓住「那一行被删/被替换」这个**唯一**的历史失效形态。
 *
 * ## 反向自检(一条永远绿的闸不是闸)
 *
 * 把 `agent-leaf.ts` 里那行 `...(shell.runs().length ? ... )` 删掉 → 第一条测试红;
 * 把 `claimed-actions.ts` 的 `r.shellRuns ?? []` 删掉 → 第二条测试红(消费面没了,
 * 这条闸就该跟着退休,而不是继续守一个没人读的字段)。两刀都实测过。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, 'agent-leaf.ts');
const CONSUMER = join(import.meta.dir, 'plan', 'claimed-actions.ts');

describe('shellRuns 生产↔消费两端都在', () => {
  test('★ 生产端:agent-leaf 的返回值真的发 shellRuns(删掉这一行 → 红)', () => {
    const src = readFileSync(SRC, 'utf8');
    // 钉「有条件发射」这个形状本身, 不钉具体写法: 允许改条件/改缩进, 不允许整行消失。
    expect(src).toContain('shellRuns: shell.runs()');
    // 缺席语义: 一条都没跑 → 字段缺席而不是 `[]`(「没用过 bash」≠「这条采集没接」)。
    // 无条件发射会把这两件事压平, 所以条件也一并钉住。
    expect(src).toMatch(/shell\.runs\(\)\.length\s*\?\s*\{\s*shellRuns/);
  });

  test('★ 消费端:claimed-actions 还在读它(消费面没了 → 红, 提醒这条闸该退休)', () => {
    const consumer = readFileSync(CONSUMER, 'utf8');
    expect(consumer).toContain('shellRuns');
  });

  test('★ 生产端不是只剩注释:发射点在代码里, 不在被注释掉的行上', () => {
    const src = readFileSync(SRC, 'utf8');
    const live = src
      .split('\n')
      .filter((l) => l.includes('shellRuns: shell.runs()'))
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    // 事故当时 `shellRuns` 在本文件里还剩一处 —— 一句注释。只数注释会读成「还在」。
    expect(live.length).toBeGreaterThan(0);
  });
});
