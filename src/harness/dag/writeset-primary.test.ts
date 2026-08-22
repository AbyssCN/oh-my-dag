/**
 * src/harness/dag/writeset-primary.test —— SDD s1 切片 1 反向自检 (2026-08-23)
 *
 * 本片新增的**正判据** = 写集核实 (SDD C-1 · C-2): 节点声明了 `write_set` ⇒
 * 跑前存哈希、跑后再算、至少一个路径哈希变了 ⇒ 判真写入, 把通过的路径并进 `filesTouched`。
 * 不问谁写的 / 用什么工具写的 / 命令文本长什么样 —— 那正是既有采集面 (受控工具通道 +
 * 命令文本解析) 都漏的形状。
 *
 * 测试形状沿用本仓惯例 (跟 `writeset-evidence.test.ts` / `artifact-scope.test.ts`):
 *   - mkdtempSync 建一棵 worktree 形状的临时树
 *   - 注入 `agentRunner` 返回 `filesTouched` (空或非空) + 跑过的 shellRuns
 *   - 真 agentRunner **不**跑, 改用 agentRunner 的副作用**模拟**「leaf 经 bash 写了文件」
 *     —— 直接对临时树的写集路径写一次, 那是 leaf 在生产里会用 bash 做的事。
 *
 * 五条 GWT (与 SDD 切片 1 一字对应):
 *   1. ★ GWT-1 节点 `write_set: ['a.ts']`, leaf 用 **bash** 写了 `a.ts` (受控工具通道
 *         `filesTouched` 空、命令文本里**不含**字面路径, 如 `bash script.sh`)
 *         ⇒ 节点 done, `filesTouched` 含 `a.ts`, 一行核实判词。
 *   2. ★ GWT-2 `a.ts` 在节点起跑**之前就存在且内容不变** (leaf 一个字没改)
 *         ⇒ **不**判真写入, 落回今天的路径 (D-2 承重)。
 *   3. ★ GWT-3 `a.ts` 起跑前**不存在**, leaf 用 bash 新建了它 ⇒ 判真写入
 *         (INV-2: `null → 有值` 算变)。
 *   4. ★ GWT-4 节点**没有** `write_set` ⇒ 行为与今天逐字相同 (INV-6, 没有合同没判据)。
 *   5. ★ GWT-5 写集 3 个文件、只有 1 个被改 ⇒ 判真写入 (D-4 「至少一个」)。
 *
 * 反向自检 (本片手做, 见 SDD §反向自检切片 1):
 *   1. 把判据从「哈希变了」改成「文件存在」⇒ GWT-2 当场红 (老文件没动, 但存在, 被误判)。
 *   2. 把「至少一个」改成「全部」⇒ GWT-5 当场红 (1/3 命中, 全部要求下被误判 empty)。
 *
 * ⚠ **不**起真 git、不依赖 rollbackBaseline: 写集核实的判据面是**哈希**, 不是 git,
 *   与隔离档与否无关。所以本文件不复用 `writeset-evidence.test.ts` 的 `makeGitTree`
 *   那个 git 树 (那条线只测救援③, 即「隔离档下重跑的 leaf 只读不写」的形状)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import type { GenerateFn } from './types';
import type { ShellRun } from '../leaf-runners';

// ── 装置 ─────────────────────────────────────────────────────────────────────

/** 在 mkdtemp 起的临时目录建一棵 worktree 形状的树, 给定相对路径全部落非空文件。 */
function makeWorktreeWith(relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-ws-primary-'));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* pre-existing baseline content */\n');
  }
  return root;
}

function rmWorktree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * 跑一次空 run: `runExecutorDagWithPlan` + 注入 generate / agentRunner。
 *
 * 关键: agentRunner 不跑真 agent —— 它收到调用时, 按 `sideEffect` 的指示去改临时树
 * 里的文件 (模拟「leaf 经 bash 写了 a.ts」), 然后返回 `filesTouched: []`
 * (受控工具通道**空**) + `shellRuns` 里一条不含字面路径的命令文本
 * (如 `bash /tmp/script.sh`, 让 `shellWriteTargets` 也救不回来 —— 模拟真实漏检形态)。
 */
