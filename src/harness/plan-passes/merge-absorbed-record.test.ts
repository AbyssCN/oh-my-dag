/**
 * src/harness/plan-passes/merge-absorbed-record.test —— #153② 合并记录随节点进 verifier 材料。
 *
 * 同病第二次发作 (2026-08-22): verifier 拿不到 `{into, absorbed}`, 把它读成「执行体省略节点」
 * → 假红 → escalation 空转。修法同形 (verifier.ts:99 那条): 把记录挂在存活节点上,
 * summarizeResults 的现有签名就读得到 (D-1), 卷面多渲染一行说明这是引擎干的 (D-2)。
 *
 * 反向自检 (承重那一位, 写进注释的不只是叙述):
 *   ① 把 verifier.ts 多渲染的那一行去掉 → 「带 absorbed_from 的结果喂 summarizeResults」这条必须红。
 *     验法: 把 `merged_from: ...` 那行注释掉, 跑这个 describe, 「★ 合并记录进 verifier 材料」红。
 *   ② 把 merge-command-chain.ts 的 `absorbed_from: chain` 改成恒不写 →
 *     「s1-green→accept 串行 command 链」那条 GWT 必须红。
 *     验法: 把 `absorbed_from: chain,` 删掉, 跑这个 describe, 第一条红。
 *   ③ 既有 merge-command-chain 与 verifier 的测试一条不改一条不红 (git diff --stat 自证)。
 *   ④ 红的时候是因为「这次合并的事实有没有出现在材料里」, 不许出现渲染函数自己算的中间量
 *     (例: 渲染 `merged.length` 这种 —— 它没承重事实)。
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from '../conductor-plan';
import type { LeafResult } from '../dag/engine';
import { mergeCommandChains } from './merge-command-chain';
import { summarizeResults } from '../verifier';

/** 构造最小合法 plan 的测试夹具 (沿用 merge-command-chain.test.ts 的形态)。 */
function makePlan(nodes: ConductorPlan['nodes'], outputs?: string[]): ConductorPlan {
  return { name: 't', nodes, ...(outputs === undefined ? {} : { outputs }) };
}

const cmd = (command: string, deps?: string[]): ConductorPlan['nodes'][string] => ({
  goal: `run ${command}`,
  executor: 'command',
  command,
  ...(deps ? { depends_on: deps } : {}),
});

const leaf = (over: Partial<LeafResult> & { id: string }): LeafResult =>
  ({ status: 'done', kind: 'command', output: '', deps: [], usage: { in: 0, out: 0 }, ...over }) as LeafResult;

