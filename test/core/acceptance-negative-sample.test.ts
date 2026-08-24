/**
 * **G4「判据必须在错的答案上失败」的行为网**(反面样本探针,2026-07-31)。
 *
 * ★ 这张网的原型对**来自 live,不是想出来的**:2026-07-31 那跑冻结的判据是
 * `grep -q "相同" docs/from-api.md` —— 它匹配得上「两处**不**相同」,**对的答案和错的答案都满足**。
 * 命令跑了、退出码 0、G4 那格看上去是绿的,而它什么都没验。
 *
 * 而**空世界自检抓不到它**:那时文件还不存在 → grep 失败 → 自检认为它能区分。
 * 所以第一组用例把这一对摆在一起:**同一条命令,一道闸放行、另一道拦下**。
 * 两道问的不是同一个问题,少哪一道都漏掉一整类。
 */
import { describe, expect, test } from 'bun:test';
import { acceptanceDiscriminationReason, acceptanceVacuityReason, probeDiscrimination } from '../../src/harness/goal/acceptance-gate';
import { classifyGoal, normalizeClassification } from '../../src/harness/goal/classify-acceptance';

/** 探针注入 runner:把"命令 + 那个临时世界"翻成一个退出码,不真起子进程(测的是判据逻辑)。 */
const grepIn =
  (needle: string, file: string) =>
  async ({ cwd }: { command: string; cwd: string }): Promise<{ exitCode: number }> => {
    const f = Bun.file(`${cwd}/${file}`);
    if (!(await f.exists())) return { exitCode: 2 };
    return { exitCode: (await f.text()).includes(needle) ? 0 : 1 };
  };

describe('G4 · live 那条虚判据 —— 空世界自检放行, 反面样本探针拦下', () => {
  const CMD = 'grep -q "相同" docs/from-api.md';
  const SAMPLE = { path: 'docs/from-api.md', content: '两处数字**不相同**: from-api 是 100, from-faq 是 500。' };

  test('空世界自检对它无话可说 —— 文件不存在, 命令失败, 于是"能区分"', async () => {
    // 这不是自检的缺陷, 是它问的问题不同。写成用例是为了让这条边界**可回归** ——
    // 哪天有人把两道闸合并成一道, 这条会红。
    const why = await acceptanceVacuityReason(CMD, async () => ({ exitCode: 2 }));
    expect(why).toBeNull();
  });

  test('★ 反面样本探针抓住它: 一份写着「不相同」的产物照样让命令通过', async () => {
    const why = await acceptanceDiscriminationReason(CMD, SAMPLE, 0, { runIn: grepIn('相同', 'docs/from-api.md') });
    expect(why).toContain('[undiscriminating]');
    expect(why).toContain('对的答案和错的答案都满足');
  });

  test('一条真判别的判据过得了同一道探针 (断言落在源材料的值上)', async () => {
    // 正例与反例只差断言的东西: 「相同」是执行体自己要写的结论词, 「100」是源材料里的值。
    // ⚠ 反面样本也得跟着换: 上面那份**含有** 100 (它错在结论不在数上), 拿它验 `grep -q "100"`
    //   会正确地判成"骗过去了"。这不是探针的毛病 —— **反面样本必须是这条判据眼里的错答案**,
    //   写这条用例时我第一版就摆错了, 留着当注: 探针的强度上限就是样本选得好不好。
    const why = await acceptanceDiscriminationReason('grep -q "100" docs/from-api.md', {
      path: 'docs/from-api.md',
      content: '本文档汇总了接口支持的格式与限制。',
    }, 0, { runIn: grepIn('100', 'docs/from-api.md') });
    expect(why).toBeNull();
  });
});

