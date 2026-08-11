/**
 * backend-gh 切片4 测试 (控制面统一 SDD `docs/plan/2026-08-11-control-plane-unification.md`,
 * D-4 / G-3 / INV-1):
 *   ① `path:suggested` label 映射 (S-1 片 e 的 t5 欠账): 建票带 label · 读回成 suggested 态 ·
 *      confirm 后摘 label (reject = close 且保留 label = 已拒建议, 不再是票)。
 *   ② 冲突以盘为准 + gh 留注记 (G-3 后半): gh 侧被手改 → 下次同步以盘覆盖, 但**先**留冲突注记。
 *
 * gh 全程注入 fixture, **永不真调 gh** (backend.test.ts / dispatch.ts 同款 idiom)。
 */
import { describe, expect, test } from 'bun:test';
import { createGhBackend } from './backend-gh';
import type { GhResult, GhRunner } from './backend';
import type { PathMap } from './types';

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
  comments?: string[];
  updatedAt?: string;
}

/** readMap/syncFromMap 共用的 GraphQL 响应拼装 (map #5 + 给定 sub-issue)。 */
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
              comments: { nodes: (s.comments ?? []).map((body) => ({ body, author: { login: 'acme' } })) },
              subIssues: { nodes: [] },
              ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
            })),
          },
        },
      },
    },
  });
}

/** 记录全部 gh 调用的 runner (graphql 读走 resp, 建票回 #42)。 */
function recording(resp: string, calls: string[][]): GhRunner {
  return fakeGh((args) => {
    calls.push(args);
    if (args.includes('graphql') && args.some((a) => a.startsWith('query='))) return okr(resp);
    if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/42\n');
    if (args[0] === 'issue' && args[1] === 'view') return okr(JSON.stringify({ id: `NODE_${args[2]}` }));
    if (args.includes('graphql')) return okr(JSON.stringify({ data: { addSubIssue: { issue: { number: 42 } } } }));
    return okr('');
  });
}

const AT = '2026-08-11T10:00:00Z';

// ── ① path:suggested label 映射 ────────────────────────────────────────────────

describe('gh suggested label 映射 — 读', () => {
  test('开 issue 带 path:suggested → status=suggested, 溯源/指纹从正文锚回读', () => {
    const resp = mapResp([
      {
        number: 31,
        title: '[research] 查一下 X',
        body: 'Suggested-by: run-42\nFingerprint: abc123',
        labels: ['path:research', 'path:suggested'],
      },
    ]);
    const b = createGhBackend(fakeGh(() => okr(resp)));
    const t = b.readMap('/repo', '5')!.tickets[0]!;
    expect(t.status).toBe('suggested');
    expect(t.suggestedBy).toBe('run-42'); // INV-S1-2: 没有来源的建议不收 → 来源必须往返
    expect(t.fingerprint).toBe('abc123'); // GWT-6 去重要靠它跨 session 生效
  });

  test('已关且仍带 path:suggested = 已拒建议 → 不在图上, 但台账 rejected 行仍收 (INV-S1-3)', () => {
    const resp = mapResp([
      {
        number: 32,
        title: '[task] 被拒的建议',
        state: 'CLOSED',
        labels: ['path:task', 'path:suggested'],
        comments: ['**suggestion-log**: rejected 2026-08-10T00:00:00Z run-7'],
      },
    ]);
    const map = createGhBackend(fakeGh(() => okr(resp))).readMap('/repo', '5')!;
    // 反向自检: 若不认 suggested label, 这张 CLOSED 票会被 baseStatus 读成 ruled 混进图 —— 断言它不在。
    expect(map.tickets).toHaveLength(0);
    expect(map.suggestionsLog).toEqual([{ ticketId: '#32', outcome: 'rejected', at: '2026-08-10T00:00:00Z', runId: 'run-7' }]);
  });

  test('无 path:suggested 的开票照旧 open (存量语义逐字节不变)', () => {
    const resp = mapResp([{ number: 33, title: '[task] 存量票', labels: ['path:task'] }]);
    const t = createGhBackend(fakeGh(() => okr(resp))).readMap('/repo', '5')!.tickets[0]!;
    expect(t.status).toBe('open');
    expect(t.suggestedBy).toBeUndefined();
  });
});

