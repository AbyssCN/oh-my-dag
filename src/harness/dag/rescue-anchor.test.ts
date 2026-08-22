/**
 * src/harness/dag/rescue-anchor.test —— SDD s1 救援① 两侧同锚 (2026-08-23)
 *
 * 承重事实: 隔离档 (`branchStrategy:'branch'`) 下, leaf 真写文件的那棵树是
 * `continuity.execRoot`, 而产物根 (line 3741) 与写集快照根 (line 3552) 都按
 * `execRoot ?? repoRoot ?? cwd` 解析。救援① 跑前快照的 `preRoot` (line 3539)
 * 之前却按 `repoRoot ?? cwd` 解析 —— 于是 `declaredAbsPre` 与跑后 `abs` 取自两棵
 * 不同的树, 守卫 `产物根跑前跑后不一致 → 不救 filesTouched 空` 在隔离档下恒触发,
 * 救援① 从来没救成过 (.omd/goal-logs/ 14 个 run 全部「不救」)。
 *
 * 修后: `preRoot` 改用 `execRoot ?? repoRoot ?? cwd`, 与跑后 `root` 同源。
 * 守卫**原样保留** —— INV-4, 一个字不动; 现在应当永不触发, 万一将来又喂错根仍 fail-closed。
 *
 * 三条 GWT (与 SDD 切片 1 一字对应):
 *   G-1 ★ 隔离档 (`execRoot` ≠ `repoRoot`), 节点声明 `output_path`, leaf 用 bash 改了它
 *        (受控通道 `filesTouched: []`) ⇒ 救援① 命中, filesTouched = [output_path],
 *        **且无**「产物根跑前跑后不一致」判词 (修前必红: 守卫必触发)。
 *   G-2 ★ 同上, 但产物内容**没变** (leaf 一个字没改) ⇒ 救援① **不**命中
 *        (落回写集核实 / empty-artifact 闸)。承重: 修准不是修松。
 *   G-3 ★ 非隔离档 (不给 `execRoot`) ⇒ 行为与今天逐字相同 (INV-3 零回归):
 *        `preRoot` 解析回 `repoRoot ?? cwd`, 隔离档专属行为不出现。
 *
 * 反向自检 (本片手做, 图上不放 falsify 节点): 把 `preRoot` 改回
 * `continuity?.repoRoot ?? process.cwd()` ⇒ G-1 当场红 (守卫触发、救援① 不命中)。
 *
 * 测试形状沿用 `writeset-primary.test.ts` / `artifact-scope.test.ts`:
 *   - mkdtempSync 建两棵临时树 (execTree / repoTree)
 *   - 注入 `agentRunner` 返回 `filesTouched: []` + `cwd: execTree`
 *   - 关键: **不声明 `write_set`**, 让写集核实跳过 (line 3759 守卫
 *     `writeSetSnapshot.length > 0`), 救援① 才是命中者
 *   - 收判词经 `setCoreLogger` (全局状态, 收尾必须还原为 dumpLogger)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

// ── 装置 ─────────────────────────────────────────────────────────────────────

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};
const dumpLogger = (): CoreLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

function makeTree(label: string, relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), `omd-rescue-anchor-${label}-`));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* pre-existing baseline */\n');
  }
  return root;
}

