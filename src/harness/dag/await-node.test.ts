/**
 * await-node 契约测试 (TDD 红: 冻结接口路径 `src/harness/dag/await-node.ts` 未落盘, import 即红)。
 *
 * 判据 (SDD `docs/plan/2026-08-11-run-board-跨run协调-sdd.md`, S3 切片; 判卷载体 =
 * `src/harness/dag/run-board.test.ts` 的 G-2/G-3 数据层冻结 —— 本文件把 await 契约钉在
 * **真实 API** 层, 载体里的 `waitForRunOnBoard` 脚手架落盘后即由本文件取代, 断言口径不变):
 * - G-2  board 追加 `published{artifact,commit}` → 一个 poll 周期内 unpark、先确定性合入 commit
 *        (D-7: 合入后 unparked 才返回)、该节点模型调用数 = 0 (INV-3)。
 * - G-3  fromRun terminal 而无 published → 立即 STALLED (不等 timeoutMs, D-6 中止条件) 且产 suggested 票。
 * - 超时 → STALLED + suggested 票 (D-8: 等满 timeoutMs, 不提前)。
 * - 谓词 (D-6 满足条件): published 匹配 artifact 且其写集与本 run 声明**不相交**; 相交 → 不 unpark,
 *       一直等到超时。artifact / fromRun 不匹配 → 同样不 unpark (过滤, 零合入尝试)。
 * - INV-4/D-7: published commit 合入冲突 → 立即 STALLED + suggested 票 (reason=merge-conflict),
 *       无静默继续路径 (不跳过冲突条目继续等下一个)。
 * - G-3 首查分支: awaitNode 启动前 fromRun 已 terminal → 同样立即 STALLED (不等 timeoutMs)。
 * - cleanup: 每条返回路径 (unpark / 首查中止 / 冲突 / 超时) finally 清 watcher + timer; 同 root
 *       连续调用互不干扰, 结束后 fixture 可整体删除。
 * - 引擎接缝: 经 `runExecutorDagWithPlan` (dispatch → runAwaitNode) 复跑 G-2/G-3 —— 下游只在合入
 *       之后才 readiness (command 里 is-ancestor 判据); stalled → failed(failureKind:'stall') 且
 *       下游 quorum skipped; 全链 generate **抛错哨兵**: 任何意外模型调用即响亮失败, 不是吞调用。
 *
 * 全程零网络、零 LLM (INV-6): 纯本地 tempdir + 板文件 IO + 本地 git (合入是真 git, 不是桩);
 * 确定性 (timer 裕度 ≫ poll 间隔, 同载体口径)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBoard, awaitingRuns, readBoard, type BoardEntry } from '../board/run-board';
import { createCommandLeafRunner } from '../command-leaf';
import type { ConductorPlan } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { awaitNode, type AwaitOptions, type AwaitSpec } from './await-node';
import { runExecutorDagWithPlan } from './engine';
import type { ExecutorDagConfig, GenerateFn } from './types';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-dag-await-node-'));
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

/** 跑本地 git (纯本地, 零网络); 非零退出即抛。 */
const git = (root: string, args: string[]): string => {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
};

/** commit 是否已在 HEAD 历史里 (D-7 "先合入" 的判据)。 */
const isAncestor = (root: string, commit: string): boolean =>
  Bun.spawnSync(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root }).exitCode === 0;

/** 契约默认值 (D-8 超时默认 3h 可配; watch 退化 poll 30s) —— 测试总是显式注入短值。 */
const spec = (over: Partial<AwaitSpec> = {}): AwaitSpec => ({
  artifact: 'X',
  timeoutMs: 60_000,
  writeSet: ['mine.ts'],
  ...over,
});
const opts = (over: Partial<AwaitOptions> = {}): AwaitOptions => ({ pollMs: 20, runId: 'r-await', ...over });

