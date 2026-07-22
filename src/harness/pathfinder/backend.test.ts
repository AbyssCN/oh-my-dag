/**
 * backend 测试: 解析序 (env>config>md) + fail-loud + gh 读拼装 + gh 写操作 emission。
 * gh 侧全程注入 GhRunner fixture, **永不真调 gh** (dispatch.ts 同款 idiom)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackend, type GhResult, type GhRunner } from './backend';

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });
const failr = (stderr: string): GhResult => ({ stdout: '', exitCode: 1, stderr });

/** 探测永远成功的 gh runner (owner/repo = acme/repo); 其余调用交给 handler。 */
function fakeGh(handler: (args: string[]) => GhResult): GhRunner {
  return (args) => {
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
    return handler(args);
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pf-backend-'));
}

describe('resolveBackend 解析序', () => {
  test('默认 md (无 env 无 config)', () => {
    const dir = tmp();
    try {
      expect(resolveBackend(dir, { env: {} }).kind).toBe('md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('config.json {backend:gh} → gh (探测通过)', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, '.omd', 'pathfinder'), { recursive: true });
      writeFileSync(join(dir, '.omd', 'pathfinder', 'config.json'), JSON.stringify({ backend: 'gh' }));
      const b = resolveBackend(dir, { env: {}, gh: fakeGh(() => okr('[]')) });
      expect(b.kind).toBe('gh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('env OMD_PATH_BACKEND 覆盖 config: env=md 压过 config=gh', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, '.omd', 'pathfinder'), { recursive: true });
      writeFileSync(join(dir, '.omd', 'pathfinder', 'config.json'), JSON.stringify({ backend: 'gh' }));
      expect(resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'md' } }).kind).toBe('md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('env=gh 压过 config=md', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, '.omd', 'pathfinder'), { recursive: true });
      writeFileSync(join(dir, '.omd', 'pathfinder', 'config.json'), JSON.stringify({ backend: 'md' }));
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh: fakeGh(() => okr('[]')) });
      expect(b.kind).toBe('gh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非法 env 值 → fail-loud throw', () => {
    const dir = tmp();
    try {
      expect(() => resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'sqlite' } })).toThrow(/只能是 gh\|md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gh 后端 fail-loud (D-E)', () => {
  test('探测失败 → throw 带修复命令, 绝不退回 md', () => {
    const dir = tmp();
    try {
      const gh: GhRunner = (args) => (args[0] === 'repo' ? failr('gh: not authenticated') : okr(''));
      expect(() => resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh })).toThrow(/gh auth login/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** gh readMap 用的 GraphQL 拼装响应 (map #5: 1 ruled research + 1 blocked task + 1 open grill)。 */
function readMapResponse(): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 5,
          title: '🧭 [map] Ship X',
          body: 'Destination: Ship X',
          state: 'OPEN',
          subIssues: {
            nodes: [
              {
                number: 11,
                title: '[research] survey deps',
                body: '',
                state: 'CLOSED',
                labels: { nodes: [{ name: 'path:research' }] },
                comments: { nodes: [{ body: '**ruling**: use bun native' }] },
                subIssues: { nodes: [{ number: 21 }] },
              },
              {
                number: 12,
                title: '[task] build it',
                body: 'some detail\n\nBlocked-by: #11',
                state: 'OPEN',
                labels: { nodes: [{ name: 'path:task' }] },
                comments: { nodes: [] },
                subIssues: { nodes: [] },
              },
              {
                number: 13,
                title: '[grill] decide shape',
                body: '',
                state: 'OPEN',
                labels: { nodes: [{ name: 'path:grill' }] },
                comments: { nodes: [] },
                subIssues: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  });
}

describe('gh readMap 拼装', () => {
  test('sub-issue → tickets: type/title/blockedBy/ruling/children/status 全拼对', () => {
    const dir = tmp();
    try {
      const gh = fakeGh((args) => (args.includes('graphql') ? okr(readMapResponse()) : okr('[]')));
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      const map = b.readMap(dir, '5')!;
      expect(map.destination).toBe('Ship X');
      expect(map.slug).toBe('5');
      expect(map.tickets).toHaveLength(3);

      const r = map.tickets.find((t) => t.id === '#11')!;
      expect(r.type).toBe('research');
      expect(r.title).toBe('survey deps');
      expect(r.status).toBe('ruled');
      expect(r.ruling).toBe('use bun native');
      expect(r.children).toEqual(['#21']);

      const task = map.tickets.find((t) => t.id === '#12')!;
      expect(task.type).toBe('task');
      expect(task.blockedBy).toEqual(['#11']);
      // #11 已裁 → task 前置满足 → open (deriveStatus 归一)。
      expect(task.status).toBe('open');

      const grill = map.tickets.find((t) => t.id === '#13')!;
      expect(grill.status).toBe('open');

      // decisionsLog 从 ruled 票的 ruling 现拼。
      expect(map.decisionsLog).toEqual([{ ticketId: '#11', gist: 'use bun native' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blockedBy 未满足 → deriveStatus 归一为 blocked', () => {
    const dir = tmp();
    try {
      const resp = JSON.stringify({
        data: {
          repository: {
            issue: {
              number: 7,
              title: '🧭 [map] Y',
              body: '',
              state: 'OPEN',
              subIssues: {
                nodes: [
                  {
                    number: 30,
                    title: '[task] later',
                    body: 'Blocked-by: #99',
                    state: 'OPEN',
                    labels: { nodes: [{ name: 'path:task' }] },
                    comments: { nodes: [] },
                    subIssues: { nodes: [] },
                  },
                ],
              },
            },
          },
        },
      });
      const gh = fakeGh((args) => (args.includes('graphql') ? okr(resp) : okr('[]')));
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      const map = b.readMap(dir, '7')!;
      expect(map.tickets[0]!.status).toBe('blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gh 写操作 emission', () => {
  test('addTicket: issue create + label + addSubIssue mutation', () => {
    const dir = tmp();
    try {
      const calls: string[][] = [];
      const gh = fakeGh((args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/42\n');
        if (args[0] === 'issue' && args[1] === 'view') return okr(JSON.stringify({ id: `NODE_${args[2]}` }));
        if (args.includes('graphql')) return okr(JSON.stringify({ data: { addSubIssue: { issue: { number: 42 } } } }));
        return okr('');
      });
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      const t = b.addTicket(dir, '5', { type: 'task', title: 'do a thing', blockedBy: ['#11'] });

      expect(t.id).toBe('#42'); // D-D: id = issue number 的 #N
      expect(t.type).toBe('task');
      expect(t.blockedBy).toEqual(['#11']);

      const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create')!;
      expect(create).toContain('--title');
      expect(create).toContain('[task] do a thing');
      expect(create).toContain('path:task');
      // blockedBy 落正文尾行 (D-C 单真相)。
      const bodyIdx = create.indexOf('--body');
      expect(create[bodyIdx + 1]).toContain('Blocked-by: #11');
      // sub-issue 挂接: addSubIssue mutation, parent=map #5 node, child=#42 node。
      const mutation = calls.find((c) => c.includes('graphql') && c.some((a) => a.includes('addSubIssue')))!;
      expect(mutation).toContain('parentId=NODE_5');
      expect(mutation).toContain('childId=NODE_42');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rule: comment **ruling** + close', () => {
    const dir = tmp();
    try {
      const calls: string[][] = [];
      const gh = fakeGh((args) => {
        calls.push(args);
        return okr('');
      });
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      b.rule(dir, '5', '#12', 'go with plan A');
      const comment = calls.find((c) => c[1] === 'comment')!;
      expect(comment).toEqual(['issue', 'comment', '12', '--body', '**ruling**: go with plan A']);
      expect(calls.some((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '12')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('markDelivered: 补 path:delivered label (票已由 rule close)', () => {
    const dir = tmp();
    try {
      const calls: string[][] = [];
      const gh = fakeGh((args) => {
        calls.push(args);
        return okr('');
      });
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      b.markDelivered(dir, '5', ['#12', '#13']);
      const edits = calls.filter((c) => c[1] === 'edit');
      expect(edits).toHaveLength(2);
      expect(edits[0]).toEqual(['issue', 'edit', '12', '--add-label', 'path:delivered']);
      expect(edits[1]).toEqual(['issue', 'edit', '13', '--add-label', 'path:delivered']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('createMap: 🧭 [map] title + path:map label, slug = 新 issue number', () => {
    const dir = tmp();
    try {
      const calls: string[][] = [];
      const gh = fakeGh((args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/9\n');
        return okr('');
      });
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      const map = b.createMap(dir, 'Ship Z', 'ship-z');
      expect(map.slug).toBe('9');
      expect(map.destination).toBe('Ship Z');
      const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create')!;
      expect(create).toContain('🧭 [map] Ship Z');
      expect(create).toContain('path:map');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gh 调用非零退出 → fail-loud throw', () => {
    const dir = tmp();
    try {
      const gh = fakeGh((args) => (args[1] === 'create' ? failr('label path:task not found') : okr('')));
      const b = resolveBackend(dir, { env: { OMD_PATH_BACKEND: 'gh' }, gh });
      expect(() => b.addTicket(dir, '5', { type: 'task', title: 'x', blockedBy: [] })).toThrow(/label path:task not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
