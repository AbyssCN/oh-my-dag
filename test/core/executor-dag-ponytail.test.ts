import { describe, expect, test } from 'bun:test';
import { runExecutorDag, PONYTAIL_LEAF_DISPOSITION, type GenerateFn } from '../../src/harness/executor-dag';

// C: ponytail 注入 leaf (构建相位) — leafPonytail 开时 leaf prompt 末附 disposition, conductor 永不挂。
// 创意节点 (node.creative) 不挂 (护交付物, 同 caveman)。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

// w(普通 leaf) + cre(创意 leaf, 依赖 w)。
const PLAN = JSON.stringify({
  name: 'pony',
  nodes: {
    w: { agent: 'x', goal: 'normal work' },
    cre: { agent: 'x', goal: 'creative work', creative: true, depends_on: ['w'] },
  },
});

function capture(): { gen: GenerateFn; sys: string[]; leafPrompts: Record<string, string> } {
  const sys: string[] = [];
  const leafPrompts: Record<string, string> = {};
  const gen: GenerateFn = async ({ model, messages }) => {
    if (model === CONDUCTOR) return { text: PLAN, usage: { in: 1, out: 1 } };
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    sys.push(typeof system === 'string' ? system : '');
    const id = (typeof user === 'string' ? user : '').match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
    leafPrompts[id] = typeof user === 'string' ? user : '';
    return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
  };
  return { gen, sys, leafPrompts };
}

describe('executor-dag ponytail 注入 (leaf-only, 构建相位)', () => {
  test('leafPonytail=true: 普通 leaf prompt 含 disposition, 创意 leaf 不含, conductor system 永不含', async () => {
    const { gen, sys, leafPrompts } = capture();
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, leafPonytail: true });
    expect(leafPrompts['w']).toContain(PONYTAIL_LEAF_DISPOSITION);
    expect(leafPrompts['cre']).not.toContain(PONYTAIL_LEAF_DISPOSITION); // 创意节点护交付物
    // conductor 的 plan 调用 system 里绝不含 ponytail (规划相位发散)
    expect(sys.every((s) => !s.includes('<ponytail>'))).toBe(true);
  });

  test('默认 (无 leafPonytail): leaf prompt 不含 disposition (opt-in)', async () => {
    const { gen, leafPrompts } = capture();
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    expect(leafPrompts['w']).not.toContain(PONYTAIL_LEAF_DISPOSITION);
  });

  test('disposition v2: 全局>局部 + 4 道护栏 (砍系统不砍片, 不砍正确性/审美/case/planned)', () => {
    // 全局优先 (最小系统而非最小片)
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('SIMPLEST WHOLE');
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('reuse'); // 复用>本地最小
    // 护栏① 不重决结构 (leaf 视野窄)
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('never re-decide structure');
    // 护栏② respect 已规划 DEFER/契约
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('DEFER');
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('not speculation');
    // 护栏③ minimal≠incomplete
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('fewer LINES, never fewer CASES');
    // 护栏④ 前端审美红线 + 维二
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('frontend EXPERIENCE');
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('statutory/legal values');
    expect(PONYTAIL_LEAF_DISPOSITION).toContain('runnable check');
  });
});