describe('G4 · 探针的 fail-open 边界 (加固不是前置条件)', () => {
  test('没给反面样本 → 不拦', async () => {
    expect(await acceptanceDiscriminationReason('grep -q x a.md', undefined)).toBeNull();
  });

  test('样本只有路径没内容 → 不拦 (半份样本证不了什么)', async () => {
    expect(await acceptanceDiscriminationReason('grep -q x a.md', { path: 'a.md', content: '' })).toBeNull();
  });

  test('★ 绝对路径 / `..` 一律拒 —— 那是模型产的字符串, 按不可信处理', async () => {
    let ran = false;
    const spy = async (): Promise<{ exitCode: number }> => {
      ran = true;
      return { exitCode: 0 };
    };
    expect(await acceptanceDiscriminationReason('grep -q x a', { path: '/etc/passwd', content: 'x' }, 0, { runIn: spy })).toBeNull();
    expect(await acceptanceDiscriminationReason('grep -q x a', { path: '../../x.md', content: 'x' }, 0, { runIn: spy })).toBeNull();
    // 拒的判据是**没跑到那一步**, 不是"跑了但结果为空" —— 后者会把一次写盘留在宿主上。
    expect(ran).toBe(false);
  });

  test('闸拒 (负退出码) → 探针无话可说, 那件事由命令闸管', async () => {
    expect(await acceptanceDiscriminationReason('grep -q x a.md', { path: 'a.md', content: 'x' }, 0, { runIn: async () => ({ exitCode: -1 }) })).toBeNull();
  });

  test('探针自己抛 → 不拦 (fail-open)', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('spawn 失败');
    };
    expect(await acceptanceDiscriminationReason('grep -q x a.md', { path: 'a.md', content: 'x' }, 0, { runIn: boom })).toBeNull();
  });

  /**
   * ★ 两种 fail-open **在账本上必须分得开**(2026-08-14 晚)。
   *
   * 原本两条 `return` 用的是同一句 `why`,而它们的下一步完全相反:
   * 「命令被闸拒」去看白名单,「探针自己炸了」是运行时缺陷、这次读数无效该重跑。
   * 压成一个标签就是本仓坑①(`NULL` ≠ 0 ≠ 不适用)。
   *
   * 这不是纸上推演:26 次全量里 `v4-5.log` 真中过一次(见 `docs/plan/2026-08-14-next-session.md`
   * 「第五张脸」),当时现场只剩一句光秃秃的 msg —— **只能靠计数**认出来。
   *
   * 反向自检:两条 `why` 改回同一个常量 → 第一条红;把 `String(err)` 从 `why` 里拿掉 → 第二条红。
   */
  test('★ 「被闸拒」与「探针自己炸了」是两件事, 判词不许同字', async () => {
    const blocked = await probeDiscrimination('grep -q x a.md', { path: 'a.md', content: 'x' }, 0, {
      runIn: async () => ({ exitCode: -1 }),
    });
    const boom = await probeDiscrimination('grep -q x a.md', { path: 'a.md', content: 'x' }, 0, {
      runIn: async () => {
        throw new Error('EBADF: bad file descriptor, epoll_ctl');
      },
    });
    expect(blocked.status).toBe('fail_open');
    expect(boom.status).toBe('fail_open');
    expect((blocked as { why: string }).why).not.toBe((boom as { why: string }).why);
  });

  test('★ 炸了的那条把**错误原文**带进 why —— 留了证据不等于证据看得见', async () => {
    const boom = await probeDiscrimination('grep -q x a.md', { path: 'a.md', content: 'x' }, 0, {
      runIn: async () => {
        throw new Error('EBADF: bad file descriptor, epoll_ctl');
      },
    });
    // 光进 logger 的字段不算: 那次真实事故的日志格式把 binding 全丢了, msg 里没有就等于没有。
    expect((boom as { why: string }).why).toContain('EBADF');
  });

  test('真实存盘一次 (不注入 runner 时探针自带 runner, 且临时目录用完就删)', async () => {
    // 这条不注入 runIn —— 走的是生产那条路 (自带 command runner + 真临时目录 + 真 grep)。
    // 没有它, 上面每一条测的都只是判据逻辑, 而"探针在生产上跑不跑得起来"没人验过。
    const why = await acceptanceDiscriminationReason('grep -q "相同" out.md', {
      path: 'out.md',
      content: '两处并不相同。',
    });
    expect(why).toContain('[undiscriminating]');
  });
});

describe('G4 · 分类器给的反面样本接进了分类结果', () => {
  test('normalize 收下扁平两格 (弱模型对嵌套对象的成功率明显更低)', () => {
    const c = normalizeClassification({
      tier: 'simple',
      acceptance_kind: 'executable',
      command: 'grep -q "100" a.md',
      negative_sample_path: 'a.md',
      negative_sample_content: '没有那个数',
    });
    expect(c.negativeSample).toEqual({ path: 'a.md', content: '没有那个数' });
  });

  test('★ 没给样本**不降级** —— 它只是少过一道闸, 不是判据不合格', () => {
    const c = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', command: 'bun test' });
    expect(c.acceptance.kind).toBe('executable');
    expect(c.negativeSample).toBeUndefined();
  });

  test('★ 端到端: 分类器给出虚判据 + 自己的反例 → classifyGoal 当场降级探索型', async () => {
    const c = await classifyGoal('把两份摘要写出来', {
      model: 'm',
      generate: async () => ({
        text: JSON.stringify({
          tier: 'simple',
          acceptance_kind: 'executable',
          command: 'grep -q "相同" docs/from-api.md',
          negative_sample_path: 'docs/from-api.md',
          negative_sample_content: '两处数字不相同: 100 与 500。',
        }),
        usage: { in: 1, out: 1 },
      }),
    });
    expect(c.acceptance.kind).toBe('exploratory');
    if (c.acceptance.kind !== 'exploratory') throw new Error('unreachable');
    // 降级理由必须**带着原命令**走 —— 下游 spec 卡要靠它知道"上一条判据错在哪", 不然它会再写一条一样的。
    expect(c.acceptance.learningGoal).toContain('[undiscriminating]');
    expect(c.acceptance.learningGoal).toContain('grep -q "相同"');
  });

  test('判别得了的判据端到端保持执行型', async () => {
    const c = await classifyGoal('把接口支持的格式数写进文档', {
      model: 'm',
      generate: async () => ({
        text: JSON.stringify({
          tier: 'simple',
          acceptance_kind: 'executable',
          command: 'grep -q "100" docs/from-api.md',
          negative_sample_path: 'docs/from-api.md',
          negative_sample_content: '本文档汇总了接口支持的格式与限制。',
        }),
        usage: { in: 1, out: 1 },
      }),
    });
    expect(c.acceptance.kind).toBe('executable');
  });
});