describe('gh suggested label 映射 — 写', () => {
  test('suggest: 建 issue 带 path:<type> + path:suggested 双 label + 溯源/指纹锚 + 挂 sub-issue', () => {
    const calls: string[][] = [];
    const b = createGhBackend(recording(mapResp([]), calls));
    const res = b.suggest!('/repo', '5', [{ type: 'research', title: '查一下 X', suggestedBy: 'run-42' }], { at: AT });

    expect(res.added).toHaveLength(1);
    expect(res.added[0]!.id).toBe('#42'); // D-D: id = issue number (纯核的 s1 内存 id 不外泄)
    expect(res.added[0]!.status).toBe('suggested');

    const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create')!;
    expect(create[create.indexOf('--label') + 1]).toBe('path:research,path:suggested');
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).toContain('Suggested-by: run-42');
    expect(body).toContain('Fingerprint: ');
    // 归属血缘: 挂到 map #5 下 (与 addTicket 同一条 addSubIssue 路径)。
    const mutation = calls.find((c) => c.includes('graphql') && c.some((a) => a.includes('addSubIssue')))!;
    expect(mutation).toContain('parentId=NODE_5');
  });

  test('suggest: 指纹撞既有票 → 不建 issue, 在撞上的票留 deduped 台账评论 (INV-S1-4 沉默去重是缺陷)', () => {
    // 既有票的指纹 = sha256('research\n查一下 X') —— 用纯核算, 避免手抄。
    const { computeFingerprint } = require('./suggest') as typeof import('./suggest');
    const fp = computeFingerprint('research', '查一下 X');
    const resp = mapResp([{ number: 30, title: '[research] 查一下 X', body: `Fingerprint: ${fp}`, labels: ['path:research'] }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const res = b.suggest!('/repo', '5', [{ type: 'research', title: '查一下 X', suggestedBy: 'run-9' }], { at: AT });

    expect(res.added).toHaveLength(0);
    expect(res.deduped).toEqual([{ draftTitle: '查一下 X', hitTicketId: '#30' }]);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'create')).toBe(false);
    const note = calls.find((c) => c[1] === 'comment')!;
    expect(note[2]).toBe('30');
    expect(note[note.indexOf('--body') + 1]).toContain('**suggestion-log**: deduped');
  });

  test('confirm accept: 摘 path:suggested label + 留 accepted 台账评论', () => {
    const resp = mapResp([{ number: 31, title: '[research] 查一下 X', body: 'Suggested-by: run-42', labels: ['path:research', 'path:suggested'] }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const entry = b.confirmSuggestion!('/repo', '5', '#31', 'accept', { at: AT });

    expect(entry).toEqual({ ticketId: '#31', outcome: 'accepted', at: AT, runId: 'run-42' });
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c[2] === '31' && c.includes('--remove-label') && c.includes('path:suggested'))).toBe(true);
    const note = calls.find((c) => c[1] === 'comment')!;
    expect(note[note.indexOf('--body') + 1]).toBe('**suggestion-log**: accepted 2026-08-11T10:00:00Z run-42');
    // INV-1: confirm 是渲染同步, 不在 gh 侧裁决 —— 绝不发裁决评论/关票。
    expect(calls.some((c) => c.some((a) => a.includes('**ruling**')))).toBe(false);
    expect(calls.some((c) => c[1] === 'close')).toBe(false);
  });

  test('confirm accept + 改题: issue 改 title, 台账 outcome=edited', () => {
    const resp = mapResp([{ number: 31, title: '[research] 查一下 X', body: 'Suggested-by: run-42', labels: ['path:research', 'path:suggested'] }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const entry = b.confirmSuggestion!('/repo', '5', '#31', 'accept', { at: AT, title: '改后题' });

    expect(entry.outcome).toBe('edited');
    const edit = calls.find((c) => c[1] === 'edit' && c.includes('--title'))!;
    expect(edit[edit.indexOf('--title') + 1]).toBe('[research] 改后题');
  });

  test('confirm reject: close 且**保留** path:suggested (下次 readMap 不再当票) + rejected 台账', () => {
    const resp = mapResp([{ number: 31, title: '[research] 查一下 X', body: 'Suggested-by: run-42', labels: ['path:research', 'path:suggested'] }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const entry = b.confirmSuggestion!('/repo', '5', '#31', 'reject', { at: AT });

    expect(entry.outcome).toBe('rejected');
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '31')).toBe(true);
    // 保留 label 才分得清「已拒建议」与「已裁票」(两者都是 CLOSED)。
    expect(calls.some((c) => c.includes('--remove-label'))).toBe(false);
    const note = calls.find((c) => c[1] === 'comment')!;
    expect(note[note.indexOf('--body') + 1]).toContain('**suggestion-log**: rejected');
  });

  test('confirm 非 suggested 票 → throw 且零 gh 写 (幂等拒绝: 同票二次 confirm 走这条)', () => {
    const resp = mapResp([{ number: 33, title: '[task] 存量票', labels: ['path:task'] }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    expect(() => b.confirmSuggestion!('/repo', '5', '#33', 'accept', { at: AT })).toThrow(/不是 suggested/);
    expect(calls.some((c) => c[1] === 'comment' || c[1] === 'edit' || c[1] === 'close')).toBe(false);
  });

  test('suggested 票上的 /confirm 照收; /rule 不收 (S-1 GWT-8: 不许跳过人确认直接裁)', () => {
    const confirmResp = mapResp([{ number: 31, title: '[research] X', labels: ['path:research', 'path:suggested'], comments: ['/confirm accept'] }]);
    expect(createGhBackend(fakeGh(() => okr(confirmResp))).collectOwnerCommands!('/repo', '5')).toEqual([
      { ticketId: '#31', command: 'confirm-accept', text: '' },
    ]);
    // 反向自检: 同一张 suggested 票上写 /rule → 一条都不收 (若收, 一次评论就把机器建议裁成了决策)。
    const ruleOnSuggested = mapResp([{ number: 31, title: '[research] X', labels: ['path:research', 'path:suggested'], comments: ['/rule 就这么定'] }]);
    expect(createGhBackend(fakeGh(() => okr(ruleOnSuggested))).collectOwnerCommands!('/repo', '5')).toEqual([]);
    // open 票上的 /rule 照旧收 (存量语义不变)。
    const ruleOnOpen = mapResp([{ number: 31, title: '[research] X', labels: ['path:research'], comments: ['/rule 就这么定'] }]);
    expect(createGhBackend(fakeGh(() => okr(ruleOnOpen))).collectOwnerCommands!('/repo', '5')).toHaveLength(1);
    // 留账: 已摘 label 的票上残留的 /confirm 仍会被收, 下轮 confirmSuggestion 抛「不是 suggested」→
    // reflowOwnerCommands 记 applied:false (不静默, 但每轮一条噪声)。收紧成 label 幂等锚要改
    // owner-commands.test.ts 的既有 fixture (#9: OPEN 无 label 的票期望收 /confirm) —— 本切片写集外。
  });
});

// ── ② G-3 后半: 冲突以盘为准 + gh 留注记 ───────────────────────────────────────

/** 盘上真源 (map-store 读出来的形状; 这里直接给, 本切片不碰 map-store)。 */
function truth(tickets: PathMap['tickets']): PathMap {
  return { destination: 'Ship X', slug: '5', tickets, decisionsLog: [] };
}

describe('G-3 冲突以盘为准 (D-4 单真源 · INV-1)', () => {
  test('gh 手改 (盘 ruled / gh 被 reopen) → 以盘为准 close 回去, 且留冲突注记含两侧状态与时间', () => {
    const resp = mapResp([
      { number: 12, title: '[task] build it', state: 'OPEN', labels: ['path:task'], updatedAt: '2026-08-10T09:00:00Z' },
    ]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const out = b.syncFromMap('/repo', '5', truth([{ id: '#12', type: 'task', title: 'build it', blockedBy: [], status: 'ruled' }]), { at: AT });

    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ ticketId: '#12', mapStatus: 'ruled', ghStatus: 'open', ghUpdatedAt: '2026-08-10T09:00:00Z' });
    // 以盘为准: gh 侧被关回去。
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '12')).toBe(true);
    // 不静默覆盖: 注记含两侧各自认为的状态 + 两侧时间。
    const note = calls.find((c) => c[1] === 'comment')!;
    const body = note[note.indexOf('--body') + 1]!;
    expect(body).toContain('盘: ruled');
    expect(body).toContain('gh: open');
    expect(body).toContain(AT);
    expect(body).toContain('2026-08-10T09:00:00Z');
  });

  test('★反向自检 (G-6): 注记**先于**覆盖发出 —— 覆盖失败也留得下现场', () => {
    // 证伪方式 (实跑过): 把 syncFromMap 里 `run(gh, [issue comment ...])` 那一步删掉 → 本测试与上一条
    // 同时红 (`comment` 调用找不到 → undefined)。即"静默覆盖"这一违规样本确实过不了闸。
    const resp = mapResp([{ number: 12, title: '[task] build it', state: 'OPEN', labels: ['path:task'], updatedAt: '2026-08-10T09:00:00Z' }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    b.syncFromMap('/repo', '5', truth([{ id: '#12', type: 'task', title: 'build it', blockedBy: [], status: 'ruled' }]), { at: AT });
    const noteIdx = calls.findIndex((c) => c[1] === 'comment');
    const closeIdx = calls.findIndex((c) => c[1] === 'close');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(noteIdx);
  });

  test('gh 手改 suggested → 盘上是 delivered: label 与 state 一并纠正回盘', () => {
    const resp = mapResp([{ number: 12, title: '[task] build it', state: 'OPEN', labels: ['path:task', 'path:suggested'], updatedAt: '2026-08-10T09:00:00Z' }]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const out = b.syncFromMap('/repo', '5', truth([{ id: '#12', type: 'task', title: 'build it', blockedBy: [], status: 'delivered' }]), { at: AT });

    expect(out.conflicts[0]).toMatchObject({ mapStatus: 'delivered', ghStatus: 'suggested' });
    expect(calls.some((c) => c[1] === 'close')).toBe(true);
    expect(calls.some((c) => c.includes('--remove-label') && c.includes('path:suggested'))).toBe(true);
    expect(calls.some((c) => c.includes('--add-label') && c.includes('path:delivered'))).toBe(true);
  });

  test('渲染等价的状态差 (盘 blocked/escalated · gh open) → 不算冲突, 零 gh 写 (否则每轮刷注记)', () => {
    const resp = mapResp([
      { number: 12, title: '[task] a', state: 'OPEN', labels: ['path:task'] },
      { number: 13, title: '[task] b', state: 'OPEN', labels: ['path:task'] },
    ]);
    const calls: string[][] = [];
    const b = createGhBackend(recording(resp, calls));
    const out = b.syncFromMap(
      '/repo',
      '5',
      truth([
        { id: '#12', type: 'task', title: 'a', blockedBy: ['#99'], status: 'blocked' },
        { id: '#13', type: 'task', title: 'b', blockedBy: [], status: 'escalated' },
      ]),
      { at: AT },
    );
    expect(out.conflicts).toEqual([]);
    expect(out.synced).toEqual([]);
    expect(calls.some((c) => c[1] === 'comment' || c[1] === 'edit' || c[1] === 'close')).toBe(false);
  });

  test('盘上有票而 gh 无对应 issue → missing 列出 (NULL≠0: 「没镜像」不冒充「一致」)', () => {
    const calls: string[][] = [];
    const b = createGhBackend(recording(mapResp([]), calls));
    const out = b.syncFromMap('/repo', '5', truth([{ id: '#77', type: 'task', title: 'x', blockedBy: [], status: 'open' }]), { at: AT });
    expect(out.missing).toEqual(['#77']);
    expect(out.conflicts).toEqual([]);
    expect(calls.some((c) => c[1] === 'comment')).toBe(false);
  });

  test('map issue 不存在 → fail-loud throw (不静默当作全一致)', () => {
    const b = createGhBackend(fakeGh(() => okr(JSON.stringify({ data: { repository: { issue: null } } }))));
    expect(() => b.syncFromMap('/repo', '5', truth([]), { at: AT })).toThrow(/找不到地图/);
  });
});
