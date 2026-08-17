/**
 * ticket.writeSet/sddPath 锚往返 (切片 7 后置, 控制面统一 SDD D-3「#ticket 写集」契约):
 *   ① 开票带 writeSet/sddPath → 正文落 `Write-set:` / `Sdd-path:` 锚 (同 Executor-kind 锚同款 fixture)。
 *   ② readMap 读回 → 票带 writeSet/sddPath, 保序无损。
 *   ③ 显式 writeSet: [] → 锚写出空值 + 读回 [] (与缺省区分: NULL≠0)。
 *   ④ 缺省 writeSet/sddPath → 正文无锚 + 读回 undefined (不编空串, 不编默认值)。
 *
 * gh 全程注入 fixture (同 backend-gh.test.ts Executor-kind 锚同款 idiom), 永不真调 gh。
 *
 * 反向自检 (实跑过):
 *   - 把 addTicket 里 `Write-set:` / `Sdd-path:` 行删 → ① 红 (锚没写)
 *   - 把 readMap 的写集解析摘 → ② 红 (读回 undefined); 把 split+filter 改回 `value.split(',')` → ② 也红 (空成员留在数组)
 *   - 把 `writeSet !== undefined` 改回 `writeSet` 短路 → ③ 红 (空数组被当成缺省, 锚没写)
 *   - 把 `if (nt.sddPath)` 改回 `if (nt.sddPath !== undefined)` → ④ 红 (sddPath:'' 也写出空串锚)
 */
import { describe, expect, test } from 'bun:test';
import { createGhBackend } from './backend-gh';
import type { GhResult, GhRunner } from './backend';

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

/** 探测永远成功的 gh runner (owner/repo = acme/repo); 其余调用交给 handler。 */
function fakeGh(handler: (args: string[]) => GhResult): GhRunner {
  return (args) => {
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
    return handler(args);
  };
}

interface SubFixture {
  number: number;
  title: string;
  body?: string;
  state?: string;
  labels?: string[];
  /** 字符串 = 只有正文 (无 createdAt, 老响应形状); 对象 = 带服务端时刻。 */
  comments?: Array<string | { body: string; createdAt: string }>;
}

/** readMap 共用的 GraphQL 响应拼装 (map #5 + 给定 sub-issue)。 */
function mapResp(subs: SubFixture[], mapNumber = 5): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: mapNumber,
          title: '🧭 [map] Ship X',
          body: 'Destination: Ship X',
          state: 'OPEN',
          subIssues: {
            nodes: subs.map((s) => ({
              number: s.number,
              title: s.title,
              body: s.body ?? '',
              state: s.state ?? 'OPEN',
              labels: { nodes: (s.labels ?? []).map((name) => ({ name })) },
              // author=acme (= fakeGh 的 owner), 让 owner 指令过滤天然通过。
              comments: {
                nodes: (s.comments ?? []).map((c) => (typeof c === 'string' ? { body: c, author: { login: 'acme' } } : { ...c, author: { login: 'acme' } })),
              },
              subIssues: { nodes: [] },
            })),
          },
        },
      },
    },
  });
}

// ── ① 写: 带 writeSet/sddPath → 正文锚 (同 Executor-kind 锚同款 fixture) ────────

