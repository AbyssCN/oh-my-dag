/**
 * g1 闸的**接线**回归 (planAndExecute 拒回环) —— 判据本体的红/绿在 plan/leaf-tier-gate.test.ts,
 * 这里钉接线层的事。
 *
 * ## 2026-08-16 契约变更 (issue #144 提议 3 / #145 提议 3)
 *
 * 闸的出口从「一律拒回问模型」改成**能确定性改的自己改**:
 * - 静态节点 + 总量塞得下 → 引擎直接插 `command` 读盘节点 + 原节点降档, **零拒回**;
 * - map 模板 / 超阈 → 闸改不动 (前者没路径, 后者是结构决策), **仍然拒回**, 有界后 fail-open。
 *
 * 所以下面第一条钉的是「零拒回且改写正确」, 第二条换用一张**改不动**的图才还在钉重问预算。
 * 这两条合起来就是这次改动的全部行为承诺。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runExecutorDag } from './dag/engine';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';
import type { CommandLeafRunner, CommandLeafInput } from './leaf-runners';

/** 真实存在的文件 (仓根 README) —— 闸的 stat 走真盘, 确定路径必须真的存在才触发。 */
const REAL_FILE = join(process.cwd(), 'README.md');

/** 静态违规: agent 读确定路径 + 无写意图 → **可确定性改写**。 */
const violating = JSON.stringify({
  name: 'v',
  nodes: { ext: { executor: 'agent', output_type: 'structured', goal: `完整阅读 ${REAL_FILE} 并提取要点` } },
});

/**
 * map 模板违规 → 闸**改不动**(清单由运行期 lister 给, 闸手上没有路径也没有字节数)。
 * 这类才是今天仍然要花规划发去问模型的那一类。
 */
const violatingMap = JSON.stringify({
  name: 'vm',
  nodes: {
    fan: {
      goal: '逐份提炼',
      executor: 'map',
      map: {
        lister: { goal: '列出待读文件', executor: 'command', command: 'ls' },
        over: 'files',
        itemVar: 'item',
        keyBy: 'path',
        template: { executor: 'agent', output_type: 'structured', goal: '读 {{item.path}} 并提炼' },
      },
    },
  },
});
const compliant = JSON.stringify({ name: 'c', nodes: { sum: { goal: '总结要点' } } });

/** 记录每次调用: 规划问 (system 含 CONDUCTOR) 按剧本出 plan, leaf 问回 ok。 */
const makeGenerate = (planScript: string[], seen: { planPrompts: string[] }): GenerateFn => {
  let planCalls = 0;
  return async (req) => {
    const sys = req.messages.find((m) => m.role === 'system');
    const user = req.messages.find((m) => m.role === 'user');
    const userText = typeof user?.content === 'string' ? user.content : '';
    if (typeof sys?.content === 'string' && sys.content.includes('CONDUCTOR')) {
      seen.planPrompts.push(userText);
      const text = planScript[Math.min(planCalls, planScript.length - 1)]!;
      planCalls++;
      return { text, usage: { in: 1, out: 1 } };
    }
    return { text: 'ok', usage: { in: 1, out: 1 } };
  };
};

/** 假 command runner: 只记命令串, 不真跑 (这份测的是接线, 不是 shell)。 */
const makeCommandRunner = (seen: { commands: string[] }): CommandLeafRunner => async ({ command }: CommandLeafInput) => {
  seen.commands.push(command);
  return { text: `[fake] ${command}`, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 };
};

const cfg = (
  generate: GenerateFn,
  gate: boolean,
  commandRunner?: CommandLeafRunner,
): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  ...(commandRunner ? { commandRunner } : {}),
  ...(gate ? { leafTierGate: true, leafTierThresholdBytes: 1_500_000 } : {}),
});

describe('g1 闸接线 (planAndExecute)', () => {
  test('★ 静态违规 → 引擎自己改写成 command+leaf 对, 零拒回', async () => {
    // 这一条是 #144 提议 3 的验收: 判据命中, 而**规划座一发都没多烧**。
    // 怎么让它红: 把 engine 里的 autoRewriteLeafTier 换回 leafTierGateFindings → planPrompts
    // 变 3 (首问 + 2 次重问), 且 ext__read 不存在。
    const seen = { planPrompts: [] as string[] };
    const cmds = { commands: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violating], seen), true, makeCommandRunner(cmds)));

    expect(seen.planPrompts).toHaveLength(1); // ← 零拒回, 就是这次改动买的东西
    expect(cmds.commands).toEqual([`cat ${REAL_FILE}`]); // 单文件用 cat (多文件才 tail -v -n +1)
    expect(r.results.ext__read?.status).toBe('done');
    expect(r.results.ext?.status).toBe('done');
    // 降档而不是删节点: 原节点还在, 只是不再是 agent, 且依赖读盘节点。
    expect(r.plan.nodes.ext?.executor).toBeUndefined();
    expect(r.plan.nodes.ext?.depends_on).toContain('ext__read');
  });

  test('闸改不动的那类 (map 模板) 仍拒回, 改写建议进下一问', async () => {
    const seen = { planPrompts: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violatingMap, compliant], seen), true));
    expect(seen.planPrompts).toHaveLength(2);
    expect(seen.planPrompts[1]).toContain('档位闸拒回');
    expect(seen.planPrompts[1]).toContain('fan'); // 建议点名违规节点
    expect(r.results.sum?.status).toBe('done'); // 采纳的是第二版
    expect(r.results.fan).toBeUndefined();
  });

  test('有界: 改不动且顽固 → 1+2 次重问后 fail-open 放行执行 (不挂死)', async () => {
    const seen = { planPrompts: [] as string[] };
    await runExecutorDag('测试任务', cfg(makeGenerate([violatingMap], seen), true));
    expect(seen.planPrompts).toHaveLength(3); // 首问 + LEAF_TIER_MAX_REJECTS=2 次重问
  });

  test('闸不开 → 违规 plan 一次通过, 且**不改图** (零回归)', async () => {
    // 自动改写挂在 `config.leafTierGate` 里面 —— 闸关着就一个字节都不动图,
    // 否则「关掉闸」这个旋钮就名不副实了。
    const seen = { planPrompts: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violating], seen), false));
    expect(seen.planPrompts).toHaveLength(1);
    expect(r.results.ext?.status).toBe('done');
    expect(r.results.ext__read).toBeUndefined();
  });
});
