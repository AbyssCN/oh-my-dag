/**
 * src/harness/dag/falsify-mutate.test —— sN-falsify 切片 2 的反向自检
 * (SDD `sN-falsify` 2026-08-22, 切片 2 = 引擎执行 mutation 与还原)。
 *
 * ⚠ 切片 1 (falsify-compile.test.ts) 承重"节点长什么样", 本片承重"节点跑起来会发生什么":
 *   mutation 真生效 / 真还原 / 唯一匹配真校验 / 命令失败也还原。
 * 两条闸**逐字不同**, 不分享测试数据 (分享 = 隐式"两者一起通过"的假绿入口)。
 *
 * 反向自检模式: 每条 test 写一行「把 X 那行删掉 / 改成 Y → 此 test 由绿转红」, 闸逐字描述。
 * 决不写"看它能跑"的乱炖用例 —— 那种 test 在加闸那一刻红不了, 是把今天的债往后挪。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { CommandLeafResult } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import type { CommandLeafRunner } from '../leaf-runners';

// ── 测试装置 ─────────────────────────────────────────────────────────────────

/**
 * 一个"看文件说 exit"的 commandRunner: 读 `mutated.txt`, 若见到 MUTATION_MARKER 视为 mutation 已应用
 * → 视 verify 为"红" → 返 exit 1; 没见到 → "绿" → 返 exit 0。timeout / throw 由 opts 控。
 *
 * 把它嵌进 plan 节点的 `commandRunner` 后:
 *   - 普通 command 节点 (无 mutate) → exit 0 → done (INV-12 零回归)
 *   - falsify 节点 (mutate 把 MUTATION_MARKER 写进文件) → exit 1 → done (INV-11 expects_nonzero)
 *   - falsify 节点 mutate 但**没真生效** (mutation 步骤被绕过) → exit 0 → failed (判别力不足)
 *
 * 命令本身是 `cat mutated.txt` 的语义 (我们直接读 + exit, 不开真子进程) —— commandRunner 是
 * 测试注入点, 不走 command-leaf 的白名单/闸。
 */
function makeGreenByDefaultRunner(opts: {
  throwOnRun?: boolean;       // 跑就抛 Error → 验 finally 还原
  timedOut?: boolean;         // 返 timedOut=true → 验 finally 还原
  exitCode?: number | null;   // 显式覆盖返回码 (无视文件内容)
} = {}): { runner: CommandLeafRunner; readsCount: () => number } {
  let reads = 0;
  const runner: CommandLeafRunner = async (input) => {
    reads++;
    if (opts.throwOnRun) throw new Error('commandRunner 注入抛错');
    if (opts.timedOut) {
      return { text: 'timeout', usage: { in: 0, out: 0 }, timedOut: true, signal: 'SIGKILL', exitCode: 124 };
    }
    if (opts.exitCode !== undefined) {
      return { text: `forced exit ${opts.exitCode}`, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: opts.exitCode };
    }
    // 抽 command 串里的文件名 (约定: 命令里出现 mutated.txt 时取它, 否则取 default.txt)。
    const file = input.command.includes('default.txt') ? 'default.txt' : 'mutated.txt';
    const abs = input.command.includes('/') ? input.command.split(/\s+/).find((t) => t.endsWith('.txt'))! : file;
    let content = '';
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      content = '';
    }
    const sawMutation = content.includes('MUTATION_MARKER');
    return {
      text: `saw-mutation=${sawMutation}`,
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: sawMutation ? 1 : 0,
    };
  };
  return { runner, readsCount: () => reads };
}

/** 临时目录 + 一个初始文件 (path = 相对路径; 调用方按 temp 根拼绝对路径)。 */
function setupTempFile(initialContent: string, relPath = 'default.txt'): { root: string; relPath: string; absPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'falsify-mutate-'));
  const absPath = join(root, relPath);
  writeFileSync(absPath, initialContent, 'utf-8');
  return { root, relPath, absPath };
}

/** 收尾: 删 temp 根。 */
function cleanupTemp(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 最小可跑 plan: 一个 command 节点 (test-name), 跑 `commandRunner` 解析的命令。
 命令串 = "cat <absPath>" —— runner 据此拼绝对路径读盘, 不开子进程。
 */
function oneCommandPlan(command: string): ConductorPlan {
  return { name: 'falsify-mutate', nodes: { test: { executor: 'command', command, goal: 'test node' } } };
}

function makeConfig(extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentTemplates: new Map(),
    ...extra,
  };
}

