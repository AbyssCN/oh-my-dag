/**
 * command leaf **不许有结果缓存** —— 同一命令串每次都真跑 (2026-08-01, 量过之后删掉了原来那个)。
 *
 * 这里原本有个 per-runner 的确定性 memoize (只缓存 `exitCode===0`)。它的安全论证两环全假,
 * 而收益侧是空的 —— 三个读数都在生产 MCP 路径上量过:
 *
 * ① **跨 run**:「新调用 = 新 runner = 新缓存」只在每次现建 runner 的接线点成立。MCP 是长驻进程,
 *    `assemble` 装配期建一次 → 两个 runId 之间改掉盘上文件, 第二跑仍返回旧值。
 *    (同图对照组: 命令串多一个空格 → 缓存键不同 → 读到新值, 排掉了"下游复述时幻觉"。)
 * ② **图内**:「单 run 内输入文件不变 → 无 staleness」—— 而这台引擎的本职就是让 agent 节点改文件。
 *    live: `cat f` → agent 写 f → `cat f`(同一命令串)读回**写之前**的内容。
 * ③ **收益 = 0**: 留痕库全量 12 次真实 run / 25 个 command 节点, 同一 run 内重复命令串 **0 次**。
 *    连设计时说的主场景都覆盖不了 —— 「兄弟节点跑同一条命令」是同层并发, 缓存只在命令返回后
 *    写入, 两个都 miss。
 *
 * 于是删掉, 不留旋钮(「要么给生产者, 要么删掉, 中间态最坏」)。本文件是**防它被重新加回来**的闸:
 * 谁再挂缓存, 下面几条会红。代价(重复命令重跑一遍)正是引擎自己的偏好 ——
 * 「重跑一遍比跳过一个闸安全」。
 */
import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner } from './command-leaf';
import { runExecutorDagWithPlan } from './dag/engine';
import type { ConductorPlan } from './conductor-plan';
import type { CommandLeafRunner } from './leaf-runners';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

const generate: GenerateFn = async () => ({ text: 'leaf-out', usage: { in: 1, out: 1 } });

/** 真 runner (走真闸), 只把 spawn 换成可改答案的替身 —— 「世界会变」这件事由 setOutput 表达。 */
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

const cfg = (commandRunner: CommandLeafRunner, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  commandRunner,
  ...extra,
});

/**
 * 同一条命令串跑两个节点, b 在 a 之后 —— 老缓存正是在这一格上返旧值。
 * ⚠ `outputs: ['a']` 是 #153② 合并 pass 的挡板 (2026-08-17): 纯串行 command 直线会被机械并成
 * 一条 && 节点 (a 消失), 而本文件测的是 **runner 层不缓存**, 要的就是两个独立节点各真跑 ——
 * 把 a 标成图外引用让链不合并, 测试原意逐字保留。合并本身的语义在 merge-command-chain.test。
 */
const plan: ConductorPlan = {
  name: 'p',
  outputs: ['a'],
  nodes: {
    a: { goal: '读探针', executor: 'command', command: 'echo probe' },
    b: { goal: '再读一次同一条', executor: 'command', command: 'echo probe', depends_on: ['a'] },
  },
};

/** 图内**世界被改动**的形状: 读 → agent 写 → 再读(同一命令串)。live 抓到的就是这张图。 */
const planWithMutator: ConductorPlan = {
  name: 'p-mutate',
  nodes: {
    before: { goal: '改之前读一次', executor: 'command', command: 'echo probe' },
    mutate: { goal: '改掉它', executor: 'agent', depends_on: ['before'] },
    after: { goal: '改之后再读一次 (同一条命令串)', executor: 'command', command: 'echo probe', depends_on: ['mutate'] },
  },
};

describe('command leaf 不缓存结果', () => {
  test('图内串行: 同一条命令串的第二个节点也真跑 (spawn 两次)', async () => {
    const { runner, spawns } = probeRunner();
    const r = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r.results.a?.output).toBe('PROBE_V1');
    expect(r.results.b?.output).toBe('PROBE_V1');
    expect(spawns()).toBe(2);
  });

  test('图内世界被改动: agent 节点写完之后, 同一命令串必须读到新值 (live ② 的回归)', async () => {
    const { runner, setOutput } = probeRunner();
    const agentRunner: ExecutorDagConfig['agentRunner'] = async () => {
      setOutput('PROBE_V2_CHANGED'); // ← agent 改文件, 正是这台引擎的本职
      return { text: '改完了', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(planWithMutator, cfg(runner, { agentRunner }));
    expect(r.results.before?.output).toBe('PROBE_V1');
    // 老缓存在这里返 PROBE_V1 —— 一条"改完之后复核"的验证步就此永远看不见自己的改动。
    expect(r.results.after?.output).toBe('PROBE_V2_CHANGED');
  });

  test('跨图: 同一个 runner 复用于第二张图, 期间世界变了 → 必须读到新值 (live ① 的回归)', async () => {
    const { runner, setOutput, spawns } = probeRunner();
    const r1 = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r1.results.a?.output).toBe('PROBE_V1');

    setOutput('PROBE_V2_CHANGED');
    const r2 = await runExecutorDagWithPlan(plan, cfg(runner));
    expect(r2.results.a?.output).toBe('PROBE_V2_CHANGED');
    expect(r2.results.b?.output).toBe('PROBE_V2_CHANGED');
    expect(spawns()).toBe(4); // 两张图 × 每张两个节点, 一次不省
  });

  test('同层并发的两个相同命令各跑一遍 (老缓存连这个主场景都覆盖不了 —— 收益侧为什么是空的)', async () => {
    const { runner, spawns } = probeRunner();
    const parallel: ConductorPlan = {
      name: 'p-par',
      nodes: {
        a: { goal: '读探针', executor: 'command', command: 'echo probe' },
        b: { goal: '同时再读一次', executor: 'command', command: 'echo probe' },
      },
    };
    await runExecutorDagWithPlan(parallel, cfg(runner));
    expect(spawns()).toBe(2);
  });
});