describe('G-2: published{artifact,commit} → 一个 poll 周期内 unpark + 先合入 commit + 零模型调用', () => {
  test('谓词满足 (artifact 匹配 + 写集不相交) → unpark; commit 已入 HEAD 历史; llmCalls=0', async () => {
    const root = freshRoot();
    // 本地 git 铺底: base 提交 B; 前置分支 pre 上提交 C (待合入产物); 工作树回到 B。
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'await-node@test']);
    git(root, ['config', 'user.name', 'await-node test']);
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

    // 等待中 board 追加 published (30ms 落板, 落在 poll 间隔内 → 下一拍 poll 即看见)。
    const t = setTimeout(() => {
      appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
      appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: c, writeSet: ['pre.ts'] }));
    }, 30);
    const t0 = Date.now();
    const res = await awaitNode(root, spec(), opts());
    const elapsed = Date.now() - t0;
    clearTimeout(t);

    expect(res.verdict).toBe('unparked');
    expect(res.commit).toBe(c);
    // 一个 poll 周期内 unpark: 2s 裕度 ≫ pollMs(20ms), ≪ timeoutMs(60s) → 谓词满足路径, 不是超时路径。
    expect(elapsed).toBeLessThan(2000);
    // D-7 先确定性合入: unparked 返回时 commit 必已在工作树历史里, 产物文件落地 (纯 git, 零 LLM)。
    expect(isAncestor(root, c)).toBe(true);
    expect(readFileSync(join(root, 'pre.txt'), 'utf8')).toContain('predecessor artifact');
    expect(res.tickets).toEqual([]); // unpark 无票
    expect(res.llmCalls).toBe(0); // INV-3: 等待期零模型调用
  });
});

describe('G-3: fromRun terminal 而无 published → 立即 STALLED + suggested 票', () => {
  test('前置 run 落 terminal → 不等 timeoutMs 即 STALLED, 产 suggested 票 (reason=predecessor-terminal)', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    const t = setTimeout(() => appendBoard(root, entry('r-pre', 'terminal', { outcome: 'failed' })), 30);
    const t0 = Date.now();
    const res = await awaitNode(root, spec({ fromRun: 'r-pre' }), opts());
    const elapsed = Date.now() - t0;
    clearTimeout(t);

    expect(res.verdict).toBe('stalled');
    // 立即 STALLED (D-6 中止条件): 1s ≪ timeoutMs(60s) → 没傻等超时。
    expect(elapsed).toBeLessThan(1000);
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!).toMatchObject({
      status: 'suggested',
      reason: 'predecessor-terminal',
      suggestedBy: 'r-await',
    });
    expect(res.tickets[0]!.title.length).toBeGreaterThan(0);
    expect(res.llmCalls).toBe(0);
  });
});

describe('超时 → STALLED + suggested 票 (D-8)', () => {
  test('无 published 落板 → 等满 timeoutMs 后 STALLED, 产 suggested 票 (reason=timeout)', async () => {
    const root = freshRoot();
    const t0 = Date.now();
    const res = await awaitNode(root, spec({ timeoutMs: 150 }), opts());
    const elapsed = Date.now() - t0;

    expect(res.verdict).toBe('stalled');
    expect(elapsed).toBeGreaterThanOrEqual(100); // 真等了 timeoutMs(150ms 量级), 不是秒回
    expect(elapsed).toBeLessThan(3000);
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!).toMatchObject({ status: 'suggested', reason: 'timeout', suggestedBy: 'r-await' });
    expect(res.tickets[0]!.title.length).toBeGreaterThan(0);
    expect(res.llmCalls).toBe(0);
  });
});

