/**
 * 交付物存在性闸 (2026-08-14, plana 夜报回流第 2 条「done 但零交付」)。
 *
 * 实测背景: kaupan-ala 首跑 (6bbab733) 爆窗后大面积级联 skip, runs.db 却记 `done` ——
 * dag_run 完成路径只要不抛错不被叫停一律 succeed, 「跑完了」被当成「交付了」。
 *
 * 反向自检:
 *   · 把 zeroDeliveryReason 的 outputs 分支删掉 → 第 1 条红;
 *   · 把 dag-tools.ts 两个完成闭包里 `zeroDeliveryReason` 的调用删掉 → 接线那条红
 *     (闸函数在而没人调 = 闸不存在, 正是 shellruns 2026-08-12 那次事故的形状)。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zeroDeliveryReason } from './dag-tools';
import type { ExecutorDagResult } from '../../harness/dag/types';

const res = (
  nodes: Record<string, string>,
  outputs?: string[],
): ExecutorDagResult =>
  ({
    plan: { name: 'p', nodes: {}, ...(outputs ? { outputs } : {}) },
    results: Object.fromEntries(
      Object.entries(nodes).map(([id, status]) => [id, { id, status, kind: 'inproc', output: '', deps: [], usage: { in: 0, out: 0 } }]),
    ),
  }) as unknown as ExecutorDagResult;

describe('zeroDeliveryReason (done 必须过交付物存在性检查)', () => {
  test('★ 声明 outputs 而交付节点 skipped → 拦 (点名缺哪个)', () => {
    const r = zeroDeliveryReason(res({ a: 'done', pack: 'skipped' }, ['pack']));
    expect(r).not.toBeNull();
    expect(r!).toContain('pack');
  });

  test('outputs 全 done → 放行 (哪怕别的节点有 failed/skipped)', () => {
    expect(zeroDeliveryReason(res({ a: 'failed', b: 'skipped', pack: 'done' }, ['pack']))).toBeNull();
  });

  test('★ 未声明 outputs 且无一 done (爆窗级联 skip 的形状) → 拦', () => {
    expect(zeroDeliveryReason(res({ a: 'skipped', b: 'skipped', c: 'failed' }))).not.toBeNull();
  });

  test('未声明 outputs 但有 done → 放行 (零回归: 普通图行为不变)', () => {
    expect(zeroDeliveryReason(res({ a: 'done', b: 'failed' }))).toBeNull();
  });
});

describe('接线: 两个完成闭包都过闸 (闸在而没人调 = 闸不存在)', () => {
  test('★ dag-tools 的两个 succeed 点前都调 zeroDeliveryReason', () => {
    const src = readFileSync(join(import.meta.dir, 'dag-tools.ts'), 'utf8');
    const calls = src
      .split('\n')
      .filter((l) => l.includes('zeroDeliveryReason(result)') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    expect(calls.length).toBe(2);
  });
});
