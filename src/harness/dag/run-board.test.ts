/**
 * 判卷载体 (冻结): run-board 管线 (S1 board + S2 preflight + S3 await) 的集成判据。
 * 外部判据: `bun test src/harness/dag/run-board.test.ts` → exit 0。
 *
 * 覆盖:
 * - G-1  ignitionPreflight: 活 run 写集相交 → blocked + overlap; force → ok 且板上留越闸 note
 *        (note 是证据不是通行证 —— 后续无 force 预检仍 blocked); 冲突 run 落 terminal → 冲突消失。
 * - G-2/G-3  await 谓词与中止: 谓词真源 = 板 (claimed 无 terminal = 活); 注入短 poll/timeoutMs
 *        的等待循环按契约收敛 ('unparked' | 'stalled'); **中止 ≠ 终态** (stall 后 run 仍活, 板无伪造
 *        terminal, 写面仍被 preflight 挡)。
 * - G-4  compact: >1MB 含**超保留期**终态 → 追加后 ≤1MB, 活 run 条目全在; 且活 run 的写面证据
 *        在 compact 后仍被 preflight 看见 (G-1 与 G-4 形成回路)。

 *
 * 留账 (await-node 已写入磁盘): S3 切片补完 src/harness/dag/await-node.ts 后, 本文件把契约脚手架
 * `waitForRunOnBoard` 换成其**真实 API** `awaitNode`, 断言口径不变 (done↔unparked, aborted↔stalled;
 * 中止 ≠ 终态 判据原样: stall 后 run 仍活、板无伪造 terminal、写面仍被 preflight 挡; 短 deadline↔短
 * timeoutMs 被尊重); 引擎级判据另补: engine dispatch 经 runAwaitNode 消费**同一真实 awaitNode** (S3 接缝)。
 * G-1~G-4 数据层集成判据原样保留; 合入是真 git, 不是桩。
 * G-5 变异证伪 (compact 反转为删活条目 → 本族测试红) 由 src/harness/board/run-board.test.ts 的
 * G-4 条款承担, 本文件不重做。
 *
 * 全程零网络、零 LLM (INV-6): 纯本地 tempdir + 板文件 IO + 本地 git, 确定性 (timer 裕度 ≫ poll 间隔)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard, type BoardEntry } from '../board/run-board';
import { ignitionPreflight } from '../goal/ignition-preflight';
import { awaitNode, type AwaitOptions, type AwaitSpec } from './await-node';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-dag-run-board-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (runId: string, event: BoardEntry['event'], extra: Partial<BoardEntry> = {}): BoardEntry => ({
  v: 1,
  ts: new Date().toISOString(),
  runId,
  event,
  ...extra,
});

const boardFile = (root: string): string => join(root, '.omd', 'run-board.jsonl');
/** D-5 保留期契约值: 默认 24h, 自 terminal 条目 ts 起算 (与 board/run-board.test.ts 同口径)。 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const tsAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();


/** 直接写板文件 (绕过 appendBoard 构造超限板): 父目录先建好。 */
const writeBoard = (root: string, lines: string[]): void => {
  mkdirSync(dirname(boardFile(root)), { recursive: true });
  writeFileSync(boardFile(root), lines.join('\n') + '\n', 'utf8');
};

/** 跑本地 git (纯本地, 零网络); 非零退出即抛。 */
const git = (root: string, args: string[]): string => {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
};

/** 真实 await API 契约值: 测试总显式注入短值 (D-8 默认 3h 不可用于测试)。 */
const spec = (over: Partial<AwaitSpec> = {}): AwaitSpec => ({
  artifact: 'X',
  timeoutMs: 60_000,
  writeSet: ['src/a.ts'],
  ...over,
});
const opts = (over: Partial<AwaitOptions> = {}): AwaitOptions => ({ pollMs: 5, runId: 'r1', ...over });