function rmTree(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * 跑一次: 隔离档 / 非隔离档可切换, 注入 agentRunner 模拟「leaf 用 bash 写了产物」。
 *
 * 关键: 节点**不声明** `write_set` (让写集核实跳过, 救援① 才是命中者)。
 *   agentRunner 收到调用时按 sideEffect 去 execTree 改 output_path 路径,
 *   然后返 `filesTouched: []` (受控通道空) + `cwd: execTree` (让
 *   `artifactRoot = r.cwd` 解析到 execTree —— 救援① 跑后 `root` 用它)。
 */
async function runOnce(opts: {
  outputPath: string;
  isolation: boolean;
  sideEffect?: (execTree: string) => void;
  agentText?: string;
  execTreeExists?: boolean; // G-2 用: 文件已存在但内容不变
}) {
  const execTree = makeTree('exec', opts.execTreeExists ? [opts.outputPath] : []);
  const repoTree = makeTree('repo', []);
  const plan: ConductorPlan = {
    name: 'rescue-anchor',
    nodes: {
      W: {
        goal: '改文件',
        executor: 'agent',
        output_path: opts.outputPath,
        // 故意不写 write_set —— 写集核实跳过, 救援① 才是命中者
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
      // 模拟 leaf 跑过 bash: 父目录建好 (mkdtempSync 只建顶层), 然后 sideEffect 改盘
      const abs = join(execTree, opts.outputPath);
      mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
      opts.sideEffect?.(execTree);
      return {
        text: opts.agentText ?? '写好了。',
        usage: { in: 1, out: 1 },
        filesTouched: [], // 受控通道空, 让救援① 命中
        cwd: execTree, // 救援① 跑后 root = artifactRoot = r.cwd = execTree
      };
    },
    continuity: {
      manager: new CheckpointManager(mkdtempSync(join(tmpdir(), 'omd-rescue-anchor-ckpt-'))),
      runId: 'rescue-anchor-run',
      repoRoot: opts.isolation ? repoTree : execTree,
      // isolation=true ⇒ execRoot = execTree ≠ repoTree (隔离档形状)
      // isolation=false ⇒ execRoot 缺席 (非隔离档形状, INV-3 零回归)
      ...(opts.isolation ? { execRoot: execTree } : {}),
    },
  };
  try {
    return await runExecutorDagWithPlan(plan, cfg);
  } finally {
    rmTree(execTree);
    rmTree(repoTree);
  }
}

const pickMsg = (lines: Captured[], msg: string): Captured[] => lines.filter((l) => l.msg === msg);

// ── 三条 GWT ──────────────────────────────────────────────────────────────────

describe('救援① 两侧同锚 (SDD 2026-08-23 · s1 切片 1)', () => {
  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 ★ 隔离档 + bash 写 + 内容变了 ⇒ 救援① 命中, 不触发「根不一致」守卫
  test('G-1 隔离档下 leaf 用 bash 改产物 ⇒ 救援① 命中 (修前必红)', async () => {
    const r = await runOnce({
      outputPath: 'src/hello.md',
      isolation: true,
      sideEffect: (tree) => writeFileSync(join(tree, 'src/hello.md'), '// 新内容\n'),
    });
    // 修前必红: 守卫触发 → filesTouched 仍空 → 闸判 empty-artifact → 节点 failed
    // 修后: 救援① 命中 → filesTouched = [src/hello.md] → 节点 done
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/hello.md']);
    // 守卫 (fail-closed) 必须**不**触发 —— 两根同源
    expect(pickMsg(cap.lines, '[omd/executor-dag] 产物根跑前跑后不一致 → 不救 filesTouched 空 (fail-closed)')).toEqual([]);
    // 救援① 必中: 判词在
    expect(pickMsg(cap.lines, '[omd/executor-dag] filesTouched 空但声明产物内容变了 → 判真写入 (疑经 bash 等非受控工具), 补进 filesTouched').length).toBe(1);
  });

  // G-2 ★ 同形但产物内容没变 ⇒ 救援① 不命中 (承重: 修准不是修松)
  test('G-2 隔离档下产物内容不变 ⇒ 救援① 不命中 (D-2 承重: 没干活不能救活)', async () => {
    const r = await runOnce({
      outputPath: 'src/hello.md',
      isolation: true,
      execTreeExists: true, // 文件已存在 + baseline 内容
      agentText: '看了一眼, 不用改。',
      // 故意不传 sideEffect —— 盘上文件不动, 哈希与跑前一致
    });
    // 修后: 救援① 不命中 (哈希未变) → 落回空产物闸 → 节点 failed
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('empty-artifact');
    // 救援① 的判词**不应**出现
    expect(pickMsg(cap.lines, '[omd/executor-dag] filesTouched 空但声明产物内容变了 → 判真写入 (疑经 bash 等非受控工具), 补进 filesTouched')).toEqual([]);
  });

  // G-3 ★ 非隔离档 (无 execRoot) ⇒ 行为与今天逐字相同 (INV-3 零回归)
  test('G-3 非隔离档 (无 execRoot) ⇒ preRoot 回退 repoRoot, 救援① 命中路径不变', async () => {
    // 与 G-1 同样: leaf 用 bash 改产物, 但**不**传 execRoot。
    //   preRoot 解析链 = repoRoot ?? cwd —— 这里 repoRoot = execTree (单根),
    //   与跑后 root (artifactRoot = r.cwd = execTree) 同源 ⇒ 守卫不触发, 救援① 命中。
    //   这一条钉的是 INV-3: 不传 execRoot 时取值与今天逐字相同 (即没改根解析),
    //   所以今天本来就能跑通的行为不会被本片改坏。
    const r = await runOnce({
      outputPath: 'src/hello.md',
      isolation: false,
      sideEffect: (tree) => writeFileSync(join(tree, 'src/hello.md'), '// 新内容\n'),
    });
    expect(r.results.W!.status).toBe('done');
    expect(r.results.W!.filesTouched).toEqual(['src/hello.md']);
    // 守卫不触发 —— 单根场景本来就不触发
    expect(pickMsg(cap.lines, '[omd/executor-dag] 产物根跑前跑后不一致 → 不救 filesTouched 空 (fail-closed)')).toEqual([]);
  });
});
