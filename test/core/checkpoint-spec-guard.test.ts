/**
 * T-1a 规格守卫 —— resume 的绿节点复用要问一句「这**还是不是同一个节点**」(2026-08-28)。
 *
 * ## 洞在哪
 *
 * `shouldSkip` 的复用输入面是: status · leafKind · 依赖产出哈希 (D-O) · `generation` · 产物哈希。
 * 其中 `generation = hash(task 前 400 字 + nodeIds + deps)` —— 它签的是图的**形态**。
 * 节点自身的语义字段 (`write_set` / `self_check` / `command` / `model` / `persona` …)
 * **一个都不在里面**: 形态没变而节点内容变了, resume 照样把它当绿跳过。
 *
 * 而这些字段早就被 `merkleFingerprints` 的 `nodeFieldsKey` 逐个签过, 引擎写 checkpoint 时
 * 也早就把值存进了 `NodeCheckpoint.fingerprint`。缺的只是**在 `shouldSkip` 里比一次**。
 *
 * ## 这组测试的判别力在哪 (它为什么不是一条永远绿的闸)
 *
 * 单一变量选的是 **`write_set`**, 不是 `goal` —— 这是刻意的:
 * `runExecutorDagWithPlan` 的 task 由 `deriveTaskFromPlan` 生成, 而 `planOutline` 会把
 * **各节点的 goal 逐行印进去**。所以改 goal 会连带改掉 `generation`, 既有的代数守卫
 * 就抓到了, 拿它当用例等于量一把已经存在的尺子。
 * `write_set` 不进 `planOutline` ⇒ `generation` 逐字节不变 ⇒ **只有指纹这一格看得见**。
 * 「generation 不变」这件事由 ★③ 直接断言, 不靠推理。
 *
 * ## 诚实边界: 这**不是** S-51 的修法
 *
 * S-51 那一格 (契约改了片外的规格、而编译出来的节点逐字节不变) 本组抓不到 ——
 * 节点没变, 指纹按定义就不该变。要抓它得让「该片规格的内容哈希」先进到节点里去
 * (T-1b), 那是另一票。本组只钉「节点自己变了 ⇒ 不许复用」这一半。
 *
 * ## 反向自检 (真跑过)
 * · 摘掉 `shouldSkip` 里那段指纹比对 → ★① 红 (b 被当绿跳过, generate 不再被调)。
 * · 把接线点的 `fingerprint` 不传 (闸缺席) → ★① 红。
 * · 把 `specChangedNodes` 的透传守卫从 `!== undefined` 改成 `.length` → ★⑥ 红
 *   (「resume 了但没变」被压成缺席, 与「不是 resume」再也分不开 —— 仓规坑 ①)。
 * · 把「两侧任一缺席 → 退回原语义」改成「缺席即不匹配」→ ★⑤ 红。
 *   ⚠ 这一条起初写的是「★② 红」, 实测**不红** —— 引擎那条路两侧恒有指纹, 根本走不到
 *   fail-open 那一格。★⑤ 才是真覆盖它的那条 (直接问 `shouldSkip`)。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager, computeDagGeneration } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 'spec-guard-run';
let root: string;
let manager: CheckpointManager;
let savedDataHome: string | undefined;

beforeEach(() => {
  // OMD_DATA_HOME 设了会把 checkpoint 改写到共享 ~/.omd/…/continuity → 固定 runId 跨用例泄漏。
  savedDataHome = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-specguard-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (savedDataHome === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = savedDataHome;
  rmSync(root, { recursive: true, force: true });
});

/** a → b。`write_set` 是本组的单一变量 —— 它不进 planOutline, 所以 generation 看不见它。 */
const planWith = (bWriteSet: string[]): ConductorPlan =>
  ({
    name: 'spec-guard',
    nodes: {
      a: { goal: '产出 A' },
      b: { goal: '消费 A', depends_on: ['a'], write_set: bWriteSet },
    },
  }) as ConductorPlan;

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '?';

/** 注入式 generate: 只记谁被真调起来了。`a` 的产出恒定, 免得 D-O 输入面守卫抢戏。 */
const fake = (): { generate: GenerateFn; calls: string[] } => {
  const calls: string[] = [];
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user')?.content;
    const id = leafId(typeof user === 'string' ? user : '');
    calls.push(id);
    return { text: id === 'a' ? 'A-固定产出' : `B(${id})`, usage: { in: 1, out: 1 } };
  };
  return { generate, calls };
};

const cfg = (generate: GenerateFn, resume: boolean): ExecutorDagConfig => ({
  conductorModel: 'fixture:none',
  leafModel: 'fixture:none',
  generate,
  agentTemplates: new Map(),
  continuity: { manager, runId: RUN, repoRoot: root, ...(resume ? { resume: true } : {}) },
});