describe('ticket.writeSet/sddPath 锚 — 写', () => {
  test('addTicket 带 writeSet + sddPath → 正文落 `Write-set:` / `Sdd-path:` 锚', () => {
    const seen: string[][] = [];
    const b = createGhBackend(
      fakeGh((args) => {
        seen.push(args);
        if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/o/r/issues/9');
        if (args[0] === 'issue' && args[1] === 'view') return okr('{"id":"NODE_X"}');
        if (args[0] === 'api') return okr('{"id":"NODE_X"}');
        return okr('[]');
      }),
    );
    b.addTicket('/tmp', '#1', {
      type: 'task',
      title: '带写集票',
      blockedBy: [],
      writeSet: ['src/a.ts', 'src/b.ts'],
      sddPath: 'docs/plan/x.md',
    });
    const create = seen.find((a) => a[0] === 'issue' && a[1] === 'create')!;
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).toContain('Write-set: src/a.ts,src/b.ts');
    expect(body).toContain('Sdd-path: docs/plan/x.md');
  });

  test('addTicket 缺省 writeSet/sddPath → 正文无两锚 (NULL≠0, 不编空串)', () => {
    const seen: string[][] = [];
    const b = createGhBackend(
      fakeGh((args) => {
        seen.push(args);
        if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/o/r/issues/9');
        if (args[0] === 'issue' && args[1] === 'view') return okr('{"id":"NODE_X"}');
        if (args[0] === 'api') return okr('{"id":"NODE_X"}');
        return okr('[]');
      }),
    );
    b.addTicket('/tmp', '#1', { type: 'task', title: '普通票', blockedBy: [] });
    const create = seen.find((a) => a[0] === 'issue' && a[1] === 'create')!;
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).not.toContain('Write-set:');
    expect(body).not.toContain('Sdd-path:');
  });

  test('addTicket 显式 writeSet: [] → 正文落 `Write-set: ` 空值锚 (与缺省区分)', () => {
    const seen: string[][] = [];
    const b = createGhBackend(
      fakeGh((args) => {
        seen.push(args);
        if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/o/r/issues/9');
        if (args[0] === 'issue' && args[1] === 'view') return okr('{"id":"NODE_X"}');
        if (args[0] === 'api') return okr('{"id":"NODE_X"}');
        return okr('[]');
      }),
    );
    b.addTicket('/tmp', '#1', { type: 'task', title: '空写集票', blockedBy: [], writeSet: [] });
    const create = seen.find((a) => a[0] === 'issue' && a[1] === 'create')!;
    const body = create[create.indexOf('--body') + 1]!;
    // 显式空 ≠ 缺省: 锚必须落, 否则读回时分不出"没写"与"写空"。
    expect(body).toMatch(/^Write-set:[ \t]*$/m);
  });
});

// ── ② 读: 读回无损 ──────────────────────────────────────────────────────────────

describe('ticket.writeSet/sddPath 锚 — 读 (往返无损)', () => {
  test('readMap 读回 `Write-set:` / `Sdd-path:` 锚 → writeSet 保序, sddPath 原样', () => {
    const resp = mapResp([{
      number: 40,
      title: '[task] 带写集票',
      body: 'Write-set: src/a.ts,src/b.ts\nSdd-path: docs/plan/x.md',
      labels: ['path:task'],
    }]);
    const b = createGhBackend(fakeGh(() => okr(resp)));
    const t = b.readMap('/tmp', '5')!.tickets[0]!;
    expect(t.writeSet).toEqual(['src/a.ts', 'src/b.ts']);
    expect(t.sddPath).toBe('docs/plan/x.md');
  });

  test('readMap 显式空 `Write-set: ` → writeSet: [] (与缺省区分)', () => {
    const resp = mapResp([{
      number: 41,
      title: '[task] 空写集票',
      body: 'Write-set: ',
      labels: ['path:task'],
    }]);
    const b = createGhBackend(fakeGh(() => okr(resp)));
    const t = b.readMap('/tmp', '5')!.tickets[0]!;
    expect(t.writeSet).toEqual([]);
  });

  test('readMap 无两锚 → writeSet/sddPath = undefined (NULL≠0, 字段缺省不炸)', () => {
    const resp = mapResp([{ number: 42, title: '[task] 普通票', labels: ['path:task'] }]);
    const b = createGhBackend(fakeGh(() => okr(resp)));
    const t = b.readMap('/tmp', '5')!.tickets[0]!;
    expect(t.writeSet).toBeUndefined();
    expect(t.sddPath).toBeUndefined();
  });
});