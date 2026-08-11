import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDispatchable,
  dispatchFrontier,
  dispatchGoalTicket,
  goalDispatchedPath,
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
import type { DispatchableTicket, PathMap, RulingTicket, Ticket, TicketType } from './types';

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

/**
 * D-3 票类型闸 (SDD `docs/plan/2026-08-11-control-plane-unification.md`, G-4 + G-6)。
 *
 * 闸的形状两道门, 两道都得有自己的违规样本:
 *  ① 类型层 (主, INV-2「派发路径物理不存在」): `dispatchTicket` 收 `DispatchableTicket`,
 *     `RulingTicket` 赋不进去 —— 用 `@ts-expect-error` 钉死。
 *  ② 运行时 (兜底): `assertDispatchable` —— 挡 `as` 强转 / JS 调用方 / 磁盘 parse 出来的票
 *     (那些票静态类型一律是 `Ticket`, 类只在运行时看得见)。
 *
 * G-6 反向自检 (逐条写在各 test 里, 已实跑证伪):
 *  - 类型层那条: 把票的 `ticketClass` 从 `'ruling'` 改成 `'task'`(或把 `dispatchTicket` 的参数
 *    类型改回 `Ticket`)→ `@ts-expect-error` 变成"未使用的抑制" → `tsc` TS2578 当场红。
 *  - 运行时那条: 摘掉 `dispatchTicket` 首行的 `assertDispatchable` → 裁决票被真派 (research 票
 *    会 spawn), `toThrow` 当场红。
 */