async function runOnce(opts: {
  tree: string;
  writeSet: string[];
  output_path?: string;
  sideEffect?: (root: string) => void;
  agentFilesTouched?: string[];
  shellRunText?: string;
  agentText?: string;
}) {
  const plan: ConductorPlan = {
    name: 'writeset-primary',
    nodes: {
      W: {
        goal: '改文件',
        executor: 'agent',
        // 触发产物闸路径 (declaredArtifact 闸门): 必须给 output_path,
        // 否则 `declaredArtifact=false` 整段产物闸不跑 (GWT-1 的"修前必红"依赖此点)。
        output_path: opts.output_path ?? opts.writeSet[0] ?? 'src/x.ts',
        write_set: opts.writeSet,
      },
    },
  };
  const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
  const cfg: ExecutorDagConfig = {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    agentRunner: async () => {
      // **模拟 leaf 跑过 bash**: 先把写集所有路径的父目录都建好 (这是 sideEffect 写文件
      // 的前提 —— mkdtempSync 只建顶层, 写集里的 `src/xxx` 这种中间目录得自己 mkdir, 否则
      // writeFileSync 直接抛 ENOENT), 然后跑 sideEffect 改盘, 最后返回空 filesTouched +
      // 一条不含字面路径的 shell 命令 (真实漏检形状 —— 受控工具通道空、shellWriteTargets
      // 解析也不中)。
      for (const p of opts.writeSet) {
        mkdirSync(join(opts.tree, p).slice(0, join(opts.tree, p).lastIndexOf('/')), { recursive: true });
      }
      opts.sideEffect?.(opts.tree);
      const shellRuns: ShellRun[] = opts.shellRunText
        ? [{ command: opts.shellRunText, exitCode: 0, ok: true }]
        : [];
      return {
        text: opts.agentText ?? '写好了。',
        usage: { in: 1, out: 1 },
        filesTouched: opts.agentFilesTouched ?? [], // 受控工具通道空
        ...(shellRuns.length ? { shellRuns } : {}),
      };
    },
    continuity: {
      manager: new CheckpointManager(mkdtempSync(join(tmpdir(), 'omd-ws-primary-ckpt-'))),
      runId: 'writeset-primary-run',
      // head 档 (无 rollbackBaseline): 救援③ 一字节都不生效 —— 本片只测正判据。
      repoRoot: opts.tree,
      execRoot: opts.tree,
    },
  };
  return runExecutorDagWithPlan(plan, cfg);
}

// ── 五条 GWT (与 SDD 切片 1 一字对应) ─────────────────────────────────────────

describe('GWT-1 节点 write_set + bash 写入 (受控通道空、命令文本不含字面路径)', () => {
  let tree: string;
  beforeEach(() => { tree = makeWorktreeWith([]); }); // 空仓: a.ts 不存在
  afterEach(() => { rmWorktree(tree); });

  test('★ GWT-1 修前必红: 节点 done, filesTouched 含 a.ts (bash 写入漏检形态)', async () => {
    // 模拟: leaf 跑过一条不含字面路径的 bash 命令 (如 `bash /tmp/script.sh`),
    //   那个 script 真去写了 a.ts —— 受控工具通道空、命令文本也不含字面路径。
    //   这是既有采集面两条通道都看不见的形状 (SDD 「现场」表的第四格盲区)。
    const r = await runOnce({
      tree,
      writeSet: ['src/a.ts'],
      output_path: 'src/a.ts',
      shellRunText: 'bash /tmp/script.sh', // 不含字面路径
      sideEffect: (root) => writeFileSync(join(root, 'src/a.ts'), '// 新内容\n'),
    });
    // 真绿值: 节点 done, filesTouched 含 a.ts。
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/a.ts']);
  });
});