describe('G-1: ignitionPreflight (blocked + overlap + force 留账)', () => {
  test('活 run 写集相交 → blocked 且 conflicts 带精确 overlap', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts', 'src/shared.ts'] }));
    const rep = ignitionPreflight(root, ['src/shared.ts', 'src/b.ts']);
    expect(rep.verdict).toBe('blocked');
    expect(rep.conflicts).toEqual([{ runId: 'r1', overlap: ['src/shared.ts'] }]);
  });

  test('force → ok + 越闸 note 落板; note 是证据不是通行证', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const rep = ignitionPreflight(root, ['src/a.ts'], { force: true });
    expect(rep.verdict).toBe('ok');
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('r1');
    expect(notes[0]!.note).toContain('src/a.ts');
    // note 是证据不改判: r1 仍活, 无 force 再预检 → 仍 blocked, 且 note 不产生伪冲突
    const rep2 = ignitionPreflight(root, ['src/a.ts']);
    expect(rep2.verdict).toBe('blocked');
    expect(rep2.conflicts).toEqual([{ runId: 'r1', overlap: ['src/a.ts'] }]);
  });

  test('G-1→G-2 闭环: 冲突 run 落 terminal → 冲突消失, 预检转 ok', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
    appendBoard(root, entry('r1', 'terminal', { outcome: 'ok' }));
    const rep = ignitionPreflight(root, ['src/a.ts']);
    expect(rep.verdict).toBe('ok');
    expect(rep.conflicts).toEqual([]);
  });
});

describe('G-2/G-3: await 谓词与中止 (真实 awaitNode API; 谓词真源 = 板)', () => {
  test('G-2 谓词: claimed 无 terminal = 活; terminal 落板 → 谓词翻转, 保留期内条目仍可读', () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    expect(liveRuns(readBoard(root)).has('r1')).toBe(true); // 谓词真: 活
    appendBoard(root, entry('r1', 'terminal', { outcome: 'ok' }));
    expect(liveRuns(readBoard(root)).has('r1')).toBe(false); // 谓词翻: 终态
    // D-5: 刚写 terminal 在保留期内 → compact 不删; 谓词真源是 liveRuns, 不是条目消失
    expect(readBoard(root).some((e) => e.runId === 'r1' && e.event === 'claimed')).toBe(true);
    expect(readBoard(root).some((e) => e.runId === 'r1' && e.event === 'terminal')).toBe(true);

  });

  test('G-3 done: 注入短 poll, published 落板后等待收敛 unparked, 板证据在 (合入是真 git)', async () => {
    const root = freshRoot();
    // 本地 git 铺底: base 提交 B; 前置分支 pre 上提交 C (待合入产物); 工作树回到 B。
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'run-board@test']);
    git(root, ['config', 'user.name', 'run-board test']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'B']);
    const base = git(root, ['branch', '--show-current']);
    git(root, ['checkout', '-qb', 'pre']);
    writeFileSync(join(root, 'pre.txt'), 'predecessor artifact\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'C']);
    const c = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', base]);

    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const t = setTimeout(() => {
      appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['src/pre.ts'] }));
      appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: c, writeSet: ['src/pre.ts'] }));
    }, 30);
    const t0 = Date.now();
    try {
      const res = await awaitNode(root, spec({ fromRun: 'r-pre', timeoutMs: 2000 }), opts());
      const elapsed = Date.now() - t0;
      expect(res.verdict).toBe('unparked'); // 30ms ≪ 2000ms 裕度 → 必收敛 unparked, 无竞态
      expect(res.commit).toBe(c); // 合入的就是板上 published 的那个 commit
      expect(res.tickets).toEqual([]); // 满足路径无票
      expect(res.llmCalls).toBe(0); // INV-3: 等待期零模型调用
      expect(elapsed).toBeLessThan(2000); // 谓词满足路径, 不是超时路径
      // 板证据在: published 条目保留期内仍可读
      expect(readBoard(root).some((e) => e.runId === 'r-pre' && e.event === 'published' && e.artifact === 'X')).toBe(true);
      // 合入是真 git, 不是桩: 产物文件已落地
      expect(readFileSync(join(root, 'pre.txt'), 'utf8')).toContain('predecessor artifact');
    } finally {
      clearTimeout(t);
    }
  });

  test('G-3 abort: 注入短 timeoutMs, run 不发布 → stalled; 中止 ≠ 终态, 短 timeout 被尊重', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    const t0 = Date.now();
    const res = await awaitNode(root, spec({ timeoutMs: 60 }), opts());
    const elapsed = Date.now() - t0;
    expect(res.verdict).toBe('stalled'); // 超时路径 (无 published 落板)
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!.reason).toBe('timeout'); // 中止 = 超时, 不是 fromRun terminal
    expect(liveRuns(readBoard(root)).has('r1')).toBe(true); // 中止 ≠ 终态: run 仍活
    expect(readBoard(root).some((e) => e.runId === 'r1' && e.event === 'terminal')).toBe(false); // 无伪造 terminal
    expect(elapsed).toBeLessThan(1000); // 注入的短 timeout 被尊重, 不是 3h
    // 回路闭合: abort 后写面仍在 → 无 force 预检仍 blocked
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
  });
});

