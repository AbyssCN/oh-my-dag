import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExecutorDagWithPlan, type GenerateFn } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import {
  normalizeFaninConfig,
  parseFaninSummary,
  composeFaninView,
  buildFaninSummaryPrompt,
  DEFAULT_FANIN_MIN_CHARS,
  DEFAULT_FANIN_MIN_FANOUT,
  DEFAULT_FANIN_SCHEMA,
} from '../../src/harness/fanin-summary';

// fan-in 定向摘要 (扇出≥2 触发 + output_schema 默认化 + 全文指针) — fake generate, 不碰 live 模型。
// 证: 扇出≥2 且够长的 producer 输出被摘要替换注入下游; 扇出<2/短输出/creative/map/关闭/失败 → 全文兜底。

const LEAF = 'deepseek:deepseek-v4-flash';
const PAD = 'x'.repeat(400); // 让 producer 输出超 minChars 的填充 (仅出现在输出, 不在任何 goal)

/** 记录调用 + 按 system 前缀分流 (摘要器 vs 普通 leaf); producer goal 含 'BIG' → 长输出。 */
function makeFake() {
  const leafCalls: { id: string; prompt: string }[] = [];
  const faninCalls: { prompt: string }[] = [];
  const gen: GenerateFn = async ({ messages }) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const prompt = messages.map((m) => m.content).join('\n');
    // fan-in 摘要器: 冻结 system 前缀含 'DIRECTED fan-in summary'。
    if (sys.includes('DIRECTED fan-in summary')) {
      faninCalls.push({ prompt });
      return {
        text: JSON.stringify({ tldr: 'SUMMARIZED', key_points: ['kp1'], artifacts: ['src/x.ts'], open_questions: [] }),
        usage: { in: 20, out: 10 },
      };
    }
    const id = prompt.match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
    leafCalls.push({ id, prompt });
    // producer(goal 含 BIG) → 长输出 (超默认 minChars); 其余短。
    const body = prompt.includes('BIG') ? `OUT:${id}:${PAD}` : `OUT:${id}`;
    return { text: body, usage: { in: 10, out: 7 } };
  };
  return { gen, leafCalls, faninCalls };
}

/** a(BIG producer) → b, c (两个 consumer)。a 扇出=2。 */
function fanoutPlan(): ConductorPlan {
  return {
    name: 'fanout',
    nodes: {
      a: { agent: 'x', goal: 'produce the BIG shared artifact' },
      b: { agent: 'x', goal: 'consume a for report one', depends_on: ['a'] },
      c: { agent: 'x', goal: 'consume a for report two', depends_on: ['a'] },
    },
  } as unknown as ConductorPlan;
}

