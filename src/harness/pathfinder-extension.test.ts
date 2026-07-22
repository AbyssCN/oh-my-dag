import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPathfinderExtension,
  loadMap,
  saveMap,
  summarizeOpenMaps,
  type PathfinderExtensionDeps,
  type PathfinderExtensionOpts,
} from './pathfinder-extension';
import { createPathfinderModeState } from './plan/mode';
import type { ReflowOutcome } from './pathfinder/afk-hook';
import type { PathMap, Ticket } from './pathfinder/types';

/** 造一张票 (默认 open task, 无前置)。 */
function tk(p: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'task', title: p.id, blockedBy: [], status: 'open', ...p };
}

function seedMap(cwd: string, map: PathMap): void {
  saveMap(map, cwd);
}

/** 假 pi (mirror verify-gate / sdd-template tests): 收集 shortcut + command + on。 */
function harness(
  cwd: string,
  onRegionClear?: (ids: string[]) => void,
  extraOpts?: Partial<PathfinderExtensionOpts>,
  deps?: PathfinderExtensionDeps,
) {
  const commands = new Map<string, Function>();
  const events = new Map<string, Function[]>();
  const sent: string[] = [];
  let shortcut: { key: string; handler: Function } | null = null;
  const pi = {
    registerShortcut(key: string, def: { handler: Function }) {
      shortcut = { key, handler: def.handler };
    },
    registerCommand(name: string, def: { handler: Function }) {
      commands.set(name, def.handler);
    },
    on(ev: string, fn: Function) {
      events.set(ev, [...(events.get(ev) ?? []), fn]);
    },
    sendUserMessage(s: string) {
      sent.push(s);
    },
  };
  const state = createPathfinderModeState();
  createPathfinderExtension({ cwd, state, onRegionClear, ...extraOpts }, deps)(pi as never);

  const notices: { msg: string; level: string }[] = [];
  const statuses: Record<string, string | undefined> = {};
  const ctx = {
    cwd,
    ui: {
      notify: (msg: string, level: string) => notices.push({ msg, level }),
      setStatus: (k: string, v?: string) => {
        statuses[k] = v;
      },
    },
  };
  return {
    state,
    notices,
    statuses,
    sent,
    shortcutKey: () => shortcut!.key,
    toggle: () => shortcut!.handler(ctx),
    run: (name: string, args = '') => commands.get(name)!(args, ctx) as unknown,
    has: (name: string) => commands.has(name),
    lastNotice: () => notices[notices.length - 1]?.msg ?? '',
    allNotices: () => notices.map((n) => n.msg).join('\n'),
  };
}

