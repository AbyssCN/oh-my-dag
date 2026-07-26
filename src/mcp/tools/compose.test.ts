import { describe, expect, test } from 'bun:test';
import { createComposeTools, primitivePlan } from './compose';
import { GRAPH_SHAPES } from '../../harness/shapes';

// 组合模式入口 (2026-07-26): 原语 + 图式递到图外。
// 这些闸守的是"它别悄悄长出第二条执行路径"和"图式知识别在组合模式下蒸发"。

const fakeRun = (out = 'RESULT') =>
  async () => ({ results: { p: { status: 'done', output: out } }, usage: {} });

const tools = (run = fakeRun()) => createComposeTools({ runPlan: run as never, baseConfig: {} });
const byName = (n: string) => tools().find((t) => t.name === n)!;

describe('omd_primitive', () => {
  test('包成单节点 plan —— 复用图内机器, 不新建执行路径', () => {
    const p = primitivePlan('judge', { attempts: 3 }, 'a:b') as unknown as {
      nodes: Record<string, Record<string, unknown>>;
      outputs: string[];
    };
    expect(p.nodes.p!.kind).toBe('primitive');
    expect(p.nodes.p!.primitive).toBe('judge');
    expect(p.nodes.p!.model).toBe('a:b');
    expect(p.outputs).toEqual(['p']);
  });

  test('省略 model → 节点不带 model 字段 (交给 stamp 按档位分配)', () => {
    const p = primitivePlan('parallel', { goals: ['x'] }) as unknown as { nodes: Record<string, Record<string, unknown>> };
    expect('model' in p.nodes.p!).toBe(false);
  });

  test('未知原语 → isError, 且把可选项列出来', async () => {
    const r = (await (byName('omd_primitive').handler as never as (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>)({
      primitive: 'nope',
      params: {},
    }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('parallel');
  });

  test('escape-hatch 刻意不可组合调用 (gated 最后手段, 不该被顺手调到)', async () => {
    const r = (await (byName('omd_primitive').handler as never as (a: unknown) => Promise<{ isError?: boolean }>)({
      primitive: 'escape-hatch',
      params: {},
    }));
    expect(r.isError).toBe(true);
  });

  test('成功 → 回原语输出', async () => {
    const r = (await (byName('omd_primitive').handler as never as (a: unknown) => Promise<{ content: { text: string }[] }>)({
      primitive: 'verify',
      params: { claim: 'x' },
    }));
    expect(r.content[0]!.text).toBe('RESULT');
  });
});

describe('omd_shapes', () => {
  test('不传 id → 全部 shape (组合模式下形状知识的唯一来源)', async () => {
    const r = (await (byName('omd_shapes').handler as never as (a: unknown) => Promise<{ content: { text: string }[] }>)({}));
    const parsed = JSON.parse(r.content[0]!.text) as { id: string }[];
    expect(parsed.length).toBe(GRAPH_SHAPES.length);
    expect(parsed.every((s) => 'whenNot' in s)).toBe(true); // 反例必须一起递出去
  });

  test('传 id → 单条; 未知 id → isError 且列可选项', async () => {
    const h = byName('omd_shapes').handler as never as (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    expect(JSON.parse((await h({ id: 'ui-evidence' })).content[0]!.text).enforced).toContain('evidence pass');
    const bad = await h({ id: 'zzz' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('one-decision-then-fanout');
  });
});