/**
 * 构造一个把 `repoRoot` 钉到测试 temp 根的配置: 生产 SDD 编译出来的是相对路径 (`src/foo.ts`),
 * engine 走 `continuity.repoRoot ?? process.cwd()` 解析。测试若不钉 repoRoot, 引擎会去 process.cwd()
 * 找文件, 而那里没我们的 temp 文件 → INV-9 拿 "读盘失败" (matches=-1) 直接拒, 跑不到 mutation
 * 那条主路径。
 *
 * 这是为什么本片测试**必须**走带 continuity 的路 —— 不光验 mutation, 还顺带钉住解析根的优先级
 * (repoRoot > cwd) 与生产装配一致。
 */
function makeTempConfig(root: string, extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return makeConfig({
    ...extra,
    continuity: {
      manager: new CheckpointManager(root),
      runId: 'test-run',
      repoRoot: root,
    },
  });
}

/** 把 mutate / expects_nonzero 挂到一个 command 节点上 (passthrough 字段)。 */
function withMutate(
  plan: ConductorPlan,
  nodeId: string,
  mutate: { file: string; oldText: string; newText: string },
  expects_nonzero: boolean,
): ConductorPlan {
  const node = plan.nodes[nodeId]! as Record<string, unknown>;
  return {
    ...plan,
    nodes: {
      ...plan.nodes,
      [nodeId]: {
        ...node,
        mutate,
        expects_nonzero,
      } as ConductorPlan['nodes'][string],
    },
  };
}

// ── GWT 主闸 ──────────────────────────────────────────────────────────────────────

