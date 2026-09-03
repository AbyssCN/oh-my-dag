/**
 * D-I 验收分型 (2026-07-29) —— 判据轴的契约测试。零 live 模型 (generate 全注入)。
 *
 * 这一站要挡的是**作弊达标**: 执行体把判据改到自己够得着的地方然后诚实地报告"绿了"。
 * 挡法只有一个 —— 动手之前就把判卷标准冻结成一条**别人来跑**的命令。
 * 于是本闸盯三件事: ① 执行型必须拿得出**真跑得起来**的命令 ② 拿不出就诚实降级成探索型而不是
 * 留一个空判据 ③ 探索型必须有学习目标 + 可承受损失 (判不了成败, 至少定得了亏损上限)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceCommandBlockReason, acceptanceVacuityReason, isRunnableAcceptanceCommand } from './acceptance-gate';
import { classifyGoal, classifyPrompt, normalizeClassification, renderAcceptance, type AcceptanceSpec } from './classify-acceptance';
import { DEFAULT_COMMAND_ALLOWLIST } from '../command-leaf';
import type { GenerateFn } from '../dag/types';

const gen = (text: string): GenerateFn => async () => ({ text, usage: { in: 1, out: 1 } });

describe('可跑判定 —— 借执行期那一份闸, 不另抄一份', () => {
  test('白名单内 + 无元字符 → 可跑; && 链每环独立过闸', () => {
    expect(isRunnableAcceptanceCommand('bun test')).toBe(true);
    expect(isRunnableAcceptanceCommand('bun run tsc --noEmit && bun test')).toBe(true);
    expect(isRunnableAcceptanceCommand('bun test src/harness/goal/acceptance.test.ts')).toBe(true);
  });

  test('白名单外 / 元字符 / git 写 / 空 → 不可跑, 且给得出拒因', () => {
    expect(acceptanceCommandBlockReason('pytest -q')).toContain('not-allowed');
    expect(acceptanceCommandBlockReason('bun test; echo done')).toContain('shell-metachar');
    // 刀④ (2026-08-30): 管道本身放行, 但每段过白名单 —— tee 不在表内, 拒因换成 not-allowed。
    expect(acceptanceCommandBlockReason('bun test | tee log')).toContain('not-allowed');
    // 危险命令闸排在白名单/元字符之前 —— 拒因给的是最要紧的那条, 不是最先匹配的那条。
    expect(acceptanceCommandBlockReason('bun test; rm -rf /')).toContain('dangerous');
    // 2026-09-01 (bd1820aa) owner 显式开口放行 `add` / `commit` (commit 流最小集合) ——
    // 本行原先打的是 `git commit -am x`, 那次只改了 git-write-gate 的矩阵, 本行漏改而红。
    expect(acceptanceCommandBlockReason('git checkout .')).toContain('git-write');
    expect(acceptanceCommandBlockReason('   ')).toContain('empty');
  });

  test('&& 链里**任一环**不合法 → 整条不可跑 (fail-closed, 防合法头环先执行)', () => {
    expect(isRunnableAcceptanceCommand('bun test && pytest')).toBe(false);
    expect(isRunnableAcceptanceCommand('bun test && git push')).toBe(false);
  });
});

describe('归一 —— 弱模型每一格都自己兜, 但两条轴兜的方向相反', () => {
  test('执行型 + 可跑命令 → 原样收下 (expectExit 恒 0: 总验收判绿)', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: '  bun test  ' });
    expect(c.tier).toBe('simple');
    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test', expectExit: 0 });
  });

  test('执行型但命令跑不起来 → **降级探索型**, 原因写进学习目标 (不留空判据)', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: 'pytest -q' });
    expect(c.acceptance.kind).toBe('exploratory');
    // 降级必须说得出为什么 —— 否则它和"本来就是探索型"分不开, 而这两件事该被区别对待。
    expect(c.acceptance.kind === 'exploratory' && c.acceptance.learningGoal).toContain('not-allowed');
    expect(c.tier).toBe('simple'); // 成本轴不受判据轴降级牵连
  });

  test('执行型漏给 command → 同样降级 (执行型的全部意义就是那条命令)', () => {
    const c = normalizeClassification({ tier: 'complex', acceptance_kind: 'executable' });
    expect(c.acceptance.kind).toBe('exploratory');
  });

  test('探索型齐全 → 收下; 缺学习目标或可承受损失 → 兜底 (两样都没有 = 什么都没定)', () => {
    const ok = normalizeClassification({
      acceptance_kind: 'exploratory',
      learning_goal: '搞清楚有几种可行的 checkpoint 布局',
      affordable_loss: '两轮执行 + 一次真跑',
    });
    expect(ok.acceptance).toEqual({
      kind: 'exploratory',
      learningGoal: '搞清楚有几种可行的 checkpoint 布局',
      affordableLoss: '两轮执行 + 一次真跑',
    });

    const missing = normalizeClassification({ acceptance_kind: 'exploratory', learning_goal: '学点东西' });
    expect(missing.acceptance.kind).toBe('exploratory');
    expect(missing.acceptance.kind === 'exploratory' && missing.acceptance.affordableLoss).toBeTruthy();
  });

  test('tier 兜底方向 = complex (多接地一遍代价是钱; 误判 simple 代价是无证据契约被执行)', () => {
    expect(normalizeClassification({}).tier).toBe('complex');
    expect(normalizeClassification({ tier: '胡说' }).tier).toBe('complex');
    expect(normalizeClassification({ tier: 'SIMPLE' }).tier).toBe('simple');
  });

  test('判据轴兜底方向 = exploratory (假装机器可判而无人判, 比明说判不了坏得多)', () => {
    expect(normalizeClassification({}).acceptance.kind).toBe('exploratory');
    expect(normalizeClassification({ acceptance_kind: '随便' }).acceptance.kind).toBe('exploratory');
  });
});

describe('分类调用 —— 挂了就往保守档落, 不抛 (分类是路由不是闸)', () => {
  test('正常 JSON (含 ``` 围栏与前后散文) 也能抠出来', async () => {
    const c = await classifyGoal('给引擎加个字段', {
      generate: gen('好的:\n```json\n{"tier":"simple","acceptance_kind":"executable","command":"bun test"}\n```\n完毕'),
      model: 'c:m',
    });
    expect(c.tier).toBe('simple');
    expect(c.acceptance.kind).toBe('executable');
  });

  test('无 generate/model → 全保守档, 不抛', async () => {
    const c = await classifyGoal('g', {});
    expect(c).toEqual({
      tier: 'complex',
      acceptance: expect.objectContaining({ kind: 'exploratory' }),
      acceptanceProbe: { kind: 'skipped', why: '无分类器 (缺 generate/model)' },
      // D-19 / INV-12: classifyGoal 对外恒带一份路由决策 (与 tier/acceptance 同一发合成) ——
      // v1 无模板可命中, 恒 'none' (chain-router.ts 头注 CHAIN_TEMPLATE_IDS 空集)。
      route: { kind: 'none' },
      // R-1 (2026-09-03): 没走 LLM = null (不是 0, 也不是缺席 —— 缺席留给注入式分类器 / 老对象)。
      llmCalls: null,
    });
  });

  test('模型吐垃圾 / 抛错 → 全保守档, 不抛', async () => {
    expect((await classifyGoal('g', { generate: gen('不是 JSON'), model: 'c:m' })).tier).toBe('complex');
    const boom: GenerateFn = async () => {
      throw new Error('429');
    };
    const c = await classifyGoal('g', { generate: boom, model: 'c:m' });
    expect(c.acceptance.kind).toBe('exploratory');
  });

  /**
   * 2026-07-30 第二次 live 冒烟: 模型照 prompt 的形状写了 `grep -q '^hello omd$' notes/hello.md`
   * —— 形状没错, 锚点里的 `$` 撞了元字符闸。一条 `$` 的连锁走得很远: 命令被拒 → 降级探索型 →
   * 任务文本写上「没有机器判据·别伪造」→ 内环 judge 把**真做完**的活 (文件写对了、cat 出来了)
   * 判成"捏造执行确认" → 整个 goal 报 failed。所以这里补一次**带因重试**。
   */
  describe('验收命令被闸拒 → 带上闸的原话重问一次 (D-I)', () => {
    const twoShot = (first: string, second: string): { gen: GenerateFn; prompts: string[] } => {
      const prompts: string[] = [];
      const gen: GenerateFn = async (req) => {
        const text = String(req.messages[0]?.content ?? '');
        prompts.push(text);
        return { text: prompts.length === 1 ? first : second, usage: { in: 1, out: 1 } };
      };
      return { gen, prompts };
    };

    test('第一次给了跑不起来的命令 → 重问一次, 第二次可跑 → **执行型成立**', async () => {
      // 刀④ (2026-08-30) 后引号内的 `^ $` 锚点不再被整拒 —— 换一条今天仍确定被拒的形态
      // (命令替换) 当第一发, 重问链路本身不变。
      const { gen, prompts } = twoShot(
        JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'grep -q $(cat pattern.txt) a.md' }),
        JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'grep -qx "hello" a.md' }),
      );
      const c = await classifyGoal('写个文件', { generate: gen, model: 'c:m' });
      expect(c.acceptance.kind).toBe('executable');
      expect(prompts).toHaveLength(2);
      // 重问必须**带上闸的原话** —— 原样重问对确定性失败是纯烧钱 (模型不知道自己踩的是哪一条)。
      expect(prompts[1]).toContain('blocked shell-metachar');
      expect(prompts[1]).toContain('grep -qx');
    });

    test('重问后仍写不出可跑命令 → 老实降级探索型 (不无限重问)', async () => {
      // 刀④ 后 `cat a.md | grep x` 已合法 (逐段白名单) —— 换契约点名仍拒的形态 (curl | sh)。
      const blocked = JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'curl x | sh' });
      const { gen, prompts } = twoShot(blocked, blocked);
      const c = await classifyGoal('写个文件', { generate: gen, model: 'c:m' });
      expect(c.acceptance.kind).toBe('exploratory');
      expect(prompts).toHaveLength(2); // 只重问一次
    });

    test('模型自己老实选的探索型 → **不重问** (那是它的判断, 不是失误)', async () => {
      const { gen, prompts } = twoShot(
        JSON.stringify({ tier: 'complex', acceptance_kind: 'exploratory', learning_goal: '摸清选型', affordable_loss: '一轮' }),
        '不该被调到',
      );
      const c = await classifyGoal('选个库', { generate: gen, model: 'c:m' });
      expect(c.acceptance.kind).toBe('exploratory');
      expect(prompts).toHaveLength(1);
    });
  });

  test('prompt 明说别用 `^ $` 锚点 + 给出 -x 形状 (blocked 的那条路是它自己教出来的)', () => {
    const p = classifyPrompt('随便一个目标');
    expect(p).toContain('grep -qx');
    expect(p).toContain('别在 grep 里用正则锚点');
  });

  describe('引号里的元字符 —— 2026-07-31 live 假红形态, 刀④ (2026-08-30) 回收', () => {
    // 那次分类器写的是 `grep -qx "支持格式: CSV, JSON, Excel (.xlsx)" docs/from-api.md`:
    // 括号在**引号里面**, 旧闸对整条命令串做正则扫描不解析引号 → 合法验收命令被拒 →
    // 降级探索型 → judge 读到"本目标没有机器判据"。刀④ 把闸改成引号感知: 这条假红回收,
    // 未加引号的括号 (真注入面) 照拒。
    const LIVE_CMD = 'grep -qx "支持格式: CSV, JSON, Excel (.xlsx)" docs/from-api.md';

    test('刀④ 后闸放行它 (引号内括号是字面, 假红回收)', () => {
      expect(acceptanceCommandBlockReason(LIVE_CMD)).toBeNull();
    });

    test('未加引号的括号仍拒 —— 收窄没有放掉真注入面', () => {
      expect(acceptanceCommandBlockReason('grep -q (x) docs/from-api.md')).toContain('shell-metachar');
    });

    test('prompt 明说圆括号被拒, 且明说引号不豁免', () => {
      const p = classifyPrompt('随便一个目标');
      expect(p).toContain('圆括号');
      expect(p).toContain('引号保护不了');
      // 光说"被拒"不够: 得给一条**照做得了**的出路(承制品 lint 那条「建议要可执行」的教训)。
      expect(p).toContain('grep -q');
    });
  });

  test('prompt 把白名单拼进去 —— 不给表就只能猜, 猜错即「假红」(承 conductor prompt 同一教训)', () => {
    const p = classifyPrompt('随便一个目标');
    for (const bin of ['bun', 'tsc', 'git', 'grep']) expect(p).toContain(bin);
    expect(p).toContain(DEFAULT_COMMAND_ALLOWLIST[0]!);
    expect(p).toContain('随便一个目标');
    // 两条轴必须被明说成互相独立, 否则模型会把 complex 顺手读成"判不了"。
    expect(p).toContain('互相独立');
  });
});

