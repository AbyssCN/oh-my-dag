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