describe('G-3 引擎级 (S3 接缝: engine dispatch 经 runAwaitNode 消费同一真实 awaitNode)', () => {
  test('单 await 节点经 runExecutorDagWithPlan: 超时 → failed + failureKind:stall + 票题作 output, usage 恒 0', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r1', 'claimed', { writeSet: ['src/a.ts'] }));
    // 本地 git 铺底 (同 G-3 done 测试口径): 引擎在真 worktree 里跑, rollback-anchor 取 HEAD 才不落 warn。
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'run-board@test']);
    git(root, ['config', 'user.name', 'run-board test']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'B']);
    // 零模型节点 (executor:'await') → generate 从不被调 → 无需 fake (INV-6); root 经
    // continuity.repoRoot 注入 tempdir, 不碰仓根 (engine runAwaitNode 的 board 根同此)。
    const plan: ConductorPlan = {
      name: 'await-engine-seam',
      nodes: {
        w1: {
          goal: '等前置 r-pre 发布 src/a.ts 的产物 X',
          executor: 'await',
          await: { artifact: 'X', fromRun: 'r-pre', timeoutMs: 60 },
          write_set: ['src/a.ts'],
        },
      },
    };
    const r = await runExecutorDagWithPlan(plan, {
      conductorModel: 'test:conductor', // 预构造 plan 路径不用; 类型必填
      leafModel: 'test:leaf', // 零模型节点 → 永不解析、零调用
      agentTemplates: new Map(),
      continuity: { manager: new CheckpointManager(root), runId: 'r-engine', repoRoot: root },
    });
    const w1 = r.results['w1']!;
    expect(w1.status).toBe('failed');
    expect(w1.failureKind).toBe('stall'); // engine 把 awaitNode 的 stalled 判定映射成 stall 成因
    expect(w1.kind).toBe('await');
    expect(w1.output.length).toBeGreaterThan(0); // suggested 票题作 output → 人看得见环 (G-3)
    expect(w1.usage).toEqual({ in: 0, out: 0 }); // INV-3: 引擎侧等待期零模型调用
    expect(r.usage.leavesIn + r.usage.leavesOut).toBe(0); // 全图零 token
    // 中止 ≠ 终态 (同 G-3 判据, 经引擎路径): run 仍活, 板无伪造 terminal
    expect(liveRuns(readBoard(root)).has('r1')).toBe(true);
    expect(readBoard(root).some((e) => e.runId === 'r1' && e.event === 'terminal')).toBe(false);
  });
});

describe('G-4: compact ≤1MB 且活条目仍在', () => {
  test('超 1MB 含超保留期终态 → 追加后 ≤1MB, 活 run 条目全在; 写面证据 compact 后仍被 preflight 看见', () => {
    const root = freshRoot();
    const live = [
      entry('r-live-1', 'claimed', { writeSet: ['src/a.ts'] }),
      entry('r-live-2', 'claimed', { writeSet: ['src/b.ts'] }),
    ];
    const pad = 'x'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'claimed', { ts: tsAgo(2 * RETENTION_MS), writeSet: ['p.ts'], note: pad })));
      lines.push(JSON.stringify(entry(`r-done-${i}`, 'terminal', { ts: tsAgo(2 * RETENTION_MS), outcome: 'ok' })));
    }
    lines.push(...live.map((e) => JSON.stringify(e)));
    writeBoard(root, lines);
    expect(statSync(boardFile(root)).size).toBeGreaterThan(1024 * 1024);

    appendBoard(root, entry('r-live-3', 'claimed', { writeSet: ['src/c.ts'] }));

    expect(statSync(boardFile(root)).size).toBeLessThanOrEqual(1024 * 1024); // compact 后 ≤1MB
    const got = readBoard(root);
    for (const l of live) {
      expect(got.some((e) => e.runId === l.runId && e.writeSet?.includes(l.writeSet![0]!))).toBe(true); // 活条目全在
    }
    expect(got.some((e) => e.runId === 'r-live-3')).toBe(true); // 新追加的也在
    expect(got.some((e) => e.runId.startsWith('r-done-'))).toBe(false); // 超保留期终态 run 全清
    // G-1 ↔ G-4 回路闭合: compact 没丢活 run 的写面证据 → preflight 仍能挡冲突
    expect(ignitionPreflight(root, ['src/a.ts']).verdict).toBe('blocked');
  });
});
