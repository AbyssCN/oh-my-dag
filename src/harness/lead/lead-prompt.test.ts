/**
 * P3 S5 / INV-8 —— lead 常驻 prompt ≤ 8k, manual 一行都不进, 渲染不调 manual()。
 * 证伪: 把任一 `tool.manual()` 拼进 renderLeadPrefix → ②③红;工具行不用 `short` → ④红;
 * 往前缀里加 20k 画图说明 → ①红。
 */
import { describe, expect, test } from 'bun:test';
import { buildLeadSystemPrompt, LEAD_PROMPT_BOUNDARY, LEAD_PROMPT_RESIDENT_MAX, renderLeadPrefix } from './lead-prompt';
import { createLeadTools, LEAD_TOOL_NAMES } from './tools/index';
import { renderManual } from './render-manual';
import type { LeadCtx, LeadTool } from './types';
import { conductorSystemPrompt } from '../conductor-plan';

const ctx: LeadCtx = { cwd: '/w', writeRoot: '/w', acceptance: { command: 'bun test', expect_exit: 0 }, allowlist: ['bun'], maxFanout: 6, seats: { worker: 'a', escalation: 'b', verify: 'c' }, researchAvailable: false };
const FULL_FACTS = {
  goal: 'Fix the flaky retry in src/harness/agent-leaf.ts so that a timed-out leaf reports budgetStopped instead of done.',
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
    expect(p.length).toBeLessThanOrEqual(LEAD_PROMPT_RESIDENT_MAX);
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
