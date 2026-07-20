/**
 * pathfinder MCP 工具面测试: 全链 map→add→rule→deliver 在临时 cwd 上走通 (fake executeSlice,
 * 永不真跑模型/真 spawn); 交付语义与 TUI 同款 (全节点 done 才翻 delivered, 失败可重试)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPathfinderTools, type PathfinderToolDeps } from './pathfinder';

function tools(cwd: string, overrides: Partial<PathfinderToolDeps> = {}) {
  const deps: PathfinderToolDeps = {
    cwd,
    env: {},
    models: { conductorModel: '', leafModel: 'fake:leaf' },
    agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
    commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 })) as PathfinderToolDeps['commandRunner'],
    dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
    ...overrides,
  };
  const list = createPathfinderTools(deps);
  const byName = new Map(list.map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await byName.get(name)!.handler(args as never, {} as never)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  return { call };
}

describe('pathfinder MCP tools', () => {
  test('map→add→rule→deliver 全链: 区域报信 → 显式交付 → 票翻 delivered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async (plan: { nodes: Record<string, unknown> }) => {
          executed++;
          return {
            results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])),
          };
        }) as unknown as PathfinderToolDeps['executeSlice'],
      });

      expect((await call('path_map')).text).toContain('无开放地图');
      expect((await call('path_map', { destination: 'Ship X' })).text).toContain('slug=ship-x');

      const add = await call('path_add', { title: 'build the thing', type: 'task' });
      expect(add.text).toContain('✓ 已加票 t1');

      const rule = await call('path_rule', { ticketId: 't1', ruling: 'do it with bun' });
      expect(rule.text).toContain('✓ 已裁 t1');
      expect(rule.text).toContain('path_deliver'); // 区域散尽只报信
      expect(executed).toBe(0); // rule 绝不执行

      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(false);
      expect(executed).toBe(1);
      expect(deliver.text).toContain('已交付');
      expect(deliver.text).toContain('delivered=1');

      // 已交付区域不复入: 再 deliver 无可交付。
      const again = await call('path_deliver');
      expect(again.isError).toBe(true);
      expect(executed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deliver 失败不标记: 有节点未 done → isError, 票保持 ruled 可重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir, {
        executeSlice: (async () => ({ results: { t1: { status: 'failed' } } })) as unknown as PathfinderToolDeps['executeSlice'],
      });
      await call('path_map', { destination: 'Ship X' });
      await call('path_add', { title: 'build', type: 'task' });
      await call('path_rule', { ticketId: 't1', ruling: 'go' });
      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(true);
      expect(deliver.text).toContain('未标记交付');
      // 仍可交付 (票还是 ruled)。
      expect((await call('path_tickets')).text).toContain('ruled=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('slug 歧义: 多图省略 slug → 报错列 slug; blockedBy 引用不存在 → 拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir);
      await call('path_map', { destination: 'Ship X' });
      await call('path_map', { destination: 'Ship Y' });
      const amb = await call('path_tickets');
      expect(amb.isError).toBe(true);
      expect(amb.text).toContain('ship-x');
      const bad = await call('path_add', { title: 'x', slug: 'ship-x', blockedBy: ['nope'] });
      expect(bad.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
