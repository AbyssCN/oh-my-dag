/**
 * acceptance-probe —— **探针裁决的五种终局** (2026-08, G4 · 5-kind 冻结契约)。零 live 模型 (generate 全注入)。
 *
 * 判出执行型之后, vet 在开跑前跑两道探针 (空世界自检 / 反面样本), 加上分类本身的失败与
 * 模型自己选探索型, 终局共五种, 各自落进 `acceptanceProbe` 一格:
 *
 * | 终局 | kind | acceptance 之后 | why 来源 |
 * |---|---|---|---|
 * | passed-both | `passed-both` | 执行型, 原样 | — |
 * | vacuity-only | `vacuity-only` | 执行型, fail-open 保留 | 判别探针跳过的原话 (没有就省略) |
 * | demoted | `demoted` | 探索型 | 探针 / 闸的原话 |
 * | skipped | `skipped` | **两种都有** (见下) | 失败原文 (**必填**) |
 * | exploratory | `exploratory` | 探索型, 无探针 | — |
 *
 * ⚠ `skipped` 覆盖**两类"没跑成"**, 靠 `why` 区分, 且**去向不同** ——
 *   ① **分类本身没跑成** (无分类器 / 解析失败) → 落保守档探索型;
 *   ② **探针没跑成** (fail-open, 如没给 runner) → **仍是执行型**, 不降级。
 *   合成一个 kind 是刻意的: 账本要答的是"这条判据过了几道闸", 而两者都是"少过了一道";
 *   要追到底是哪一类, `why` 里有原话。**但别把 ② 记成 `vacuity-only`** ——
 *   那个词的意思是"空世界那道跑了", 用在空世界没跑成的格上标签正好是反的 (2026-08-03 修过一次)。
 *
 * 本文件专盯**终局可达性 + `why` 的逐字性**: 每种终局都从真实 classify→vet 流走进去 (注入
 * generate / runCommand, 探针照常真跑), 断言钉在**冻结文本字面量**上 —— 终局被省略、被改标签、
 * 或 why 丢字, 测试就红。探针各自的判定逻辑在 acceptance.test.ts 已有契约测试, 这里不重复;
 * 也不把 vet 的分支逻辑抄进测试 —— 断言的是**结果**, 不是实现。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGoal } from './classify-acceptance';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { GenerateFn, ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { CommandLeafRunner } from '../leaf-runners';

const gen = (text: string): GenerateFn => async () => ({ text, usage: { in: 1, out: 1 } });

/** 冻结文本字面量 (acceptance.ts 里逐字的那几串 —— 断言钉字面量, 不引用实现内部常量, 免得测的是实现自己)。 */
const VACUOUS_WHY =
  '[vacuous] 这条验收命令在**活还没干之前**就已经满足 (退出码 0 = 期望值) —— ' +
  '它区分不了"做完了"与"还没做", 因此它不是一条判据。';
const UNDISCRIMINATING_WHY =
  '[undiscriminating] 这条验收命令在一份**明显错**的产物上**照样通过**(退出码 0 = 期望值) —— ' +
  '对的答案和错的答案都满足它, 因此它判不了成败。反面样本: `docs/from-api.md` = "目标数: 100"';
const NO_NEGATIVE_SAMPLE_WHY = '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)';
const BLOCKED_WHY = "[blocked not-allowed: 'pytest' ∉ allowlist]";
const NO_CLASSIFIER_WHY = '无分类器 (缺 generate/model)';
const MALFORMED_EXPLORATORY_WHY = '探索型缺学习目标或可承受损失';

/** 空世界自检的注入 runner: 退出码即裁决 (0 = 空世界里就绿 = 虚判据; 非 0 = 红 = 通过自检)。 */
const runExit = (exitCode: number) => async () => ({ exitCode });

