/**
 * E-T2 research 可用性闸 —— 纯函数半 + 教学半 + 接线在位扫描。
 *
 * 证伪记录 (新闸当场证伪, 2026-08-28): 把 researchNodesWithoutRunner 的
 * `if (researchAvailable) return [];` 删掉 → G-3 当场红 (可用时也命中);
 * 把 map 模板分支删掉 → G-2 当场红。两次都做过再恢复。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { researchNodesWithoutRunner, researchUnavailableRemediation } from './research-availability-gate';
import { conductorSystemPrompt } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';

const planWith = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

describe('E-T2 · research 可用性闸 (纯函数半)', () => {
  test('G-1: 顶层 research 节点被点名', () => {
    const p = planWith({
      r1: { executor: 'research', goal: '查外部资料', depends_on: [] },
      a1: { executor: 'leaf', goal: '写报告', depends_on: ['r1'] },
    });
    expect(researchNodesWithoutRunner(p, false)).toEqual(['r1']);
  });

  test('G-2: map 模板里的 research 也被点名 (半藏形态)', () => {
    const p = planWith({
      m1: {
        executor: 'map',
        goal: '每个主题查一遍',
        depends_on: [],
        map: {
          lister: { executor: 'command', command: 'ls' },
          over: 'items', itemVar: 'it',
          template: { executor: 'research', goal: '查 {{it}}' },
        },
      } as ConductorPlan['nodes'][string],
    });
    expect(researchNodesWithoutRunner(p, false)).toEqual(['m1']);
  });

  test('G-3 (反向自检): researchAvailable=true → 同一张图零命中', () => {
    const p = planWith({ r1: { executor: 'research', goal: '查', depends_on: [] } });
    expect(researchNodesWithoutRunner(p, true)).toEqual([]);
  });

  test('G-4: 无 research 的图零命中 (零回归)', () => {
    const p = planWith({
      a: { executor: 'leaf', goal: '写', depends_on: [] },
      c: { executor: 'command', command: 'echo ok', depends_on: ['a'], goal: '验' },
    });
    expect(researchNodesWithoutRunner(p, false)).toEqual([]);
  });

  test('remediation 文案点名节点且禁"改名成 leaf 凭记忆调研" (D-6)', () => {
    const msg = researchUnavailableRemediation(['r1', 'm1']);
    expect(msg).toContain('r1, m1');
    expect(msg).toContain('凭记忆调研');
  });
});

describe('E-T2 · 教学半 (conductorSystemPrompt)', () => {
  test('researchAvailable=false → 注入 CAPABILITY NOTICE (full 与 lean 档都有; bare 刻意没有)', () => {
    expect(conductorSystemPrompt({ researchAvailable: false })).toContain('CAPABILITY NOTICE');
    expect(conductorSystemPrompt({ researchAvailable: false, profile: 'lean' })).toContain('CAPABILITY NOTICE');
  });

  test('省略/true → 提示词不提 (零回归: 现有部署 prompt 逐字节不变)', () => {
    expect(conductorSystemPrompt({})).not.toContain('CAPABILITY NOTICE');
    expect(conductorSystemPrompt({ researchAvailable: true })).not.toContain('CAPABILITY NOTICE');
  });
});

describe('E-T2 · 接线在位 (源码面扫描, 防静默摘线)', () => {
  const engineSrc = readFileSync(new URL('../dag/engine.ts', import.meta.url), 'utf8');

  test('规划环里挂着确定性拒回 (researchNodesWithoutRunner 被引擎消费)', () => {
    expect(engineSrc).toContain('researchNodesWithoutRunner(candidate, false)');
    expect(engineSrc).toContain('research 可用性闸拒回 plan');
  });

  test('子图展开在 researchRunner 缺席时追加 research 禁单', () => {
    expect(engineSrc).toContain("['research', '本部署无 search provider");
  });
});