describe('C-1: 合并记录挂存活节点, mergeCommandChains 返回值逐字不变', () => {
  test('★ GWT-1 s1-green → accept 串行 command 链 → accept 带 absorbed_from:[s1-green], merged 与今天逐字相同', () => {
    const plan = makePlan({
      impl: { goal: 'implement', executor: 'agent' },
      s1_green: cmd('bun test', ['impl']),
      accept: cmd('echo done', ['s1_green']),
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    // INV-3: 返回值 merged 与今天逐字相同。
    expect(merged).toEqual([{ into: 'accept', absorbed: ['s1_green'] }]);
    // INV-1: 存活节点带 absorbed_from (链序)。
    expect(out.nodes.accept?.absorbed_from).toEqual(['s1_green']);
    // 合并行为 INV-4: 命令串、依赖逐字不变。
    expect(out.nodes.accept?.command).toBe('bun test && echo done');
    expect(out.nodes.accept?.depends_on).toEqual(['impl']);
  });

  test('★ GWT-2 无可并链 → 任何节点都不带 absorbed_from, plan 逐字节与今天相同', () => {
    const plan = makePlan({
      a: cmd('tsc'),
      b: { goal: 'write', executor: 'agent', depends_on: ['a'] },
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    expect(merged).toEqual([]);
    expect(out).toBe(plan); // 同一对象, 零拷贝。
    for (const id of Object.keys(out.nodes)) {
      expect(out.nodes[id]?.absorbed_from).toBeUndefined();
    }
  });

  test('★ GWT-3 expect_exit:1 的 sN-red 不参与合并 (今日行为, INV-4 一个字不动)', () => {
    const plan = makePlan({
      red: { ...cmd('bun test src/new.test.ts'), expect_exit: 1 },
      types: cmd('tsc', ['red']),
      tests: cmd('bun test', ['types']),
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    // red 不可吸收; types→tests 仍并成一条 → 只并这一段。
    expect(merged).toEqual([{ into: 'tests', absorbed: ['types'] }]);
    // red 不带 absorbed_from (没参与合并)。
    expect(out.nodes.red?.absorbed_from).toBeUndefined();
    // tests 参与合并, 带 absorbed_from。
    expect(out.nodes.tests?.absorbed_from).toEqual(['types']);
  });

  test('★ INV-2 未参与合并的节点不带 absorbed_from (NULL ≠ 0 ≠ 不适用)', () => {
    const plan = makePlan({
      impl: { goal: 'implement', executor: 'agent' },
      gate_types: cmd('tsc', ['impl']),
      gate_tests: cmd('bun test', ['gate_types']),
      gate_build: cmd('bun run build', ['gate_tests']),
      report: { goal: 'summarize', depends_on: ['gate_build'] },
    });
    const { plan: out } = mergeCommandChains(plan);
    // gate_types / gate_tests 被吸收 → 不出现在新图里, 也无 absorbed_from。
    expect(out.nodes.gate_types).toBeUndefined();
    expect(out.nodes.gate_tests).toBeUndefined();
    // gate_build 参与合并, 带 absorbed_from。
    expect(out.nodes.gate_build?.absorbed_from).toEqual(['gate_types', 'gate_tests']);
    // impl / report 未参与合并 → 不带该字段。
    expect(out.nodes.impl?.absorbed_from).toBeUndefined();
    expect(out.nodes.report?.absorbed_from).toBeUndefined();
  });
});

describe('C-2: summarizeResults 渲染合并事实 (D-2: 说清是引擎干的)', () => {
  test('★ GWT-4 带 absorbed_from 的节点 → 输出含被吸收 id 与「引擎机械合并」', () => {
    const plan = makePlan({
      impl: { goal: 'implement', executor: 'agent' },
      s1_green: cmd('bun test', ['impl']),
      accept: cmd('echo done', ['s1_green']),
    });
    const { plan: out } = mergeCommandChains(plan);
    const results: Record<string, LeafResult> = {
      impl: leaf({ id: 'impl', kind: 'agent', output: 'implemented', exitCode: 0 }),
      accept: leaf({ id: 'accept', output: 'done', exitCode: 0 }),
    };
    const s = summarizeResults(out, results);
    // 含被吸收的 id
    expect(s).toContain('s1_green');
    // 含「引擎机械合并」 —— 不写明就回到 verifier 读成「少一个节点」的死路。
    expect(s).toContain('引擎机械合并');
    // 含「命令一条不少且被吸收者排在链首」 —— 这是 D-2 的措辞。
    expect(s).toContain('命令一条不少');
    expect(s).toContain('被吸收者排在链首');
    // 含合并行 (任意顺序) 与 accept 的命令串。
    expect(s).toContain('merged_from');
    expect(s).toContain('$ bun test && echo done');
  });

  test('★ GWT-5 不带 absorbed_from 的节点 → 输出逐字节与今天相同 (老调用方零回归)', () => {
    const plan: ConductorPlan = {
      name: 'p',
      nodes: {
        count: { goal: '统计', executor: 'command', command: 'ls src/harness/*.ts | wc -l' },
        blocked: { goal: '读凭证', executor: 'command', command: 'cat .env' },
        prose: { goal: '写一段说明', executor: 'leaf' },
      },
    };
    const results: Record<string, LeafResult> = {
      count: leaf({ id: 'count', output: '93', exitCode: 0 }),
      blocked: leaf({ id: 'blocked', status: 'failed', output: '[blocked]', exitCode: -1 }),
      prose: leaf({ id: 'prose', kind: 'inproc', output: '一段说明文字。' }),
    };
    const s = summarizeResults(plan, results);
    // 老卷面照旧 —— 这是 verifier-evidence.test.ts 已经钉死的字面量, 这里再钉一次。
    expect(s).toContain('$ ls src/harness/*.ts | wc -l');
    expect(s).toContain('exit 0');
    expect(s).toContain('exit -1');
    expect(s).toContain('闸拒');
    // 没有 absorbed_from → 渲染函数不该编出 merged_from / 引擎机械合并 这些词。
    expect(s).not.toContain('merged_from');
    expect(s).not.toContain('引擎机械合并');
    expect(s).not.toContain('命令一条不少');
  });

  test('★ 合并行的措辞把责任归属讲透 (verifier 一眼就读到这是引擎干的, 不是执行体省略)', () => {
    const plan = makePlan({
      a: cmd('cmd-a'),
      b: cmd('cmd-b', ['a']),
      c: cmd('cmd-c', ['b']),
    });
    const { plan: out } = mergeCommandChains(plan);
    const results: Record<string, LeafResult> = {
      c: leaf({ id: 'c', output: 'done', exitCode: 0 }),
    };
    const s = summarizeResults(out, results);
    // c 是吸收尾, 渲染行应明确点名「是引擎合并」+「不是执行体省略」。
    expect(s).toContain('引擎机械合并');
    expect(s).toContain('不是执行体省略');
    // 给出被吸收者的 id 链 (链序)。
    expect(s).toMatch(/merged_from: \[a, b\]/);
  });
});