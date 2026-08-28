/**
 * 任务分区约定 —— verifier 卷面契约 (NOTES 2026-08-28「verifier 把软措辞读成硬约束」)。
 *
 * 实证判例: run `a3317932`, task 里的成本提示「节点数控制在 10 个以内」被 verifier 判成
 * 硬约束, 11 节点整轮红 (4 次点火吃掉 1 次)。这不是 verifier 的 bug (那样读是合理阅读),
 * 缺的是 task 与 verifier 之间「约束 vs 提示」的语法 —— 本闸钉的就是那个语法真在卷面上。
 *
 * 边界诚实: 单测只能钉「规则进了模型收到的 prompt」(接线在位)。
 * 「提示区违反仍绿 / 硬约束区违反必红」是 LLM 行为面, 要靠 bench/probe 读数, 不在这里装样子。
 *
 * 反向自检 (2026-08-28 实跑): 把 verifier.ts 里「任务分区约定」那一段删掉 → 本文件当场红; 恢复 → 绿。
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultVerifier } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const plan: ConductorPlan = { name: 'p', nodes: { answer: { goal: '一句话回答', executor: 'leaf' } } };
const results: Record<string, LeafResult> = {
  answer: {
    id: 'answer', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 0, out: 0 },
  } as unknown as LeafResult,
};

function capturing() {
  let seen = '';
  const verifier = createDefaultVerifier({
    verifierModel: 'fake:m',
    callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
      seen = req.messages.map((m) => m.content).join('\n');
      return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
    }) as never,
  });
  return [verifier, () => seen] as const;
}

describe('任务分区约定随卷', () => {
  test('卷面含分区规则: 提示区不构成判据 · 硬约束区逐条硬判 · 无分区照旧', async () => {
    const [verifier, seenPrompt] = capturing();
    await verifier({ task: '做一件事\n\n## 提示\n节点数控制在 10 个以内', plan, results });
    const paper = seenPrompt();
    expect(paper).toContain('任务分区约定');
    expect(paper).toContain('不构成验收判据');
    expect(paper).toContain('## 硬约束');
    // 阴性半: 规则必须写明「没有分区的任务照旧」—— 否则老任务的全文抽取语义被顺手改掉。
    expect(paper).toContain('没有分区的任务照旧');
  });
});
