/**
 * src/harness/conductor/conductor-tools-wiring.test —— T-1 / INV-1 (P3 契约 D-22, S6b, 2026-09-02):
 * solve 的 conductor 面 (headless 执行侧) 不混进 dag_ / omd_set_ 工具, 也没有 write / edit。
 *
 * 2026-10-08 S1: conductor_chat 轮工具面随对话位删除, 「包含关系」与「chat 位 conductor 卡」两条随之删。
 *
 * 证伪方式: conductor 面里混进 dag_ / omd_set_ 工具 → 前缀断言红。
 */
import { describe, expect, test } from 'bun:test';
import { buildConductorFace } from '../goal/orchestrating-loop';
import type { ConductorCtx } from './types';

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  allowlist: [],
  maxFanout: 2,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

describe('INV-1 — conductor 面', () => {
  test('conductor 面 (headless 执行侧) 无 dag_ / omd_set_ 前缀工具, 无 write / edit', () => {
    const face = buildConductorFace(
      { goal: 'g', writeRoot: '/tmp/x', minutesLeft: null, tokensLeft: null, maxFanout: 2, researchAvailable: false },
      { ctx: CTX, runChild: async () => { throw new Error('not in this test'); } },
    );
    const all = [...face.toolNames, ...face.customTools!.map((t) => t.name)];
    for (const n of all) {
      expect(n.startsWith('dag_')).toBe(false);
      expect(n.startsWith('omd_set_')).toBe(false);
    }
    expect(all).not.toContain('write');
    expect(all).not.toContain('edit');
  });
});
