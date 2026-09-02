import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchSeatModels, writeBenchConfig } from './bench-bootstrap';
import { SEATS } from '../src/model/seats';

describe('bench-bootstrap (E1b 容器配置引导)', () => {
  test('★ 全 18 座钉到 bench:<model> (SEATS 真源驱动, 座位增减自动跟)', () => {
    const m = benchSeatModels({ OMD_BENCH_MODEL: 'gpt-x' });
    expect(Object.keys(m).length).toBe(SEATS.length);
    for (const s of SEATS) expect(m[s.id]).toBe('bench:gpt-x');
  });

  test('★ OMD_BENCH_MODEL 缺失 → throw (fail-closed 不写半套)', () => {
    expect(() => benchSeatModels({})).toThrow(/OMD_BENCH_MODEL/);
  });

  test('★ 三角色模式 (owner E2 选型): 指挥/审核/worker 按组分派', () => {
    const m = benchSeatModels({
      OMD_BENCH_CONDUCTOR_MODEL: 'claude-opus-5',
      OMD_BENCH_WORKER_MODEL: 'MiniMax-M3',
      OMD_BENCH_VERIFIER_MODEL: 'gpt-5.6-sol',
    });
    expect(Object.keys(m).length).toBe(SEATS.length);
    for (const id of ['conductor', 'escalation', 'fusion', 'graft']) expect(m[id]).toBe('bench:claude-opus-5');
    for (const id of ['verifier', 'review', 'review-spec']) expect(m[id]).toBe('bench:gpt-5.6-sol');
    for (const id of ['leaf', 'agent', 'judge', 'gate', 'lens']) expect(m[id]).toBe('bench:MiniMax-M3');
  });

  test('★ 四角色模式 (可选): OMD_BENCH_JUDGE_MODEL 给了 → judge 拿独立坐标, 不给 → 与三角色模式逐字相同', () => {
    // 反向自检: 把 JUDGE_SEATS 判断删掉/把 j 恒当 undefined → (a) 这条第一断言红。
    // (a) 四个 env 都给: judge 落到独立第四坐标, 既不等于 verifier 也不等于 leaf(worker)。
    const withJudge = benchSeatModels({
      OMD_BENCH_CONDUCTOR_MODEL: 'claude-opus-5',
      OMD_BENCH_WORKER_MODEL: 'MiniMax-M3',
      OMD_BENCH_VERIFIER_MODEL: 'gpt-5.6-sol',
      OMD_BENCH_JUDGE_MODEL: 'deepseek-v4-pro',
    });
    expect(withJudge.judge).toBe('bench:deepseek-v4-pro');
    expect(withJudge.judge).not.toBe(withJudge.verifier);
    expect(withJudge.judge).not.toBe(withJudge.leaf);

    // (b) 只给原三件套: judge 仍落回 leaf(worker) 坐标 —— 今日行为不变, 与既有「★ 三角色模式」测试逐字一致。
    const withoutJudge = benchSeatModels({
      OMD_BENCH_CONDUCTOR_MODEL: 'claude-opus-5',
      OMD_BENCH_WORKER_MODEL: 'MiniMax-M3',
      OMD_BENCH_VERIFIER_MODEL: 'gpt-5.6-sol',
    });
    expect(withoutJudge.judge).toBe(withoutJudge.leaf);
  });

  test('★ 三角色缺任一 → throw (不写半套)', () => {
    expect(() => benchSeatModels({ OMD_BENCH_CONDUCTOR_MODEL: 'a', OMD_BENCH_WORKER_MODEL: 'b' })).toThrow(/齐给/);
  });

  test('★ OMD_BENCH_MODEL + OMD_BENCH_JUDGE_MODEL 同给, 三件套缺席 → throw (P2 审: 不许静默落单模型分支吞掉 judge)', () => {
    // 反向自检: 把 anyRole 的 `Boolean(c || w || v || j)` 改回不含 j 的版本 → 本条当场绿变红
    // 反面 —— 会静默落进单模型分支, 18 座全钉 gpt-x, OMD_BENCH_JUDGE_MODEL 被吞, 不 throw。
    expect(() =>
      benchSeatModels({ OMD_BENCH_MODEL: 'gpt-x', OMD_BENCH_JUDGE_MODEL: 'deepseek-v4-pro' }),
    ).toThrow(/齐给/);
  });

  test('writeBenchConfig 保留既有其它键, models 整段覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-boot-'));
    try {
      mkdirSync(join(root, '.omd'), { recursive: true });
      writeFileSync(join(root, '.omd', 'config.json'), JSON.stringify({ version: 1, declaredPlans: ['x'], models: { leaf: 'old:m' } }));
      const p = writeBenchConfig(root, { leaf: 'bench:gpt-x' });
      const j = JSON.parse(readFileSync(p, 'utf8'));
      expect(j.declaredPlans).toEqual(['x']);
      expect(j.models).toEqual({ leaf: 'bench:gpt-x' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('既有 config.json 是坏 JSON → 重建且不抛 (证据行走 stderr)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-boot-'));
    try {
      mkdirSync(join(root, '.omd'), { recursive: true });
      writeFileSync(join(root, '.omd', 'config.json'), '{oops');
      const p = writeBenchConfig(root, { leaf: 'bench:gpt-x' });
      expect(JSON.parse(readFileSync(p, 'utf8')).models.leaf).toBe('bench:gpt-x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