describe('D-3 票类型闸 — 裁决票永不可派发 (G-4/G-6)', () => {
  /** 一张裁决票 (判别键必填)。type 可变 —— 用来验"类维度赢 type 维度"。 */
  function ruling(id: string, type: TicketType = 'grill'): RulingTicket {
    return { id, type, title: id, blockedBy: [], status: 'open', ticketClass: 'ruling' };
  }

  test('G-4 类型层: 裁决票赋不进 dispatchTicket 的参数 (@ts-expect-error 钉死)', () => {
    const d = fakeDeps();
    const t = ruling('g9');
    expect(() => {
      // 证伪 (G-6): 'ruling' → 'task' 或参数类型退回 Ticket, 下面这行就不再报错,
      // 那条抑制立刻变成 TS2578「未使用的抑制指令」→ tsc 当场红。
      // @ts-expect-error INV-2: RulingTicket ⊄ DispatchableTicket —— 派发口收不进裁决票。
      dispatchTicket(t, ctx, d);
    }).toThrow();
    // 副作用一个都不许有 (类型层拒了也别留 spawn/git 的尾巴)。
    expect(d.spawns).toHaveLength(0);
    expect(d.gits).toHaveLength(0);
  });

  test('G-4 运行时第二道: as 强转绕过类型层 → 装配期拒, 错误指名票 id + type + 类', () => {
    const d = fakeDeps();
    // 违规样本: 模拟 JS 调用方 / 磁盘 parse 出来的票 —— 静态类型骗过第一道门。
    const smuggled = ruling('g9') as unknown as DispatchableTicket;
    // 证伪: 摘掉 dispatchTicket 首行的 assertDispatchable, 这条当场红 (票被真派)。
    expect(() => dispatchTicket(smuggled, ctx, d)).toThrow(/g9/);
    let msg = '';
    try {
      dispatchTicket(smuggled, ctx, d);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('装配期拒');
    expect(msg).toContain('g9');
    expect(msg).toContain('type=grill');
    expect(msg).toContain('ticketClass=ruling');
    expect(d.spawns).toHaveLength(0);
    expect(d.gits).toHaveLength(0);
  });

  test('G-4 类赢 type: 标了 ruling 的 research 票也不派 (不 spawn)', () => {
    const d = fakeDeps();
    const smuggled = ruling('r9', 'research') as unknown as DispatchableTicket;
    // 证伪: 闸若按 type 判而非按类判, research 分支会先跑到 spawn —— spawns 变 1, 这条红。
    expect(() => dispatchTicket(smuggled, { cwd: '/repo', slug: 'ship-x' }, d)).toThrow(/r9/);
    expect(d.spawns).toHaveLength(0);
  });

  test('G-4 dispatchFrontier: 裁决票 (哪怕 type=research) 只 reported, 永不进 dispatched', () => {
    const d = fakeDeps();
    const map: PathMap = {
      destination: 'Ship X',
      slug: 'ship-x',
      tickets: [
        tk({ id: 'r1', type: 'research', title: 'research A' }),
        ruling('r9', 'research'), // 裁决票伪装成 research —— 类维度必须赢
        ruling('g9'),
      ],
      decisionsLog: [],
    };
    // 证伪: 去掉 dispatchFrontier 里的 dispatchable 判据, r9 进 dispatched 且 spawns 变 2 → 红。
    const fd = dispatchFrontier(map, ctx, d);
    expect(fd.dispatched.map((x) => x.ticketId)).toEqual(['r1']);
    expect(fd.reported.map((t) => t.id).sort()).toEqual(['g9', 'r9']);
    expect(d.spawns).toHaveLength(1);
  });

  test('fail-closed: 词表外的 ticketClass (真相文件手改) 拒派, 不静默放行', () => {
    const d = fakeDeps();
    const typo = { ...tk({ id: 'x1', type: 'research' }), ticketClass: 'rulingg' } as unknown as DispatchableTicket;
    // 证伪: 闸若只判 === 'ruling', 手滑一个字母就把裁决票放成可派票 —— 这条当场红。
    expect(() => dispatchTicket(typo, ctx, d)).toThrow(/rulingg/);
    expect(d.spawns).toHaveLength(0);
    // 批量口同样 fail-closed: 认不出的类归 reported, 不给执行体。
    const map: PathMap = { destination: 'X', slug: 'ship-x', tickets: [typo as unknown as Ticket], decisionsLog: [] };
    const fd = dispatchFrontier(map, ctx, fakeDeps());
    expect(fd.dispatched).toHaveLength(0);
    expect(fd.reported.map((t) => t.id)).toEqual(['x1']);
  });

  test('存量兼容: 未标类的四型票照旧可派 (缺省 undefined = 语义不变)', () => {
    // NULL≠0: 「没标类」≠「标了任务票」—— 存量票一个字节没改, 派发行为必须与改动前逐字节相同。
    // 证伪: 闸若把 undefined 当非法 (fail-closed 收得太宽), 存量图全部卡死 —— 这条当场红。
    for (const type of ['research', 'grill', 'prototype', 'task'] as const) {
      const d = fakeDeps();
      const t = tk({ id: `legacy-${type}`, type });
      expect(assertDispatchable(t)).toBe(t as DispatchableTicket);
      expect(() => dispatchTicket(t, { cwd: '/repo', slug: 'legacy' }, d)).not.toThrow();
    }
  });

  // ── 切片 6: goal 档派发口的类洞 (切片 2 留账的 P1) ────────────────────────────
  //
  // `dispatchGoalTicket` 此前收 `ticketId: string` —— 手上没有票就没有类可判, 两道门都够不着。
  // 它是**第二条会把票交给执行体的路** (detached solve, 一跑就烧钱), 所以闸缺在这里比缺在
  // dispatchTicket 上更贵: 那条至少还有 dispatchFrontier 在前面挡, 这条是 path_deliver 直连。

  test('G-4 goal 档: 裁决票赋不进 dispatchGoalTicket 的参数 (@ts-expect-error 钉死)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pf-goal-gate-'));
    try {
      const t = ruling('g9', 'task');
      expect(() => {
        // 证伪 (G-6): 'ruling' → 'task', 或参数类型退回 `ticketId: string`, 这条抑制立刻变成
        // TS2578「未使用的抑制指令」→ tsc 当场红 (实跑证伪过)。
        // @ts-expect-error INV-2: RulingTicket ⊄ DispatchableTicket —— goal 派发口同样收不进裁决票。
        dispatchGoalTicket(cwd, 'm', t, '收敛这个', { spawnDetached: () => 1, makeRunId: () => 'r' });
      }).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('G-4 goal 档运行时: as 强转的裁决票 → 装配期拒, 不 spawn 且**不留在途标记**', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pf-goal-gate-'));
    try {
      const spawns: string[][] = [];
      const smuggled = ruling('g9', 'task') as unknown as DispatchableTicket;
      // 证伪: 摘掉 dispatchGoalTicket 首行的 assertDispatchable → 票被真 fire (spawns 变 1) 且
      // 标记落盘, 这条当场红。标记那一位单独钉: 假阳性标记 = 票永远卡在"在飞"。
      expect(() => dispatchGoalTicket(cwd, 'm', smuggled, '收敛这个', { spawnDetached: (c) => (spawns.push(c), 1) })).toThrow(/装配期拒/);
      expect(spawns).toHaveLength(0);
      expect(existsSync(goalDispatchedPath(cwd, 'm', 'g9'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('存量兼容 (goal 档): 未标类的 ruled task 票照旧 fire (缺省 undefined = 语义不变)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pf-goal-gate-'));
    try {
      const spawns: string[][] = [];
      const d = dispatchGoalTicket(cwd, 'm', tk({ id: 't2', type: 'task' }), '收敛这个', {
        spawnDetached: (c) => (spawns.push(c), 1),
        makeRunId: () => 'run-fixed',
      });
      // 证伪: 闸若把 undefined 当非法, 存量 goal 档票全部派不出去 —— 这条当场红。
      expect(d).toEqual({ runId: 'run-fixed', already: false });
      expect(spawns).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('显式标 question/task 的票可派 (三类里可派的那两类)', () => {
    const q: DispatchableTicket = { ...tk({ id: 'q1', type: 'research' }), ticketClass: 'question' };
    const w: DispatchableTicket = { ...tk({ id: 'w1', type: 'task' }), ticketClass: 'task' };
    const d = fakeDeps();
    expect(dispatchTicket(q, { cwd: '/repo', slug: 'ship-x' }, d).kind).toBe('afk');
    expect(dispatchTicket(w, ctx, d)).toEqual({ kind: 'compile', ticketId: 'w1' });
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
