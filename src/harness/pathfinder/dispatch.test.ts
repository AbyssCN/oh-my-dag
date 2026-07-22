import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchFrontier,
  dispatchTicket,
  disposePrototype,
  prototypeBranch,
  prototypeDir,
  researchDispatchedPath,
  researchResultPath,
  researchScriptPath,
  type DispatchDeps,
} from './dispatch';
import type { GhResult, GhRunner } from './backend';
import type { PathMap, Ticket } from './types';

/** 造一张票 (默认 open task, 无前置)。 */
function tk(p: Partial<Ticket> & Pick<Ticket, 'id' | 'type'>): Ticket {
  return { title: p.id, blockedBy: [], status: 'open', ...p };
}

/** 记录副作用的 fake deps (永不真 spawn / 真 git)。 */
function fakeDeps(): DispatchDeps & { spawns: string[][]; gits: string[][] } {
  const spawns: string[][] = [];
  const gits: string[][] = [];
  return {
    spawns,
    gits,
    spawnDetached: (cmd) => {
      spawns.push(cmd);
      return 4242;
    },
    git: (args) => {
      gits.push(args);
    },
  };
}

const ctx = { cwd: '/repo', slug: 'ship-x' };

describe('dispatch — dispatchTicket routes by type', () => {
  test('research → afk: spawns dag-research + --out resultPath', () => {
    const d = fakeDeps();
    const r = dispatchTicket(tk({ id: 'r1', type: 'research', title: 'which store?' }), ctx, d);
    expect(r.kind).toBe('afk');
    if (r.kind !== 'afk') throw new Error('nope');
    expect(r.ticketId).toBe('r1');
    expect(r.resultPath).toBe(researchResultPath('/repo', 'ship-x', 'r1'));
    expect(r.pid).toBe(4242);
    // 命令: bun run <包内 scripts/dag-research.ts 绝对路径> "<title>" --out <resultPath>
    // (按包安装位置解析, 不依赖 ctx.cwd — 安装到别的 repo 也找得到脚本)
    expect(d.spawns).toHaveLength(1);
    const cmd = d.spawns[0]!;
    expect(cmd.slice(0, 2)).toEqual(['bun', 'run']);
    expect(cmd[2]).toBe(researchScriptPath());
    expect(cmd[2]!.endsWith('scripts/dag-research.ts')).toBe(true);
    expect(cmd[3]).toBe('which store?');
    expect(cmd[cmd.indexOf('--out') + 1]).toBe(r.resultPath);
    expect(d.gits).toHaveLength(0);
  });

  test('grill → hitl: prompt, no spawn', () => {
    const d = fakeDeps();
    const r = dispatchTicket(tk({ id: 'g1', type: 'grill', title: 'lock the schema' }), ctx, d);
    expect(r).toEqual({ kind: 'hitl', ticketId: 'g1', prompt: '/grill this: lock the schema' });
    expect(d.spawns).toHaveLength(0);
    expect(d.gits).toHaveLength(0);
  });

  test('prototype → worktree: git worktree add -b, no spawn', () => {
    const d = fakeDeps();
    const r = dispatchTicket(tk({ id: 'p1', type: 'prototype', title: 'spike it' }), ctx, d);
    expect(r).toEqual({
      kind: 'worktree',
      ticketId: 'p1',
      dir: prototypeDir('/repo', 'p1'),
      branch: prototypeBranch('p1'),
    });
    expect(d.gits).toEqual([['worktree', 'add', prototypeDir('/repo', 'p1'), '-b', 'proto/p1']]);
    expect(d.spawns).toHaveLength(0);
  });

  test('task → compile: nothing runs', () => {
    const d = fakeDeps();
    const r = dispatchTicket(tk({ id: 't1', type: 'task' }), ctx, d);
    expect(r).toEqual({ kind: 'compile', ticketId: 't1' });
    expect(d.spawns).toHaveLength(0);
    expect(d.gits).toHaveLength(0);
  });
});