describe('pathfinder-extension', () => {
  test('registers shift+tab + /path /rule /tickets /pathfinder commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      const h = harness(dir);
      expect(h.shortcutKey()).toBe('shift+tab');
      for (const c of ['path', 'rule', 'tickets', 'pathfinder']) expect(h.has(c)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shift+tab toggles pathfinder mode state normal→pathfinder→normal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      const h = harness(dir);
      expect(h.state.status).toBe('normal');
      h.toggle();
      expect(h.state.status).toBe('pathfinder');
      h.toggle();
      expect(h.state.status).toBe('normal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enter with no open map prompts to name a destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      const h = harness(dir);
      h.toggle();
      expect(h.state.status).toBe('pathfinder');
      expect(h.lastNotice().toLowerCase()).toContain('destination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enter with one open map resumes + surfaces frontier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 'q1', title: 'pick a store' })],
        decisionsLog: [],
      });
      const h = harness(dir);
      h.toggle();
      expect(h.state.status).toBe('pathfinder');
      expect(h.state.activeSlug).toBe('ship-x');
      expect(h.allNotices()).toContain('q1'); // frontier ticket surfaced
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/path with no arg lists open maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, { destination: 'Ship X', slug: 'ship-x', tickets: [tk({ id: 'a' })], decisionsLog: [] });
      seedMap(dir, { destination: 'Ship Y', slug: 'ship-y', tickets: [], decisionsLog: [] });
      const h = harness(dir);
      h.run('path');
      const out = h.allNotices();
      expect(out).toContain('ship-x');
      expect(out).toContain('ship-y');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/path <destination> creates + persists a new map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      const h = harness(dir);
      h.run('path', 'Build the pathfinder mode');
      expect(h.state.status).toBe('pathfinder');
      expect(h.state.activeSlug).toBe('build-the-pathfinder-mode');
      // persisted to markdown truth
      expect(summarizeOpenMaps(dir).map((m) => m.slug)).toContain('build-the-pathfinder-mode');
      expect(h.allNotices().toLowerCase()).toContain('creat');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/rule rules a frontier ticket → persisted ruled + ruling; frontier recomputed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 't1', title: 'decide store' }), tk({ id: 't2', title: 'decide format', blockedBy: ['t1'] })],
        decisionsLog: [],
      });
      const h = harness(dir);
      h.run('path', 'ship-x'); // open by slug
      h.run('rule', 't1 use markdown-in-git');
      const map = loadMap(dir, 'ship-x')!;
      const t1 = map.tickets.find((t) => t.id === 't1')!;
      expect(t1.status).toBe('ruled');
      expect(t1.ruling).toBe('use markdown-in-git');
      expect(map.decisionsLog.some((d) => d.ticketId === 't1')).toBe(true);
      // t2 was blocked by t1; now t1 ruled → t2 enters frontier (surfaced)
      expect(h.allNotices()).toContain('t2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/rule bad usage + unknown ticket warn, no crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, { destination: 'Ship X', slug: 'ship-x', tickets: [tk({ id: 't1' })], decisionsLog: [] });
      const h = harness(dir);
      h.run('path', 'ship-x');
      h.run('rule', 't1'); // missing ruling
      expect(h.lastNotice().toLowerCase()).toMatch(/usage|用法/);
      h.run('rule', 'nope some ruling'); // unknown ticket
      expect(h.lastNotice().toLowerCase()).toMatch(/no ticket|没有票/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('onRegionClear injection fires when all task tickets ruled + region clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 't1', title: 'only task' })],
        decisionsLog: [],
      });
      const cleared: string[][] = [];
      const h = harness(dir, (ids) => cleared.push(ids));
      h.run('path', 'ship-x');
      await h.run('rule', 't1 done');
      expect(cleared).toEqual([['t1']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default onRegionClear wire: compileSlice → executeSlice, plan passed + result reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 't1', title: 'only task' })],
        decisionsLog: [],
      });
      const fakePlan = { name: 'pathfinder-slice:ship-x', nodes: { t1: { goal: 'done', executor: 'leaf' } } };
      let compiledRegion: string[] | null = null;
      let executedPlan: unknown = null;
      const deps: PathfinderExtensionDeps = {
        compileSlice: ((_m: PathMap, ids: string[]) => {
          compiledRegion = ids;
          return fakePlan;
        }) as unknown as PathfinderExtensionDeps['compileSlice'],
        executeSlice: (async (plan: unknown) => {
          executedPlan = plan;
          return { verification: { pass: true } };
        }) as unknown as PathfinderExtensionDeps['executeSlice'],
      };
      // no onRegionClear override → 散尽只报信 (/deliver 闸); owner 显式 /deliver 才执行。
      const h = harness(dir, undefined, { leafModel: 'ds:flash' }, deps);
      h.run('path', 'ship-x');
      await h.run('rule', 't1 done');
      expect(h.allNotices()).toContain('/deliver'); // 报信不执行
      expect(executedPlan).toBeNull();
      await h.run('deliver', '');
      expect(compiledRegion as string[] | null).toEqual(['t1']);
      expect(executedPlan).toBe(fakePlan);
      expect(h.allNotices()).toContain('delivered');
      expect(h.sent.join('\n')).toContain('slice-delivered'); // brief sent to runtime
      // 交付后区域票翻 delivered (终态) → 再裁新票不会把 t1 重新编进区域。
      const after = loadMap(dir, 'ship-x');
      expect(after?.tickets.find((t) => t.id === 't1')?.status).toBe('delivered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default wire without leafModel degrades to a message, never executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, { destination: 'Ship X', slug: 'ship-x', tickets: [tk({ id: 't1', title: 'task' })], decisionsLog: [] });
      let executed = false;
      const deps: PathfinderExtensionDeps = {
        executeSlice: (async () => {
          executed = true;
          return {};
        }) as unknown as PathfinderExtensionDeps['executeSlice'],
      };
      const h = harness(dir, undefined, {}, deps); // no leafModel
      h.run('path', 'ship-x');
      await h.run('rule', 't1 done');
      await h.run('deliver', ''); // 闸后执行入口; 缺 leafModel → 引导语, 不执行
      expect(executed).toBe(false);
      expect(h.allNotices().toLowerCase()).toContain('leafmodel');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('auto-dispatch gating: no prefetch by default; --prefetch + autoPrefetch trigger dispatchFrontier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 'r1', type: 'research', title: 'research it' })],
        decisionsLog: [],
      });
      let dispatchCalls = 0;
      let timerCalls = 0;
      const deps: PathfinderExtensionDeps = {
        dispatchFrontier: (() => {
          dispatchCalls++;
          return { dispatched: [{ kind: 'afk', ticketId: 'r1', resultPath: '/x' }], reported: [] };
        }) as unknown as PathfinderExtensionDeps['dispatchFrontier'],
        reflowResearchResults: (() => []) as unknown as PathfinderExtensionDeps['reflowResearchResults'],
        setInterval: (() => {
          timerCalls++;
          return 'HANDLE';
        }) as unknown as PathfinderExtensionDeps['setInterval'],
        clearInterval: (() => {}) as unknown as PathfinderExtensionDeps['clearInterval'],
      };

      // (a) default: entering + /tickets must NOT dispatch.
      const h = harness(dir, undefined, {}, deps);
      h.toggle(); // enter
      await h.run('tickets');
      expect(dispatchCalls).toBe(0);
      expect(timerCalls).toBe(0);

      // (b) explicit /tickets --prefetch triggers it.
      await h.run('tickets', '--prefetch');
      expect(dispatchCalls).toBe(1);
      expect(timerCalls).toBe(1);
      expect(h.allNotices()).toContain('prefetch');

      // (c) autoPrefetch opt: /path opens + auto dispatches.
      const h2 = harness(dir, undefined, { autoPrefetch: true }, deps);
      await h2.run('path', 'ship-x');
      expect(dispatchCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D-10 自续: 回流孵出 research 子票 → 预算内自动续派; 预算 0 → 停 + 提醒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ext-'));
    const prevBudget = process.env.OMD_PATH_RESEARCH_BUDGET;
    try {
      seedMap(dir, {
        destination: 'Ship X',
        slug: 'ship-x',
        tickets: [tk({ id: 'r1', type: 'research', title: 'research it' })],
        decisionsLog: [],
      });
      let dispatchCalls = 0;
      let tickFn: (() => void) | null = null;
      let nextOutcomes: ReflowOutcome[] = [];
      const deps: PathfinderExtensionDeps = {
        dispatchFrontier: (() => {
          dispatchCalls++;
          return { dispatched: [{ kind: 'afk', ticketId: 'r1', resultPath: '/x' }], reported: [] };
        }) as unknown as PathfinderExtensionDeps['dispatchFrontier'],
        // 每 tick 折入 → 返回受控 outcomes (模拟一轮 landed 结果回流)。
        reflowResearchResults: (() => nextOutcomes) as unknown as PathfinderExtensionDeps['reflowResearchResults'],
        setInterval: ((fn: () => void) => {
          tickFn = fn;
          return 'HANDLE';
        }) as unknown as PathfinderExtensionDeps['setInterval'],
        clearInterval: (() => {}) as unknown as PathfinderExtensionDeps['clearInterval'],
      };
      const h = harness(dir, undefined, {}, deps);
      await h.run('path', 'ship-x --prefetch');
      expect(dispatchCalls).toBe(1);

      // 回流带 research 子票 → 自动续派 (预算默认 12, 本 cwd 无 .dispatched → used=0)。
      delete process.env.OMD_PATH_RESEARCH_BUDGET;
      nextOutcomes = [{ ticketId: 'r1', newChildren: [tk({ id: 'r1-c1', type: 'research', title: 'child q' })] }];
      tickFn!();
      expect(dispatchCalls).toBe(2);
      expect(h.allNotices()).toContain('self-expansion');

      // 预算 0 → 自续停 + 提醒; 非 research 子票也不触发。
      process.env.OMD_PATH_RESEARCH_BUDGET = '0';
      nextOutcomes = [{ ticketId: 'r1-c1', newChildren: [tk({ id: 'r1-c1-c1', type: 'research', title: 'grand q' })] }];
      tickFn!();
      expect(dispatchCalls).toBe(2);
      expect(h.allNotices()).toContain('budget exhausted');
      nextOutcomes = [{ ticketId: 'x', newChildren: [tk({ id: 'x-c1', type: 'task', title: 'build' })] }];
      tickFn!();
      expect(dispatchCalls).toBe(2);
    } finally {
      if (prevBudget === undefined) delete process.env.OMD_PATH_RESEARCH_BUDGET;
      else process.env.OMD_PATH_RESEARCH_BUDGET = prevBudget;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
