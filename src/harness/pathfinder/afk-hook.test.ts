import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyAfkResult, distill, parseChildren, reflowResearchResults, watchAfkResults, type AfkReflow } from './afk-hook';
import { resolveBackend, type GhResult, type GhRunner } from './backend';
import { createGhBackend } from './backend-gh';
import { researchResultPath } from './dispatch';
import { loadMap, saveMap } from './map-store';
import type { PathMap, Ticket } from './types';

function tk(p: Partial<Ticket> & Pick<Ticket, 'id' | 'type'>): Ticket {
  return { title: p.id, blockedBy: [], status: 'open', ...p };
}

describe('afk-hook — distill', () => {
  test('takes first paragraph, one line, skips heading', () => {
    const md = '# Title\n\nThe store should be markdown-in-git.\n\nMore detail here.';
    expect(distill(md)).toBe('The store should be markdown-in-git.');
  });
  test('stops before ## children section', () => {
    const md = 'Use SQLite as index.\n\n## children\n- [task] build it';
    expect(distill(md)).toBe('Use SQLite as index.');
  });
  test('empty → placeholder', () => {
    expect(distill('   \n\n')).toContain('空');
  });
});

describe('afk-hook — parseChildren', () => {
  test('parses typed + untyped list items (default research)', () => {
    const md = 'body\n\n## children\n- [task] do the thing\n- plain one\n- [grill] lock it\n';
    expect(parseChildren(md)).toEqual([
      { type: 'task', title: 'do the thing' },
      { type: 'research', title: 'plain one' },
      { type: 'grill', title: 'lock it' },
    ]);
  });
  test('no section → []', () => {
    expect(parseChildren('just a body, no children')).toEqual([]);
  });
  test('invalid type falls back to research; stops at next ## heading', () => {
    const md = '## children\n- [bogus] weird\n\n## other\n- not a child';
    expect(parseChildren(md)).toEqual([{ type: 'research', title: 'weird' }]);
  });
});

describe('afk-hook — applyAfkResult (pure)', () => {
  const base: PathMap = {
    destination: 'Ship X',
    slug: 'ship-x',
    tickets: [
      tk({ id: 'r1', type: 'research', title: 'pick a store' }),
      tk({ id: 't2', type: 'task', title: 'build it', blockedBy: ['r1'] }),
    ],
    decisionsLog: [],
  };

  test('rules ticket, distills ruling, appends decisionsLog, computes unblocked', () => {
    const res = applyAfkResult(base, 'r1', 'Markdown-in-git is the truth source.');
    const r1 = res.map.tickets.find((t) => t.id === 'r1')!;
    expect(r1.status).toBe('ruled');
    expect(r1.ruling).toBe('Markdown-in-git is the truth source.');
    expect(res.map.decisionsLog.some((d) => d.ticketId === 'r1')).toBe(true);
    // t2 was blocked by r1 → now unblocked
    expect(res.unblocked).toEqual(['t2']);
    // input map not mutated (purity)
    expect(base.tickets.find((t) => t.id === 'r1')!.status).toBe('open');
  });

  test('parses ## children → adds child tickets blockedBy parent, registers on parent', () => {
    const md = 'Distilled answer.\n\n## children\n- [task] sub build\n- follow-up question';
    const res = applyAfkResult(base, 'r1', md);
    expect(res.newChildren.map((c) => c.id)).toEqual(['r1-c1', 'r1-c2']);
    expect(res.newChildren[0]).toMatchObject({ id: 'r1-c1', type: 'task', title: 'sub build', blockedBy: ['r1'], status: 'open' });
    expect(res.newChildren[1]).toMatchObject({ id: 'r1-c2', type: 'research', title: 'follow-up question' });
    const r1 = res.map.tickets.find((t) => t.id === 'r1')!;
    expect(r1.children).toEqual(['r1-c1', 'r1-c2']);
    // children have no blockers other than r1 (now ruled) → they + t2 are unblocked
    expect(res.unblocked.sort()).toEqual(['r1-c1', 'r1-c2', 't2']);
  });

  test('unknown ticket id → no-op, empty reflow', () => {
    const res = applyAfkResult(base, 'ghost', 'whatever');
    expect(res.map).toBe(base);
    expect(res.newChildren).toEqual([]);
    expect(res.unblocked).toEqual([]);
  });
});

