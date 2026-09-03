/**
 * P3 S5 / INV-8 —— lead 常驻 prompt ≤ 8k, manual 一行都不进, 渲染不调 manual()。
 * 证伪: 把任一 `tool.manual()` 拼进 renderLeadPrefix → ②③红;工具行不用 `short` → ④红;
 * 往前缀里加 20k 画图说明 → ①红。
 */
import { describe, expect, test } from 'bun:test';
import { buildLeadSystemPrompt, LEAD_PROMPT_BOUNDARY, LEAD_PROMPT_PREFIX_MAX, LEAD_PROMPT_RESIDENT_MAX, renderLeadPrefix } from './lead-prompt';
import { createLeadTools, LEAD_TOOL_NAMES } from './tools/index';
import { renderManual } from './render-manual';
import type { LeadCtx, LeadTool } from './types';
import { conductorSystemPrompt } from '../conductor-plan';

const ctx: LeadCtx = { cwd: '/w', writeRoot: '/w', acceptance: { command: 'bun test', expect_exit: 0 }, allowlist: ['bun'], maxFanout: 6, seats: { worker: 'a', escalation: 'b', verify: 'c' }, researchAvailable: false };
const FULL_FACTS = {
  // 2026-09-03: goal 按 bench 真题面的长度给 (实测 800–900 字符) —— 2026-09-02 首批 INV-8 超限 (8217/8299)
  // 就是因为这里此前只放了一句 100 字符的 goal, 满槽不满。
  goal: ('Fix the flaky retry in src/harness/agent-leaf.ts so that a timed-out leaf reports budgetStopped instead of done. ' +
    'Context: the leaf loop in agent-leaf.ts wraps the provider call with a deadline; when the deadline fires the loop returns the partial ' +
    'assistant message and the caller currently maps it to done because filesTouched is non-empty. Reproduce with ' +
    'OMD_LEAF_TIMEOUT_MS=10 bun test src/harness/dag/budget-leaf-timeout.test.ts and observe the status column. The fix must keep the ' +
    'partial output (do not drop it), set budgetStopped with the elapsed time, and leave the checkpoint untouched so a resume can reuse it. ' +
    'Do not touch run-goal.ts; the terminal-state mapping there is owned by another change. Add one red test first, then make it green. ' +
    'Report the before/after failure set of the acceptance command and the exit codes verbatim. ' +
    'Keep the change under fifty lines and do not reformat untouched code.').slice(0, 900),
  writeRoot: '/home/nick/repos/oh-my-dag',
  protectedPaths: ['docs/plan/NOTES.md', 'src/model/seats.ts'],
  acceptance: { command: 'bun test src/harness/dag/budget-leaf-timeout.test.ts', expect_exit: 0 },
  minutesLeft: 38,
  tokensLeft: 250_000,
  maxFanout: 6,
  objective: 'finish in the least wall time within the token budget',
  researchAvailable: true,
  upstream: 'Prior round: worker w1 returned red twice on the same assertion; verifier not yet called.',
};