describe('#205 awaiting 落板 —— 「谁在等」这件事要被记下来', () => {
  test('★ 真进等待 → 板上出现 awaiting (带 artifact/timeoutMs), 且 awaitingRuns 认得出它', async () => {
    const root = freshRoot();
    await awaitNode(root, spec({ timeoutMs: 120 }), opts()); // 等到超时 STALLED
    const entries = readBoard(root);
    const aw = entries.filter((e) => e.event === 'awaiting');
    // ★ 反向自检 (已实测会红): 去掉 await-node 里那段 appendBoard → 这条红,
    //   而红的方式正是它防的那件事 —— 观察面永远看不见有人在等。
    expect(aw).toHaveLength(1);
    expect(aw[0]!).toMatchObject({ runId: 'r-await', artifact: 'X', timeoutMs: 120 });
    // 此刻 run 还没 terminal、也没人 published ⇒ 判定认它是「未收口的等待」。
    expect(awaitingRuns(entries).map((a) => a.artifact)).toEqual(['X']);
  });

  /**
   * 落在两次首检**之后**是刻意的: 前面任一命中就直接返回, 那种「根本没等」的情况记一条
   * awaiting 会让观察面闪一个从不存在的等待 —— 而板是 append-only, 抹不掉。
   */
  test('★ 首检就 STALLED (前置已 terminal) → **不记** awaiting (根本没等过就不该有记录)', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'terminal', { outcome: 'failed' }));
    const res = await awaitNode(root, spec({ fromRun: 'r-pre' }), opts());
    expect(res.verdict).toBe('stalled'); // 首检那一条就返回了, 循环没进
    // ★ 反向自检 (已实测会红): 把 appendBoard 那段挪到两次首检**之前** → 这条红,
    //   而红的方式正是它防的那件事 —— 观察面闪一个从不存在的等待, 且板 append-only 抹不掉。
    expect(readBoard(root).filter((e) => e.event === 'awaiting')).toHaveLength(0);
  });
});

describe('谓词: 写集与本 run 声明不相交 (D-6 满足条件)', () => {
  test('published 写集与本 run 声明相交 → 不满足 → 不 unpark, 等到超时 STALLED', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['shared.ts'] }));
    appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: 'c0ffee', writeSet: ['shared.ts'] }));
    const res = await awaitNode(root, spec({ timeoutMs: 150, writeSet: ['shared.ts', 'mine.ts'] }), opts());

    expect(res.verdict).toBe('stalled');
    expect(res.commit).toBeUndefined(); // 谓词挡住 → 未 unpark → 无合入
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!.reason).toBe('timeout'); // 走的是超时路径, 不是满足路径
    expect(res.llmCalls).toBe(0);
  });
});

describe('INV-4/D-7: 合入冲突 → 立即 STALLED + suggested 票 (无静默继续路径)', () => {
  test('published commit 与本地 HEAD 冲突 → reason=merge-conflict 的票, 不跳过继续等', async () => {
    const root = freshRoot();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'await-node@test']);
    git(root, ['config', 'user.name', 'await-node test']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'B']);
    const base = git(root, ['branch', '--show-current']);
    // pre 分支把 base.txt 改成 'pre\n' → 提交 C (待合入产物)。
    git(root, ['checkout', '-qb', 'pre']);
    writeFileSync(join(root, 'base.txt'), 'pre\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'C']);
    const c = git(root, ['rev-parse', 'HEAD']);
    // 本地 HEAD 把同一文件改成 'mine\n' → 与 C 合入必冲突 (同文件双侧改动)。
    git(root, ['checkout', '-q', base]);
    writeFileSync(join(root, 'base.txt'), 'mine\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'M']);
    // 板已满足谓词 → 首查即尝试合入 → 冲突 → 立即 STALLED。
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: c, writeSet: ['pre.ts'] }));
    const t0 = Date.now();
    const res = await awaitNode(root, spec(), opts());
    const elapsed = Date.now() - t0;

    expect(res.verdict).toBe('stalled');
    expect(res.commit).toBeUndefined(); // 冲突 → 未 unpark
    expect(elapsed).toBeLessThan(1000); // 冲突路径, 不是 60s 超时路径
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!).toMatchObject({
      status: 'suggested',
      reason: 'merge-conflict',
      suggestedBy: 'r-await',
    });
    expect(res.tickets[0]!.title).toContain('合入 published commit'); // 票标题指名失败合入
    expect(res.llmCalls).toBe(0);
  });
});