describe('fan-in 定向摘要 (executor-dag 接缝)', () => {
  test('扇出≥2 且够长 → 摘要 1 发, 下游注入摘要而非全文', async () => {
    const { gen, faninCalls } = makeFake();
    const calls: Record<string, string> = {};
    const wrapped: GenerateFn = async (req) => {
      const r = await gen(req);
      const id = req.messages.map((m) => m.content).join('\n').match(/\[omd leaf: (\w+)\]/)?.[1];
      if (id) calls[id] = req.messages.map((m) => m.content).join('\n');
      return r;
    };
    const res = await runExecutorDagWithPlan(fanoutPlan(), {
      conductorModel: '', leafModel: LEAF, generate: wrapped, faninSummary: { minChars: 50 },
    });

    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    // 摘要器恰调 1 次 (a 扇出=2 → 1 发, 跨 b/c 摊薄)
    expect(faninCalls.length).toBe(1);
    // 下游 b/c 注入 <fan-in-summary> 视图, 不含 producer 全文的填充
    expect(calls.b).toContain('<fan-in-summary>');
    expect(calls.b).toContain('SUMMARIZED');
    expect(calls.b).not.toContain(PAD);
    expect(calls.c).toContain('<fan-in-summary>');
    expect(calls.c).not.toContain(PAD);
    // 定向: 摘要器 prompt 含两个 consumer 目标 + producer 全文 (须读全文才能摘)
    expect(faninCalls[0]!.prompt).toContain('consume a for report one');
    expect(faninCalls[0]!.prompt).toContain('consume a for report two');
    expect(faninCalls[0]!.prompt).toContain(PAD);
    // 账本: 摘要 usage(in20/out10) 折进 a → leavesIn=10*3+20=50, leavesOut=7*3+10=31
    expect(res.usage.leavesIn).toBe(50);
    expect(res.usage.leavesOut).toBe(31);
  });

  test('扇出<2 (单 consumer) → 不摘要, 全文注入', async () => {
    const { gen, faninCalls } = makeFake();
    const plan = {
      name: 'linear',
      nodes: {
        a: { agent: 'x', goal: 'produce BIG output' },
        b: { agent: 'x', goal: 'consume a', depends_on: ['a'] },
      },
    } as unknown as ConductorPlan;
    const res = await runExecutorDagWithPlan(plan, {
      conductorModel: '', leafModel: LEAF, generate: gen, faninSummary: { minChars: 50 },
    });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    expect(faninCalls.length).toBe(0); // 扇出1 无摊薄 → 不触发
  });

  test('短输出 (< minChars) → 不摘要即便扇出≥2', async () => {
    const { gen, faninCalls, leafCalls } = makeFake();
    // producer goal 不含 BIG → 短输出 'OUT:a'
    const plan = {
      name: 'short',
      nodes: {
        a: { agent: 'x', goal: 'produce small output' },
        b: { agent: 'x', goal: 'consume one', depends_on: ['a'] },
        c: { agent: 'x', goal: 'consume two', depends_on: ['a'] },
      },
    } as unknown as ConductorPlan;
    await runExecutorDagWithPlan(plan, { conductorModel: '', leafModel: LEAF, generate: gen });
    expect(faninCalls.length).toBe(0);
    // 全文注入: b 收到 a 的原始输出
    const bCall = leafCalls.find((c) => c.id === 'b');
    expect(bCall?.prompt).toContain('OUT:a');
  });

  test('摘要器返回非 JSON → fail-open 回退全文, DAG 仍全 done', async () => {
    const faninCalls: { prompt: string }[] = [];
    const gen: GenerateFn = async ({ messages }) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      const prompt = messages.map((m) => m.content).join('\n');
      if (sys.includes('DIRECTED fan-in summary')) {
        faninCalls.push({ prompt });
        return { text: 'sorry I cannot produce json', usage: { in: 20, out: 10 } }; // 坏输出
      }
      const id = prompt.match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
      return { text: prompt.includes('BIG') ? `OUT:${id}:${PAD}` : `OUT:${id}`, usage: { in: 10, out: 7 } };
    };
    const captured: Record<string, string> = {};
    const wrapped: GenerateFn = async (req) => {
      const r = await gen(req);
      const id = req.messages.map((m) => m.content).join('\n').match(/\[omd leaf: (\w+)\]/)?.[1];
      if (id) captured[id] = req.messages.map((m) => m.content).join('\n');
      return r;
    };
    const res = await runExecutorDagWithPlan(fanoutPlan(), {
      conductorModel: '', leafModel: LEAF, generate: wrapped, faninSummary: { minChars: 50 },
    });
    expect(faninCalls.length).toBe(1); // 试过摘要
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    // 回退全文: b 收到 a 的全文 (含 PAD), 无 <fan-in-summary>
    expect(captured.b).toContain(PAD);
    expect(captured.b).not.toContain('<fan-in-summary>');
  });

  test('faninSummary.enabled:false → 关闭, 全文注入', async () => {
    const { gen, faninCalls } = makeFake();
    await runExecutorDagWithPlan(fanoutPlan(), {
      conductorModel: '', leafModel: LEAF, generate: gen, faninSummary: { enabled: false, minChars: 50 },
    });
    expect(faninCalls.length).toBe(0);
  });

  test('creative producer → 护交付物, 不摘要', async () => {
    const { gen, faninCalls } = makeFake();
    const plan = {
      name: 'creative',
      nodes: {
        a: { agent: 'x', goal: 'produce BIG creative copy', creative: true },
        b: { agent: 'x', goal: 'judge one', depends_on: ['a'] },
        c: { agent: 'x', goal: 'judge two', depends_on: ['a'] },
      },
    } as unknown as ConductorPlan;
    await runExecutorDagWithPlan(plan, { conductorModel: '', leafModel: LEAF, generate: gen, faninSummary: { minChars: 50 } });
    expect(faninCalls.length).toBe(0);
  });

  test('全文指针: continuity 在 → 全文落盘 + 视图带 path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-fanin-'));
    try {
      const { gen } = makeFake();
      const captured: Record<string, string> = {};
      const wrapped: GenerateFn = async (req) => {
        const r = await gen(req);
        const id = req.messages.map((m) => m.content).join('\n').match(/\[omd leaf: (\w+)\]/)?.[1];
        if (id) captured[id] = req.messages.map((m) => m.content).join('\n');
        return r;
      };
      await runExecutorDagWithPlan(fanoutPlan(), {
        conductorModel: '', leafModel: LEAF, generate: wrapped, faninSummary: { minChars: 50 },
        continuity: { manager: new CheckpointManager(root), runId: 'run1', repoRoot: root },
      });
      // 落盘文件存在且含全文 (OMD_DATA_HOME 未设 → repoRoot/.omd/continuity/<runId>/)
      const full = join(root, '.omd', 'continuity', 'run1', 'fanin-a.txt');
      expect(existsSync(full)).toBe(true);
      expect(readFileSync(full, 'utf-8')).toContain(PAD);
      // 下游视图含指针路径
      expect(captured.b).toContain('fanin-a.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('output_schema 默认化: 声明则遵之, 否则默认 schema', async () => {
    const { gen, faninCalls } = makeFake();
    const plan = {
      name: 'schema',
      nodes: {
        a: { agent: 'x', goal: 'produce BIG output', output_schema: { custom_field: 'my instruction' } },
        b: { agent: 'x', goal: 'consume one', depends_on: ['a'] },
        c: { agent: 'x', goal: 'consume two', depends_on: ['a'] },
      },
    } as unknown as ConductorPlan;
    await runExecutorDagWithPlan(plan, { conductorModel: '', leafModel: LEAF, generate: gen, faninSummary: { minChars: 50 } });
    expect(faninCalls.length).toBe(1);
    // 声明的 output_schema 进摘要器 prompt (非默认)
    expect(faninCalls[0]!.prompt).toContain('custom_field');
    expect(faninCalls[0]!.prompt).not.toContain('open_questions');
  });

  test('warmThenFanout 路径同样摘要 (暖发节点=root a)', async () => {
    const { gen, faninCalls } = makeFake();
    await runExecutorDagWithPlan(fanoutPlan(), {
      conductorModel: '', leafModel: LEAF, generate: gen, warmThenFanout: true, faninSummary: { minChars: 50 },
    });
    expect(faninCalls.length).toBe(1); // 暖发的 a 也走 maybeFaninView
  });
});

