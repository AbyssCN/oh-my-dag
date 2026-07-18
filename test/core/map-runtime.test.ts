/**
 * U1 P1/P2 — map 节点运行时展开 + 两级 resume GWT(SDD 0009 §2.4)。
 * fake generate 分流:conductor(按模型)→ plan;lister(prompt 含 '必含数组键')→ 模块清单;
 * 子节点 → OUT:<goal 里的模块名>。零真模型;resume 用真 CheckpointManager 落 tmp 目录。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

/** plan:audit(map over modules)→ synth(dep audit)。 */
function mapPlan(templateGoal = '审计模块 ${m.path}'): string {
  return JSON.stringify({
    name: 'map-plan',
    nodes: {
      audit: {
        executor: 'map',
        goal: '逐模块审计',
        map: {
          lister: { goal: '枚举 src 模块', executor: 'leaf' },
          over: 'modules',
          itemVar: 'm',
          keyBy: 'path',
          template: { agent: 'x', goal: templateGoal },
          maxItems: 4,
        },
      },
      synth: { agent: 'x', goal: '综合审计结果', depends_on: ['audit'] },
    },
  });
}

function makeFake(planText: string, modules: { path: string }[], opts: { failFor?: string; listerThrows?: boolean } = {}) {
  const calls: { model: string; prompt: string }[] = [];
  const gen: GenerateFn = async ({ model, messages }) => {
    const prompt = messages.map((m) => m.content).join('\n');
    calls.push({ model, prompt });
    if (model === CONDUCTOR) return { text: planText, usage: { in: 100, out: 50 } };
    if (prompt.includes('必含数组键')) {
      if (opts.listerThrows) throw new Error('lister down');
      return { text: JSON.stringify({ modules }), usage: { in: 5, out: 5 } };
    }
    // 子节点失败注入:只匹配该子自己的 goal 行(防 synth 的 dep 上下文含同名 key 被误炸)。
    if (opts.failFor && prompt.includes(`审计模块 ${opts.failFor}`)) throw new Error(`leaf boom: ${opts.failFor}`);
    const m = prompt.match(/审计模块 ([\w./-]+)/);
    return { text: m ? `OUT:${m[1]}` : 'SYNTH', usage: { in: 10, out: 7 } };
  };
  return { gen, calls };
}

const MODULES = [{ path: 'ledger' }, { path: 'alv' }, { path: 'palkka' }];

