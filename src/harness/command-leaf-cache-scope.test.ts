/**
 * command leaf 的 memo 缓存**寿命**闸 (2026-08-01, live 抓出来的洞)。
 *
 * 缓存本身是对的 (确定性只读命令, 同一张图里兄弟节点跑同一条命令不该跑两遍)。错的是它的
 * **寿命由谁决定**: 老论证写着「新调用 = 新 runner = 新缓存」, 而那是个**没人钉住的前提** ——
 * 它只在"每次调用现建 runner"的接线点 (TUI / eval) 成立。MCP 是长驻进程, `assemble` 装配期
 * 建一次 runner, 于是同一个缓存跨了这台 daemon 上的所有 run。
 *
 * live 实测 (生产 MCP 路径, 三跑):
 *   run#1 `cat probe.txt` → PROBE_V1 · 改盘上文件 · run#2 (新 runId, 同命令串) → **仍是 PROBE_V1**
 *   同图对照组 (命令串只多一个空格 → 缓存键不同) → PROBE_V2_CHANGED = 真读了磁盘
 * 对照组排掉了"下游 leaf 复述时幻觉"这个替代解释, 把变量锁死在缓存键上。
 *
 * 危害方向是最坏的那个: 只缓存 `exitCode===0` ⇒ 红→绿看得见, **绿→红看不见** —— 一条 `bun test`
 * 闸在这台 daemon 上过一次, 之后代码改坏了也照绿。它还顺手废掉了 executor-dag 那条设计
 * (「command 节点刻意不落绿 checkpoint, resume 时重跑一遍比跳过一个闸安全」): 重跑发生了,
 * 结果来自缓存, 闸还是被跳过了, 只是降到没人看的一层。
 *
 * 收口在**引擎**: runDagInternal 每张图开跑前调一次 `resetCache()`。放这儿而不是各接线点,
 * 是因为"每个接线点都记得现建 runner"正是上面那条前提的翻版, 下一个接线点照样会漏。
 */
import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner } from './command-leaf';
import { runExecutorDagWithPlan } from './executor-dag';
import type { ConductorPlan } from './conductor-plan';
import type { CommandLeafRunner } from './leaf-runners';
import type { ExecutorDagConfig, GenerateFn } from './executor-dag-types';

const generate: GenerateFn = async () => ({ text: 'leaf-out', usage: { in: 1, out: 1 } });

/** 真 runner (走真闸/真 memoize), 只把 spawn 换成可改答案的替身 —— 缓存逻辑本体不被替掉。 */
function probeRunner(): { runner: CommandLeafRunner; setOutput: (s: string) => void; spawns: () => number } {
  let current = 'PROBE_V1';
  let spawns = 0;
  const runner = createCommandLeafRunner({
    allowlist: ['echo'],
    spawn: async () => {
      spawns++;
      return { stdout: current, stderr: '', exitCode: 0 };
    },
  });
  return { runner, setOutput: (s) => (current = s), spawns: () => spawns };
}

const cfg = (commandRunner: CommandLeafRunner): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  commandRunner,
});

/** 两个节点跑**同一条**命令串, b 在 a 之后 (串行) —— memoize 的真实生效面。 */
const plan: ConductorPlan = {
  name: 'p',
  nodes: {
    a: { goal: '读探针', executor: 'command', command: 'echo probe' },
    b: { goal: '再读一次同一条', executor: 'command', command: 'echo probe', depends_on: ['a'] },
  },
};

/** 同一条命令串挂两个**无依赖**节点 → 同层并发。 */
const planParallel: ConductorPlan = {
  name: 'p-par',
  nodes: {
    a: { goal: '读探针', executor: 'command', command: 'echo probe' },
    b: { goal: '同时再读一次', executor: 'command', command: 'echo probe' },
  },
};

describe('command leaf memo 缓存的寿命 = 一张图', () => {
  test('图内串行: 同一条命令串的第二个节点 → 命中缓存, 只 spawn 一次 (memoize 零回归)', async () => {
    const { runner, spawns } = probeRunner();
    const r = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r.results.a?.output).toBe('PROBE_V1');
    expect(r.results.b?.output).toBe('PROBE_V1');
    expect(spawns()).toBe(1);
  });

  /**
   * **已知边界** (2026-08-01 量出来的, 不是回归): 缓存只在命令**返回后**写入, 于是同层并发的
   * 两个相同命令都会 miss → 各跑一遍。而"同一张图里兄弟节点跑同一条命令"恰是这个机制当初
   * 说的主场景 —— 它实际只覆盖**串行**重复 (跨层 / map 子节点排队跑到)。
   *
   * 刻意不在这一轮修 (在飞去重要缓存 promise 而不是结果, 那会改动失败路径的语义: 一次失败的
   * 在飞调用会被两个节点共享, 而现在的约定是"只缓存 exitCode===0, 失败各自重试")。
   * 钉在这里是为了让这条边界**有读数**: 谁哪天加了在飞去重, 这条会红, 那时连同上面那条约定一起改。
   */
  test('图内并发: 同层两个相同命令各跑一遍 —— 缓存不认在飞的重复 (已知边界)', async () => {
    const { runner, spawns } = probeRunner();
    const r = await runExecutorDagWithPlan(planParallel, cfg(runner));
    expect(r.results.a?.output).toBe('PROBE_V1');
    expect(r.results.b?.output).toBe('PROBE_V1');
    expect(spawns()).toBe(2);
  });

  test('跨图: 同一个 runner 复用于第二张图, 期间盘上内容变了 → 必须读到新值', async () => {
    const { runner, setOutput, spawns } = probeRunner();
    const r1 = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r1.results.a?.output).toBe('PROBE_V1');

    setOutput('PROBE_V2_CHANGED'); // ← live 里这一步是"盘上文件被改了 / 代码被改坏了"
    const r2 = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r2.results.a?.output).toBe('PROBE_V2_CHANGED');
    expect(r2.results.b?.output).toBe('PROBE_V2_CHANGED');
    // 第二张图重新 spawn 了一次 (图内 b 仍命中缓存 —— 清的是缓存, 不是把 memoize 关掉)。
    expect(spawns()).toBe(2);
  });

  test('反向自检: 摘掉 resetCache 把手 → 陈缓存立刻复现 (证明上面那条闸不是恒绿的)', async () => {
    const { runner, setOutput } = probeRunner();
    // 包一层, 只藏掉把手 —— 这就是修复前 MCP 路径上那个 runner 的形状 (长驻 + 无从清)。
    const noHandle: CommandLeafRunner = (input) => runner(input);
    await runExecutorDagWithPlan(plan, cfg(noHandle));
    setOutput('PROBE_V2_CHANGED');
    const r2 = await runExecutorDagWithPlan(plan, cfg(noHandle));
    // 盘上是 V2, 拿到的是 V1 —— live 上抓到的正是这一格。
    expect(r2.results.a?.output).toBe('PROBE_V1');
  });

  test('memoize:false 的 runner 不挂把手 —— "有没有缓存"从类型面看得出来', () => {
    const off = createCommandLeafRunner({ allowlist: ['echo'], memoize: false });
    expect(off.resetCache).toBeUndefined();
    const on = createCommandLeafRunner({ allowlist: ['echo'] });
    expect(typeof on.resetCache).toBe('function');
  });
});