describe('T-1a 规格守卫 · resume 复用要问「还是不是同一个节点」', () => {
  test('★① 节点的 write_set 变了 → resume 不许当绿跳过, b 真重跑', async () => {
    const first = fake();
    await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(first.generate, false));
    expect(first.calls.sort()).toEqual(['a', 'b']);

    // 单一变量: 只有 b 的 write_set 变了。id / deps / goal / task 一字未动。
    const second = fake();
    await runExecutorDagWithPlan(planWith(['src/new.ts']), cfg(second.generate, true));

    // b 必须真被调起来 —— 它的规格变了, 上一跑那份绿证明的是**另一个节点**。
    expect(second.calls).toContain('b');
  });

  test('★② 什么都没变 → 照旧复用, a 与 b 都不重跑 (闸不许把省钱那条路一起掐了)', async () => {
    const first = fake();
    await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(first.generate, false));

    const second = fake();
    await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(second.generate, true));

    // 一个都不该被调起来。这条是 ★① 的对照臂: 只有它绿, ★① 的红才说明问题。
    expect(second.calls).toEqual([]);
  });

  test('★③ 判别力自证: 改 write_set 时 generation 逐字节不变 (所以只有指纹看得见)', () => {
    // 这条不跑引擎, 直接量那把尺子: `computeDagGeneration` 的输入面里根本没有 write_set。
    // 它红 = 本组的单一变量选错了 (改 write_set 也动了 generation), 那时 ★① 量的就是既有的
    // 代数守卫, 不是新加的这道。
    const outline = (p: ConductorPlan) => ({
      goal: `spec-guard\n\n===== 已裁决的执行分解 =====\n- [a]: 产出 A\n- [b] (depends_on: a): 消费 A`,
      nodeIds: Object.keys(p.nodes),
      deps: Object.fromEntries(Object.entries(p.nodes).map(([k, n]) => [k, (n as { depends_on?: string[] }).depends_on ?? []])),
    });
    expect(computeDagGeneration(outline(planWith(['src/old.ts'])))).toBe(
      computeDagGeneration(outline(planWith(['src/new.ts']))),
    );
  });

  test('★⑤ 两侧任一缺席 → 退回原语义 (fail-open: 缺席不是不匹配)', async () => {
    // 直接问 `shouldSkip`, 不经引擎 —— 引擎那条路两侧恒有指纹, 走不到这一格。
    // 它管的是**旧 checkpoint** 与**运行时展开的子节点** (预载那刻还不在图里, 算不出当前指纹)。
    // 把这一格判成不匹配 = 每次 resume 全图重跑, 省钱那条路整个没了。
    const first = fake();
    await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(first.generate, false));

    // 调用方不给指纹 (闸缺席) → 照旧跳过
    expect(manager.shouldSkip(RUN, 'b', undefined, undefined, {})).toBe(true);
    // 给一个对不上的 → 不跳 (这条同时证明上面那个 true 不是因为整段判定失效)
    expect(manager.shouldSkip(RUN, 'b', undefined, undefined, { fingerprint: '对不上的指纹' })).toBe(false);
  });

  test('★⑥ 摘要读数出声 (S-51 抓法 ③): 三格分明 —— 缺席 / 0 / 非空', async () => {
    // S-51 那次的病灶不是「闸没拦住」, 是「拦住了没人知道」: run 摘要只说「复用 6 节点」。
    // 这一条钉的是**读数存在且分得开三格**, 不是钉摘要的措辞。
    const first = fake();
    const r0 = await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(first.generate, false));
    // 格一: 不是 resume ⇒ 字段**缺席**。这不是「0 个失效」, 是「这一问不适用」。
    expect(r0.specChangedNodes).toBeUndefined();

    const second = fake();
    const r1 = await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(second.generate, true));
    // 格二: resume 了, 而一片都没失效 ⇒ **空数组**, 不是缺席。
    expect(r1.specChangedNodes).toEqual([]);

    const third = fake();
    const r2 = await runExecutorDagWithPlan(planWith(['src/new.ts']), cfg(third.generate, true));
    // 格三: b 的规格变了 ⇒ 点名 b。a 没变, 不该混进来。
    expect(r2.specChangedNodes).toEqual(['b']);
  });

  test('★④ 上游没变时不受下游牵连 (每片一份哈希, 不是整份文档一份)', async () => {
    // merkle: fp(n) = hash(fields(n) + 前驱 fp)。改 b 只动 b 自己 —— a 没有前驱、字段没变,
    // 指纹不动 ⇒ 仍复用。整份文档一份哈希的做法会让这条红, 而那种闸会被人关掉。
    const first = fake();
    await runExecutorDagWithPlan(planWith(['src/old.ts']), cfg(first.generate, false));

    const second = fake();
    await runExecutorDagWithPlan(planWith(['src/new.ts']), cfg(second.generate, true));

    expect(second.calls).not.toContain('a');
  });
});
