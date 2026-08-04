/**
 * t6 心跳契约 (GWT-T6-1/2/3): dry-run 不执行 deliver / apply 执行且零裁决面调用 / 重入零副作用。
 */
import { describe, expect, test } from 'bun:test';
import { heartbeatOnce, type HeartbeatTools } from './omd-heartbeat';

const make = (region: { slice: string[]; goals: string[] } | null) => {
  const calls: string[] = [];
  const tools: HeartbeatTools = {
    listMaps: () => [{ slug: 'm1' }],
    tickets: async (s) => (calls.push(`tickets:${s}`), '◈ goal 票 p1 回流: 已交付 · runId r1'),
    deliver: async (s) => (calls.push(`deliver:${s}`), '◈ slice "x" 已执行'),
    region: () => region,
  };
  return { tools, calls };
};

describe('heartbeatOnce', () => {
  test('GWT-T6-1: dry-run — 回流执行, deliver 不执行, 输出含 dry-run 与区域', async () => {
    const { tools, calls } = make({ slice: ['t1'], goals: ['p2'] });
    const out = await heartbeatOnce(tools, { apply: false });
    expect(calls).toEqual(['tickets:m1']); // 无 deliver
    expect(out.join('\n')).toContain('dry-run');
    expect(out.join('\n')).toContain('slice 1 张 · goal 1 张');
  });

  test('GWT-T6-2: --apply — deliver 执行; 工具面根本没有 rule/confirm 可调 (INV-T6-1 结构性成立)', async () => {
    const { tools, calls } = make({ slice: ['t1'], goals: [] });
    await heartbeatOnce(tools, { apply: true });
    expect(calls).toEqual(['tickets:m1', 'deliver:m1']);
    // INV-T6-1: HeartbeatTools 接口只有 listMaps/tickets/deliver/region — 裁决面在类型层就不存在。
    expect(Object.keys(tools).sort()).toEqual(['deliver', 'listMaps', 'region', 'tickets']);
  });

  test('GWT-T6-3: 无区域 → 只回流; 重入行为一致 (幂等零新状态)', async () => {
    const { tools, calls } = make(null);
    const a = await heartbeatOnce(tools, { apply: true });
    const b = await heartbeatOnce(tools, { apply: true });
    expect(calls).toEqual(['tickets:m1', 'tickets:m1']); // 两次都只回流
    expect(a).toEqual(b);
  });
});
