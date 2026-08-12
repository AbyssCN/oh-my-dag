/**
 * `filesTouched` 的**真发射点**闸(2026-08-12,收 `rca-filestouched-gate` 那张 P0 票)。
 *
 * ## 它守的是什么 —— 一个已经发生过一次的 P0
 *
 * 产物闸(`dag/engine.ts` 的 `declaredArtifact` 段)拿「`filesTouched` 空」当
 * **谎报完工**的判据:写文件节点 done 的必要条件 = 真碰了文件。
 * 而 `AgentLeafRunner` 曾经**根本不填这个字段** —— 于是产物闸对每一个真交付文件的节点
 * 恒判 failed:run1/run2 全 7 叶 failed,与模型无关(run2 的叶子已真写 `src/mcp/server.ts`,
 * 照样判 failed)。生产者 `c0ffec9`(2026-07-20「修产物闸对真交付文件节点的恒冤杀」)才补上。
 *
 * **补上了,却一直没有闸。** 而它就发在 `agent-leaf.ts` 那一行返回值上 ——
 * **同一行**的 `shellRuns` 2026-08-12 被 S1 埋点整段替换掉过(见
 * `agent-leaf-shellruns-wiring.test.ts` 与图鉴 S-35)。那次全绿交付而生产链路已断。
 *
 * 为什么既有测试守不住:全仓 `filesTouched` 的断言(`goal/run-goal.test.ts`、
 * `test/core/observers.test.ts`、`sensor-wording-a5.test.ts` …)**无一例外**挂在注入的
 * `agentRunner` 上 —— 夹具自己喂这个字段,一次都不经过 `agent-leaf.ts` 的真发射点。
 * `tsc` 也不报:少发一个字段在结构类型下合法。
 *
 * ## 与 shellRuns 那条闸的关键差别:这个字段必须**无条件**发
 *
 * `shellRuns` 是**有条件**发(一条都没跑 → 字段缺席,「没用过 bash」≠「采集没接」)。
 * `filesTouched` 相反:产物闸读的就是 `filesTouched.length === 0`,所以
 * **空数组是有意义的读数**(量过了,一个文件都没碰),缺席则会让下游 `?? []` 把
 * 「没接上」读成「没碰文件」→ 冤杀原样复活。故这里钉的是「无条件发射」。
 *
 * ## 为什么是源码面闸(同 shellRuns 那条)
 *
 * 行为闸要让真工具事件流跑起来(SDK 通道的事件来自 SDK 真调 omd 桥,注入的 `sdkQueryFn`
 * 造不出来)。源码面够用,因为历史失效形态只有一个:那一行被删/被替换。
 *
 * ## 反向自检(三刀都实测过)
 *
 * ① 删掉 `filesTouched: [...touched]` → ★① ★③ 红;
 * ② 改成有条件发射(`...(touched.size ? { filesTouched: [...touched] } : {})`)→ ★② 红
 *    —— 这正是冤杀复活的那条路;
 * ③ 把 engine 的消费点改名 → ★④ 红(消费面没了,这条闸就该退休,而不是继续守孤儿字段)。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, 'agent-leaf.ts');
const CONSUMER = join(import.meta.dir, 'dag', 'engine.ts');

describe('filesTouched 生产↔消费两端都在 (P0 rca-filestouched-gate 的常驻闸)', () => {
  test('★ 生产端:agent-leaf 的返回值真的发 filesTouched(删掉这一行 → 红)', () => {
    const src = readFileSync(SRC, 'utf8');
    expect(src).toContain('filesTouched: [...touched]');
  });

  test('★ 生产端是**无条件**发:空数组是读数, 缺席不是(改成有条件 → 红)', () => {
    const src = readFileSync(SRC, 'utf8');
    const line = src.split('\n').find((l) => l.includes('filesTouched: [...touched]'))!;
    // 同一行上的 `...(cond ? { filesTouched` 形状 = 有条件发射 = 冤杀复活路径。
    expect(line).not.toMatch(/\?\s*\{[^}]*filesTouched/);
    expect(src).not.toMatch(/\.\.\.\([^)]*\?\s*\{\s*filesTouched/);
  });

  test('★ 生产端不是只剩注释:发射点在代码里, 不在被注释掉的行上', () => {
    const src = readFileSync(SRC, 'utf8');
    // 本文件里 `filesTouched` 另有 5 处注释 —— 只数出现次数会读成「还在」(S-35 原样)。
    const live = src
      .split('\n')
      .filter((l) => l.includes('filesTouched: [...touched]'))
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    expect(live.length).toBeGreaterThan(0);
  });

  test('★ 消费端:engine 的产物闸还在读它(消费面没了 → 红, 提醒这条闸该退休)', () => {
    const consumer = readFileSync(CONSUMER, 'utf8');
    expect(consumer).toContain('filesTouched.length === 0');
  });
});
