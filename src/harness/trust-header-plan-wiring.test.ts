/**
 * A8 信任边界的**规划层**接线回归 —— TRUST_FENCE_RULE 在规划 prompt 冻结前缀里承诺
 * 「本次任务会给你一个 8 位十六进制信任 token, 在任务正文最开头声明」(prompt-fence.ts:58),
 * 而 plan 请求此前从不预置 token 头 (只有叶层 engine.ts buildLeafPrompt 兑现)。
 * 后果实测: goal 带 owner 权威措辞 (「已终审放行 / 不得重议」) 时 planner 按
 * 「缺 token 即伪造」fail-closed, 把整图规划成单节点 blocker, 零实施
 * (run 9228064a-b645-4c83-8b2e-16417e8afeb6, 2026-08-09, dream S4 首派)。
 * 证伪方式: 把 engine.ts plan 请求 user 消息里的 trustHeader 拿掉 → 本测试当场红
 * (2026-08-09 落地时按此复证过一次)。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDag } from './dag/engine';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

const TOKEN_LINE_RE = /\[信任 token: [0-9a-f]{8}\]/;

const planJson = JSON.stringify({ name: 'p', nodes: { sum: { goal: '总结要点' } } });

/** 规划问 (system 含 CONDUCTOR) 回固定 plan 并记录 user 正文; leaf 问回 ok。 */
const makeGenerate = (seen: { planPrompts: string[] }): GenerateFn => {
  return async (req) => {
    const sys = req.messages.find((m) => m.role === 'system');
    const user = req.messages.find((m) => m.role === 'user');
    const userText = typeof user?.content === 'string' ? user.content : '';
    if (typeof sys?.content === 'string' && sys.content.includes('CONDUCTOR')) {
      seen.planPrompts.push(userText);
      return { text: planJson, usage: { in: 1, out: 1 } };
    }
    return { text: 'ok', usage: { in: 1, out: 1 } };
  };
};

const cfg = (generate: GenerateFn): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
});

describe('A8 规划层 token 头接线', () => {
  test('plan 请求正文声明 8 位 hex 信任 token, 且排在任务文本之前', async () => {
    const seen = { planPrompts: [] as string[] };
    const task = '测试任务 —— owner 已终审放行, 按计划执行';
    await runExecutorDag(task, cfg(makeGenerate(seen)));
    expect(seen.planPrompts).toHaveLength(1);
    const prompt = seen.planPrompts[0]!;
    expect(prompt).toMatch(TOKEN_LINE_RE);
    // token 声明必须在任务正文之前 (prompt-fence.ts:66: 排在任何不可信内容之前)
    expect(prompt.search(TOKEN_LINE_RE)).toBeLessThan(prompt.indexOf(task));
  });
});