describe('afk-hook — watchAfkResults (once mode)', () => {
  const map: PathMap = {
    destination: 'Ship X',
    slug: 'ship-x',
    tickets: [
      tk({ id: 'r1', type: 'research', title: 'A' }),
      tk({ id: 'r2', type: 'research', title: 'B' }),
      tk({ id: 'r3', type: 'research', title: 'C' }),
    ],
    decisionsLog: [],
  };

  test('applies ready result, fires onReflow + saveMap; ignores not-ready; isolates a bad result', () => {
    const reflows: AfkReflow[] = [];
    const saved: string[] = [];
    const r1Path = researchResultPath('/repo', 'ship-x', 'r1');
    const r2Path = researchResultPath('/repo', 'ship-x', 'r2');
    const r3Path = researchResultPath('/repo', 'ship-x', 'r3');

    watchAfkResults(
      map,
      { cwd: '/repo', mode: 'once' },
      {
        readIfReady: (p) => {
          if (p === r1Path) return 'r1 is done.\n\n## children\n- [task] next';
          if (p === r2Path) return null; // not ready → ignored
          if (p === r3Path) throw new Error('disk exploded'); // bad → isolated
          return null;
        },
        saveMap: (mm) => saved.push(mm.slug),
        onReflow: (r) => reflows.push(r),
      },
    );

    // only r1 landed
    expect(reflows.map((r) => r.ticketId)).toEqual(['r1']);
    expect(reflows[0]!.newChildren.map((c) => c.id)).toEqual(['r1-c1']);
    expect(saved).toEqual(['ship-x']); // persisted once (r1)
  });

  test('interval mode: setInterval injected, stop clears it', () => {
    let intervalFn: (() => void) | null = null;
    let cleared = 0;
    const h = watchAfkResults(
      map,
      { cwd: '/repo', mode: 'interval', intervalMs: 100 },
      {
        readIfReady: () => null,
        setInterval: (fn) => {
          intervalFn = fn;
          return 'HANDLE';
        },
        clearInterval: () => {
          cleared++;
        },
      },
    );
    expect(intervalFn).not.toBeNull();
    h.stop();
    expect(cleared).toBe(1);
  });
});

// ── reflowResearchResults (后端无关折入编排, S3) ─────────────────────────────────

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

/** 探测永远成功的 gh runner (owner/repo = acme/repo); 其余调用交给 handler (backend.test.ts 同款)。 */
function fakeGh(handler: (args: string[]) => GhResult): GhRunner {
  return (args) => {
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
    return handler(args);
  };
}

/** map #5 的 readMap GraphQL 响应, sub-issue #11 = research-done 票 (评论堆由入参给)。 */
function reflowMapResponse(comments: Array<{ body: string }>): string {
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
                state: 'OPEN',
                labels: { nodes: [{ name: 'path:research' }, { name: 'research-done' }] },
                comments: { nodes: comments },
                subIssues: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  });
}

