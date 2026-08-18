/**
 * #167 —— command 节点的绿 checkpoint「只当账不当闸」契约。
 *
 * 事故形状 (run 68cfb43f): accept (command) 红一攻绿一攻, 绿的那攻刻意不落 checkpoint →
 * base 文件只剩红那份, 验尸把一单成功读成「判据红」。修法 = 账诚实 (绿也落) + 闸不动
 * (shouldSkip 对 leafKind 'command' 恒 false, resume 照旧重跑 oracle)。
 * 两半各自可证伪: 删 engine 的 command saveDoneCheckpoint → ①红; 删 shouldSkip 的
 * leafKind 卡 → ③红 (当场验过, 恢复后绿)。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './checkpoint-manager';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from '../dag/types';

const PLAN: ConductorPlan = {
  name: 'p167',
  nodes: { gate: { goal: 'run the oracle', executor: 'command', command: 'echo ok' } },
};

/** 一次性引擎配置: 假 command runner 计数真跑次数。 */
function cfg(root: string, runId: string, resume: boolean, spawns: { n: number }): ExecutorDagConfig {
  return {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    commandRunner: async () => {
      spawns.n++;
      return { text: 'oracle ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 };
    },
    continuity: { manager: new CheckpointManager(root), runId, repoRoot: root, ...(resume ? { resume: true } : {}) },
  } as unknown as ExecutorDagConfig;
}

describe('#167 command 绿 checkpoint: 账诚实, 闸不跳', () => {
  test('① 账: command 节点 done 后 base 文件存在且 status=done (不再只可能 failed/skipped)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const spawns = { n: 0 };
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', false, spawns));
    const base = join(root, '.omd', 'continuity', 'r1', 'gate.json');
    expect(existsSync(base)).toBe(true);
    const cp = JSON.parse(readFileSync(base, 'utf8')) as { status: string; leafKind: string };
    expect(cp.status).toBe('done');
    expect(cp.leafKind).toBe('command');
  });

  test('② 闸: resume 同 runId, command 节点仍真跑 (oracle 不许被绿账跳过)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const spawns = { n: 0 };
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', false, spawns));
    expect(spawns.n).toBe(1);
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', true, spawns));
    expect(spawns.n).toBe(2); // 绿 checkpoint 在盘上, 但 resume 没拿它跳过
  });

  test('③ shouldSkip 单点: command 绿恒 false; 无产物 inproc 绿为 true (对照, 证明尺子本身能跳)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const m = new CheckpointManager(root);
    const base = { outputPaths: [], artifactHashes: {}, tokenUsage: null, summary: 's', durationMs: 0, createdAt: new Date().toISOString(), schemaVersion: 1 as const };
    m.saveCheckpoint('r1', { nodeId: 'gate', leafKind: 'command', status: 'done', ...base });
    m.saveCheckpoint('r1', { nodeId: 'calc', leafKind: 'inproc', status: 'done', ...base });
    expect(m.shouldSkip('r1', 'gate')).toBe(false);
    expect(m.shouldSkip('r1', 'calc')).toBe(true);
  });
});

/**
 * S-43 的**第二张脸**(2026-08-18,run dbfe0c66)—— #167「command 恒不跳」有一个例外。
 *
 * `expect_exit` 非 0 的 command 节点是**基线测量型**:它验的是「**实装前**这条测试会不会红」,
 * 而"实装前"在一个 run 里按定义只存在一次。resume 时重跑它,量的是一个**已经不存在的时刻** ——
 * 读到绿是必然的,而且毫无意义。实盘:`s1-red` / `s3-red` 双双 `[expect_exit 1, 实得 0]`,
 * 于是 `s1`/`s2` 被 dep-skip,整张图塌掉,而实装其实是好的。
 *
 * #167 的理由(「command 便宜且往往就是验收 oracle,重跑比跳过一个闸安全」)对**期望绿**的闸
 * 成立,对**期望红**的闸正好相反 —— 同一条规则,两种语义,不能共用一个出口。
 *
 * 与 `semantic-key.ts` 那条(replan 面)是同一条纪律的两个消费点:S-43 有两张脸,
 * replan 一张、resume 一张,只修一张等于没修。
 */
describe('S-43 第二张脸: expect_exit 非 0 的 command 节点在 resume 时只量一次', () => {
  const RED_PLAN: ConductorPlan = {
    name: 'p43',
    nodes: { red: { goal: '证伪: 实装前必须红', executor: 'command', command: 'bun test x.test.ts', expect_exit: 1 } },
  };

  /** 第一跑红(exit 1 = 满足 expect_exit)、resume 那跑绿(实装已经在树上)—— 正是实盘的形状。 */
  function redThenGreen(root: string, runId: string, resume: boolean, spawns: { n: number }): ExecutorDagConfig {
    return {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentTemplates: new Map(),
      commandRunner: async () => {
        spawns.n++;
        return { text: 'out', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: spawns.n === 1 ? 1 : 0 };
      },
      continuity: { manager: new CheckpointManager(root), runId, repoRoot: root, ...(resume ? { resume: true } : {}) },
    } as unknown as ExecutorDagConfig;
  }

  // 证伪: 把 shouldSkip 里的 baselineGate 例外删掉 → 本条红 (spawns.n 变 2, 且 red 节点判 failed),
  // 读到的正是实盘那个错值 `[expect_exit 1, 实得 0]`。
  test('★ resume 不重跑基线闸: 第一跑红=done, resume 时不再真跑, 也不会被"实得 0"判红', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-s43-'));
    const spawns = { n: 0 };
    const r1 = await runExecutorDagWithPlan(RED_PLAN, redThenGreen(root, 'rr', false, spawns));
    expect(r1.results.red!.status).toBe('done'); // exit 1 == expect_exit 1
    expect(spawns.n).toBe(1);
    const r2 = await runExecutorDagWithPlan(RED_PLAN, redThenGreen(root, 'rr', true, spawns));
    expect(spawns.n).toBe(1); // 没再真跑 —— 那个时刻已经不存在了
    expect(r2.results.red!.status).toBe('done'); // 继承上一代读数, 不是"实得 0"判红
  });

  test('shouldSkip 单点: 基线闸跳, 普通 command 照旧不跳 (#167 一个字没动)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-s43-'));
    const m = new CheckpointManager(root);
    const base = { outputPaths: [], artifactHashes: {}, tokenUsage: null, summary: 's', durationMs: 0, createdAt: new Date().toISOString(), schemaVersion: 1 as const };
    m.saveCheckpoint('rr', { nodeId: 'red', leafKind: 'command', status: 'done', ...base });
    expect(m.shouldSkip('rr', 'red')).toBe(false); // 不声明基线 → 照旧恒不跳
    expect(m.shouldSkip('rr', 'red', undefined, undefined, { baselineGate: true })).toBe(true);
  });
});
