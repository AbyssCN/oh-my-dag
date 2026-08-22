/**
 * **这一程加的观测位,连起来通不通**(2026-08-06,集成闸)。
 *
 * ## 为什么单独要一条
 *
 * 2026-08-06 这一程在 executor / 留痕层 / 读数板之间加了六七个新观测位
 * (`rollback` · `writeCandidates` · `writeRace` 两档 · `artifactMove` · `detector-wrote` ·
 * `NodeCheckpoint.round` · `DagRunNode.rounds/maxRounds`),**每一个都是单独测的**。
 *
 * 而本仓的教训是 **判据对 ≠ 通道通**(交接 31 §五 第 4 条):⑧.6 那次 10 条判据用例全绿,
 * 端到端那两条才红;同一程后来又发现运行时写竞争**只看得见顶层节点**,子图那一层
 * 一直没接进来 —— 两次都是"每一格都对、连起来没通"。
 *
 * 所以这里跑**一张真图**(fake 模型,零成本):conductor 展开两个并发子节点、都真写文件、
 * 其中一个是 detector,跑完落一行**真账**,然后逐位断言那一行上该有的东西都在。
 *
 * ⚠ 它**刻意不断言具体数值**(那是各自单元测试的活),只断言**这一位有没有被写出来** ——
 *   它要抓的是"接线断了",不是"算错了"。数值断言放这里会让这条闸随口径调整反复变红。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { createDagRecorder } from '../../src/harness/dag/dag-record';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig } from '../../src/harness/dag/types';

/** conductor 子图: 两个**无依赖**的兄弟(会并发)+ 其中一个标 detector。 */
const SUB = JSON.stringify({
  name: 's',
  nodes: {
    w1: { goal: '写产物一', executor: 'agent' },
    chk: { goal: '检查一下', executor: 'agent', detector: true },
  },
});

describe('★ 2026-08-06 那批观测位 · 端到端接线 (判据对 ≠ 通道通)', () => {
  test('真跑一张图 → 真落一行账: 新加的每一位都到得了账本/结果面', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obs-wire-'));
    try {
      const res = await runExecutorDagWithPlan(
        { name: 'outer', nodes: { C: { goal: '干活', executor: 'conductor' } } } as ConductorPlan,
        {
          conductorModel: 'c:m',
          leafModel: 'l:m',
          agentTemplates: new Map(),
          continuity: { manager: new CheckpointManager(root), runId: 'wire-1', repoRoot: root },
          generate: (async () => ({ text: SUB, usage: { in: 1, out: 1 } })) as never,
          agentRunner: async (i: { prompt: string }) => {
            await new Promise((r) => setTimeout(r, 20)); // 让两个兄弟的窗口真重叠
            const isChk = i.prompt.includes('检查');
            writeFileSync(join(root, 'shared.md'), 'x'); // 两个都写同一个文件 = 真竞争
            return {
              text: 'ok',
              usage: { in: 1, out: 1 },
              filesTouched: ['shared.md'],
              // detector 那个也报一次受控写 → ⑤.1 的分子该点亮
              writeEffects: [{ path: 'shared.md', lineDelta: 1, noop: false }],
              // bash 写 → writeCandidates 那一位(盘上核得过, 因为文件真在且刚写)
              shellRuns: [{ command: `echo hi > ${join(root, 'shared.md')}`, exitCode: 0, ok: true }],
              cwd: root,
              ...(isChk ? {} : {}),
            };
          },
        } as unknown as ExecutorDagConfig,
      );

      // ── ① 结果面 ─────────────────────────────────────────────────────────
      // rollback: 起跑时照的那张 git 快照 —— 五态之一, **不许缺席**(缺席 = 那条链没接)
      expect(res.rollback).toBeDefined();
      expect(['clean', 'dirty-tracked', 'dirty-untracked', 'not-a-repo', 'unknown']).toContain(res.rollback!.kind);
      // writeRace: 两档口径都要在 (子图那一层接进来之后才可能非零, 这里只断言"位在")
      expect(res.writeRace).toBeDefined();
      expect(typeof res.writeRace!.pairs).toBe('number');
      expect(typeof res.writeRace!.pairsInferred).toBe('number');
      // artifactMove: 单轮档不会有跨轮比较, 但那三个数**必须被写出来**(缺席 = 没接线)
      expect(res.artifactMove).toBeDefined();

      // ── ② 节点面 ─────────────────────────────────────────────────────────
      const kids = Object.values(res.results).filter((r) => r.id.startsWith('C::'));
      expect(kids.length).toBe(2); // 夹具自证: 子图真展开了
      // writeCandidates: shell 写的可见性那一位 —— 至少一个子节点该有
      expect(kids.some((r) => (r.writeCandidates?.length ?? 0) > 0)).toBe(true);
      // conductor 自己要报内环轮数 (⑧.1 的 ④ 格靠它)
      expect(typeof res.results.C!.rounds).toBe('number');

      // ── ③ checkpoint 面 ──────────────────────────────────────────────────
      const cpDir = join(root, '.omd', 'continuity', 'wire-1');
      const cps = readdirSync(cpDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => JSON.parse(readFileSync(join(cpDir, f), 'utf8')) as { nodeId: string; round?: number });
      // 子图节点的 checkpoint 必须带轮次 (⑧.7 可信面的前提); 顶层 conductor 刻意缺席
      const kidCps = cps.filter((c) => c.nodeId.startsWith('C::'));
      expect(kidCps.length).toBeGreaterThan(0);
      expect(kidCps.every((c) => typeof c.round === 'number')).toBe(true);
      expect(cps.find((c) => c.nodeId === 'C')?.round).toBeUndefined();

      // ── ④ 留痕面 (真写一行账, 再读回来) ──────────────────────────────────
      const db = new Database(':memory:');
      const rec = createDagRecorder({ db });
      const id = rec.record(res, { runId: 'wire-1', entry: 'dag_run' });
      const row = rec.get(id)!;
      expect(row.rollback).toBeDefined(); // D1
      expect(row.writeRace).toBeDefined(); // ⑧.6
      expect(row.writeRace!.pairsInferred).toBeDefined(); // ⑧.6 推断档
      expect(row.artifactMove).toBeDefined(); // ⑧
      const cNode = row.nodes.find((n) => n.id === 'C')!;
      expect(typeof cNode.rounds).toBe('number'); // ⑧.1 ②③④
      expect(typeof cNode.maxRounds).toBe('number');
      // detector 那一位 + 它的写次数 (⑤.1 的分母与分子各自的来源)
      const dNode = row.nodes.find((n) => n.detector === true);
      expect(dNode).toBeDefined();
      expect(dNode!.writeCounts).toBeDefined();
      rec.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