describe('谓词: artifact / fromRun 过滤 (D-6)', () => {
  test('published 的 artifact 或 runId 不匹配 → 不 unpark (零合入尝试), 等超时 STALLED', async () => {
    const root = freshRoot();
    // ① artifact 匹配但 runId ≠ fromRun ② runId 匹配但 artifact 不对 —— 两条都不满足谓词。
    appendBoard(root, entry('r-other', 'published', { artifact: 'X', commit: 'c0ffee', writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'published', { artifact: 'Y', commit: 'c0ffee', writeSet: ['pre.ts'] }));
    const res = await awaitNode(root, spec({ fromRun: 'r-pre', timeoutMs: 150 }), opts());

    expect(res.verdict).toBe('stalled');
    expect(res.commit).toBeUndefined(); // 过滤 → 从未尝试 git 合入
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!.reason).toBe('timeout'); // 走超时路径, 不是满足路径
    expect(res.llmCalls).toBe(0);
  });
});

describe('G-3 首查分支: 启动前 fromRun 已 terminal 而无 published', () => {
  test('首查即中止 → 立即 STALLED (reason=predecessor-terminal), 不等 timeoutMs', async () => {
    const root = freshRoot();
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'terminal', { outcome: 'failed' }));
    const t0 = Date.now();
    const res = await awaitNode(root, spec({ fromRun: 'r-pre' }), opts());
    const elapsed = Date.now() - t0;

    expect(res.verdict).toBe('stalled');
    expect(elapsed).toBeLessThan(1000); // 60s timeoutMs 根本没等
    expect(res.tickets).toHaveLength(1);
    expect(res.tickets[0]!).toMatchObject({
      status: 'suggested',
      reason: 'predecessor-terminal',
      suggestedBy: 'r-await',
    });
    expect(res.llmCalls).toBe(0);
  });
});

describe('cleanup: 返回后无残留 watcher/timer (finally 兜底)', () => {
  test('同 root 超时→STALLED 后再 unpark: 两次调用互不干扰, fixture 可整体删除', async () => {
    const root = freshRoot();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'await-node@test']);
    git(root, ['config', 'user.name', 'await-node test']);
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

    // 第一次: 超时 → STALLED (finally 清掉 watcher + wakeTimer)。
    const r1 = await awaitNode(root, spec({ timeoutMs: 60 }), opts());
    expect(r1.verdict).toBe('stalled');
    expect(r1.llmCalls).toBe(0);

    // 第二次: 同一 root, 板已有 published → 首查即 unpark (第一次的残留不得串进来)。
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: c, writeSet: ['pre.ts'] }));
    const r2 = await awaitNode(root, spec(), opts());
    expect(r2.verdict).toBe('unparked');
    expect(r2.commit).toBe(c);
    expect(r2.llmCalls).toBe(0);

    // 返回后无句柄残留 → root 可整体删除 (afterEach 里 force:true 再删一次也无害)。
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
});

