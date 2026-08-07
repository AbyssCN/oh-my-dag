import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/dag/engine';
import type { AgentLeafInput } from '../../src/harness/leaf-runners';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';

// 产物校验闸 (2026-07-03): agent 写文件节点声称的 filesTouched 必须真实存在 → 测试用真 tmp 文件。
const TMP = mkdtempSync(join(tmpdir(), 'dag-artifact-'));
const realArtifact = (name: string): string => {
  const p = join(TMP, name);
  writeFileSync(p, '// artifact');
  return p;
};

// M3 conductor inproc-写文件 bug 修复: conductor (M3 非确定性) 把"写文件"节点标成 leaf →
// inproc 不能写文件 → exit 0 但无产物 (静默假成功)。guard: output_type:file/git ∨ output_path ∨
// goal 写文件信号 → 必须 agent (有 runner 则提升, 无 runner 则失败不静默 done)。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

function gen(plan: string): GenerateFn {
  return async ({ model }) =>
    model === CONDUCTOR ? { text: plan, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };
}
const fileAgentRunner = (touched: string[], flag: { called: boolean }) => async (_i: AgentLeafInput) => {
  flag.called = true;
  return { text: 'wrote', usage: { in: 1, out: 1 }, filesTouched: touched };
};

describe('executor-dag 写文件节点 guard (M3 conductor bug)', () => {
  test('output_type:file + executor:leaf + agentRunner → 提升 agent', async () => {
    const plan = JSON.stringify({ name: 'b', nodes: { impl: { goal: '实现缓存', executor: 'leaf', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([realArtifact('x.ts')], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.kind).toBe('agent'); // 被提升, 非 inproc
    expect(res.results['impl']!.status).toBe('done');
  });

  test('output_type:file + 无 agentRunner → 失败 (拒绝 inproc 静默假成功)', async () => {
    const plan = JSON.stringify({ name: 'b', nodes: { impl: { goal: '实现缓存', executor: 'leaf', output_type: 'file' } } });
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan) });
    expect(res.results['impl']!.status).toBe('failed'); // 关键: 不是 done
  });

  test('goal 启发式 (创建 src/lru.ts, 无 output_type) → 提升 agent', async () => {
    const plan = JSON.stringify({ name: 'h', nodes: { impl: { goal: '创建 src/lru.ts 实现 LRU 缓存', executor: 'leaf' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([realArtifact('lru.ts')], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.kind).toBe('agent');
  });

  test('产物校验闸: agent 写文件节点 filesTouched 空 → failed (拒绝 empty-done)', async () => {
    const plan = JSON.stringify({ name: 'e', nodes: { impl: { goal: '实现缓存', executor: 'agent', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.status).toBe('failed'); // 2026-07-03 ultraspeed 实测: 3/4 节点 empty-done → 本闸拒
    expect(res.results['impl']!.output).toContain('产物校验失败');
  });

  test('产物校验闸: 声称的产物路径不存在 → failed', async () => {
    const plan = JSON.stringify({ name: 'g', nodes: { impl: { goal: '实现缓存', executor: 'agent', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner(['/tmp/__no_such_artifact__.ts'], flag),
    });
    expect(res.results['impl']!.status).toBe('failed');
    expect(res.results['impl']!.output).toContain('不存在');
  });

  test('纯分析节点 (goal=分析, 无 output_type) → 仍 inproc (不误提升)', async () => {
    const plan = JSON.stringify({ name: 'a', nodes: { think: { goal: '分析 src/x.ts 的 LRU 逻辑给出建议', executor: 'leaf' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([], flag),
    });
    expect(res.results['think']!.kind).toBe('inproc'); // 分析不写文件 → 不误提升
    expect(flag.called).toBe(false);
  });
});

// 2026-07-26 实测复现的真 bug: 产物校验闸拿 `continuity?.repoRoot ?? process.cwd()` 当根解析
// filesTouched 的相对路径, 而 agent runner 的 cwd 可以是任意目录 (worktree / 子项目)。
// 两者不一致 → 写对了文件的节点被判 empty-done → 下游整片级联 skip。
// 全栈 eval 里 6 次跑挂 10 个节点、35 次级联, 根因就是这一行。
describe('产物校验闸的根 = leaf 自报的 cwd', () => {
  const PLAN = JSON.stringify({
    name: 'fp',
    nodes: { impl: { goal: '实现 src/x.ts', executor: 'agent', output_type: 'file', output_path: 'src/x.ts' } },
  });

  test('leaf 在别的 cwd 下写对了文件 → 判 done (此前误判 failed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-fp-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
    const gen: GenerateFn = async ({ model }) =>
      model === 'c:c' ? { text: PLAN, usage: { in: 1, out: 1 } } : { text: 'ok', usage: { in: 1, out: 1 } };
    const res = await runExecutorDag('t', {
      conductorModel: 'c:c',
      leafModel: 'l:l',
      generate: gen,
      // 关键: runner 的根是 dir, 不是 process.cwd(); 结果自报 cwd
      agentRunner: async () => ({ text: 'done', usage: { in: 1, out: 1 }, filesTouched: ['src/x.ts'], cwd: dir }),
    });
    expect(res.results.impl!.status).toBe('done');
    rmSync(dir, { recursive: true, force: true });
  });

  test('自报 cwd 但文件真不存在 → 仍判 failed (闸没被削弱)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-fp-'));
    const gen: GenerateFn = async ({ model }) =>
      model === 'c:c' ? { text: PLAN, usage: { in: 1, out: 1 } } : { text: 'ok', usage: { in: 1, out: 1 } };
    const res = await runExecutorDag('t', {
      conductorModel: 'c:c',
      leafModel: 'l:l',
      generate: gen,
      agentRunner: async () => ({ text: 'done', usage: { in: 1, out: 1 }, filesTouched: ['src/nope.ts'], cwd: dir }),
    });
    expect(res.results.impl!.status).toBe('failed');
    expect(res.results.impl!.output).toContain('产物校验失败');
    rmSync(dir, { recursive: true, force: true });
  });

  test('不自报 cwd → 回落老行为 (零回归)', async () => {
    const gen: GenerateFn = async ({ model }) =>
      model === 'c:c' ? { text: PLAN, usage: { in: 1, out: 1 } } : { text: 'ok', usage: { in: 1, out: 1 } };
    const res = await runExecutorDag('t', {
      conductorModel: 'c:c',
      leafModel: 'l:l',
      generate: gen,
      agentRunner: async () => ({ text: 'done', usage: { in: 1, out: 1 }, filesTouched: ['src/nope-xyz.ts'] }),
    });
    expect(res.results.impl!.status).toBe('failed');
  });
});

/**
 * 2026-07-30 live 冒烟挖出来的假阴性: agent 用 **bash 重定向** 写文件时 `filesTouched` 是空的
 * (它只统计 write/edit 族工具) —— 于是一次**真成功**被产物闸判成 empty-done, judge 跟着判未收敛,
 * 整个 goal 报 failed。自主环因此收不了尾。
 *
 * 救回的条件刻意苛刻, 三条缺一不可: ① 节点自己**声明**了 output_path ② 那个文件此刻在
 * ③ 它的**内容跟跑之前不一样**。少了 ③ 就是"把一个早就在那儿的文件当成本次产物", 闸等于白设。
 */
describe('产物校验闸: 救回经 bash 写入的**声明**产物 (但不放过 empty-done)', () => {
  const planWith = (node: Record<string, unknown>): string =>
    JSON.stringify({ name: 'bp', nodes: { impl: { goal: '实现 out.txt', executor: 'agent', output_type: 'file', ...node } } });
  const genOf = (plan: string): GenerateFn => async ({ model }) =>
    model === 'c:c' ? { text: plan, usage: { in: 1, out: 1 } } : { text: 'ok', usage: { in: 1, out: 1 } };

  /** 跑一次: agentRunner 不报 filesTouched, 但按 write 回调真写盘 (= bash 重定向的形状)。 */
  const run = async (opts: { declare: boolean; write: string | null; pre?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-bashwrite-'));
    if (opts.pre !== undefined) writeFileSync(join(dir, 'out.txt'), opts.pre);
    const plan = planWith(opts.declare ? { output_path: 'out.txt' } : {});
    const res = await runExecutorDag('t', {
      conductorModel: 'c:c',
      leafModel: 'l:l',
      generate: genOf(plan),
      continuity: { manager: new CheckpointManager(dir), runId: 'r', repoRoot: dir },
      agentRunner: async () => {
        if (opts.write !== null) writeFileSync(join(dir, 'out.txt'), opts.write);
        // ⚠ 关键: 真写了盘却**不报** filesTouched —— bash 重定向就是这个形状。
        return { text: '写完了', usage: { in: 1, out: 1 }, filesTouched: [], cwd: dir };
      },
    });
    const leaf = res.results.impl!;
    rmSync(dir, { recursive: true, force: true });
    return leaf;
  };

  test('声明了 output_path + 真写了新文件 → 救回判 done, 且产物补进 filesTouched', async () => {
    const leaf = await run({ declare: true, write: 'hello\n' });
    expect(leaf.status).toBe('done');
    expect(leaf.filesTouched).toEqual(['out.txt']); // 补上了 → checkpoint/下游拿得到产物锚
  });

  test('声明了 output_path + 把已有文件**改**了 → 也算真写入', async () => {
    const leaf = await run({ declare: true, pre: '旧内容\n', write: '新内容\n' });
    expect(leaf.status).toBe('done');
  });

  test('声明了 output_path 但文件**内容没变** → 仍 failed (不许拿早就在的文件充产物)', async () => {
    const leaf = await run({ declare: true, pre: '一直就是这样\n', write: '一直就是这样\n' });
    expect(leaf.status).toBe('failed');
    expect(leaf.output).toContain('产物校验失败');
  });

  test('声明了 output_path 但压根没写 → 仍 failed (empty-done 照拒)', async () => {
    const leaf = await run({ declare: true, write: null });
    expect(leaf.status).toBe('failed');
  });

  test('**没声明** output_path → 不救 (没有可核对的东西, "我做完了"不算证据)', async () => {
    const leaf = await run({ declare: false, write: 'hello\n' });
    expect(leaf.status).toBe('failed');
    expect(leaf.output).toContain('filesTouched 空');
  });
});
