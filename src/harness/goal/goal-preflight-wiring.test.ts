/**
 * runGoal 入口直调 ignitionPreflight 测试 (t-gate-inmigrate 票 SDD 切片 5+7)。
 *
 * 三闸副本挂点 = runGoalInner 入口直调。CLI / MCP / TUI-via-MCP 三入口自动获得同闸。
 * 默认配置兜底: 调用方未传三字段 → 从 `<root>/.omd/preflight.json` 读;再缺席 → 闸段缺席。
 *
 * **反向自检注释原文**(SDD 切片 5):
 *   - 把 `runGoalInner` 入口的 `ignitionPreflight(...)` 调用删掉 → R-W-① 用例红
 *   - 把 `.omd/preflight.json` 加载逻辑改成缺席 → R-W-① 红但 R-W-② 仍绿
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import { appendBoard, readBoard } from '../board/run-board';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ConductorPlan } from '../conductor-plan';
import { appendBoard as ab2 } from '../board/run-board'; // ensure import (single source)

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-goal-preflight-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 闸 A 草案字符串(与 night.sh L42 同款)。 */
const DRAFT_MARKER = '草案,待 owner 签字';

/** 最小化 cfg: 不传 freezeCheck / seatExpectations / exclusiveLocks。 */
const minimalCfg = (root: string, extra: Partial<RunGoalConfig> = {}): RunGoalConfig => ({
  cwd: root,
  dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
  _today: () => '2026-07-28',
  ...extra,
});

/** 默认 `_runDag` 替身:不真跑分类,直接返个空 contract/execute。 */
const noopRunDag = (async (_plan: ConductorPlan): Promise<ExecutorDagResult> => ({
  plan: { name: 'goal-contract', nodes: {} },
  results: {},
} as unknown as ExecutorDagResult)) as RunGoalConfig['_runDag'];