describe('GWT-2 老文件存在且未改 ⇒ 不判真写入 (D-2 承重)', () => {
  let tree: string;
  beforeEach(() => { tree = makeWorktreeWith(['src/a.ts']); }); // a.ts 已存在 + baseline 内容
  afterEach(() => { rmWorktree(tree); });

  test('★ GWT-2 哈希未变 ⇒ 落回今天的路径 (empty-done 仍判死)', async () => {
    // leaf 一个字没改: sideEffect 不动盘。GWT-2 是 D-2 承重:
    //   判据要分「干了活」与「什么都没干」, 而「什么都没干」是合法 empty-done,
    //   必须判死 —— 否则闸白设 (这正是既有闸在防的那种坏)。
    const r = await runOnce({
      tree,
      writeSet: ['src/a.ts'],
      output_path: 'src/a.ts',
      shellRunText: 'bash /tmp/script.sh',
      // 故意不传 sideEffect —— 盘上文件不动, 哈希与跑前一致
      agentText: '看了一眼, 不用改。',
    });
    // 真绿值: 节点 failed, failureKind empty-artifact —— 哈希没变, 写集核实
    //   不救, 闸落回今天路径 (scopedTouched.length === 0)。
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
  });
});

describe('GWT-3 跑前不存在 + bash 新建 ⇒ 判真写入 (INV-2 null→有值算变)', () => {
  let tree: string;
  beforeEach(() => { tree = makeWorktreeWith([]); }); // 空仓
  afterEach(() => { rmWorktree(tree); });

  test('★ GWT-3 INV-2 承重: null→hash 算变, filesTouched 含 a.ts', async () => {
    const r = await runOnce({
      tree,
      writeSet: ['src/a.ts'],
      output_path: 'src/a.ts',
      shellRunText: 'bash /tmp/script.sh',
      sideEffect: (root) => writeFileSync(join(root, 'src/a.ts'), '// 新建\n'),
    });
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/a.ts']);
  });
});

describe('GWT-4 节点没有 write_set ⇒ 行为逐字与今天相同 (INV-6 没有合同没有判据)', () => {
  let tree: string;
  beforeEach(() => { tree = makeWorktreeWith(['src/x.ts']); });
  afterEach(() => { rmWorktree(tree); });

  test('★ GWT-4 INV-6 承重: 没有 write_set ⇒ 不快照不复算, 受控通道空 ⇒ 仍判死', async () => {
    // 与 GWT-2 同形, 但不声明 write_set: 闸完全不应被写集核实触碰,
    //   行为 = 救援①②③ 之后 scopedTouched.length === 0 ⇒ failed (今天逐字)。
    const r = await runOnce({
      tree,
      writeSet: [], // 关键: 写集为空
      output_path: 'src/x.ts', // 触发 declaredArtifact 闸门, 但不触发写集核实
      shellRunText: 'bash /tmp/script.sh',
      agentText: '看了一眼, 不用改。',
    });
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
  });
});

describe('GWT-5 写集 3 文件、只有 1 个被改 ⇒ 判真写入 (D-4 至少一个)', () => {
  let tree: string;
  beforeEach(() => { tree = makeWorktreeWith(['src/a.ts', 'src/b.ts', 'src/c.ts']); });
  afterEach(() => { rmWorktree(tree); });

  test('★ GWT-5 D-4 承重: 1/3 命中仍判真写入 (不要求全部命中)', async () => {
    const r = await runOnce({
      tree,
      writeSet: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      output_path: 'src/a.ts',
      shellRunText: 'bash /tmp/script.sh',
      sideEffect: (root) => writeFileSync(join(root, 'src/b.ts'), '// 改 b\n'), // 只动 b
    });
    // 真绿值: 节点 done, filesTouched 含**改了的那一个** (b.ts)。
    //   a.ts/c.ts 哈希未变 ⇒ 不进 verified (D-4 「至少一个」不是「全部」)。
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/b.ts']);
  });
});