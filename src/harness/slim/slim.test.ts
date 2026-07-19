/**
 * src/harness/slim —— dag-slim 纯件测试 (prompt 构建 / diff 切分 / 预构造 plan / 单行提取格式化)
 * + CLI 冒烟 (--help 干净 env, 零模型调用)。DAG 集成走注入 fake generate。
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { DESIGN_VOCAB, PONYTAIL_DISCIPLINE } from '../review/design-vocab';
import {
  buildGlobalPrompt,
  buildLocalPrompt,
  GLOBAL_KINDS,
  LOCAL_KINDS,
  SYNTH_GOAL,
  FINDING_LINE_FORMAT,
  LEAN_SENTINEL,
} from './prompts';
import { splitDiffByFile, buildLocalPlan, SYNTH_NODE_ID } from './local-plan';
import { extractFindingLines, formatReport } from './findings';
import { PlanSchema } from '../conductor-plan';
import { runExecutorDagWithPlan, type GenerateFn } from '../executor-dag';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'dag-slim.ts');

const TWO_FILE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  '+const a = 1;',
  'diff --git a/docs/b.md b/docs/b.md',
  'index 333..444 100644',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1 +1,2 @@',
  '+hello',
].join('\n');

describe('slim/prompts 两遍 prompt 构建', () => {
  test('全局遍 prompt: 注入 vocab+discipline 块 + 4 类全局 kind + 单行格式, 不含局部 kind', () => {
    const p = buildGlobalPrompt({ scope: 'main...HEAD 改动文件:\nsrc/a.ts' });
    expect(p).toContain(DESIGN_VOCAB);
    expect(p).toContain(PONYTAIL_DISCIPLINE);
    expect(p).toContain(FINDING_LINE_FORMAT);
    expect(p).toContain('src/a.ts');
    for (const k of GLOBAL_KINDS) expect(p).toContain(`\`${k.kind}:\``);
    for (const k of LOCAL_KINDS) expect(p).not.toContain(`\`${k.kind}:\``);
  });

  test('局部遍 prompt: 注入 vocab+discipline 块 + 4 类局部 kind + 护栏, 不含全局 kind', () => {
    const p = buildLocalPrompt('src/x.ts');
    expect(p).toContain(DESIGN_VOCAB);
    expect(p).toContain(PONYTAIL_DISCIPLINE);
    expect(p).toContain('src/x.ts');
    for (const k of LOCAL_KINDS) expect(p).toContain(`\`${k.kind}:\``);
    for (const k of GLOBAL_KINDS) expect(p).not.toContain(`\`${k.kind}:\``);
    // 护栏 (PONYTAIL_DISCIPLINE 的可执行化): planned DEFER ≠ finding · 少行不少 case
    expect(p).toContain('DEFER');
    expect(p).toContain('少行数永不少 case');
  });
});

describe('slim/local-plan diff 切分 + 预构造 plan', () => {
  test('splitDiffByFile: 按 diff --git 边界切 per-file chunk, 文件名取 b/ 侧', () => {
    const chunks = splitDiffByFile(TWO_FILE_DIFF);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.file).toBe('src/a.ts');
    expect(chunks[1]!.file).toBe('docs/b.md');
    expect(chunks[0]!.chunk).toContain('+const a = 1;');
    expect(chunks[0]!.chunk).not.toContain('+hello');
    expect(splitDiffByFile('not a diff at all')).toEqual([]);
  });

  test('buildLocalPlan: 每文件一个 inproc leaf + synth 汇总, 过 PlanSchema 校验', () => {
    const chunks = splitDiffByFile(TWO_FILE_DIFF);
    const plan = buildLocalPlan(chunks);
    // 程序造的 plan 也过弱模型同一道闸
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    const ids = Object.keys(plan.nodes);
    expect(ids.length).toBe(chunks.length + 1);
    expect(ids).toContain(SYNTH_NODE_ID);
    const chunkIds = ids.filter((id) => id !== SYNTH_NODE_ID);
    expect(plan.nodes[SYNTH_NODE_ID]!.depends_on).toEqual(chunkIds);
    expect(plan.nodes[SYNTH_NODE_ID]!.goal).toBe(SYNTH_GOAL);
    // diff hunk 走 args.diff 不进 goal (executor-dag goal 启发式扫描的规避 seam)
    const first = plan.nodes[chunkIds[0]!]!;
    expect(first.executor).toBe('leaf');
    expect((first.args as { diff: string }).diff).toContain('+const a = 1;');
    expect(first.goal).not.toContain('+const a = 1;');
    expect(() => buildLocalPlan([])).toThrow('空 chunk');
  });

  test('runExecutorDagWithPlan 集成 (fake generate): leaf 收到 chunk, synth 收到前驱 finding 行', async () => {
    const chunks = splitDiffByFile(TWO_FILE_DIFF);
    const plan = buildLocalPlan(chunks);
    const calls: { model: string; content: string }[] = [];
    const generate: GenerateFn = async (req) => {
      const content = req.messages.map((m) => m.content).join('\n');
      calls.push({ model: req.model, content });
      if (content.includes(SYNTH_GOAL)) return { text: 'delete: src/a.ts:1 — cut 死代码, replace with nothing', usage: { in: 1, out: 1 } };
      return { text: `yagni: 单实现抽象 in ${content.includes('src/a.ts') ? 'src/a.ts' : 'docs/b.md'}`, usage: { in: 1, out: 1 } };
    };
    const dag = await runExecutorDagWithPlan(plan, { conductorModel: 't:c', leafModel: 't:leaf', cavemanLevel: 'off', generate });
    expect(dag.results[SYNTH_NODE_ID]!.status).toBe('done');
    // chunk leaf prompt 里带了 diff 载荷 (经 Args 渲染)
    const leafCall = calls.find((c) => c.content.includes('src/a.ts') && !c.content.includes(SYNTH_GOAL))!;
    expect(leafCall.model).toBe('t:leaf');
    expect(leafCall.content).toContain('const a = 1;'); // JSON.stringify 转义后仍含代码本体
    // synth 的 prompt 收到全部前驱输出 (fan-in)
    const synthCall = calls.find((c) => c.content.includes(SYNTH_GOAL))!;
    expect(synthCall.content).toContain('Predecessor outputs');
    expect(synthCall.content).toContain('yagni: 单实现抽象 in src/a.ts');
    expect(synthCall.content).toContain('yagni: 单实现抽象 in docs/b.md');
  });
});

describe('slim/findings 单行提取 + 报告格式化', () => {
  test('extractFindingLines: 只认给定 kind 前缀, 容忍 bullet/加粗/全角冒号, 丢散文', () => {
    const text = [
      '以下是审查结果:',
      'dedup: src/a.ts:10 — cut 手写 slug, replace with shared slugify',
      '- collapse: src/b.ts:5 — cut 平行实现, replace with 合并到 x',
      '**layer:** src/c.ts:1 — cut wrapper, replace with 直调',
      'couple: src/d.ts:2 — cut 本地副本, replace with 复用 util',
      'delete: src/e.ts:9 — cut 死代码, replace with nothing', // 局部 kind, 全局提取不认
      '总结: 以上 4 条。',
      LEAN_SENTINEL,
    ].join('\n');
    const g = extractFindingLines(text, GLOBAL_KINDS);
    expect(g.length).toBe(4);
    expect(g[0]).toBe('dedup: src/a.ts:10 — cut 手写 slug, replace with shared slugify');
    expect(g[1]).toStartWith('collapse: ');
    expect(g[2]).toStartWith('layer: ');
    expect(extractFindingLines(text, LOCAL_KINDS)).toEqual(['delete: src/e.ts:9 — cut 死代码, replace with nothing']);
    expect(extractFindingLines(`${LEAN_SENTINEL}\n没什么可删。`, GLOBAL_KINDS)).toEqual([]);
  });

  test('formatReport: Global 组在前 Local 在后; 全空 → Lean already. Ship.', () => {
    const out = formatReport([
      { title: 'Global', lines: ['dedup: a — cut x, replace with y'] },
      { title: 'Local', lines: [] },
    ]);
    expect(out.indexOf('## Global')).toBeLessThan(out.indexOf('## Local'));
    expect(out).toContain('dedup: a — cut x, replace with y');
    expect(out).toContain('(无 finding)');
    expect(formatReport([{ title: 'Global', lines: [] }, { title: 'Local', lines: [] }])).toBe('Lean already. Ship.');
  });
});

describe('scripts/dag-slim CLI 冒烟 (零模型调用)', () => {
  test('--help 干净 env 下打印 usage, exit 0 (env -i 等价)', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--help'], { cwd: REPO_ROOT, env: {} });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('usage:');
    expect(p.stdout.toString()).toContain('--global-model');
  });

  test('--no-global 与 --no-local 同给 = 无事可做, exit 1', () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, '--no-global', '--no-local'], { cwd: REPO_ROOT, env: {} });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('无事可做');
  });
});
