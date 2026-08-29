/**
 * src/mcp/tools/goal-writeset-review-wiring.test —— 盘点表 #3 + #4 的注入面接线。
 *
 * 盘点: `docs/plan/2026-08-30-unwired-inventory.md` 主表 #3 (`RunGoalConfig.writeSet`) / #4
 * (`RunGoalConfig.designReview`)。两条的闸体、纯核、单测早就建成, 缺的只是**唯一生产
 * `runGoal` 调用点** (`goal.ts` 的 `deps.runGoal(...)`) 上那一个字段 —— 于是
 * `if (config.writeSet)` / `if (config.designReview)` 在 solve 路径上恒假,
 * 写集归属阶梯 + writeScope + sliceCoverage 三个读数与整条设计审核一次都没跑过。
 *
 * ## 这条网钉的是"注入了什么", 不是"闸判得对不对"
 *
 * 判定本身在 `harness/writeset/write-set.ts` 与 `harness/goal/design-review.ts`, 各自有单测。
 * 这里只钉接缝: **传没传 · 传的值从哪来 · 什么时候不传**。替身 `runGoal` 把 config 收下即可,
 * 不需要真跑一趟 DAG。
 *
 * ## 反向自检 (每条都写了怎么把它弄红)
 *
 * ⚠ 「无 SDD → 不注入」那条是**反向的**: 它证明的是行为红线 —— 接线前后逐字节相同。
 * 把注入做成无条件 (漏掉 `sddWriteSetFace` 里的 `if (!sddPath) return undefined`) 时它才红,
 * 而那正是最容易犯的错: `declared` 缺席会让 run-goal.ts:1958 兜底到 `SDD_DECLARED_WRITE_SET`
 * —— 2026-08-10 那一趟 SDD run 自己的写面 —— 于是每个动 `src/model/**` 的活凭空判红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGoalTool, type GoalToolDeps } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';

type SeenConfig = Parameters<GoalToolDeps['runGoal']>[1];

/** 分解表壳 (与 goal-ignition-dryrun.test 同款; 本测试不复述 parseBreakdown 的自检)。 */
const tableShell = (rows: string[]): string =>
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

/**
 * 两片, 各带 `+ test` 简写 —— 并集应当是 4 条路径 (两片各展开成 实装 + 同名 test)。
 * 两片写集**不相交**是硬要求: 相交的 SDD 在 D3 空跑闸就被同步拒 (「并发跑会互相覆盖」),
 * 根本走不到注入点 —— 所以「并集去重」这一格在这条路上不可达, 不在这里假装测它。
 */
const SDD_OK = tableShell([
  '| 1 a | src/foo.ts + test | — | bun test src/foo.test.ts |',
  '| 2 b | src/bar.ts + test | 1 | bun test src/bar.test.ts |',
]);
/** 分解段没有表 → parseBreakdown 抛。首跑走不到 (D3 fatal 闸先拒), 只有真续跑够得着。 */
const SDD_BROKEN = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n散文没有表\n## 非目标\n- 无';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * 非 git 的临时仓 —— T-3 契约入库闸在这里**缺席** (fail-open), 于是不必为了测注入面
 * 去 `git init` + commit 一份契约 (单一变量: 这组测的是注入, 不是点火闸)。
 */
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-ws-review-'));
  dirs.push(d);
  return d;
};