describe('lead prompt', () => {
  test('★ ① 常驻字符 ≤ 8000 (满槽 facts); 对照 conductor full prompt', () => {
    const tools = createLeadTools(ctx);
    const p = buildLeadSystemPrompt(FULL_FACTS, tools);
    const old = conductorSystemPrompt().length;
    console.log(`lead resident=${p.length} chars · conductor full=${old} chars`);
    expect(FULL_FACTS.goal.length).toBeGreaterThanOrEqual(850); // 满槽是真满: 题面按 bench 实测长度
    expect(p.length).toBeLessThanOrEqual(LEAD_PROMPT_RESIDENT_MAX);
    // 前缀自己的上限: 给事实留 ≥ 1400 字符 (2026-09-03)。删掉任一节的精简 → 这条先红。
    expect(renderLeadPrefix(tools).length).toBeLessThanOrEqual(LEAD_PROMPT_PREFIX_MAX);
    expect(old).toBeGreaterThan(p.length * 2);
  });

  test('★ ② 七张 manual 的首行一条都不出现在常驻 prompt 里', () => {
    const p = buildLeadSystemPrompt(FULL_FACTS, createLeadTools(ctx));
    for (const name of LEAD_TOOL_NAMES) {
      const head = renderManual(name).split('\n')[0]!;
      expect(head.length).toBeGreaterThan(5);
      expect(p).not.toContain(head);
    }
  });

  test('★ ③ 渲染过程一次都不调 manual()', () => {
    let calls = 0;
    const spied: LeadTool[] = createLeadTools(ctx).map((t) => ({ ...t, manual: () => { calls++; return t.manual(); } }));
    buildLeadSystemPrompt(FULL_FACTS, spied);
    renderLeadPrefix(spied);
    expect(calls).toBe(0);
  });

  test('★ ④ §1 工具行逐字来自注册表 short', () => {
    const tools = createLeadTools(ctx);
    const prefix = renderLeadPrefix(tools);
    for (const t of tools) expect(prefix).toContain(`- ${t.name}: ${t.short}`);
    const swapped = tools.map((t) => (t.name === 'work' ? { ...t, short: 'CHANGED SHORT' } : t));
    expect(renderLeadPrefix(swapped)).toContain('- work: CHANGED SHORT');
  });

  test('★ ⑤ 全部槽被填, 渲染后无残留 {{, 事实全在边界之后', () => {
    const p = buildLeadSystemPrompt(FULL_FACTS, createLeadTools(ctx));
    expect(p).not.toContain('{{');
    const [prefix, facts] = p.split(LEAD_PROMPT_BOUNDARY);
    for (const s of [FULL_FACTS.goal, 'bun test src/harness/dag/budget-leaf-timeout.test.ts', '38 minutes', '250000 tokens', '6 workers at once', FULL_FACTS.objective, 'docs/plan/NOTES.md', 'Prior round']) {
      expect(facts).toContain(s);
      expect(prefix).not.toContain(s);
    }
    const other = buildLeadSystemPrompt({ ...FULL_FACTS, goal: 'other', minutesLeft: null, tokensLeft: null, objective: undefined, researchAvailable: false, upstream: undefined }, createLeadTools(ctx));
    expect(other.split(LEAD_PROMPT_BOUNDARY)[0]).toBe(prefix);
    expect(other).toContain('no minute budget');
  });

  test('★ ⑥ 工具清单不含 write / edit (lead 不写文件, owner 9/2 裁)', () => {
    const prefix = renderLeadPrefix(createLeadTools(ctx));
    const toolSection = prefix.slice(prefix.indexOf('## 1. Tools'), prefix.indexOf('## 2.'));
    expect(toolSection).not.toMatch(/\b(write|edit)\(/);
    expect(toolSection).toContain('read(path');
    expect(toolSection).toContain('bash(command)');
  });
});

describe('1-A (2026-09-03): 判据文件先落盘的事实行', () => {
  test('criterionFiles 非空 → 判据行尾接 "Missing now: …" (≤ 140 字符; 满槽夹具 7967 已贴着 8000, 真 bench 事实约 7780); 缺席 / 空 → 无', () => {
    const tools = createLeadTools(ctx);
    const base = buildLeadSystemPrompt(FULL_FACTS, tools);
    const withFiles = buildLeadSystemPrompt({ ...FULL_FACTS, criterionFiles: ['tests/test_tz.py'] }, tools);
    expect(withFiles).toContain('Missing now: tests/test_tz.py — dispatch #1 must be ONE work()');
    console.log(`lead resident with criterionFiles=${withFiles.length} chars (+${withFiles.length - base.length})`);
    // 满槽夹具 (900 字 goal + protectedPaths + upstream) 本就贴着 8000; 真 bench 事实没有 upstream / protectedPaths, 约 7780 + 这段。
    expect(withFiles.length - base.length).toBeLessThanOrEqual(140);
    expect(base).not.toContain('Missing now:');
    expect(buildLeadSystemPrompt({ ...FULL_FACTS, criterionFiles: [] }, tools)).not.toContain('Missing now:');
  });
});
