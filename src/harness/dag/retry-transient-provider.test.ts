/**
 * 瞬时 provider 故障的 L0 退避重试 (2026-09-03, code80-p3 首批塌于 MiniMax 529)。
 *
 * 反向自检: 把 engine.ts L0 环里 `cap` 那行的 transient 分支删掉 → ★① 红 (只剩「抛错补一次」= 2 发);
 * 把 `isTransientProviderFailure` 恒 false → ★① 红, ★③ 仍绿。
 * 边界: 只管**抛错**路径 —— 返回 failed 叶 (conductor 展开失败等) 走各自既有契约, engine.test.ts
 * 「transport-error no-retry」钉着那一边 (2026-09-03 第一版把 leaf.output 也算进来, 当场把它翻红)。
 * 配额类 (quota / 配额耗尽) 不算瞬时 —— 60s 内不会好, 重试只加倍花钱。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { isTransientProviderFailure, transientProviderDelayMs, TRANSIENT_PROVIDER_ATTEMPTS } from './retry-domain';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { AgentLeafRunner } from '../leaf-runners';

const OVERLOADED =
  '[agent-leaf] provider 报错 (model=bench:MiniMax-M3): 529: {"type":"overloaded_error","message":"当前服务集群负载较高，请稍后重试 (2064)","http_code":529}';

async function runWith(failTimes: number, message: string): Promise<{ status: string | undefined; calls: number; ms: number }> {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-transient-'));
  let calls = 0;
  const plan: ConductorPlan = { name: 'p', nodes: { W: { goal: '干活', executor: 'agent' } } };
  const agentRunner: AgentLeafRunner = (async () => {
    calls += 1;
    if (calls <= failTimes) throw new Error(message);
    return { text: '做完了。', usage: { in: 1, out: 1 }, filesTouched: [], cwd };
  }) as unknown as AgentLeafRunner;
  const generate: GenerateFn = (async () => ({ text: 'x', usage: { in: 0, out: 0 } })) as unknown as GenerateFn;
  const config = { cwd, agentRunner, generate, leafModel: 'test:leaf' } as unknown as ExecutorDagConfig;
  const t0 = Date.now();
  try {
    const r = await runExecutorDagWithPlan(plan, config);
    return { status: r.results.W?.status, calls, ms: Date.now() - t0 };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('瞬时 provider 故障 → L0 退避重试', () => {
  test('★① 529 overloaded 两发失败、第三发成功 → done, 恰 3 次调用 (此前: 2 发即 failed)', async () => {
    process.env.OMD_PROVIDER_RETRY_BASE_MS = '0';
    const r = await runWith(2, OVERLOADED);
    expect(r.calls).toBe(TRANSIENT_PROVIDER_ATTEMPTS);
    expect(r.status).toBe('done');
  });

  test('★② 恒 529 → 三发用尽后 failed (不无限重试), 且真等了退避 (base 30ms → 30 + 90)', async () => {
    process.env.OMD_PROVIDER_RETRY_BASE_MS = '30';
    const r = await runWith(99, OVERLOADED);
    expect(r.calls).toBe(TRANSIENT_PROVIDER_ATTEMPTS);
    expect(r.status).toBe('failed');
    expect(r.ms).toBeGreaterThanOrEqual(110);
  });

  test('★③ 非瞬时抛错 (401) → 维持「抛错补一次」= 2 发, 不抬预算', async () => {
    process.env.OMD_PROVIDER_RETRY_BASE_MS = '0';
    const r = await runWith(99, '[agent-leaf] provider 报错 (model=x): 401: {"type":"authentication_error"}');
    expect(r.calls).toBe(2);
    expect(r.status).toBe('failed');
  });

  test('分类表: 正例与反例', () => {
    for (const m of [OVERLOADED, 'HTTP 429 Too Many Requests', 'fetch failed', 'read ECONNRESET', '503 Service Unavailable', 'rate limit exceeded']) {
      expect(isTransientProviderFailure(m)).toBe(true);
    }
    for (const m of [undefined, '', '401 unauthorized', '404 model not found', 'Unsupported parameter: reasoning', '400 bad request 529 mentioned', '429 insufficient_quota', '模拟 429 配额耗尽']) {
      expect(isTransientProviderFailure(m)).toBe(false);
    }
  });

  test('退避: base × 3^attempt, 封顶 60s, env 每次读', () => {
    process.env.OMD_PROVIDER_RETRY_BASE_MS = '5000';
    expect([0, 1, 2, 5].map(transientProviderDelayMs)).toEqual([5000, 15000, 45000, 60000]);
    process.env.OMD_PROVIDER_RETRY_BASE_MS = '0';
    expect(transientProviderDelayMs(3)).toBe(0);
    delete process.env.OMD_PROVIDER_RETRY_BASE_MS;
    expect(transientProviderDelayMs(0)).toBe(5000);
  });
});
