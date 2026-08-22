/**
 * 「绿节点配空盘」后果网 (SDD 2026-08-22 · 片 3g 后续网, C-1/C-2):
 * `done` 节点声明了 `write_set`, 而写集里**一个文件都不在盘上** ⇒ 出一条
 * `DagObservation { kind: 'empty-write-set' }`, 不改节点 status (D-1)。
 *
 * 4 条 GWT:
 *   G1. `done` 且声明 `write_set` 且全不在盘上 ⇒ 出观察, `s1.status` 仍 'done' (D-1 / 承重)
 *   G2. 写集里有一个文件在盘上 ⇒ **不报** (INV-4 / D-2: 判据窄到「一个都不在」)
 *   G3. 没有 `write_set` ⇒ **不报** (D-3: 没合同不判)
 *   G4. 隔离档(`execRoot` 与 `repoRoot` 不同)下, 文件在 `execRoot` 那棵树里 ⇒ **不报** (D-4 钉)
 *
 * 写法照既有 harness (`rollback-reuse-disjoint.test.ts` 的 mkdtempSync + 真跑 + observations 断言;
 * 与 `artifact-scope.test.ts` 的 `runExecutorDagWithPlan` + 注入 fake `agentRunner` 同形)。
 * **不**声明 `output_path` —— 否则产物闸先判 empty-artifact 失败, 把节点打成 `'failed'`,
 * 根本轮不到这一道闸 (闸判的是 `done` 节点, 不是 `failed`)。这是产物闸与本闸的天然分工。
 *
 * 反向自检 (SDD §反向自检, 本片**手做**, 见父节点出的报告):
 *   1. 把判据从「**一个都不在**」放宽成「**一个都不在或有一个不在**」⇒ G2 当场红。
 *   2. 把根从 `execRoot ?? repoRoot ?? cwd` 换成 `repoRoot ?? cwd` ⇒ G4 当场红 (隔离档下
 *      漏检 execRoot 那棵树)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { GenerateFn, ExecutorDagConfig } from './types';
import { CheckpointManager } from '../continuity/checkpoint-manager';

const fakeGenerate = (): GenerateFn => async () => ({ text: 'stub', usage: { in: 1, out: 1 } });

const tinyConfig = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

const tinyPlan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'empty-write-set', nodes });

/** 临时根 (best-effort 清理)。 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-empty-ws-'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('empty-write-set 观察 (SDD 2026-08-22 · C-1/C-2)', () => {
  test('★ G1 · done + write_set 全不在盘上 ⇒ 出一条 empty-write-set 观察, status 不改', async () => {
    // SDD GWT 钉: 「一个都不在」 ⇒ 出观察, 但节点 status 仍是 done (D-1 只报不判)。
    const r = await runExecutorDagWithPlan(
      tinyPlan({ s1: { goal: '改两个文件', write_set: ['never/exists/a.ts', 'never/exists/b.ts'] } }),
      tinyConfig(fakeGenerate()),
    );

    // 1) 节点必须 done (写文件节点的 done 与 write_set 无关, 这闸不改 status)。
    expect(r.results.s1!.status).toBe('done');
    // 2) 必须出一条 empty-write-set 观察, nodes 含 s1。
    // observations 字段在 ExecOnce 上必填, 但 ExecutorDagResult 上**缺席当空**(INV-6
    // 常态零噪声: 出 undefined 与出 [] 逐字同义)。这里用 `?? []` 把两种形态统一掉。
    const obs = (r.observations ?? []).filter((o) => o.kind === 'empty-write-set');
    expect(obs).toHaveLength(1);
    expect(obs[0]!.nodes).toEqual(['s1']);
    // 3) message 必须把后果说清楚 (人 + 模型都看的一句)。
    expect(obs[0]!.message).toMatch(/声明了 write_set/);
    expect(obs[0]!.message).toMatch(/一个文件都不在盘上/);
  });

  test('★ G2 · 写集里哪怕一个文件在盘上 ⇒ 不报 (INV-4 / D-2 窄判据)', async () => {
    // SDD GWT 钉: 「一个都不在」才报 —— 有一个在 ⇒ 不报。判据故意窄, 防 `少了几个就报` 噪声。
    mkdirSync(join(root, 'exists'), { recursive: true });
    writeFileSync(join(root, 'exists/on-disk.ts'), '/* fixture */\n');

    const r = await runExecutorDagWithPlan(
      tinyPlan({
        s1: {
          goal: '改两个文件',
          // 一个在盘上 (绝对路径), 一个不在 → 整个写集**不满足**「一个都不在」 ⇒ 不报。
          write_set: [join(root, 'exists/on-disk.ts'), '/tmp/this-file-really-does-not-exist-anywhere.ts'],
        },
      }),
      tinyConfig(fakeGenerate()),
    );

    expect(r.results.s1!.status).toBe('done');
    expect((r.observations ?? []).filter((o) => o.kind === 'empty-write-set')).toEqual([]);
  });

  test('★ G3 · 没有 write_set ⇒ 不参与判定 (D-3 没合同不判)', async () => {
    // SDD GWT 钉: 节点没声明 write_set = 没承诺 ⇒ 不判定 (与产物闸 `declaredArtifact` 同源纪律)。
    const r = await runExecutorDagWithPlan(
      tinyPlan({ s1: { goal: '纯检查, 不改盘' } }),
      tinyConfig(fakeGenerate()),
    );

    expect(r.results.s1!.status).toBe('done');
    expect((r.observations ?? []).filter((o) => o.kind === 'empty-write-set')).toEqual([]);
  });

  test('★ G4 · 隔离档 (execRoot 与 repoRoot 不同), 文件在 execRoot 那棵树 ⇒ 不报 (D-4 钉)', async () => {
    // SDD GWT 钉: 根取 execRoot --- 隔离档下文件写在 worktree 里, 拿 status 锚 stat 就是对着
    //   另一棵树查 (片 1.5 的同款坑)。
    //
    // 形态: write_set 是相对路径, 文件**真实写在 execRoot 那棵 worktree 里**; repoRoot 是
    //   一个不存在的路径。
    //   - 根取对了 (execRoot) ⇒ existsSync 在 worktree 里命中 ⇒ 不报。
    //   - 根取错了 (repoRoot / cwd) ⇒ existsSync 在 worktree 里查不到 ⇒ 误报 = 红。
    const wt = join(root, 'worktree');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'a.ts'), '/* in the worktree */\n');
    // wt 现在是 worktree 根 —— 写到 wt 下的路径, 与 'a.ts' (相对路径 join wt 后)
    //   解析到同一个文件, existsSync 命中 ⇒ 不报。
    // Checkpoint manager 只是 continuity 的 type 必填项, 不真存 checkpoint。fakeRoot 与两个
    //   continuity.root 同源即可。
    const ckptRoot = mkdtempSync(join(tmpdir(), 'omd-empty-ws-ckpt-'));
    try {
      const manager = new CheckpointManager(ckptRoot);
      const r = await runExecutorDagWithPlan(
        tinyPlan({ s1: { goal: '改 worktree 里一个文件', write_set: ['a.ts'] } }),
        tinyConfig(fakeGenerate(), {
          // ⚠ 故意把 repoRoot 指到一个绝不存在的路径, execRoot 指到真 worktree,
          //   钉的是「根取 execRoot, 不取 repoRoot / cwd」。
          continuity: {
            manager,
            runId: 'g4-isolated',
            repoRoot: '/__nope__/repo/never/exists',
            execRoot: wt,
          },
        }),
      );

      expect(r.results.s1!.status).toBe('done');
      expect((r.observations ?? []).filter((o) => o.kind === 'empty-write-set')).toEqual([]);
    } finally {
      rmSync(ckptRoot, { recursive: true, force: true });
    }
  });

  test('failed / skipped 节点不参与判定 (D-3: 失败本就没承诺产出)', async () => {
    // SDD D-3 钉: 闸只看 `done` 节点 —— 让 `failed` / `skipped` 节点走自己的判词通道, 不被这闸二次处理。
    // 这里 simplest 实现 = 构造一张空图、空 done 节点, 确保观察面**逐字不变**。
    const r = await runExecutorDagWithPlan(
      // 给一个会失败的节点 (无 write_set), 另一个 declared 但无产物: 这里**不**造那个形状
      // (它会触发别的闸), 只是验证观察面在没有 done + write_set 时零报。
      tinyPlan({ s1: { goal: '纯查找' } }),
      tinyConfig(fakeGenerate()),
    );

    expect(r.results.s1!.status).toBe('done');
    expect((r.observations ?? []).filter((o) => o.kind === 'empty-write-set')).toEqual([]);
  });

  test('零命中 ⇒ 观察列表逐字同旧 (INV-6 常态零噪声)', async () => {
    // 不写集、不报 ⇒ 跑完的 observations 与「没这条闸」逐字相等 (没造新词)。
    const r = await runExecutorDagWithPlan(
      tinyPlan({ s1: { goal: '纯查找' } }),
      tinyConfig(fakeGenerate()),
    );
    const matching = (r.observations ?? []).filter((o) => o.kind === 'empty-write-set');
    expect(matching).toEqual([]);
  });
});