/** 执行段的假 _runDag: 只回一份"内环判收敛"的 leaf, 不真跑图。 */
const fakeExecuteDag: NonNullable<RunGoalConfig['_runDag']> = async () =>
  ({
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      execute: {
        id: 'execute', status: 'done', kind: 'conductor', output: '[conductor 子图]',
        deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true,
      },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;


describe('五种终局 —— 真实 classify→vet 流', () => {
  describe('① passed-both —— 两道探针都真跑且都过', () => {
    test('空世界红 + 反面样本上命令失败 → 执行型原样收下, kind=passed-both, 无 why', async () => {
      const c = await classifyGoal('把目标数写进 docs/from-api.md', {
        generate: gen(
          JSON.stringify({
            tier: 'simple',
            acceptance_kind: 'executable',
            command: 'grep -qx "目标数: 100" docs/from-api.md',
            negative_sample_path: 'docs/from-api.md',
            negative_sample_content: '还没有这个数', // 明显错的产物里没有那行 → 命令失败
          }),
        ),
        model: 'c:m',
        runCommand: runExit(1), // 空世界里是红的 → 空世界自检过
      });
      // 判别力探针是真跑的 (临时目录里真 grep) —— 不是构造出来的联合值。
      expect(c.acceptance).toEqual({
        kind: 'executable',
        command: 'grep -qx "目标数: 100" docs/from-api.md',
        expectExit: 0,
      });
      expect(c.acceptanceProbe).toEqual({ kind: 'passed-both' });
    });
  });

  describe('② 少过一道闸 —— vacuity-only (没给样本) 与 skipped (探针没跑成), 都不降级', () => {
    test('分类器没给反面样本 → why 逐字, 执行型 fail-open 保留', async () => {
      const c = await classifyGoal('g', {
        generate: gen(
          JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'grep -qx "目标数: 100" docs/from-api.md' }),
        ),
        model: 'c:m',
        runCommand: runExit(1),
      });
      // 探针没走到裁决不降级 —— 这条判据只过了空世界一道闸, 但执行型仍在。
      expect(c.acceptance.kind).toBe('executable');
      expect(c.acceptanceProbe).toEqual({ kind: 'vacuity-only', why: NO_NEGATIVE_SAMPLE_WHY });
    });

    /**
     * ⚠ 这条断言原本写的是 `{ kind: 'vacuity-only' }` —— **错的, 而且它自己的注释就打自己的脸**:
     * 注释说"空世界自检根本没跑", 而 `vacuity-only` 的意思恰恰是"空世界那道跑了、判别那道没跑"。
     * 散文写对了, 断言写反了, 于是这条测试**把缺陷固化了下来**(tsc 与全量 test 当时 2159 全绿)。
     *
     * 抓到它的是本仓的 verifier(判词点名 `acceptance.ts:524-542` 的状态映射不符契约),
     * 不是任何机械 oracle。留这段注解当样本:**「测试绿」不等于「语义对」**,
     * 尤其当测试与实现由同一次改动一起产出时 —— 它们会一起错, 而且互相背书。
     */
    test('没给 runner (空世界自检 fail-open) → skipped 且带 why (不是 vacuity-only)', async () => {
      const c = await classifyGoal('g', {
        generate: gen(
          JSON.stringify({
            tier: 'simple',
            acceptance_kind: 'executable',
            command: 'grep -qx "目标数: 100" docs/from-api.md',
            negative_sample_path: 'docs/from-api.md',
            negative_sample_content: '还没有这个数',
          }),
        ),
        model: 'c:m',
        // 不传 runCommand → 空世界自检根本没跑; 判别探针是好的 → 只有一道闸真跑了, 而且是**判别那道**。
      });
      expect(c.acceptance.kind).toBe('executable');
      // fail-open 语义不变 (仍是 executable, 没降级), 但账本要如实记"有一道没跑成"并说清哪一道。
      expect(c.acceptanceProbe?.kind).toBe('skipped');
      expect((c.acceptanceProbe as { why: string }).why).toContain('空世界自检未能运行');
    });
  });

  describe('③ demoted —— 任一探针响 / 闸拒 → 降级探索型, why 逐字', () => {
    test('g4 · 空世界自检响 (活没干就绿) → why=探针原话逐字', async () => {
      const c = await classifyGoal('g', {
        generate: gen(JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'cat README.md' })),
        model: 'c:m',
        runCommand: runExit(0), // 空世界里就绿 = 恒真判据
      });
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'demoted', why: VACUOUS_WHY });
      // 学习目标把探针原话 + 原命令带走 —— 下一步的人看得到被拒的是哪条。
      if (c.acceptance.kind === 'exploratory') {
        expect(c.acceptance.learningGoal).toContain(VACUOUS_WHY);
        expect(c.acceptance.learningGoal).toContain('cat README.md');
      }
    });

    test('g4 · 反面样本上命令照样过 → why=判别探针原话逐字 (含样本原文)', async () => {
      const c = await classifyGoal('g', {
        generate: gen(
          JSON.stringify({
            tier: 'simple',
            acceptance_kind: 'executable',
            command: 'grep -qx "目标数: 100" docs/from-api.md',
            negative_sample_path: 'docs/from-api.md',
            negative_sample_content: '目标数: 100', // 明显错的产物里就有那行 → 命令照样过
          }),
        ),
        model: 'c:m',
        runCommand: runExit(1), // 空世界是红的 —— 这次降级是反面样本探针判的, 不是空世界
      });
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'demoted', why: UNDISCRIMINATING_WHY });
    });

    test('blocked · 闸拒且重试后仍拒 → why=闸的原话逐字 (重试那次为准)', async () => {
      const blocked = JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'pytest -q' });
      const prompts: string[] = [];
      const twoShot: GenerateFn = async (req) => {
        prompts.push(String(req.messages[0]?.content ?? ''));
        return { text: blocked, usage: { in: 1, out: 1 } };
      };
      const c = await classifyGoal('g', { generate: twoShot, model: 'c:m' });
      expect(prompts).toHaveLength(2); // 只重问一次
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'demoted', why: BLOCKED_WHY });
      // 重试必须带上闸的原话 —— why 与第二次重问用的是同一串, 不重写。
      expect(prompts[1]).toContain(BLOCKED_WHY);
    });
  });

  describe('④ skipped —— 分类调用/解析失败 → 保守档, 不抛 (fail-open)', () => {
    test('generate 抛错 → why=失败原文逐字, 全保守档 (complex + 探索型)', async () => {
      const boom: GenerateFn = async () => {
        throw new Error('429');
      };
      const c = await classifyGoal('g', { generate: boom, model: 'c:m' });
      expect(c.tier).toBe('complex');
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'skipped', why: 'Error: 429' });
    });

    test('无 generate/model → 同一终局, why=缺件原话逐字', async () => {
      const c = await classifyGoal('g', {});
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'skipped', why: NO_CLASSIFIER_WHY });
    });

    test('探索型缺学习目标/可承受损失 → 空壳分型退回, why=原话逐字', async () => {
      const c = await classifyGoal('g', {
        generate: gen(JSON.stringify({ tier: 'complex', acceptance_kind: 'exploratory', learning_goal: '学点东西' })),
        model: 'c:m',
      });
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe).toEqual({ kind: 'skipped', why: MALFORMED_EXPLORATORY_WHY });
    });
  });

  describe('⑤ exploratory —— 模型自己选的探索型 (无探针、无降级)', () => {
    test('齐全的学习目标 + 可承受损失 → 原样收下, kind=exploratory, 不重问', async () => {
      const prompts: string[] = [];
      const spy: GenerateFn = async (req) => {
        prompts.push(String(req.messages[0]?.content ?? ''));
        return {
          text: JSON.stringify({
            tier: 'complex',
            acceptance_kind: 'exploratory',
            learning_goal: '摸清有几种可行的 checkpoint 布局',
            affordable_loss: '两轮执行 + 一次真跑',
          }),
          usage: { in: 1, out: 1 },
        };
      };
      const c = await classifyGoal('g', { generate: spy, model: 'c:m' });
      expect(prompts).toHaveLength(1); // 不是降级 → 不重问
      expect(c.acceptance).toEqual({
        kind: 'exploratory',
        learningGoal: '摸清有几种可行的 checkpoint 布局',
        affordableLoss: '两轮执行 + 一次真跑',
      });
      expect(c.acceptanceProbe).toEqual({ kind: 'exploratory' });
    });
  });
});