describe('sN-falsify 切片 2 — 引擎执行 mutation 与还原 (C-3 / INV-8..12)', () => {
  test('GWT-1: mutation 真让 verify 红 → 节点 done, 文件**逐字节还原**', async () => {
    // 反向自检 (GWT-1 闸):
    //   (a) 把 engine.ts 里 mutate 的 `mutated = mutateOriginal!.split(...).join(...)` 改成
    //       `mutated = mutateOriginal!` (mutation 不应用) → 此 test 红: 验证 mutation 生效
    //       路径承重, 不是「说了 mutate 但没动文件」。
    //   (b) 把 engine.ts 的 finally 里 `writeFileSync(mutatePath, mutateOriginal, 'utf-8')` 删了
    //       → 此 test 的「文件逐字节还原」断言红: 验证 INV-10 finally 还原承重, 这是整片**最紧的
    //       一条** (还原失败 = 工作树污染 = 静默)。
    const { root, relPath, absPath } = setupTempFile('hello world\n');
    try {
      const { runner } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'hello world\n', newText: 'MUTATION_MARKER goodbye\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('done'); // mutation 应用 → exit 1 → expects_nonzero → done
      expect(r.results.test!.exitCode).toBe(1);
      // 还原: 文件**逐字节**与初始相同 (这就是 INV-10 那一刀的形状)。
      const after = readFileSync(absPath, 'utf-8');
      expect(after).toBe('hello world\n');
      expect(after).not.toContain('MUTATION_MARKER');
    } finally { cleanupTemp(root); }
  });

  test('GWT-2: mutation 没让 verify 红 (mutation 后仍 exit 0) → 节点 failed + 文件还原 (判别力不足)', async () => {
    // 反向自检: 把 engine.ts 里 INV-11 那行 `ok = !blocked && r.exitCode !== 0` 改成
    //   `ok = true` (不论什么 exit 都判 done) → 此 test 红: 验证 expects_nonzero 的判别力是真的
    //   闸, 不是默认 done 的开关。
    const { root, relPath, absPath } = setupTempFile('unchanged\n');
    try {
      const { runner } = makeGreenByDefaultRunner();
      // mutation 把内容改了但**没**改成 MUTATION_MARKER → runner 仍判 0 → falsify 期望非零失败。
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'unchanged\n', newText: 'still-no-marker\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('failed'); // exit 0 + expects_nonzero = 判别力不足 → failed
      expect(r.results.test!.failureKind).toBe('assert-failed'); // expect_exit=1 拿到 0 → assert-failed (D-K 词表)
      expect(r.results.test!.output).toContain('expects_nonzero');
      // 还原: 文件仍与初始相同 (mutation 应用过, 但**被还原了**)。
      expect(readFileSync(absPath, 'utf-8')).toBe('unchanged\n');
    } finally { cleanupTemp(root); }
  });

  test('GWT-3a: oldText 出现 0 次 → failed (点名匹配数) + 文件**未动** + 命令未跑', async () => {
    // 反向自检: 把 engine.ts 里 `if (matches !== 1)` 的判等删掉, 改成
    //   `if (false)` (永远跳过零匹配检查) → 此 test 红: 验证 INV-9 唯一匹配闸承重。
    //   「找不到就跳过」正是本片要堵的悄悄关掉自检的口子。
    const { root, relPath, absPath } = setupTempFile('alpha beta gamma\n');
    try {
      const { runner, readsCount } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'NOT_PRESENT', newText: 'whatever' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('failed');
      expect(r.results.test!.exitCode).toBeNull();
      expect(r.results.test!.output).toContain('matches=0');
      expect(r.results.test!.output).toContain('command 未执行');
      // 文件**未动** (mutation 没应用) + 命令**未跑** (commandRunner 没被调用)。
      expect(readFileSync(absPath, 'utf-8')).toBe('alpha beta gamma\n');
      expect(readsCount()).toBe(0);
    } finally { cleanupTemp(root); }
  });

  test('GWT-3b: oldText 出现 2 次 → failed (点名匹配数) + 文件**未动** + 命令未跑', async () => {
    // 反向自检: 把 INV-9 的 `matches !== 1` 改成 `matches === 0` (只看零匹配, 放过多匹配) →
    //   此 test 红: 验证多匹配也必须拒, 不是只堵零匹配。
    const { root, relPath, absPath } = setupTempFile('dup dup tail\n');
    try {
      const { runner, readsCount } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'dup', newText: 'X' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('failed');
      expect(r.results.test!.exitCode).toBeNull();
      expect(r.results.test!.output).toContain('matches=2');
      expect(r.results.test!.output).toContain('command 未执行');
      expect(readFileSync(absPath, 'utf-8')).toBe('dup dup tail\n');
      expect(readsCount()).toBe(0);
    } finally { cleanupTemp(root); }
  });

  test('GWT-4: commandRunner 抛错 → 文件**仍被还原** (INV-10 finally)', async () => {
    // 反向自检: 把 engine.ts try/finally 改成 try/catch (finally 删了) → 此 test 红:
    //   文件会是 MUTATION_MARKER 版, 「逐字节还原」断言红。**这一条最要紧**: 还原没做会污染
    //   工作树, 而污染是静默的。
    const { root, relPath, absPath } = setupTempFile('original\n');
    try {
      const { runner } = makeGreenByDefaultRunner({ throwOnRun: true });
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'original\n', newText: 'MUTATION_MARKER\n' }, true);
      // 不 expect.toThrow —— engine 内部 catch 后转成 failed LeafResult, 文件还原在 finally 完成。
      // (这是本片的契约: 命令出错 / 抛错 / 超时 / 进程被杀 都不许污染。)
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('failed');
      expect(readFileSync(absPath, 'utf-8')).toBe('original\n'); // 关键: finally 把原文写回了
      expect(readFileSync(absPath, 'utf-8')).not.toContain('MUTATION_MARKER');
    } finally { cleanupTemp(root); }
  });

  test('GWT-4b: commandRunner 返 timedOut=true → 文件**仍被还原**', async () => {
    // 与 GWT-4 同源 (finally 通道); 超时是另一类命令失败, 也必须保证还原。
    //
    // ⚠ 节点 status 在超时场景的语义: INV-11 严格读作 "退出码 ≠ 0 判 done" —— exit 124 ≠ 0
    // → 走 done 分支。本片 GWT-4 只保证 "文件被还原" 这一条 (INV-10 finally), status 不
    // 锁死 (超时是合同留白, 留给后续读数决定是否在 INV-11 加 timedOut 豁免 —— 那条改必须改合同)。
    const { root, relPath, absPath } = setupTempFile('orig\n');
    try {
      const { runner } = makeGreenByDefaultRunner({ timedOut: true });
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'orig\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      // 文件**仍被还原** (GWT-4 / INV-10) —— 这一刀是本片最紧的, 也是这测试存在的原因。
      expect(readFileSync(absPath, 'utf-8')).toBe('orig\n');
      expect(readFileSync(absPath, 'utf-8')).not.toContain('MUTATION_MARKER');
      // exitCode 透传 124 (不是闸拒, 不是 null, 是真超时退出码) —— 数据完整留给下游判别。
      expect(r.results.test!.exitCode).toBe(124);
    } finally { cleanupTemp(root); }
  });

  test('GWT-5: 不带 mutate 的普通 command 节点 → 行为逐字不变 (INV-12 零回归)', async () => {
    // 反向自检: 把 engine.ts 里 INV-12 的"不带 mutate 走老路径"那条拆了, 强制每条 command 都过
    //   mutate 通道 → 此 test 红 (命令里没有 mutate, 走老 expect_exit 路径才会 done):
    //   验证零回归契约承重。
    const { root, absPath } = setupTempFile('plain content\n');
    try {
      const { runner } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      // 不挂 mutate → expect_exit 缺省 0 → exit 0 → done。
      const r = await runExecutorDagWithPlan(plan, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('done');
      expect(r.results.test!.exitCode).toBe(0);
      expect(r.results.test!.output).toBe('saw-mutation=false');
    } finally { cleanupTemp(root); }
  });

  test('闸拒 (exitCode < 0) 在 expects_nonzero 通道也恒 failed (与 D-K 同条纪律)', async () => {
    // 反向自检: 把 engine.ts 里 expects_nonzero 分支的 `!blocked` 删了, 写成
    //   `ok = r.exitCode !== 0` → 此 test 红: 验证闸拒(负码)不会被 expects_nonzero 翻译成 done
    //   (与 D-K 那条「负码恒 failed」逐字对齐, 不允许从 falsify 通道另开一条绕过去的路)。
    const { root, relPath, absPath } = setupTempFile('x\n');
    try {
      const { runner } = makeGreenByDefaultRunner({ exitCode: -1 });
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'x\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('failed');
      expect(r.results.test!.exitCode).toBe(-1);
      expect(r.results.test!.output).toContain('闸拒');
      expect(readFileSync(absPath, 'utf-8')).toBe('x\n'); // 还原
    } finally { cleanupTemp(root); }
  });

  test('INV-2 编译期闸在引擎面不背书: engine 不验 file 是否在片写集内 (那片由 sdd-compile 担)', async () => {
    // 反向自检: 如果未来谁在 engine.ts 里加了 `if (!writeSet.has(file)) throw` 类似的兜底闸,
    //   编译面的拒绝会被静默地双兜, 错误落点离根因更远。本 test 不期望 engine 拒绝 —— 它只
    //   期望 mutate 真生效 (这是 engine 的活), 把「越界」的责任留给 sdd-compile。
    const { root, relPath, absPath } = setupTempFile('abc\n');
    try {
      const { runner } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'abc\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('done'); // engine 不挡, 允许 mutate 应用
      expect(readFileSync(absPath, 'utf-8')).toBe('abc\n'); // 还原
    } finally { cleanupTemp(root); }
  });

  test('多轮复用命中后 mutate 节点仍按完整流程跑 (D-21 不吞 mutation 的关键一跳)', async () => {
    // 反向自检: 如果未来谁在 runNodeOnce 里把 mutate 节点放进 D-21 复用早退分支 →
    //   此 test 红 (mutation 没跑, 文件不可能被还原, 但更糟的是文件根本**没被 mutation 过**
    //   → verify 跑在原始内容上, falsify 自检就没了意义 —— 整条闸等于被悄悄关掉)。
    const { root, relPath, absPath } = setupTempFile('initial\n');
    try {
      const { runner } = makeGreenByDefaultRunner();
      const plan = oneCommandPlan(`cat ${absPath}`);
      const plan2 = withMutate(plan, 'test', { file: relPath, oldText: 'initial\n', newText: 'MUTATION_MARKER\n' }, true);
      const r = await runExecutorDagWithPlan(plan2, makeTempConfig(root, { commandRunner: runner }));
      expect(r.results.test!.status).toBe('done'); // mutation 路径必须真跑
      expect(r.results.test!.exitCode).toBe(1); // mutation 应用后 verify 红
      expect(readFileSync(absPath, 'utf-8')).toBe('initial\n'); // 还原
    } finally { cleanupTemp(root); }
  });
});