describe('reflowResearchResults — md 后端 (行为等价)', () => {
  test('落盘结果 → 母票 ruled + distill ruling + decisionsLog + 子票挂母票; 再收幂等空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-reflow-md-'));
    try {
      saveMap(
        {
          destination: 'Ship X',
          slug: 'ship-x',
          tickets: [
            { id: 'r1', type: 'research', title: 'pick store', blockedBy: [], status: 'open' },
            { id: 't2', type: 'task', title: 'build', blockedBy: ['r1'], status: 'open' },
          ],
          decisionsLog: [],
        },
        dir,
      );
      const resultPath = researchResultPath(dir, 'ship-x', 'r1');
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, '## 终稿\n\nmarkdown-in-git 作真相源。\n\n## children\n- [task] 实装存储', 'utf8');

      const b = resolveBackend(dir, { env: {} });
      expect(b.kind).toBe('md');
      const outcomes = reflowResearchResults(b, dir, 'ship-x');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ticketId).toBe('r1');
      expect(outcomes[0]!.warning).toBeUndefined();
      expect(outcomes[0]!.newChildren).toHaveLength(1);

      const map = loadMap(dir, 'ship-x')!;
      const r1 = map.tickets.find((t) => t.id === 'r1')!;
      expect(r1.status).toBe('ruled');
      expect(r1.ruling).toBe('markdown-in-git 作真相源。');
      expect(map.decisionsLog.some((d) => d.ticketId === 'r1')).toBe(true);
      const child = outcomes[0]!.newChildren[0]!;
      expect(child.type).toBe('task');
      expect(child.blockedBy).toEqual(['r1']);
      expect(r1.children).toContain(child.id); // parentId → 挂母票血缘

      // r1 已 ruled → 下轮 collect 不再命中 (ack no-op 的幂等锚点 = ruled 状态)。
      expect(reflowResearchResults(b, dir, 'ship-x')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reflowResearchResults — gh 后端', () => {
  test('research-done 票 + 结果评论 → rule + close + 子票建票 + ack 摘 label', () => {
    const calls: string[][] = [];
    const gh = fakeGh((args) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (args.some((a) => a.includes('addSubIssue'))) return okr(JSON.stringify({ data: { addSubIssue: { issue: { number: 30 } } } }));
        return okr(reflowMapResponse([{ body: '## 终稿 (综合判优)\n\n用 bun 原生方案。\n\n## children\n- [task] 实装 bun 方案' }]));
      }
      if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/30\n');
      if (args[0] === 'issue' && args[1] === 'view') return okr(JSON.stringify({ id: `NODE_${args[2]}` }));
      return okr('');
    });
    const b = resolveBackend('/repo', { env: { OMD_PATH_BACKEND: 'gh' }, gh });

    const outcomes = reflowResearchResults(b, '/repo', '5');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ticketId).toBe('#11');
    expect(outcomes[0]!.warning).toBeUndefined();
    expect(outcomes[0]!.newChildren.map((c) => c.id)).toEqual(['#30']); // D-D: 子票 id = 新 issue number
    expect(outcomes[0]!.newChildren[0]).toMatchObject({ type: 'task', title: '实装 bun 方案', blockedBy: ['#11'] });

    // 状态翻转: **ruling** 评论 (distill 后正文) + close。
    expect(calls.find((c) => c[1] === 'comment')).toEqual(['issue', 'comment', '11', '--body', '**ruling**: 用 bun 原生方案。']);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '11')).toBe(true);
    // 子票 create 带 [task] 标题 + Blocked-by 母票。
    const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create')!;
    expect(create).toContain('[task] 实装 bun 方案');
    expect(create[create.indexOf('--body') + 1]).toContain('Blocked-by: #11');
    // ack: 摘 research-done label (幂等锚点)。
    expect(calls.find((c) => c[1] === 'edit' && c.includes('--remove-label'))).toEqual(['issue', 'edit', '11', '--remove-label', 'research-done']);
  });

  test('native 策略: 子票 (blockedBy=[母票]) 走原生依赖 emission, 不写 Blocked-by 尾行', () => {
    const calls: string[][] = [];
    const gh = fakeGh((args) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (args.some((a) => a.includes('addSubIssue'))) return okr(JSON.stringify({ data: { addSubIssue: { issue: { number: 30 } } } }));
        // native 读: reflowMapResponse 的 sub #11 无 blockedBy 字段 → readMap 视作 [] (与本用例无关)。
        return okr(reflowMapResponse([{ body: '## 终稿\n\n用 bun 原生方案。\n\n## children\n- [task] 实装 bun 方案' }]));
      }
      if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/30\n');
      if (args[0] === 'issue' && args[1] === 'view') return okr(JSON.stringify({ id: `NODE_${args[2]}` }));
      // 母票 #11 databaseId lookup。
      if (args[0] === 'api' && /issues\/11$/.test(args[1] ?? '')) return okr('9110\n');
      return okr('');
    });
    // config 门写 native; createGhBackend(gh, true) 直构 (探测走 fakeGh)。
    const b = createGhBackend(gh, true);

    const outcomes = reflowResearchResults(b, '/repo', '5');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.newChildren.map((c) => c.id)).toEqual(['#30']);
    expect(outcomes[0]!.newChildren[0]).toMatchObject({ type: 'task', title: '实装 bun 方案', blockedBy: ['#11'] });

    // 子票 create body 无 Blocked-by 尾行 (native 不写 body 真相)。
    const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create')!;
    const createBody = create[create.indexOf('--body') + 1] ?? '';
    expect(createBody).not.toContain('Blocked-by');
    // 前置边走原生: 母票 #11 databaseId lookup + REST POST 到子票 #30。
    expect(calls.some((c) => c[0] === 'api' && c[1] === 'repos/acme/repo/issues/11' && c.includes('.id'))).toBe(true);
    expect(
      calls.some((c) => c[0] === 'api' && c.includes('POST') && c[3] === 'repos/acme/repo/issues/30/dependencies/blocked_by' && c.includes('issue_id=9110')),
    ).toBe(true);
    // 反向证伪: 全程无 body Blocked-by 尾行。
    expect(calls.some((c) => c.some((a) => a.includes('Blocked-by:')))).toBe(false);
  });

  test('失败路径: research-done 但无结果评论 → 警告, 不 rule 不 ack (留待下轮)', () => {
    const calls: string[][] = [];
    const gh = fakeGh((args) => {
      calls.push(args);
      // 只有失败通知评论 (无 `## 终稿` 结果形状)。
      if (args[0] === 'api' && args[1] === 'graphql') return okr(reflowMapResponse([{ body: '⚠ research failed: http://x' }]));
      return okr('');
    });
    const b = resolveBackend('/repo', { env: { OMD_PATH_BACKEND: 'gh' }, gh });

    const outcomes = reflowResearchResults(b, '/repo', '5');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.warning).toBeDefined();
    expect(outcomes[0]!.newChildren).toEqual([]);
    // 不 ack (未摘 label → 下轮重试), 不 rule (无 comment/close)。
    expect(calls.some((c) => c.includes('--remove-label'))).toBe(false);
    expect(calls.some((c) => c[1] === 'comment' || c[1] === 'close')).toBe(false);
  });
});