describe('fanin-summary 纯 helper', () => {
  test('normalizeFaninConfig: 默认 ON + 阈值', () => {
    expect(normalizeFaninConfig()).toEqual({ enabled: true, minChars: DEFAULT_FANIN_MIN_CHARS, minFanout: DEFAULT_FANIN_MIN_FANOUT });
    expect(normalizeFaninConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeFaninConfig({ minChars: 5 }).minChars).toBe(5);
    expect(normalizeFaninConfig({ model: 'p:m' }).model).toBe('p:m');
  });

  test('parseFaninSummary: 剥 fence / 首{末}; 非对象/坏 → null', () => {
    expect(parseFaninSummary('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseFaninSummary('noise {"a":1} tail')).toEqual({ a: 1 });
    expect(parseFaninSummary('[1,2]')).toBeNull(); // 数组非对象
    expect(parseFaninSummary('not json at all')).toBeNull();
    expect(parseFaninSummary('{bad json')).toBeNull();
  });

  test('composeFaninView: 有/无指针', () => {
    const withPtr = composeFaninView({ tldr: 't' }, '/x/fanin-a.txt', 1234);
    expect(withPtr).toContain('<fan-in-summary>');
    expect(withPtr).toContain('/x/fanin-a.txt');
    expect(withPtr).toContain('1234');
    const noPtr = composeFaninView({ tldr: 't' }, null, 1234);
    expect(noPtr).toContain('<fan-in-summary>');
    expect(noPtr).not.toContain('full output');
  });

  test('buildFaninSummaryPrompt: 定向 (含下游目标 + schema + 全文)', () => {
    const p = buildFaninSummaryPrompt({
      producerGoal: 'gg', output: 'OUTPUT_BODY', depGoals: ['do X', 'do Y'], schema: DEFAULT_FANIN_SCHEMA,
    });
    expect(p).toContain('gg');
    expect(p).toContain('do X');
    expect(p).toContain('do Y');
    expect(p).toContain('OUTPUT_BODY');
    expect(p).toContain('open_questions');
    // 无下游目标 → 兜底措辞
    expect(buildFaninSummaryPrompt({ output: 'o', depGoals: [], schema: {} })).toContain('synthesize this with sibling');
  });
});
