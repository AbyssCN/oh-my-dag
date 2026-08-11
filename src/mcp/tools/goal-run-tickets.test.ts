/**
 * **切片 6 ①③** —— `dag_goal` 的挂票面 (SDD `docs/plan/2026-08-11-control-plane-unification.md`
 * D-6①③ / G-1 / G-2 / INV-1)。
 *
 * ## 这条网钉的是什么
 *
 * 切片 1 把散雾出口的纯核 (`run-tickets.ts`) 与 `run-goal` 的注入面 (`config.tickets`) 都建好了,
 * 而**生产上一个调用方都没有** —— 也就是说 G-1 的那条链 (「任一 solve/goal run 产出未决/发现物
 * → map 上出现 suggested 票」) 端到端从没跑通过一次。这条网是那条 wire 的证据面, 外加 D-6③
 * 「run 天然挂票」的生死判据。
 *
 * ## G-6 反向自检 (逐条实跑证伪过, 方式写在各 test 里)
 *
 * 每条闸都附一条"把实装改坏 → 这条当场红"的说明。一条永远绿的闸不是闸。
 *
 * ⚠ INV-1 那条是**反向的**: 它证明的是"没配 map 的仓行为逐字节没变" —— 于是把挂票做成
 * 无条件生效 (漏掉 `ticketTarget` 判空) 时它才是那个当场红的。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool, type GoalToolDeps } from './goal';
import { RunRegistry } from '../run-registry';
import { resolveBackend } from '../../harness/pathfinder/backend';
import { declaredTicketClass, type PathMap, type Ticket } from '../../harness/pathfinder/types';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const mdBackend = (cwd: string) => resolveBackend(cwd, { env: { OMD_PATH_BACKEND: 'md' } });

const result = (goal: string, over: Partial<RunGoalResult> = {}): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
  ...over,
});

/** 起一个临时仓 + 一个 goal 工具; `maps` 里的每个目的地各建一张空图 (空 = 无图仓)。 */
function make(maps: string[], goalResult: (goal: string) => RunGoalResult | Promise<RunGoalResult> = (g) => result(g)) {
  const root = mkdtempSync(join(tmpdir(), 'omd-run-ticket-'));
  for (const d of maps) mdBackend(root).createMap(root, d, d);
  /** runGoal 收到的 config (① 的证据面: tickets 传没传、传的是什么)。 */
  const seen: { config?: Parameters<GoalToolDeps['runGoal']>[1] } = {};
  const tool = createGoalTool({
    runGoal: async (goal: string, config: Parameters<GoalToolDeps['runGoal']>[1]) => {
      seen.config = config;
      return goalResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    resolveBackend: mdBackend,
  } as never);
  const readMap = (slug: string): PathMap | null => mdBackend(root).readMap(root, slug);
  return { tool, root, seen, readMap };
}

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text?: string }[] }>;
/** runGoal 是 fire-and-forget (handler 不等它) —— 让出一轮再看盘上状态。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const ticketOf = (map: PathMap | null, id: string): Ticket | undefined => map?.tickets.find((t) => t.id === id);

describe('★ 切片6① 散雾出口接通 —— dag_goal 把 map 句柄交给 runGoal', () => {
  test('★ INV-1: 仓里没有 map → 不传 tickets、不建图、回话不提票 (行为逐字节照旧)', async () => {
    const { tool, root, seen } = make([]);
    try {
      const r = await call(tool, { goal: '在无图仓里干活' });
      await settle();
      // 证伪: 把 handler 里的 `ticketTarget ? … : undefined` 改成无条件挂票 → 这三条一起红。
      expect(seen.config?.tickets).toBeUndefined();
      expect(existsSync(join(root, 'docs', 'plan', 'pathfinder'))).toBe(false); // 不代建图 (不越权)
      expect(r.content.map((c) => c.text ?? '').join('\n')).not.toContain('ticket:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 恰一张图 → tickets.slug/runId 传进 runGoal (G-1 那条链的第一跳)', async () => {
    const { tool, root, seen } = make(['ship-x']);
    try {
      const r = await call(tool, { goal: '把 X 发出去' });
      const runId = /runId: (\S+)/.exec(r.content.map((c) => c.text ?? '').join('\n'))![1]!;
      // 证伪: 删掉 runGoal 调用里那段 `...(ticketTarget && … ? { tickets: … } : {})` → 全红。
      expect(seen.config?.tickets?.slug).toBe('ship-x');
      expect(seen.config?.tickets?.runId).toBe(runId); // G-2: 票 → runId → 回执
      expect(typeof seen.config?.tickets?.sink.suggest).toBe('function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ sink 的 cwd **钉死在主仓** —— 隔离档 (worktree) 下票不许落进随时会被删的树', async () => {
    const { tool, root, seen, readMap } = make(['ship-x']);
    try {
      await call(tool, { goal: '隔离档也要挂票' });
      // run-goal 用 `config.cwd` 调 sink (branch 档下那是 worktree)。这里模拟它传一个**别的** cwd:
      // 票仍须落在主仓的图上。证伪: sink 改成透传 `_cwd` → 这条读不到票, 当场红。
      const bogus = join(root, '.omd', 'worktrees', 'run-x');
      seen.config!.tickets!.sink.suggest!(bogus, 'ship-x', [{ type: 'grill', title: '未决: 要不要上 X', suggestedBy: 'run-1' }], {
        at: '2026-08-11T00:00:00.000Z',
      });
      const suggested = readMap('ship-x')!.tickets.filter((t) => t.status === 'suggested');
      expect(suggested).toHaveLength(1);
      expect(suggested[0]!.title).toContain('要不要上 X');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 多图未指定 slug → **不猜**, 不挂票; 显式 slug → 挂在那张上', async () => {
    const { tool, root, seen } = make(['ship-x', 'ship-y']);
    try {
      await call(tool, { goal: '两张图的仓' });
      // 证伪: 把"多张 → 不猜"改成 `maps[0]`, 这条红 —— 猜错图 = 票长在与这趟活无关的图上。
      expect(seen.config?.tickets).toBeUndefined();
      await call(tool, { goal: '这次说清楚', slug: 'ship-y' });
      expect(seen.config?.tickets?.slug).toBe('ship-y');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 指定的 slug 本仓没有 → 不挂票也**不代建图** (不强迫无图仓开图)', async () => {
    const { tool, root, seen } = make(['ship-x']);
    try {
      await call(tool, { goal: '指错图' , slug: 'no-such-map' });
      expect(seen.config?.tickets).toBeUndefined();
      expect(mdBackend(root).listMaps(root).map((m) => m.slug)).toEqual(['ship-x']); // 没多出一张
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('★ 切片6③ run 天然挂票 —— 起跑开任务票, 终态如实翻', () => {
  test('★ 起跑即开票: task 票 · ticketClass=task · 身携 runId · 出生 open', async () => {
    // runGoal **永不 settle** —— 这一条问的是"票在 run 还在飞的时候长什么样"; 用一个立刻收敛的
    // 替身会读到终态 (首跑实测: 读到 delivered), 那就把"起跑"和"终态"两件事量成了一件。
    const { tool, root, readMap } = make(['ship-x'], () => new Promise<RunGoalResult>(() => {}));
    try {
      const r = await call(tool, { goal: '把 X 收敛掉' });
      const text = r.content.map((c) => c.text ?? '').join('\n');
      const runId = /runId: (\S+)/.exec(text)![1]!;
      // 证伪: 注掉 handler 里的 openRunTicket → 图上零票, 这一整条红。
      const map = readMap('ship-x')!;
      expect(map.tickets).toHaveLength(1);
      const tk = map.tickets[0]!;
      expect(tk.type).toBe('task');
      expect(declaredTicketClass(tk)).toBe('task'); // D-3: 出生即标类 (标了才有闸可判)
      expect(tk.suggestedBy).toBe(runId); // G-2 锚
      expect(tk.title).toContain('把 X 收敛掉');
      // **出生不是 ruled**: ruled 的 task 票会被 readyRegion 收进待交付区域 → path_deliver 会把
      // 一趟正在飞的 run 再跑一遍。证伪: 把出生状态改成 'ruled', 这条红。
      expect(tk.status).toBe('open');
      expect(text).toContain(`ticket: ${tk.id}`); // 起跑这一刻就说得出挂在哪
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 同一 runId 再起 (resume) 不重复开票 —— 幂等锚 = suggestedBy', async () => {
    const { tool, root, readMap } = make(['ship-x'], (g) => result(g, { converged: false, outcome: 'budget-exhausted', budgetStopped: '预算到顶' }));
    try {
      const r = await call(tool, { goal: '长活' });
      const runId = /runId: (\S+)/.exec(r.content.map((c) => c.text ?? '').join('\n'))![1]!;
      await settle();
      await call(tool, { goal: '长活', resume: runId });
      await settle();
      // 证伪: 去掉 openRunTicket 里的 existing 复用 → 变成 2 张, 这条红 (O-3 票量级正是它)。
      expect(readMap('ship-x')!.tickets.filter((t) => t.suggestedBy === runId)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 收敛 → 票翻 delivered (且判词落盘 + ruledAt 戳上)', async () => {
    const { tool, root, readMap } = make(['ship-x']);
    try {
      const r = await call(tool, { goal: '会成的活' });
      const tid = /ticket: (\S+)/.exec(r.content.map((c) => c.text ?? '').join('\n'))![1]!;
      await settle();
      // 证伪: 把 settleRunTicket 的 SUCCESS 分支去掉 → 票停在 open, 这条红。
      const tk = ticketOf(readMap('ship-x'), tid)!;
      expect(tk.status).toBe('delivered');
      expect(tk.ruling).toContain('[run 收敛]');
      expect(tk.ruledAt).toBeTruthy(); // D-5 三戳之二 (backend.rule 打的)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ blocked (BLOCKED) → 票翻 escalated, 并打上等人进入戳 (G-2 + D-5)', async () => {
    const { tool, root, readMap } = make(['ship-x'], (g) =>
      result(g, { converged: false, outcome: 'blocked', blocked: '需要 owner 给个凭证' }),
    );
    try {
      const r = await call(tool, { goal: '会卡住的活' });
      const tid = /ticket: (\S+)/.exec(r.content.map((c) => c.text ?? '').join('\n'))![1]!;
      await settle();
      // 证伪: 把 STALLED/BLOCKED 分支删掉 → 票停在 open, 这条红。
      const tk = ticketOf(readMap('ship-x'), tid)!;
      expect(tk.status).toBe('escalated');
      // 没有这个戳的话, 这张票的等待读数永远是 waiting-unknown-since → 72h 超时永不触发。
      expect(tk.waitingSince).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ not-converged (STALLED) → escalated; budget-exhausted (EXHAUSTED) → **留 open**', async () => {
    // 两格并排放才看得出这不是"恒翻": 一格的下一步是"人来看", 另一格的下一步是"加预算接着跑",
    // 把后者翻成终态 = 把一件没完的事记成完了。
    for (const [over, want] of [
      [{ outcome: 'not-converged' as const }, 'escalated'],
      [{ outcome: 'budget-exhausted' as const, budgetStopped: '到顶' }, 'open'],
    ] as const) {
      const { tool, root, readMap } = make(['ship-x'], (g) => result(g, { converged: false, ...over }));
      try {
        const r = await call(tool, { goal: `${over.outcome} 的活` });
        const tid = /ticket: (\S+)/.exec(r.content.map((c) => c.text ?? '').join('\n'))![1]!;
        await settle();
        // 证伪: 把 else 分支也翻成 escalated → EXHAUSTED 那格红。
        expect(ticketOf(readMap('ship-x'), tid)!.status).toBe(want);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('★ 开票失败 / 翻票失败都不掀 run (fail-open, 但留痕)', async () => {
    // 违规样本: 后端的写口全炸 —— run 仍须正常终态 (票是控制面, run 是执行面)。
    const root = mkdtempSync(join(tmpdir(), 'omd-run-ticket-'));
    mdBackend(root).createMap(root, 'ship-x', 'ship-x');
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async (g: string) => result(g),
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      resolveBackend: (cwd: string) => ({
        ...mdBackend(cwd),
        addTicket: () => { throw new Error('盘满了'); },
      }),
    } as never);
    try {
      const r = await call(tool, { goal: '写口坏了的仓' });
      const text = r.content.map((c) => c.text ?? '').join('\n');
      const runId = /runId: (\S+)/.exec(text)![1]!;
      await settle();
      // 证伪: 把 openRunTicket 的 try/catch 去掉 → handler 抛错, 这条红。
      expect(text).not.toContain('ticket:');
      expect(registry.getRecord(runId)?.status).toBe('done');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
