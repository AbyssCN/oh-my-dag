/**
 * 票 id 形状归一 (#206) —— 同一个 id 在三处曾有三种行为。
 *
 * gh 的票 id 是 `#N`, 工具面历来也收裸 `N` (写路 `bareNumber()` 归一), 但**读路是精确匹配**。
 * 2026-08-19 实测: 同一张 suggested 票, `path_rule '#177'` 被守卫拒, 而 `path_rule '177'`
 * **守卫不响且真去 comment + close 了** —— INV-S1-1「suggested 票不许绕过人确认直接裁」
 * 被一个字符串形状绕过去。`map_confirm` 是第三种: 完全不归一, 裸 id 报「票不存在」。
 *
 * 修法在**工具层**解一次 id, 读路写路共用同一个值 (见 `resolveTicketId` 的说明)。
 * 本文件全程注入 fixture, **永不真调 gh**。
 */
import { describe, expect, test } from 'bun:test';
import { createPathfinderTools, resolveTicketId } from './pathfinder';
import { createGhBackend } from '../../harness/pathfinder/backend-gh';
import type { GhResult, GhRunner } from '../../harness/pathfinder/backend';
import type { PathMap } from '../../harness/pathfinder/types';

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

const mapResp = (labels: string[]) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 5,
          title: '🧭 [map] X',
          body: 'Destination: X',
          state: 'OPEN',
          subIssues: {
            nodes: [
              {
                number: 177,
                title: '[task] 建议票',
                body: '',
                state: 'OPEN',
                labels: { nodes: labels.map((name) => ({ name })) },
                comments: { nodes: [] },
                subIssues: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  });

function tools(calls: string[][], labels = ['path:task', 'path:suggested']) {
  const gh: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'a/b' }));
    if (args[0] === 'issue' && args[1] === 'list') return okr(JSON.stringify([{ number: 5, title: '🧭 [map] X' }]));
    if (args.includes('graphql')) return okr(mapResp(labels));
    return okr('');
  };
  return createPathfinderTools({
    cwd: '/tmp',
    env: {},
    models: { conductorModel: '', leafModel: '' },
    resolveBackend: () => createGhBackend(gh),
  } as never);
}

const call = async (name: string, args: Record<string, unknown>, calls: string[][], labels?: string[]) => {
  const t = tools(calls, labels).find((x) => x.name === name)!;
  return (await t.handler(args as never, {} as never)) as { content: { text: string }[]; isError?: boolean };
};
/** 有没有真去写 gh (comment/close/edit 都算写)。 */
const wroteGh = (calls: string[][]): boolean =>
  calls.some((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'close' || c[1] === 'edit'));

describe('#206 票 id 形状归一', () => {
  test('resolveTicketId: 精确 / 去 # 后相等都认; 认不出给 null (不猜)', () => {
    const map = { destination: 'X', slug: '5', decisionsLog: [], tickets: [{ id: '#177', type: 'task', title: 't', blockedBy: [], status: 'open' }] } as unknown as PathMap;
    expect(resolveTicketId(map, '#177')).toBe('#177');
    expect(resolveTicketId(map, '177')).toBe('#177'); // 裸 id 解成盘上真 id
    expect(resolveTicketId(map, ' 177 ')).toBe('#177'); // 顺手收空白
    expect(resolveTicketId(map, '17')).toBeNull(); // **不做前缀模糊** (猜错票比认不出坏)
    expect(resolveTicketId(map, '')).toBeNull();
    expect(resolveTicketId(null, '177')).toBeNull();
  });

  /**
   * ★ 这条是这张票的全部理由: 修之前 `#177` 被拒而 `177` 直接把 suggested 票裁掉并写了 gh。
   * 两种形状必须**同一个结论**。
   */
  test('★ path_rule 拒 suggested 票 —— `#177` 与裸 `177` 结论一致, 且都零 gh 写', async () => {
    for (const id of ['#177', '177']) {
      const calls: string[][] = [];
      const r = await call('path_rule', { ticketId: id, ruling: 'go', slug: '5' }, calls);
      // ★ 反向自检 (已实测会红): 把 makeRule 里的 resolveTicketId 那三行去掉 →
      //   裸 id 那一轮 isError 变 undefined 且 wroteGh 变 true, 两条断言同时红。
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('机器建议');
      expect(wroteGh(calls)).toBe(false);
    }
  });

  test('map_confirm: 裸 id 也认 (此前报「票不存在」—— 同一个 id 两个工具面两种行为)', async () => {
    const calls: string[][] = [];
    const r = await call('map_confirm', { ticketId: '177', action: 'reject', slug: '5' }, calls);
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toContain('rejected');
  });

  test('认不出的 id → 响亮拒, 且零 gh 写 (不静默当没这张票)', async () => {
    for (const name of ['path_rule', 'map_confirm']) {
      const calls: string[][] = [];
      const args = name === 'path_rule' ? { ticketId: '999', ruling: 'go', slug: '5' } : { ticketId: '999', action: 'accept', slug: '5' };
      const r = await call(name, args, calls);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('找不到票');
      expect(wroteGh(calls)).toBe(false);
    }
  });

  test('非 suggested 票: 两种形状都能正常裁 (归一没把好路堵掉)', async () => {
    for (const id of ['#177', '177']) {
      const calls: string[][] = [];
      const r = await call('path_rule', { ticketId: id, ruling: 'go', slug: '5' }, calls, ['path:task']);
      expect(r.isError).not.toBe(true);
      expect(wroteGh(calls)).toBe(true);
    }
  });
});
