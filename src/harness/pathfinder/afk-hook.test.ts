import { describe, expect, test } from 'bun:test';
import { applyAfkResult, distill, parseChildren, watchAfkResults, type AfkReflow } from './afk-hook';
import { researchResultPath } from './dispatch';
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