describe('dispatch — gh 后端 research 走云端 label 派发 (S2 · D-F)', () => {
  const okr = (stdout = ''): GhResult => ({ stdout, exitCode: 0, stderr: '' });

  test('research (backend=gh): 幂等打 path:research label, 不 spawn/不 git, .dispatched 照写 (D-J)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dispatch-gh-'));
    try {
      const calls: string[][] = [];
      const gh: GhRunner = (args) => {
        calls.push(args);
        return okr();
      };
      const spawns: string[][] = [];
      const gits: string[][] = [];
      const deps: DispatchDeps = {
        gh,
        spawnDetached: (cmd) => {
          spawns.push(cmd);
          return 1;
        },
        git: (args) => {
          gits.push(args);
        },
      };
      const ghCtx = { cwd: dir, slug: '5', backend: 'gh' as const };
      const r = dispatchTicket(tk({ id: '#42', type: 'research', title: 'which store?' }), ghCtx, deps);

      expect(r).toEqual({ kind: 'gh-label', ticketId: '#42', label: 'path:research' });
      // gh CLI 收裸 number (去 #), 幂等 add-label。
      expect(calls).toEqual([['issue', 'edit', '42', '--add-label', 'path:research']]);
      // 云端派发: 无本地进程 / 无 git。
      expect(spawns).toHaveLength(0);
      expect(gits).toHaveLength(0);
      // .dispatched 标记照写 (预算记账留本地, D-J)。
      const marker = researchDispatchedPath(dir, '5', '#42');
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('gh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('research (backend=gh): gh 非零退出 → fail-loud throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dispatch-gh-'));
    try {
      const gh: GhRunner = () => ({ stdout: '', exitCode: 1, stderr: 'label path:research not found' });
      const ghCtx = { cwd: dir, slug: '5', backend: 'gh' as const };
      expect(() => dispatchTicket(tk({ id: '#42', type: 'research', title: 'x' }), ghCtx, { gh })).toThrow(
        /label path:research not found/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dispatchFrontier (backend=gh): research 票走 gh-label, 其余仅 reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dispatch-gh-'));
    try {
      const calls: string[][] = [];
      const gh: GhRunner = (args) => {
        calls.push(args);
        return okr();
      };
      const map: PathMap = {
        destination: 'Ship X',
        slug: '5',
        tickets: [
          tk({ id: '#11', type: 'research', title: 'research A' }),
          tk({ id: '#13', type: 'grill' }),
          tk({ id: '#14', type: 'task' }),
        ],
        decisionsLog: [],
      };
      const fd = dispatchFrontier(map, { cwd: dir, slug: '5', backend: 'gh' }, { gh });
      expect(fd.dispatched.map((x) => x.kind)).toEqual(['gh-label']);
      expect(fd.dispatched[0]!.ticketId).toBe('#11');
      expect(fd.reported.map((t) => t.id).sort()).toEqual(['#13', '#14']);
      expect(calls).toEqual([['issue', 'edit', '11', '--add-label', 'path:research']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dispatch — disposePrototype', () => {
  test('git worktree remove --force', () => {
    const d = fakeDeps();
    disposePrototype('p1', '/repo', d);
    expect(d.gits).toEqual([['worktree', 'remove', '--force', prototypeDir('/repo', 'p1')]]);
  });
});

describe('dispatch — dispatchFrontier only spawns research', () => {
  test('research spawned; grill/prototype/task only reported (no side effects)', () => {
    const map: PathMap = {
      destination: 'Ship X',
      slug: 'ship-x',
      tickets: [
        tk({ id: 'r1', type: 'research', title: 'research A' }),
        tk({ id: 'r2', type: 'research', title: 'research B' }),
        tk({ id: 'g1', type: 'grill' }),
        tk({ id: 'p1', type: 'prototype' }),
        tk({ id: 't1', type: 'task' }),
        // blocked research → not on frontier → not dispatched
        tk({ id: 'r3', type: 'research', blockedBy: ['t1'] }),
      ],
      decisionsLog: [],
    };
    const d = fakeDeps();
    const fd = dispatchFrontier(map, ctx, d);
    expect(fd.dispatched.map((x) => x.ticketId).sort()).toEqual(['r1', 'r2']);
    expect(fd.dispatched.every((x) => x.kind === 'afk')).toBe(true);
    expect(fd.reported.map((t) => t.id).sort()).toEqual(['g1', 'p1', 't1']);
    // only research spawned; git never touched
    expect(d.spawns).toHaveLength(2);
    expect(d.gits).toHaveLength(0);
  });
});
