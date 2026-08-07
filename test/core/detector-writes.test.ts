/**
 * **检查者写了东西吗**(D4 / §7.3「检查者只读」,2026-08-06)。
 *
 * ## 这一格今天靠运气成立
 *
 * §7.3 说检查者应当只读。而 omd 的 D-Q 检测者是**图内节点** —— 它和被它检查的兄弟共享
 * 同一棵 worktree,并且 conductor 把它排成 `executor:'agent'` 时它手里**就是有写工具的**。
 *
 * 实测(2026-08-06,54 跑留痕):23 个 detector 节点里 **7 个是 agent**,其中记了 `writeCounts` 的
 * **4 个全是 `[0,0]`**(另 3 个 `skipped` 没记那一位)—— **它们有机会写却没写**。也就是说这条纪律今天成立,
 * 但成立的方式是**运气不是不变量**,而且一旦有一个真写了,此前**没有任何一处会知道**。
 *
 * ## 这套网的重心在**分母**上
 *
 * 「0 次检测者写」要能读,分母必须是「手里**真有写工具**的检测者数」。把 `inproc` 检测者
 * 算进去会把基率往低了报 —— 那是拿"不可能"冒充"没发生",正是 S-19 那一族。
 * 所以下面一半用例在钉分母:哪些进机会、哪些进 `unobserved`、哪些一格都不进。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDetectorWrites, type DetectorWriteFacts } from '../../src/harness/plan/observers';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const d = (o: Partial<DetectorWriteFacts> & { id: string }): DetectorWriteFacts => ({ kind: 'agent', ...o });

describe('检查者只读 · 判据本身', () => {
  test('agent 检测者写了 → 报, 且它是一次机会', () => {
    const r = detectDetectorWrites([d({ id: 'chk', writes: 2 })]);
    expect(r.opportunities).toBe(1);
    expect(r.findings).toBe(1);
    expect(r.observations[0]!.kind).toBe('detector-wrote');
    expect(r.observations[0]!.nodes).toEqual(['chk']);
  });

  test('★ agent 检测者**没写** → 不报, 但**照样进分母** (0/1 才是"查过零检出")', () => {
    const r = detectDetectorWrites([d({ id: 'chk', writes: 0 })]);
    expect(r.opportunities).toBe(1); // ← 这一行是分母存在的证据
    expect(r.findings).toBe(0);
  });

  test('★ inproc 检测者**一格都不进** —— 它没有写工具, 那是"不可能"不是"没发生"', () => {
    // 少了这条, 16 个 inproc 检测者会把基率的分母灌大 3 倍, 把一个没量过的 0 说成很可信。
    const r = detectDetectorWrites([d({ id: 'chk', kind: 'inproc', writes: 0 })]);
    expect(r.detectors).toBe(1); // 它是个检测者
    expect(r.opportunities).toBe(0); // 但不是一次"能写而没写"的机会
    expect(r.unobserved).toBe(0); // 也不是"没人报"
  });

  test('★ 两位都缺席 (旧 runner 没报) → 进 unobserved, **不算没写**', () => {
    const r = detectDetectorWrites([d({ id: 'chk' })]);
    expect(r.unobserved).toBe(1);
    expect(r.opportunities).toBe(0); // 缺席 ≠ 0 —— 拿它当"没写"就是编一个读数
    expect(r.findings).toBe(0);
  });

  test('★ 只有 shell 候选 (受控写为 0) 也报, 而判词说明这是**推断**', () => {
    // 与 ⑧.6 同一条纪律: 证据强度不同的两类, 判词要分档 —— 下一步不同。
    const r = detectDetectorWrites([d({ id: 'chk', writes: 0, writeCandidates: ['out/x.md'] })]);
    expect(r.findings).toBe(1);
    expect(r.observations[0]!.message).toContain('推断');
    const controlled = detectDetectorWrites([d({ id: 'c2', writes: 3 })]);
    expect(controlled.observations[0]!.message).not.toContain('这一条是**推断**的');
  });

  test('判词点破为什么这件事要紧 —— 否则读的人只当是洁癖', () => {
    const msg = detectDetectorWrites([d({ id: 'chk', writes: 1 })]).observations[0]!.message;
    expect(msg).toContain('§7.3');
    expect(msg).toContain('共享同一棵 worktree');
    expect(msg).toContain('只报不拦');
  });

  test('确定性序: 同一批换个顺序进来, 报告逐字相同', () => {
    const a = d({ id: 'n1', writes: 1 });
    const b = d({ id: 'n2', writes: 1 });
    const fwd = detectDetectorWrites([a, b]).observations.map((o) => o.message);
    const rev = detectDetectorWrites([b, a]).observations.map((o) => o.message);
    expect(fwd).toEqual(rev);
  });
});

describe('检查者只读 · 接在引擎上 (真跑一遍)', () => {
  /** 子图: work → check(detector, 依赖 work) —— 同 `detector-cancel.test.ts` 的形状。 */
  const SUB = JSON.stringify({
    name: 's',
    nodes: {
      work: { goal: '干活', executor: 'agent' },
      check: { goal: '检查', executor: 'agent', detector: true, depends_on: ['work'] },
    },
  });

  /** 一个 conductor 展开出「干活的 + 检测者」两个子节点, 而检测者自己也动手写。 */
  const run = async (detectorWrites: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'dwrite-'));
    const plan = { name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor' } } } as ConductorPlan;
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentTemplates: new Map(),
      // 展开调用返回子图; leaf 那一路走 agentRunner, 不经 generate。
      generate: (async () => ({ text: SUB, usage: { in: 1, out: 1 } })) as GenerateFn,
      agentRunner: async (i: { prompt: string }) => {
        // `AgentLeafInput` 只有 prompt + model —— 节点身份靠 prompt 里的 goal 认(夹具够用)。
        const isChecker = i.prompt.includes('检查');
        const wrote = !isChecker || detectorWrites;
        const file = isChecker ? 'checker-scratch.md' : 'artifact.md';
        if (wrote) writeFileSync(join(dir, file), 'x');
        return {
          text: isChecker ? '看过了' : '写好了',
          usage: { in: 1, out: 1 },
          filesTouched: wrote ? [file] : [],
          // ⚠ `writeCounts` 是引擎从 `writeEffects` **派生**的, runner 直接给那一位不生效
          //   (这一条是写这套夹具时当场撞到的)。空数组 = 报了但一次没写, 与缺席分得开。
          writeEffects: wrote ? [{ path: file, lineDelta: 1, noop: false }] : [],
          cwd: dir,
        };
      },
    } as unknown as ExecutorDagConfig;
    return runExecutorDagWithPlan(plan, cfg);
  };

  test('★ 检测者动手改盘 → 观察面出 detector-wrote', async () => {
    // 证伪: 把 executor-dag 里 `observe(detectorProbe.observations)` 那行删掉 → 这条红。
    const res = await run(true);
    const hit = res.observations?.filter((o) => o.kind === 'detector-wrote') ?? [];
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]!.message).toContain('§7.3');
  });

  test('★ 检测者只读 → 不报 (证明这条不是恒响的)', async () => {
    const res = await run(false);
    expect(res.observations?.some((o) => o.kind === 'detector-wrote')).toBeFalsy();
  });
});