describe('runGoal 入口直调 ignitionPreflight (R-W-④)', () => {
  test('R-W-①: 默认 .omd/preflight.json 含闸 A 草案 → runGoal 抛 IgnitionBlockedError', async () => {
    const root = freshRoot();
    // 写默认配置
    const dir = join(root, '.omd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'preflight.json'),
      JSON.stringify({
        freezeCheck: { files: [{ path: 'docs/plan/autoresearch-objective.md', draftMarker: DRAFT_MARKER }] },
      }),
      'utf8',
    );
    // 写含草案 marker 的目标向量文件
    mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan', 'autoresearch-objective.md'), `${DRAFT_MARKER}\n`, 'utf8');

    // 不传 freezeCheck → 期望默认加载触发闸 A → 抛 IgnitionBlockedError
    let thrown: unknown = null;
    try {
      await runGoal('任何目标', minimalCfg(root, { _runDag: noopRunDag }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).name).toBe('IgnitionBlockedError');
    expect((thrown as Error).message).toContain('autoresearch-objective.md');
    expect((thrown as Error).message).toContain('草案,待 owner 签字');
  });

  test('R-W-②: 显式注入空 freezeCheck → 闸段缺席, 不抛 IgnitionBlockedError', async () => {
    const root = freshRoot();
    // 写默认配置(也含闸 A 草案 marker)—— 应被显式空覆盖
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'preflight.json'),
      JSON.stringify({
        freezeCheck: { files: [{ path: 'docs/plan/x.md', draftMarker: DRAFT_MARKER }] },
      }),
      'utf8',
    );
    mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan', 'x.md'), `${DRAFT_MARKER}\n`, 'utf8');

    // 显式注入空 freezeCheck → 闸 A 缺席
    const cfg: RunGoalConfig = minimalCfg(root, {
      freezeCheck: { files: [] },
      _runDag: noopRunDag,
    });
    // 不应抛 IgnitionBlockedError(可能因其它原因抛错,但绝不能是它)
    let ignitionBlocked = false;
    try {
      await runGoal('任何目标', cfg);
    } catch (e) {
      if ((e as Error).name === 'IgnitionBlockedError') ignitionBlocked = true;
    }
    expect(ignitionBlocked).toBe(false);
  });

  test('R-W-③: 闸 A 拒 → 抛 IgnitionBlockedError 且板上零条目(claim 之前抛不造 terminal)', async () => {
    const root = freshRoot();
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'preflight.json'),
      JSON.stringify({
        freezeCheck: { files: [{ path: 'docs/plan/x.md', draftMarker: DRAFT_MARKER }] },
      }),
      'utf8',
    );
    mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan', 'x.md'), `${DRAFT_MARKER}\n`, 'utf8');

    let thrown: unknown = null;
    try {
      await runGoal(
        '任何目标',
        minimalCfg(root, {
          // runId 经 dag.sessionId 钉死 (RunGoalConfig 无顶层 sessionId; 见 run-goal 的 boardRunId 链)
          dag: { conductorModel: 'c:m', leafModel: 'l:m', sessionId: 'sess-preflight-block' } as ExecutorDagConfig,
          _runDag: noopRunDag,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).name).toBe('IgnitionBlockedError');
    // 既有不变量 (run-goal.test.ts「claim 之前抛 → 板上零条目」) 覆盖闸拒:
    // 闸在烧 token 之前拒, run 没「点过火」, 板上不该有任何条目;拒因走异常 message。
    expect(readBoard(root).filter((e) => e.runId === 'sess-preflight-block')).toEqual([]);
    expect((thrown as Error).message.length).toBeGreaterThan(0);
  });

  test('R-W-闸 B 拒 → runGoal 抛 IgnitionBlockedError (seatExpectations)', async () => {
    const root = freshRoot();
    // 显式注入同族 seatExpectations(verifier = conductor)
    const cfg: RunGoalConfig = minimalCfg(root, {
      seatExpectations: { conductor: 'minimax-cn:MiniMax-M3', verifier: 'minimax-cn:MiniMax-M3' },
      _runDag: noopRunDag,
    });
    let thrown: unknown = null;
    try {
      await runGoal('任何目标', cfg);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).name).toBe('IgnitionBlockedError');
  });

  test('R-W-闸 C 拒 → runGoal 抛 IgnitionBlockedError (exclusiveLocks 撞活锁)', async () => {
    const root = freshRoot();
    const lockPath = join(root, '.omd', 'solve-results', 'r1.lock');
    mkdirSync(join(root, '.omd', 'solve-results'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: Date.now() - 5 * 60 * 1000 }), 'utf8');

    const cfg: RunGoalConfig = minimalCfg(root, {
      exclusiveLocks: { resultOut: lockPath },
      _runDag: noopRunDag,
    });
    let thrown: unknown = null;
    try {
      await runGoal('任何目标', cfg);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).name).toBe('IgnitionBlockedError');
    expect((thrown as Error).message).toContain('99999');
    expect((thrown as Error).message).toContain('已在用');
  });

  test('R-W-三字段全缺席 + .omd/preflight.json 不存在 → 闸段缺席, 不抛', async () => {
    const root = freshRoot();
    const cfg: RunGoalConfig = minimalCfg(root, { _runDag: noopRunDag });
    let ignitionBlocked = false;
    try {
      await runGoal('任何目标', cfg);
    } catch (e) {
      if ((e as Error).name === 'IgnitionBlockedError') ignitionBlocked = true;
    }
    expect(ignitionBlocked).toBe(false);
  });

  test('R-W-.omd/preflight.json 形状坏 → warn + 闸段缺席(fail-open)', async () => {
    const root = freshRoot();
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(join(root, '.omd', 'preflight.json'), '{not-json', 'utf8');
    const cfg: RunGoalConfig = minimalCfg(root, { _runDag: noopRunDag });
    let ignitionBlocked = false;
    try {
      await runGoal('任何目标', cfg);
    } catch (e) {
      if ((e as Error).name === 'IgnitionBlockedError') ignitionBlocked = true;
    }
    expect(ignitionBlocked).toBe(false);
  });
});