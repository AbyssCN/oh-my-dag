/**
 * 评论裁决折入契约 (第五程): owner 过滤 / 最后一条生效 / 幂等锚 / 折入分发。
 */
import { describe, expect, test } from 'bun:test';
import type { PathBackend, OwnerCommand } from './backend';
import { reflowOwnerCommands } from './afk-hook';

const fakeBackend = (cmds: OwnerCommand[], over: Partial<PathBackend> = {}): { b: PathBackend; ruled: string[][] } => {
  const ruled: string[][] = [];
  const b = {
    kind: 'gh',
    listMaps: () => [],
    readMap: () => null,
    createMap: () => { throw new Error('x'); },
    addTicket: () => { throw new Error('x'); },
    rule: (_c: string, _s: string, id: string, ruling: string) => { ruled.push([id, ruling]); },
    markDelivered: () => {},
    collectResearchResults: () => [],
    ackResearchResult: () => {},
    collectOwnerCommands: () => cmds,
    ...over,
  } as unknown as PathBackend;
  return { b, ruled };
};

describe('reflowOwnerCommands', () => {
  test('/rule → backend.rule, 裁决=评论原文逐字', () => {
    const { b, ruled } = fakeBackend([{ ticketId: '#7', command: 'rule', text: '按方案A, 预算 $10' }]);
    const out = reflowOwnerCommands(b, '/tmp', '1');
    expect(ruled).toEqual([['#7', '按方案A, 预算 $10']]);
    expect(out[0]).toMatchObject({ ticketId: '#7', applied: true });
  });

  test('confirm 而后端未实装 confirmSuggestion → 搁置不炸 (warn 行)', () => {
    const { b, ruled } = fakeBackend([{ ticketId: '#8', command: 'confirm-accept', text: '' }]);
    const out = reflowOwnerCommands(b, '/tmp', '1');
    expect(ruled).toEqual([]);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.note).toContain('未实装');
  });

  test('rule 抛错 → 该条失败不拖垮其余', () => {
    const { b, ruled } = fakeBackend(
      [
        { ticketId: '#7', command: 'rule', text: 'x' },
        { ticketId: '#9', command: 'rule', text: 'y' },
      ],
      { rule: (_c, _s, id, r) => { if (id === '#7') throw new Error('炸'); (b as never as { _r: string[][] }); ruledPush(id, r); } } as never,
    );
    // 简化: 用可抛错的 rule 变体
    const calls: string[][] = [];
    function ruledPush(id: string, r: string) { calls.push([id, r]); }
    const out = reflowOwnerCommands(b, '/tmp', '1');
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.note).toContain('折入失败');
    expect(out[1]!.applied).toBe(true);
    void ruled;
  });

  test('md 后端 (无 collectOwnerCommands) → 空, 零副作用', () => {
    const { b } = fakeBackend([], { collectOwnerCommands: undefined } as never);
    expect(reflowOwnerCommands(b, '/tmp', '1')).toEqual([]);
  });

  test('/rule 空正文 → 忽略 (不落空裁决)', () => {
    const { b, ruled } = fakeBackend([{ ticketId: '#7', command: 'rule', text: '' }]);
    const out = reflowOwnerCommands(b, '/tmp', '1');
    expect(ruled).toEqual([]);
    expect(out[0]!.note).toContain('空正文');
  });
});

// ── gh 侧收集: owner 过滤 / 最后一条 / 幂等锚 (fakeGh, 永不真调) ───────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackend, type GhResult, type GhRunner } from './backend';

const okr = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: '' });
const fakeGh = (graphql: string): GhRunner => (args) => {
  if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
  if (args.includes('graphql')) return okr(graphql);
  return okr('[]');
};

const mapWith = (subs: object[]): string =>
  JSON.stringify({ data: { repository: { issue: { number: 1, title: '🧭 [map] X', body: 'Destination: X', state: 'OPEN', subIssues: { nodes: subs } } } } });

describe('gh collectOwnerCommands', () => {
  test('只认 owner(acme) 本人; 取最后一条; 非 open 票 (幂等锚) 不收', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'oc-'));
    const graphql = mapWith([
      {
        number: 7, title: '[task] a', body: '', state: 'OPEN',
        labels: { nodes: [{ name: 'path:task' }] },
        comments: { nodes: [
          { body: '/rule 路人的指令', author: { login: 'stranger' } },     // 非 owner → 忽略
          { body: '/rule 第一版', author: { login: 'acme' } },
          { body: '随便聊天', author: { login: 'acme' } },                 // 非指令 → 忽略
          { body: '/rule 最终版', author: { login: 'acme' } },             // 最后一条生效
        ] },
        subIssues: { nodes: [] },
      },
      {
        number: 8, title: '[task] b', body: '', state: 'CLOSED',           // 非 open → 幂等锚, 不收
        labels: { nodes: [{ name: 'path:task' }] },
        comments: { nodes: [{ body: '/rule 已裁过的', author: { login: 'acme' } }] },
        subIssues: { nodes: [] },
      },
      {
        number: 9, title: '[task] c', body: '', state: 'OPEN',
        labels: { nodes: [{ name: 'path:task' }] },
        comments: { nodes: [{ body: '/confirm accept', author: { login: 'acme' } }] },
        subIssues: { nodes: [] },
      },
    ]);
    const b = resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'gh' }, gh: fakeGh(graphql) });
    const cmds = b.collectOwnerCommands!(cwd, '1');
    expect(cmds).toEqual([
      { ticketId: '#7', command: 'rule', text: '最终版' },
      { ticketId: '#9', command: 'confirm-accept', text: '' },
    ]);
    rmSync(cwd, { recursive: true, force: true });
  });
});
