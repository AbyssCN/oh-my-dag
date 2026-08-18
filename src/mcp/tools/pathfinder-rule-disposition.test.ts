/**
 * path_rule disposition (#161) — execute(默认=既有行为逐字节一致) 与 close(rule + markDelivered
 * 复合路)的语义闸。close 是 slices 不接管的终结裁决 # #123 prototype 票照常进区域 → 误点火
 * 那条路仍由本测试反向钉死 (GWT-1, 证"今天的危险路还在"), close 路是**给它加闸门**而非拆路。
 *
 * 锚 (D-3): close 后 ruling = `[closed-by-ruling] <正文>` — 区分「交付完成」与「裁决终结」,
 * 人/看板据此分辨, 语义不撒谎。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPathfinderTools, readyRegion, type PathfinderToolDeps } from './pathfinder';
import { resolveBackend } from '../../harness/pathfinder/backend';

function makeTools(cwd: string, overrides: Partial<PathfinderToolDeps> = {}) {
  const deps: PathfinderToolDeps = {
    cwd,
    env: { OMD_PATH_BACKEND: 'md' },
    models: { conductorModel: '', leafModel: 'fake:leaf' },
    agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
    commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 })) as PathfinderToolDeps['commandRunner'],
    dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
    resolveBackend: (c: string) => resolveBackend(c, { env: { OMD_PATH_BACKEND: 'md' } }),
    ...overrides,
  };
  const list = createPathfinderTools(deps);
  const byName = new Map(list.map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await byName.get(name)!.handler(args as never, {} as never)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
  };
  return { call, deps };
}

async function openMapAndAddPrototype(
  call: (n: string, a?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
) {
  await call('path_map', { destination: 'Ship X' });
  // #197: prototype 显式 executorKind='goal' (#135 prototype 恒 goal 档; 缺 kind 被 map_add 闸裁)
  await call('path_add', { title: '砸网实验 prototype', type: 'prototype', executorKind: 'goal' });
  return 'p1';
}

describe('path_rule disposition (#161 · 切片 1)', () => {
  test("GWT-1: 缺省 disposition (execute) → ruled 进区域 (反向自检: #123 点火路今天仍在)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rule-disp-'));
    try {
      const { call } = makeTools(dir);
      const id = await openMapAndAddPrototype(call);
      const rule = await call('path_rule', { ticketId: id, ruling: '放弃: 砸网' });
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁');
      const backend = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } });
      const map = backend.readMap(dir, 'ship-x')!;
      const t = map.tickets.find((tk) => tk.id === id)!;
      // 行为与今天逐字节一致 (INV-1):
      expect(t.status).toBe('ruled');
      expect(t.ruling).toBe('放弃: 砸网');
      // 反向自检半: 这条证明危险路今天仍在, 修的是给它加闸门不是偷偷拆路。
      const region = readyRegion(map);
      expect(region).not.toBeNull();
      expect(region!.goals).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GWT-2: disposition='close' → delivered + [closed-by-ruling] 锚 + 区域排除", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rule-disp-'));
    try {
      const { call } = makeTools(dir);
      const id = await openMapAndAddPrototype(call);
      const rule = await call('path_rule', {
        ticketId: id,
        ruling: '放弃: 砸网',
        disposition: 'close',
      });
      expect(rule.isError).toBe(false);
      const backend = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } });
      const map = backend.readMap(dir, 'ship-x')!;
      const t = map.tickets.find((tk) => tk.id === id)!;
      // INV-2 (D-1 + D-3): close 后的票 status=delivered 且 ruling 以 [closed-by-ruling] 开头。
      expect(t.status).toBe('delivered');
      expect(t.ruling?.startsWith('[closed-by-ruling] ')).toBe(true);
      expect(t.ruling).toContain('放弃: 砸网');
      // INV-3 (D-2): readyRegion 排除该票 (delivered 天然被排除; belt+braces 双检)。
      const region = readyRegion(map);
      if (region !== null) {
        expect(region.slice).not.toContain(id);
        expect(region.goals).not.toContain(id);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GWT-3: disposition='execute' 显式传 → 与 GWT-1 行为一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rule-disp-'));
    try {
      const { call } = makeTools(dir);
      const id = await openMapAndAddPrototype(call);
      const rule = await call('path_rule', {
        ticketId: id,
        ruling: 'go',
        disposition: 'execute',
      });
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁');
      const backend = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } });
      const map = backend.readMap(dir, 'ship-x')!;
      const t = map.tickets.find((tk) => tk.id === id)!;
      // INV-1: 显式 'execute' 与缺省同路, ruling 不带前缀。
      expect(t.status).toBe('ruled');
      expect(t.ruling?.startsWith('[closed-by-ruling] ')).toBe(false);
      const region = readyRegion(map);
      expect(region).not.toBeNull();
      expect(region!.goals).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GWT-4: suggested 票 → close 拒 (INV-S1-1, D-4), 票状态不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rule-disp-'));
    try {
      const { call } = makeTools(dir);
      await call('path_map', { destination: 'Ship X' });
      // 走完整后端入图口造 suggested (含 suggestedBy, INV-S1-2 必填):
      const backend = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } });
      const r = backend.suggest!(dir, 'ship-x', [
        { type: 'task', title: '机器建议: 要不要做', suggestedBy: 'run-x' },
      ], { at: '2026-08-17T00:00:00.000Z' });
      expect(r.added.length).toBe(1);
      const sid = r.added[0]!.id;
      const before = backend.readMap(dir, 'ship-x')!.tickets.find((t) => t.id === sid)!.status;
      expect(before).toBe('suggested');
      // close 路也得先 confirm 收件 (D-4):
      const rule = await call('path_rule', {
        ticketId: sid,
        ruling: '通过',
        disposition: 'close',
      });
      expect(rule.isError).toBe(true);
      expect(rule.text).toContain('先 map_confirm');
      // 票未被裁决、仍是 suggested:
      const after = backend.readMap(dir, 'ship-x')!.tickets.find((t) => t.id === sid)!.status;
      expect(after).toBe('suggested');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GWT-5: close 成功的回执含「已终结」与 `closed-by-ruling` 字样 (D-5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rule-disp-'));
    try {
      const { call } = makeTools(dir);
      await call('path_map', { destination: 'Ship X' });
      // #197: prototype 显式 executorKind='goal' (同 openMapAndAddPrototype 一致性)
      await call('path_add', { title: '终结实验 prototype', type: 'prototype', executorKind: 'goal' });
      const rule = await call('path_rule', {
        ticketId: 'p1',
        ruling: '放弃 (CubeSandbox 砸网)',
        disposition: 'close',
      });
      expect(rule.isError).toBe(false);
      // 同 N5「一次正确的 BLOCKED 被念成 failed」纪律: 裁 (execute) 与终结 (close) 必须可分辨。
      expect(rule.text).toContain('已终结');
      expect(rule.text).toContain('closed-by-ruling');
      // 不应再说「✓ 已裁 p1:」(那是 execute 路的话; 防串味)。
      expect(rule.text).not.toMatch(/✓ 已裁 p1:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