describe('引擎接缝 (dispatch → runAwaitNode → awaitNode)', () => {
  test('G-2: 引擎 park await 节点 → 落 published → unpark 合入 → 下游 command 在合入后执行; 零 generate 调用', async () => {
    const root = freshRoot();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'await-node@test']);
    git(root, ['config', 'user.name', 'await-node test']);
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

    const plan: ConductorPlan = {
      name: 'seam-g2',
      nodes: {
        W: { goal: '等 artifact X', executor: 'await', await: { artifact: 'X', timeoutMs: 5000 }, write_set: ['mine.ts'] },
        D: {
          goal: '合入后的下游',
          executor: 'command',
          // is-ancestor + 产物文件在: 只有 W 已确定性合入 C, 本节点才可能 done ——
          // "成功 commit 集成发生在下游 readiness 之前" 的直接判据。
          command: `git merge-base --is-ancestor ${c} HEAD && test -f pre.txt && echo OK`,
          depends_on: ['W'],
        },
      },
    };
    // generate = 抛错哨兵: await 路径任何意外模型调用 → 响亮失败, 不被 mock 吞掉 (INV-3/INV-6)。
    const generateCalls: string[] = [];
    const generate: GenerateFn = async () => {
      generateCalls.push('GENERATE');
      throw new Error('await 接缝测试: generate 被意外调用 (INV-3/INV-6 违例)');
    };
    const config: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      commandRunner: createCommandLeafRunner({ allowlist: ['git', 'test', 'echo'], cwd: root }),
      continuity: { manager: new CheckpointManager(root), runId: 'r-seam-g2', repoRoot: root },
    };
    const run = runExecutorDagWithPlan(plan, config);
    // 引擎 park W 期间落板 (30ms; fs.watch 主触发立即醒, poll 只是兜底)。
    const t = setTimeout(() => {
      appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
      appendBoard(root, entry('r-pre', 'published', { artifact: 'X', commit: c, writeSet: ['pre.ts'] }));
    }, 30);
    const t0 = Date.now();
    const r = await run;
    const elapsed = Date.now() - t0;
    clearTimeout(t);

    expect(elapsed).toBeLessThan(10_000); // 等的是 unpark, 不是 5s timeoutMs
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.output).toBe(c); // 引擎把合入的 commit 作为节点输出
    expect(r.results.W!.usage).toEqual({ in: 0, out: 0 }); // INV-3: 引擎记账同样恒 0
    expect(r.results.D!.status).toBe('done'); // 下游 readiness 在合入之后 (命令里 is-ancestor 判据)
    expect(r.results.D!.output).toContain('OK');
    expect(generateCalls).toEqual([]); // 全链零模型调用
  });

  test('G-3: fromRun 已 terminal → failed(failureKind=stall) + 下游 skipped; 零 generate 调用', async () => {
    const root = freshRoot();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'await-node@test']);
    git(root, ['config', 'user.name', 'await-node test']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'B']);
    appendBoard(root, entry('r-pre', 'claimed', { writeSet: ['pre.ts'] }));
    appendBoard(root, entry('r-pre', 'terminal', { outcome: 'failed' }));

    const plan: ConductorPlan = {
      name: 'seam-g3',
      nodes: {
        W: {
          goal: '等 r-pre 的 X',
          executor: 'await',
          await: { artifact: 'X', fromRun: 'r-pre', timeoutMs: 5000 },
          write_set: ['mine.ts'],
        },
        D: { goal: '不该跑的下游', executor: 'command', command: 'echo SHOULD-NOT-RUN', depends_on: ['W'] },
      },
    };
    const generateCalls: string[] = [];
    const generate: GenerateFn = async () => {
      generateCalls.push('GENERATE');
      throw new Error('await 接缝测试: generate 被意外调用 (INV-3/INV-6 违例)');
    };
    const config: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      commandRunner: createCommandLeafRunner({ allowlist: ['echo'], cwd: root }),
      continuity: { manager: new CheckpointManager(root), runId: 'r-seam-g3', repoRoot: root },
    };
    const t0 = Date.now();
    const r = await runExecutorDagWithPlan(plan, config);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3000); // 立即 STALLED, 没等 5s timeoutMs
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('stall');
    expect(r.results.W!.output).toContain('r-pre'); // 票标题透出到节点输出
    expect(r.results.W!.usage).toEqual({ in: 0, out: 0 });
    expect(r.results.D!.status).toBe('skipped'); // quorum fail-skip
    expect(generateCalls).toEqual([]);
  });
});
