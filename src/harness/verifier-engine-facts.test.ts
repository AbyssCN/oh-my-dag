/**
 * src/harness/verifier-engine-facts —— **C-1 引擎记录进卷面 + C-2 章程两句** 闸
 * (SDD 2026-08-22 verifier-engine-facts, 切片 1)。
 *
 * ## 这道闸治什么
 *
 * 2026-08-22 三跑又各撞一次: verifier 判词逐字说「证据不齐 (没贴命令/退出码/读数)」4/8。
 * 引擎手里本来就有 (engineFacts 渲染的就是), 只是没往 verifier 卷面上放 —— 而 verifier 只能
 * 拿到执行体的散文复述, 59b295db 那次执行体自报「全量 61 fail」, 真仓同棵 worktree 里跑是
 * 0 fail (沙箱 vs 真仓的偏差)。**执行体自述的读数, 连它自己都保证不了是真仓的读数**。
 *
 * 修法: 让引擎自己记的那份渲染进 verifier 的卷面, 并在章程里说清它是事实来源。
 *
 * ## 四条 GWT (来自契约)
 *
 * · G1 shellRuns 节点 → 卷面含「执行命令: ... (exit N)」与「引擎记录」抬头;
 * · G2 自述「全量 0 fail」+ 引擎 shellRuns exit 1 → **两个都在**卷面 (不替执行体圆场);
 * · G3 无 shellRuns/filesTouched/filesRead → 节点段与改动前**逐字节相同** (INV-3 零回归);
 * · G4 经 createDefaultVerifier 的 callModelFn 接缝截 prompt → 同时含 INV-6 + INV-7 关键词。
 *
 * ## 反向自检 (切片 1 表)
 *
 * | # | 文件 | oldText | newText |
 * |---|---|---|---|
 * | 1 | src/harness/verifier.ts | `engineFacts(leaf, { expectExit: node?.expect_exit ?? 0, shellCap: ENGINE_FACT_SHELL_CAP })` | `[]` |
 *
 * 把它换成 `[]` ⇒ G1/G2 当场红, 红的理由只准是「卷面里没有那一行」(对得上单条
 * `toContain` 的失败信息)。承重的那一位是**引擎记录到底有没有上卷面** —— 它假, 闸假。
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultVerifier, summarizeResults } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const leaf = (over: Partial<LeafResult> & { id: string }): LeafResult =>
  ({ status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 0, out: 0 }, ...over }) as LeafResult;

describe('C-1 引擎记录进卷面 (engineFacts 渲到 verifier 摘要里)', () => {
  test('★ GWT-1: shellRuns 节点 → 卷面含「执行命令: <原文> (exit <码>)」与「引擎记录」抬头', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { build: { goal: '跑校验', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = {
      build: leaf({
        id: 'build',
        shellRuns: [{ command: 'npx tsc --noEmit -p tsconfig.json', exitCode: 0, ok: true }],
        output: '收尾说明',
      }),
    };
    const s = summarizeResults(plan, results);
    expect(s).toContain('引擎记录 (ground truth, 优先于本节点自述):');
    expect(s).toContain('执行命令: npx tsc --noEmit -p tsconfig.json (exit 0)');
    // 抬头在正文之前 (C-1 契约: 「在正文**之前**」)。
    const factIdx = s.indexOf('执行命令: npx tsc');
    const bodyIdx = s.indexOf('收尾说明');
    expect(factIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(factIdx);
  });

  test('★ GWT-2: leaf 正文「全量 0 fail」与 engine shellRuns exit 1 同时出现在卷面', () => {
    // 这一条钉的是「卷面不替执行体圆场」—— 引擎与自述冲突时两边都得在, 让 verifier 自己判。
    const plan: ConductorPlan = { name: 'p', nodes: { test: { goal: '跑测试', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = {
      test: leaf({
        id: 'test',
        output: '全量 0 fail, 全过。',
        shellRuns: [{ command: 'bun test', exitCode: 1, ok: false }],
      }),
    };
    const s = summarizeResults(plan, results);
    expect(s).toContain('全量 0 fail, 全过。');
    expect(s).toContain('执行命令: bun test (exit 1)');
  });

  test('★ GWT-3: 无 shellRuns/filesTouched/filesRead → 节点段与改动前逐字节相同 (INV-3 零回归)', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { simple: { goal: '一句话说明', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = {
      simple: leaf({ id: 'simple', output: '一份说明。' }),
    };
    const s = summarizeResults(plan, results);
    // INV-3 (D-5): engineFacts 返空 ⇒ 一个字都不加。预值即改动前 summarizeResults 对同一输入的输出。
    const expected = 'plan: p · 1 nodes\n\n### simple [done] — 一句话说明\n一份说明。';
    expect(s).toBe(expected);
    expect(s).not.toContain('引擎记录');
  });

  test('★ INV-2: filesTouched 节点 → 卷面出现「写入文件: ...」行', () => {
    // 配套 GWT-1, 钉 filesTouched 这条通道 (不只是 shellRuns)。
    const plan: ConductorPlan = { name: 'p', nodes: { w: { goal: '写文件', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = {
      w: leaf({
        id: 'w',
        output: '写完了',
        filesTouched: ['src/harness/verifier.ts'],
      }),
    };
    const s = summarizeResults(plan, results);
    expect(s).toContain('引擎记录 (ground truth, 优先于本节点自述):');
    expect(s).toContain('写入文件: src/harness/verifier.ts');
  });
});

describe('C-2 章程两句 (INV-6 + INV-7) 经 verifier prompt 真随卷', () => {
  test('★ GWT-4: 经 createDefaultVerifier 的 callModelFn 接缝截下 prompt, 同时含 INV-6 与 INV-7', async () => {
    let seen = '';
    const verifier = createDefaultVerifier({
      verifierModel: 'fake:m',
      callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
        seen = req.messages.map((m) => m.content).join('\n');
        return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
      }) as never,
    });
    const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: '做点什么', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = { a: leaf({ id: 'a', output: '完成' }) };
    await verifier({ task: 't', plan, results });
    // INV-6: 「引擎记录里已有的命令与退出码, **不必**再要求执行体复述」。
    expect(seen).toContain('引擎记录');
    expect(seen).toContain('不必');
    // INV-7: 「执行体自述与引擎记录**冲突** ⇒ 以引擎记录为准, **且判不通过**」。
    expect(seen).toContain('冲突');
    expect(seen).toContain('以引擎记录为准');
    expect(seen).toContain('判不通过');
    // 既存四条不通过判据 (1–4) 逐字保留 (非目标之一): 不能顺手改老判据。
    expect(seen).toContain('1. 任一明确要求未满足');
    expect(seen).toContain('2. **高风险接缝**');
    expect(seen).toContain('3. 结果是**捏造的数据 / 假执行确认**');
    expect(seen).toContain('4. 计划有节点失败导致结果不完整');
  });
});

describe('与已知存在的 harness 闸配套 (零回归护栏)', () => {
  // 这条不是契约, 是 sanity: 既有节点 (command 节点带 `$ 命令` / `exit 码`) 的卷面**仍**在。
  // 反向自检: 把 meta 那段删掉 ⇒ 这条当场红。
  test('command 节点的 `$ 命令` + `exit 码` 仍出现在卷面 (INV-5)', () => {
    const plan: ConductorPlan = {
      name: 'p',
      nodes: { c: { goal: '数文件', executor: 'command', command: 'ls src/harness/*.ts | wc -l' } },
    };
    const results: Record<string, LeafResult> = {
      c: leaf({ id: 'c', kind: 'command', output: '93', exitCode: 0 }),
    };
    const s = summarizeResults(plan, results);
    expect(s).toContain('$ ls src/harness/*.ts | wc -l');
    expect(s).toContain('exit 0');
  });
});