/**
 * runGoal 的 **onClassified** —— 分类定稿后恰好调一次, 且带的是**定稿后**的探针裁决
 * (production 接线: `_classify` 缺席时回落真实 classifyGoal→vet, 回调拿到的就是 vet 盖完章的终局)。
 */
describe('runGoal — onClassified 暴露定稿后的 acceptanceProbe', () => {
  const baseCfg = (dag: Partial<ExecutorDagConfig> = {}): RunGoalConfig => ({
    cwd: mkdtempSync(join(tmpdir(), 'omd-probe-')),
    dag: { conductorModel: 'c:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-08-01',
    _runDag: fakeExecuteDag,
  });

  test('恰好调一次, 收到的是 _classify 返回的**同一个对象**, 且先于 _runDag', async () => {
    const classified = {
      tier: 'simple' as const,
      acceptance: { kind: 'executable' as const, command: 'bun test', expectExit: 0 },
      acceptanceProbe: { kind: 'demoted' as const, why: '探针原话' },
    };
    const order: string[] = [];
    let received: unknown;
    await runGoal('g', {
      ...baseCfg(),
      _classify: async () => classified,
      onClassified: (c) => {
        order.push('onClassified');
        received = c;
      },
      _runDag: (async (plan, dag) => {
        order.push('_runDag');
        return fakeExecuteDag(plan, dag);
      }) as RunGoalConfig['_runDag'],
    });
    expect(received).toBe(classified); // 同一引用 —— 回调拿到的就是定稿那一份, 不是副本
    expect(order).toEqual(['onClassified', '_runDag']); // 在进图与任何运行记录之前
  });

  test('production 接线 (_classify 缺席): 真实 classify→vet 走完, 回调拿到定稿终局', async () => {
    let received: { acceptanceProbe?: unknown } | undefined;
    const cmdRunner: CommandLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 1 }); // 空世界红
    await runGoal('把目标数写进 docs/from-api.md', {
      ...baseCfg({
        generate: gen(
          JSON.stringify({
            tier: 'simple',
            acceptance_kind: 'executable',
            command: 'grep -qx "目标数: 100" docs/from-api.md',
            negative_sample_path: 'docs/from-api.md',
            negative_sample_content: '还没有这个数',
          }),
        ),
        commandRunner: cmdRunner,
      }),
      onClassified: (c) => {
        received = c;
      },
    });
    // 回调看到的是 vet 盖完章的定稿: 两道探针都真跑且都过 → passed-both, 执行型原样。
    expect(received?.acceptanceProbe).toEqual({ kind: 'passed-both' });
  });

  test('_classify 抛错 → 不调 (没有定稿的分类可持久化)', async () => {
    let called = 0;
    expect(
      runGoal('g', {
        ...baseCfg(),
        _classify: async () => {
          throw new Error('分类炸了');
        },
        onClassified: () => {
          called += 1;
        },
      }),
    ).rejects.toThrow('分类炸了');
    expect(called).toBe(0);
  });
});
