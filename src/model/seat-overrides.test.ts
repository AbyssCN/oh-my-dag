/**
 * C4 判据:
 *  ① 无 seats 段: effectiveSeatSampling ≡ seatSampling (byte 级无变化)。
 *  ② 覆盖生效 (整段替换, 非 deep-merge), 且真的走到消费点 (llm-judge 的 gate 采样)。
 *  ③ 未知座位 id 被拒且点名 (座位词表不接受新增)。
 *  ④ 坏条目 issue 命中字段路径。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigIssue } from '../config/issues';
import { makeLlmConvergenceJudge } from '../harness/plan/llm-judge';
import { resetConfigCache } from './role-models';
import { effectiveSeatSampling, readSeatOverrides } from './seat-overrides';
import { ALL_SEAT_IDS, seatSampling } from './seats';

let dirs: string[] = [];
function tmpConfig(content: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-seatov-'));
  dirs.push(d);
  const p = join(d, 'config.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  resetConfigCache();
});

describe('C4 · config.seats 座位采样覆盖', () => {
  test('① 无 seats 段: 每个座位的生效采样与编译期表逐项相等', () => {
    const p = tmpConfig({ models: {} });
    for (const id of ALL_SEAT_IDS) {
      expect(effectiveSeatSampling(id, { configPath: p })).toEqual(seatSampling(id));
    }
  });

  test('② 覆盖生效且是整段替换 (不 deep-merge 编译期字段)', () => {
    const p = tmpConfig({ seats: { gate: { sampling: { temperature: 0.31 } } } });
    expect(effectiveSeatSampling('gate', { configPath: p })).toEqual({ temperature: 0.31 });
    // 未覆盖的座位不受影响
    expect(effectiveSeatSampling('verifier', { configPath: p })).toEqual(seatSampling('verifier'));
  });

  test('② 消费点真生效: llm-judge 的 gate 调用带上覆盖温度', async () => {
    const p = tmpConfig({ seats: { gate: { sampling: { temperature: 0.31 } } } });
    const prevEnv = process.env.OMD_CONFIG_PATH;
    process.env.OMD_CONFIG_PATH = p;
    resetConfigCache();
    try {
      let seenTemp: number | undefined;
      const judge = makeLlmConvergenceJudge<{ ok: boolean }>({
        judgeModel: 'probe:judge',
        task: 't',
        extract: () => ({ status: 'done', summary: 's' }),
        callModelFn: (async (req: { temperature?: number }) => {
          seenTemp = req.temperature;
          return { parsed: { converged: true, score: 1 }, usage: { in: 0, out: 0 } };
        }) as never,
      });
      await judge({ ok: true }, 1);
      expect(seenTemp).toBe(0.31);
    } finally {
      if (prevEnv === undefined) delete process.env.OMD_CONFIG_PATH;
      else process.env.OMD_CONFIG_PATH = prevEnv;
      resetConfigCache();
    }
  });

  test('③ 未知座位 id: 拒 + issue 点名, 不进结果', () => {
    const p = tmpConfig({ seats: { 'no-such-seat': { sampling: { temperature: 0.5 } } } });
    const issues: ConfigIssue[] = [];
    const out = readSeatOverrides({ configPath: p, issues });
    expect(out['no-such-seat']).toBeUndefined();
    expect(issues.some((i) => i.path === 'seats.no-such-seat' && i.message.includes('未知座位 id'))).toBe(true);
  });

  test('④ 坏条目: issue 命中字段路径', () => {
    const p = tmpConfig({ seats: { gate: { sampling: { temperature: 'hot' } } } });
    const issues: ConfigIssue[] = [];
    const out = readSeatOverrides({ configPath: p, issues });
    expect(out.gate?.sampling).toBeUndefined();
    expect(issues.some((i) => i.path === 'seats.gate.sampling.temperature')).toBe(true);
  });
});