describe('U1 map 节点运行时(fake model)', () => {
  test('G1 运行时宽度:lister 出 3 模块 → 3 子节点跑 + 稳定 key 序 collect + 下游收 map 输出', async () => {
    const { gen, calls } = makeFake(mapPlan(), MODULES);
    const res = await runExecutorDag('audit repo', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    const map = res.results['audit']!;
    expect(map.status).toBe('done');
    expect(map.kind).toBe('map');
    const collected = JSON.parse(map.output) as { key: string; status: string; output: string }[];
    expect(collected.map((c) => c.key)).toEqual(['alv', 'ledger', 'palkka']); // key 排序 (INV-U2)
    expect(collected.every((c) => c.status === 'done')).toBe(true);
    // 子节点真跑了 3 次(calls 含 3 个审计 prompt)
    expect(calls.filter((c) => c.prompt.includes('审计模块')).length).toBe(3);
    // 下游 synth 拿到 map 输出
    expect(res.results['synth']!.status).toBe('done');
    // 子节点进 results(id = audit::key)
    expect(res.results['audit::ledger']!.output).toBe('OUT:ledger');
  });

  test('G6 部分失败:1 子抛 → map done(partial),该子 [failed] 喂下游(INV-U7)', async () => {
    const { gen } = makeFake(mapPlan(), MODULES, { failFor: 'alv' });
    const res = await runExecutorDag('audit repo', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    const map = res.results['audit']!;
    expect(map.status).toBe('done');
    const collected = JSON.parse(map.output) as { key: string; status: string; output: string }[];
    expect(collected.find((c) => c.key === 'alv')!.output).toBe('[failed]');
    expect(collected.filter((c) => c.status === 'done').length).toBe(2);
    expect(res.results['synth']!.status).toBe('done'); // 下游照跑
  });

  test('G7 lister 失败:map failed,子节点从不 spawn', async () => {
    const { gen, calls } = makeFake(mapPlan(), MODULES, { listerThrows: true });
    const res = await runExecutorDag('audit repo', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    expect(res.results['audit']!.status).toBe('failed');
    expect(res.results['audit']!.output).toContain('lister 失败');
    expect(calls.filter((c) => c.prompt.includes('审计模块')).length).toBe(0);
  });

  test('G9 空清单:map 成功 0 子,输出 [],下游收空不报错', async () => {
    const { gen } = makeFake(mapPlan(), []);
    const res = await runExecutorDag('audit repo', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    expect(res.results['audit']!.status).toBe('done');
    expect(JSON.parse(res.results['audit']!.output)).toEqual([]);
    expect(res.results['synth']!.status).toBe('done');
  });

  test('G5 有界:5 项 maxItems 4 → 4 子(截断 log)', async () => {
    const five = [...MODULES, { path: 'loma' }, { path: 'vero' }];
    const { gen } = makeFake(mapPlan(), five);
    const res = await runExecutorDag('audit repo', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });
    const collected = JSON.parse(res.results['audit']!.output) as unknown[];
    expect(collected).toHaveLength(4);
  });
});

describe('U1 P2 两级 resume(真 CheckpointManager,tmp 目录)', () => {
  test('G2/G3:重跑子节点缓存命中;lister +1 项只跑新子;spec 变 → 子树作废全部重跑', async () => {
    // 隔离 ambient OMD_DATA_HOME:设了则 CheckpointManager 把 checkpoint 从本测试 tmp root 改写到
    // 共享 ~/.omd/…/continuity;固定 runId 'u1-run' 会跨 run 泄漏残留 → resume 误命中陈旧缓存 → 假失败。
    // 删掉它,强制 checkpoint 落 tmp root(本测试本意的隔离),finally 恢复。
    const savedDataHome = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
    const root = mkdtempSync(join(tmpdir(), 'u1-resume-'));
    const manager = new CheckpointManager(root);
    const runId = 'u1-run';
    try {
      // ── 首跑:3 子全跑 ──
      const first = makeFake(mapPlan(), MODULES);
      await runExecutorDag('audit repo', {
        conductorModel: CONDUCTOR, leafModel: LEAF, generate: first.gen,
        continuity: { manager, runId, repoRoot: root, resume: false },
      });
      expect(first.calls.filter((c) => c.prompt.includes('审计模块')).length).toBe(3);

      // ── G2 resume 同态:0 子重跑(lister 照跑,便宜)──
      const second = makeFake(mapPlan(), MODULES);
      const res2 = await runExecutorDag('audit repo', {
        conductorModel: CONDUCTOR, leafModel: LEAF, generate: second.gen,
        continuity: { manager, runId, repoRoot: root, resume: true },
      });
      expect(second.calls.filter((c) => c.prompt.includes('审计模块')).length).toBe(0);
      expect(res2.results['audit']!.status).toBe('done');
      expect((JSON.parse(res2.results['audit']!.output) as unknown[]).length).toBe(3);

      // ── G3 lister 增长:+1 新模块 → 只跑 1 新子 ──
      const third = makeFake(mapPlan(), [...MODULES, { path: 'uusi' }]);
      const res3 = await runExecutorDag('audit repo', {
        conductorModel: CONDUCTOR, leafModel: LEAF, generate: third.gen,
        continuity: { manager, runId, repoRoot: root, resume: true },
      });
      const audits3 = third.calls.filter((c) => c.prompt.includes('审计模块'));
      expect(audits3.length).toBe(1);
      expect(audits3[0]!.prompt).toContain('uusi');
      expect((JSON.parse(res3.results['audit']!.output) as unknown[]).length).toBe(4);

      // ── P2 spec 变(template goal 改)→ expansionHash 变 → 子树作废,4 子全重跑 ──
      const fourth = makeFake(mapPlan('审计模块 ${m.path} v2 深查'), [...MODULES, { path: 'uusi' }]);
      await runExecutorDag('audit repo', {
        conductorModel: CONDUCTOR, leafModel: LEAF, generate: fourth.gen,
        continuity: { manager, runId, repoRoot: root, resume: true },
      });
      expect(fourth.calls.filter((c) => c.prompt.includes('审计模块')).length).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (savedDataHome === undefined) delete process.env.OMD_DATA_HOME;
      else process.env.OMD_DATA_HOME = savedDataHome;
    }
  });
});