const tmpSdd = (root: string, text: string): string => {
  const p = join(root, 'docs', 'plan', 'sdd.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

const emptyResult = (goal: string): RunGoalResult => ({
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
});

/** 起一个 goal 工具 + 一个把 config 收下的替身 runGoal。 */
function make(root: string) {
  const seen: { config?: SeenConfig } = {};
  const registry = new RunRegistry();
  const tool = createGoalTool({
    runGoal: async (goal: string, config: SeenConfig) => {
      seen.config = config;
      return emptyResult(goal);
    },
    runRegistry: registry,
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    // 续跑那条路要它 (`resume` 无 continuity 直接拒); 首跑各条不受影响。
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
  } as never);
  return { tool, seen, registry };
}

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

/** runGoal 是 fire-and-forget (handler 不等它) —— 让出一轮再读 config。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

// ═══════════════════════════════════════════════════════════════════════════
// #3 写集对账
// ═══════════════════════════════════════════════════════════════════════════

describe('★ 盘点表 #3 —— D-2 写集对账的生产注入面', () => {
  test('★ 有 SDD → declared.allowed = 分解表写集并集 (顺序照表, `+ test` 简写已展开)', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    const out = await call(tool, { goal: '按 SDD 干活', sddPath: tmpSdd(root, SDD_OK) });
    expect(out.isError).toBeUndefined();
    await settle();

    // 证伪: 删掉 runGoal 调用里的 `...(writeSetFace ? { writeSet: writeSetFace } : {})` → 全红。
    // 值来源 = `ticketFieldsFromSdd` (与开票那条同一个函数同一份合同); 换成别的解析路径,
    // 「+ test」简写展开或去重任一处不同, 下面这条当场红。
    expect(seen.config?.writeSet?.declared?.allowed).toEqual([
      'src/foo.ts',
      'src/foo.test.ts',
      'src/bar.ts',
      'src/bar.test.ts',
    ]);
  });

  test('★ forbidden 恒空 —— 分解表没有"禁写"那一列, 没有的东西不硬造', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    await call(tool, { goal: '按 SDD 干活', sddPath: tmpSdd(root, SDD_OK) });
    await settle();
    // 面外文件由 classifyWriteScope 判 'outside' (INV-3 读数, 不红) —— 那一格就是为这个留的。
    // 证伪: 往 forbidden 里塞任何猜测值 (如 `['src/model/**']`) → 这条红。
    expect(seen.config?.writeSet?.declared?.forbidden).toEqual([]);
  });

  test('★ 不注入 `_collectChangedFiles` —— diff 面走 run-goal 缺省 (config.cwd 那棵树)', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    await call(tool, { goal: '按 SDD 干活', sddPath: tmpSdd(root, SDD_OK) });
    await settle();
    // 隔离档下 `config.cwd` 是 worktree —— run-goal 的缺省 `collectChangedFiles(config.cwd)`
    // 天然对着**执行那棵树**。在这里注入一个烤死主仓 cwd 的收集器, 隔离档会对着空 diff 对账。
    // 证伪: 补一个 `_collectChangedFiles` 进注入面 → 这条红。
    expect(seen.config?.writeSet?._collectChangedFiles).toBeUndefined();
    expect(seen.config?.writeSet?.globalExempt).toBeUndefined();
    expect(seen.config?.writeSet?.intentional).toBeUndefined();
  });

  test('★★ 行为红线: 无 SDD → 整个 writeSet 字段不传 (闸缺席, 与接线前逐字节相同)', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    const out = await call(tool, { goal: '没有 SDD 的探索型活' });
    expect(out.isError).toBeUndefined();
    await settle();

    // 这是本组最要紧的一条。`goal` 无 SDD 时没有任何声明面, 硬造一个 = 凭空发明判据;
    // 更糟的是传 `{}` (declared 缺席) —— run-goal.ts:1958 会兜底到 `SDD_DECLARED_WRITE_SET`,
    // 那是别人那一趟 run 的写面, 于是每个动 src/model/** 的活凭空判「撞禁写面」红。
    // 证伪: 把注入改成无条件 (`writeSet: writeSetFace ?? {}`) → 这条当场红。
    expect(seen.config?.writeSet).toBeUndefined();
    expect('writeSet' in (seen.config as object)).toBe(false);
  });

  test('★ SDD 读不出写集 (真续跑够得着的那条路) → 不注入, run 照跑 (fail-open)', async () => {
    // 坏 SDD 在**首跑**走不到这里 (D3 fatal 闸先同步拒)。只有真续跑 —— registry 里已有一条
    // failed 记录 —— 才跳过点火闸直达注入点。这条钉的是那时的处置: 声明面缺席, 不掀桌。
    const root = freshRoot();
    const { tool, seen, registry } = make(root);
    const runId = 'resume-me';
    registry.register(runId, { goal: '上一趟', meta: {} });
    registry.start(runId);
    registry.fail(runId, '上一趟挂了');

    const out = await call(tool, { goal: '续跑', resume: runId, sddPath: tmpSdd(root, SDD_BROKEN) });
    expect(out.isError).toBeUndefined();
    await settle();

    // 证伪: 把 `sddWriteSetFace` 的 try/catch 去掉 → handler 抛, 这条红 (且 run 起不来)。
    expect(seen.config?.writeSet).toBeUndefined();
    // 闸缺席 ≠ run 失败: 写集对账是这趟活的读数面, 读不出就不读, 不阻塞执行面。
    // runGoal 真的被调过 (config 收到了) —— 否则上面那条 undefined 是"没跑"而不是"没注入"。
    expect(seen.config).toBeDefined();
    expect(seen.config?.designReview).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #4 设计审核
// ═══════════════════════════════════════════════════════════════════════════

describe('★ 盘点表 #4 —— P4 设计审核的生产注入面', () => {
  test('★ 恒注入 (有无 SDD 都注) —— 该不该审由前端 glob 自闸, 不由点火时的开关', async () => {
    for (const withSdd of [false, true]) {
      const root = freshRoot();
      const { tool, seen } = make(root);
      await call(tool, {
        goal: '一趟写型活',
        ...(withSdd ? { sddPath: tmpSdd(root, SDD_OK) } : {}),
      });
      await settle();
      // 证伪: 删掉调用里的 `designReview: {}` → 两轮都红。
      // 恒注入是安全的: maybeRunDesignReview 先求 改动文件 ∩ 前端 glob, 不相交当场
      // `scheduled:false` 返回, 零模型调用 (INV-6 / G-4)。
      expect(seen.config?.designReview).toBeDefined();
    }
  });

  test('★ 保守缺省: 无 screenshotCommand ⇒ 走 D-10 diff-only, 且不许拿它冒充截图审', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    await call(tool, { goal: '一趟写型活' });
    await settle();
    const dr = seen.config?.designReview;
    expect(dr).toBeDefined(); // 先钉住"注了" —— 否则下面两条 undefined 是"没注"而不是"没给"

    // 全仓没有任何截图命令的约定面 (`screenshotCommand` 仅出现在 run-goal / design-review
    // 两个定义处, 零配置来源) —— 拿不到就不给。不给 ⇒ productionDesignReviewRunner 返
    // undefined ⇒ maybeRunDesignReview 落 D-10 diff-only 文本审。
    //
    // ⚠ 反过来更糟: 给了截图命令却没有 runner, design-review.ts:176 **响亮抛**
    // (它拒绝拿 diff-only 冒充"看过截图")。宁可审得浅, 不许审得假。
    // 证伪: 在注入面里编一个 `screenshotCommand: './.omd/screenshot.sh'` → 这条红。
    expect(dr?.screenshotCommand).toBeUndefined();
    // `_runReview` 是测试注入口, 生产不许走它 (走了就是把替身当成了生产 runner)。
    expect(dr?._runReview).toBeUndefined();
  });

  test('★ profile / escalationSeat / repairAttempted 三格都不给 —— 各自回落到定义处的缺省', async () => {
    const root = freshRoot();
    const { tool, seen } = make(root);
    await call(tool, { goal: '一趟写型活' });
    await settle();
    const dr = seen.config?.designReview!;

    // profile 缺席 ⇒ 'design-review' (profiles/builtin/design-review.json)。抄一份字面量在这里
    // 就等于把缺省钉在两处, 改档案名时漂。
    expect(dr.profile).toBeUndefined();
    // escalationSeat 缺席 ⇒ 回落 dag.conductorEscalationModel (类型定义写明的缺省)。
    expect(dr.escalationSeat).toBeUndefined();
    // repairAttempted 是**三值**语义: 缺席 = 这个调用点没有"第几轮"这个概念 (D-7 的熔断/转票
    // 要外层驱动)。传 `false` 会假装我们判过。证伪: 补上 `repairAttempted: false` → 这条红。
    expect(dr.repairAttempted).toBeUndefined();
    expect(Object.keys(dr)).toEqual([]);
  });
});