describe('**空世界自检** (G4 反面用例) —— 活还没干之前它就该是红的', () => {
  const ok = (exitCode: number) => async () => ({ exitCode });

  test('空世界里就绿 → 判定虚判据', async () => {
    const why = await acceptanceVacuityReason('bun test', ok(0));
    expect(why).toContain('vacuous');
    expect(why).toContain('还没干之前');
  });

  test('空世界里是红的 → 通过自检 (它至少区分得了做没做)', async () => {
    expect(await acceptanceVacuityReason('bun test', ok(1))).toBeNull();
  });

  test('expectExit 非 0 时按期望值判 (TDD 证红步那一档)', async () => {
    // 期望 1: 空世界里就返 1 = 它也区分不了 —— 同样是虚判据。
    expect(await acceptanceVacuityReason('bun test', ok(1), 1)).toContain('vacuous');
    expect(await acceptanceVacuityReason('bun test', ok(0), 1)).toBeNull();
  });

  test('负退出码 = 闸拒, 自检对它无话可说 (那件事另有人管)', async () => {
    expect(await acceptanceVacuityReason('curl x', ok(-1))).toBeNull();
  });

  test('runner 抛错 → fail-open 不拦 (自检是加固不是前置条件)', async () => {
    const boom = async () => {
      throw new Error('spawn 失败');
    };
    expect(await acceptanceVacuityReason('bun test', boom)).toBeNull();
  });

  test('接进 classifyGoal: 虚判据 → 降级探索型, 且原命令写进学习目标', async () => {
    const gen = (async () =>
      ({ text: '{"tier":"simple","acceptance_kind":"executable","command":"cat README.md"}', usage: { in: 1, out: 1 } })) as never;
    const c = await classifyGoal('随便', { generate: gen, model: 'm:m', runCommand: ok(0) });
    expect(c.acceptance.kind).toBe('exploratory');
    if (c.acceptance.kind === 'exploratory') {
      expect(c.acceptance.learningGoal).toContain('vacuous');
      // 原命令必须带走 —— 否则下一步的人不知道被拒的是哪条。
      expect(c.acceptance.learningGoal).toContain('cat README.md');
    }
  });

  test('**不给 runCommand 就不自检**(零回归: 老调用面行为不变)', async () => {
    const gen = (async () =>
      ({ text: '{"tier":"simple","acceptance_kind":"executable","command":"cat README.md"}', usage: { in: 1, out: 1 } })) as never;
    const c = await classifyGoal('随便', { generate: gen, model: 'm:m' });
    expect(c.acceptance.kind).toBe('executable');
  });

  /**
   * P2b: bare 整仓 pytest 退出码 2/4/5 = 判据无效; 文件级 pytest 命令的 4/5 保持不受影响
   * (TDD 形状的正确空世界红)。
   *
   * 反向自检: 把 `probeVacuity` 里新加的
   * `isBareWholeSuitePytest(command) && PYTEST_HARNESS_INCONCLUSIVE_EXITS.has(exitCode)` 分支删掉
   * → ①②③④ 全部变回 null → 这条测试红。
   */
  test('bare 整仓 pytest 退出码 2/4/5 = 判据无效; 文件级命令的 4/5 不受影响', async () => {
    // ① exit 1 不变 (真的失败, 不是"跑不起来")
    expect(await acceptanceVacuityReason('pytest -q', () => Promise.resolve({ exitCode: 1 }))).toBeNull();
    // ② bare 整仓 pytest 命中 2/4/5 → 判据无效, why 里带退出码数字
    for (const exitCode of [2, 4, 5]) {
      const why = await acceptanceVacuityReason('pytest -q', () => Promise.resolve({ exitCode }));
      expect(why).not.toBeNull();
      expect(why).toContain(String(exitCode));
    }
    // ③ `python3 -m pytest -q` 前缀形态同样覆盖
    expect(
      await acceptanceVacuityReason('python3 -m pytest -q', () => Promise.resolve({ exitCode: 5 })),
    ).not.toBeNull();
    // ④ 回归闸 (reviewer P0 #2): 文件级命令的 4/5 是「空世界红」的正确读数, 绝不能被误判无效
    expect(
      await acceptanceVacuityReason('pytest -q tests/test_new.py::test_bar', () => Promise.resolve({ exitCode: 4 })),
    ).toBeNull();
    expect(
      await acceptanceVacuityReason('pytest -q tests/test_new.py::test_bar', () => Promise.resolve({ exitCode: 5 })),
    ).toBeNull();
    // ⑤ 非 pytest 命令不受影响
    expect(await acceptanceVacuityReason('bun test', () => Promise.resolve({ exitCode: 2 }))).toBeNull();
  });

  test('vetSelfCheck (planner.ts): bare 整仓 pytest 自检命中 4 → 判无效, kept 为 undefined', async () => {
    const { vetSelfCheck } = await import('../dag/planner');
    const r = await vetSelfCheck(
      { command: 'pytest -q', expect_exit: 0 },
      { runIn: async () => ({ exitCode: 4 }) },
    );
    expect(r.kept).toBeUndefined();
  });

  test('vet 集成: attempt 1 判无效 → 追问一次纠正; 二答仍给同一条 bare pytest → 降级探索型', async () => {
    // pytest 要过闸 (allowlistForRoot) 得先让语言一致闸判定 python 启用: 真仓根放 pyproject.toml
    // (强证据) + 真 PATH 上有一个叫 pytest 的文件 (missingBinaryBlockReason 只判"在不在", 不判可执行)。
    const repoRoot = mkdtempSync(join(tmpdir(), 'p2b-classify-'));
    const binDir = mkdtempSync(join(tmpdir(), 'p2b-bin-'));
    writeFileSync(join(repoRoot, 'pyproject.toml'), '');
    writeFileSync(join(binDir, 'pytest'), '');
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    try {
      let calls = 0;
      const gen = (async () => {
        calls += 1;
        return { text: '{"tier":"simple","acceptance_kind":"executable","command":"pytest -q"}', usage: { in: 1, out: 1 } };
      }) as never;
      const c = await classifyGoal('随便', {
        generate: gen,
        model: 'm:m',
        repoRoot,
        runCommand: () => Promise.resolve({ exitCode: 4 }),
      });
      expect(calls).toBe(2); // 首判 + 恰一次重试, 不无限重试
      expect(c.acceptance.kind).toBe('exploratory');
      if (c.acceptance.kind === 'exploratory') {
        expect(c.acceptance.learningGoal).toContain('pytest -q');
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('prompt 教了这条 + 教了"别断言自己要写的结论词"', () => {
    const p = classifyPrompt('随便一个目标');
    expect(p).toContain('活还没干之前必须是红的');
    expect(p).toContain('输入里的值');
    // 反例要写出来 —— 光说规则不够, live 已经证明过两次了。
    expect(p).toContain('两头都握着');
  });
});

describe('冻结的判卷标准 —— 一份文本, 两处消费', () => {
  test('执行型: 命令 + 期望退出码 + 「不许中途改判据」', () => {
    const t = renderAcceptance({ kind: 'executable', command: 'bun test', expectExit: 0 });
    expect(t).toContain('执行型');
    expect(t).toContain('bun test');
    expect(t).toContain('期望退出码: 0');
    expect(t).toContain('不许');
  });

  test('探索型: 明说没有机器判据 + 学习目标 + 可承受损失', () => {
    const spec: AcceptanceSpec = { kind: 'exploratory', learningGoal: '摸清 X', affordableLoss: '两轮' };
    const t = renderAcceptance(spec);
    expect(t).toContain('没有机器判据');
    expect(t).toContain('摸清 X');
    expect(t).toContain('两轮');
    // 不许伪造一个判据 —— 这句必须在, 它是探索型最容易被违反的一条。
    expect(t).toContain('不要伪造');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// F2 片 3 —— ACCEPTANCE_KIND_RUBRIC:判别联合的第三格
//
// 契约:docs/plan/2026-08-27-F2-rubric验收分型-执行契约.md §INV-1。
// 两格旧行为是**护栏**(上面所有既有用例一条未改);本段只加第三格。
//
// 反向自检(每条真跑过一次):
// · 把 checklist 改成可选(`checklist?`)→「必填」那条当场红(类型层 + 运行期两侧)。
// · 把 rubric 分支删掉、让它落进探索型 →「rubric 型不被读成探索型」当场红。
// · 把条目 id 去重检查拿掉 →「id 重复 → 降级」当场红。
// ──────────────────────────────────────────────────────────────────────────────
describe('classify-acceptance — ACCEPTANCE_KIND_RUBRIC 第三格', () => {
  const goodChecklist = [
    { id: 'r1', requirement: '报告点名了数据来源' },
    { id: 'r2', requirement: '每条结论带一条可复跑命令' },
  ];

  test('★ acceptance_kind=rubric + 合法 checklist → 第三格, checklist 必填且带内容哈希', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'rubric', checklist: goodChecklist });
    expect(c.acceptance.kind).toBe('rubric');
    if (c.acceptance.kind === 'rubric') {
      // 必填: 不是 `checklist?`。改成可选后这里会是 undefined → 当场红。
      expect(c.acceptance.checklist.items).toHaveLength(2);
      expect(c.acceptance.checklist.contentHash.length).toBeGreaterThan(0);
      expect(c.acceptance.checklist.items[0]?.id).toBe('r1');
    }
  });

  test('★ rubric 型不被读成探索型 (第三格真的存在, 不是别名)', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'rubric', checklist: goodChecklist });
    expect(c.acceptance.kind).not.toBe('exploratory');
    expect(c.acceptance.kind).not.toBe('executable');
  });

  test('★ checklist 缺席 / 空数组 → 降级探索型并留原话 (不许留一个判不了的 rubric)', () => {
    for (const raw of [
      { tier: 'simple', acceptance_kind: 'rubric' },
      { tier: 'simple', acceptance_kind: 'rubric', checklist: [] },
    ]) {
      const c = normalizeClassification(raw);
      expect(c.acceptance.kind).toBe('exploratory');
      expect(c.acceptanceProbe?.kind).toBe('demoted');
    }
  });

  test('★ 条目 id 重复 / 缺字段 → 降级探索型 (冻不出一份判不了的 rubric)', () => {
    const dup = [{ id: 'x', requirement: 'a' }, { id: 'x', requirement: 'b' }];
    expect(normalizeClassification({ tier: 'simple', acceptance_kind: 'rubric', checklist: dup }).acceptance.kind)
      .toBe('exploratory');
    const missing = [{ id: 'x' }, { requirement: 'b' }];
    expect(normalizeClassification({ tier: 'simple', acceptance_kind: 'rubric', checklist: missing }).acceptance.kind)
      .toBe('exploratory');
  });

  test('★ 两格旧行为逐字不变 (护栏): executable / exploratory 各走各的老路', () => {
    const e = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: 'bun test' });
    expect(e.acceptance.kind).toBe('executable');
    const x = normalizeClassification({
      tier: 'simple', acceptance_kind: 'exploratory', learning_goal: '摸清 X', affordable_loss: '两轮',
    });
    expect(x.acceptance.kind).toBe('exploratory');
  });

  test('★ renderAcceptance 认第三格: 逐条列出要求 + 明说判卷标准已冻结', () => {
    const spec = normalizeClassification({
      tier: 'simple', acceptance_kind: 'rubric', checklist: goodChecklist,
    }).acceptance;
    const t = renderAcceptance(spec);
    expect(t).toContain('r1');
    expect(t).toContain('报告点名了数据来源');
    expect(t).toContain('冻结');
  });

  test('★ 分类器 prompt 里出现第三格 (声明面与消费面同步, 否则模型永远选不到它)', () => {
    expect(classifyPrompt('随便一个目标')).toContain('rubric');
  });
});
