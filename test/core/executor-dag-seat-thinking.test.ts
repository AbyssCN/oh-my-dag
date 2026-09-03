import { describe, expect, test } from 'bun:test';
import { type GenerateFn } from '../../src/harness/dag/engine';
import { runExecutorDag } from '../helpers/legacy-plan-entry';

// S-T 座位推理档随座位下发 (SDD 2026-07-25 skills-compile-evidence-gate S-T) 的执行期证明。
// 优先序 (显式永远赢, 同 TPL-3 model 哲学): node.thinking > config 显式档 > 座位档 > 硬默认 'high'。
// fake generate 捕获每次请求的 thinkingLevel — 不碰真模型。

const CONDUCTOR = 'sol:gpt';
const LEAF = 'mimo:pro';

const PLAN = JSON.stringify({
  name: 'st',
  nodes: {
    plain: { goal: '普通 leaf' },
    explicit: { goal: '显式档 leaf', thinking: 'xhigh' },
  },
});

/** 跑一次图, 返回 nodeId → 该 leaf 请求的 thinkingLevel (conductor 单列)。 */
async function levelsOf(config: Parameters<typeof runExecutorDag>[1]): Promise<Record<string, string | undefined>> {
  const seen: Record<string, string | undefined> = {};
  const gen: GenerateFn = async ({ model, messages, thinkingLevel }) => {
    if (model === CONDUCTOR) {
      seen['#conductor'] = thinkingLevel;
      return { text: PLAN, usage: { in: 1, out: 1 } };
    }
    const prompt = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const id = prompt.match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
    seen[id] = thinkingLevel;
    return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
  };
  await runExecutorDag('t', { ...config, generate: gen });
  return seen;
}

describe('S-T 座位推理档', () => {
  test('座位档下发: 该坐标的 leaf 请求档 = 座位档 (不再是硬默认 high)', async () => {
    const seen = await levelsOf({
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      seatThinking: (coord) => (coord === LEAF ? 'low' : coord === CONDUCTOR ? 'xhigh' : undefined),
    });
    expect(seen['plain']).toBe('low');
    expect(seen['#conductor']).toBe('xhigh');
  });

  test('node 显式 thinking 赢过座位档 (TPL-3 哲学)', async () => {
    const seen = await levelsOf({
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      seatThinking: () => 'low',
    });
    expect(seen['explicit']).toBe('xhigh'); // 节点显式
    expect(seen['plain']).toBe('low'); // 座位档
  });

  test('config 显式档赢过座位档 (调用方 override 语义)', async () => {
    const seen = await levelsOf({
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      inprocThinkingLevel: 'medium',
      seatThinking: () => 'low',
    });
    expect(seen['plain']).toBe('medium');
  });

  test('向后兼容: 无 seatThinking (老 config) → 现状硬默认 high, 行为不变', async () => {
    const seen = await levelsOf({ conductorModel: CONDUCTOR, leafModel: LEAF });
    expect(seen['plain']).toBe('high');
    expect(seen['#conductor']).toBe('high');
  });

  test('seatThinking 返 undefined (该坐标无座位) → 同样回落 high', async () => {
    const seen = await levelsOf({
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      seatThinking: () => undefined,
    });
    expect(seen['plain']).toBe('high');
  });
});
