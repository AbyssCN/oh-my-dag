/**
 * C-3 (片 3) —— 教学面与回流 (D-4, D-5)。
 *
 * 四条 INV (GWT 字面照搬契约 §C-3, anchor = classifyPrompt(probe?) 与 classifyGoal 内的
 * probe 接线在实装前必须 0 命中: 测试文件引用尚不存在的 probe 参, bun test 会因 arity mismatch 而 RED):
 *   · INV-8  probe 段如实: 仓语言证据 + per-root 白名单 + 条件化示例
 *   · INV-9  无 probe 退 base: repoRoot 缺席 = 白名单 = base, 无仓语言证据段
 *   · INV-10 拒因回流恰一次: Python 仓给 bun test 两次 → 2 次生成, 第 2 次消息含拒因字面,
 *                              终局=探索型, learningGoal 含原话
 *   · INV-11 存量不回退: 既有分类测试不改断言即绿; run-goal.ts 零 diff; 无 marker 仓派生行为不变
 *
 * 测试全 stub: mkdtemp 起 marker + fake generate, 零模型调用, 零真子进程网络。
 *
 * Evidence ② 未核项 (s2 实证): 闸拒已触发 correction 第二问 → 二拒仍写不出 → 降级探索型,
 * 不必片 3 新建第二问逻辑 —— INV-10 的"调 2 次"是**沿用既有 correction 通道**,不是新机制。
 *
 * **反向自检**每条都钉死: 删 probe 段 (INV-8 必红)、删 probe 参 (INV-9 必红, fail-open 段不显),
 * 删 correction 拼接 (INV-10 必红 → 调 1 次拒一次)、改 normalize 走 base 白名单 (INV-10 必红)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGoal, classifyPrompt } from './classify-acceptance';
import { DEFAULT_COMMAND_ALLOWLIST } from '../command-leaf';
import type { GenerateFn } from '../dag/types';

let tmpRoot = '';
afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

function freshRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'omd-classify-probe-'));
  return tmpRoot;
}

/** 多发 fake generate: 第 N 次返回 responses[N-1], 并把发给它的 prompt 收进 prompts。 */
function fakeGenerate(responses: string[]): { gen: GenerateFn; prompts: string[] } {
  const prompts: string[] = [];
  const gen: GenerateFn = async (req) => {
    prompts.push(String(req.messages[0]?.content ?? ''));
    const idx = prompts.length - 1;
    return { text: responses[idx] ?? responses[responses.length - 1] ?? '', usage: { in: 1, out: 1 } };
  };
  return { gen, prompts };
}

describe('INV-8: probe 段如实 —— prompt 只教检出证据支持的工具', () => {
  test('pyproject.toml 仓 → 白名单含 pytest, 示例不含 bun test', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');

    const prompt = classifyPrompt('随便一个目标', { repoRoot: root });

    // 白名单行必须含 pytest (per-root allowlist 已贴进去)
    expect(prompt).toContain('pytest');
    // 派生提示不应再教 JS 形状的判据 (Python 仓没 JS 证据)
    // 关键判据: 整段 prompt 不出现 `bun test` (允许示例行做条件化替换)
    expect(prompt).not.toContain('bun test');
  });

  test('package.json 仓 → 白名单含 bun / tsc, 示例含 bun test / tsc --noEmit', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '');

    const prompt = classifyPrompt('随便一个目标', { repoRoot: root });

    expect(prompt).toContain('bun');
    expect(prompt).toContain('tsc');
    // JS 仓 → 例示保留 bun test / tsc --noEmit 形状 (D-4: 检出 js 包才示例 bun test)
    expect(prompt.split('\n').some((l) => l.includes('bun test'))).toBe(true);
    expect(prompt.split('\n').some((l) => l.includes('tsc --noEmit'))).toBe(true);
  });

  test('仓语言证据段显式出现在 prompt 中, 列出检出 marker', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');

    const prompt = classifyPrompt('随便一个目标', { repoRoot: root });

    // 段名: 仓语言证据 (或类似措辞), 让模型分得清这是事实不是建议
    expect(prompt).toContain('pyproject.toml');
  });
});

describe('INV-9: 无 probe 退 base', () => {
  test('不传 probe → 白名单行与 base 一致', () => {
    const prompt = classifyPrompt('随便一个目标');
    for (const bin of DEFAULT_COMMAND_ALLOWLIST) expect(prompt).toContain(bin);
  });

  test('不传 probe → 无"仓语言证据"段', () => {
    const prompt = classifyPrompt('随便一个目标');
    expect(prompt).not.toContain('仓语言证据');
  });

  test('传 probe={repoRoot: undefined} → 等价不传', () => {
    const prompt = classifyPrompt('随便一个目标', { repoRoot: undefined });
    expect(prompt).not.toContain('仓语言证据');
  });
});

describe('INV-10: 拒因回流恰一次 —— 修正通道沿用既有 correction', () => {
  test('Python 仓 + fake 生成给 bun test 两次 → generate 调 2 次, 终局探索型, learningGoal 含原话', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');

    const blocked = JSON.stringify({
      tier: 'simple',
      acceptance_kind: 'executable',
      command: 'bun test',
    });
    const { gen, prompts } = fakeGenerate([blocked, blocked]);

    const c = await classifyGoal('写个文件', { generate: gen, model: 'c:m', repoRoot: root });

    expect(prompts).toHaveLength(2);
    // 第 2 次消息含拒因字面 (lang-mismatch 的原话)
    expect(prompts[1]).toContain('blocked lang-mismatch');
    // 终局 = 探索型
    expect(c.acceptance.kind).toBe('exploratory');
    if (c.acceptance.kind === 'exploratory') {
      // learningGoal 含原话
      expect(c.acceptance.learningGoal).toContain('blocked lang-mismatch');
    }
  });
});

describe('INV-11: 存量不回退', () => {
  test('无 repoRoot → classifyPrompt 与今天字节兼容 (白名单 + base)', () => {
    const prompt = classifyPrompt('随便一个目标');
    expect(prompt).toContain(DEFAULT_COMMAND_ALLOWLIST[0]!);
    for (const bin of ['bun', 'tsc', 'git', 'grep']) expect(prompt).toContain(bin);
  });

  test('无 marker 仓 + probe → 派生与今天一致 (示例保留 bun test / tsc --noEmit)', () => {
    // D-4: 都无 → "只留 grep / cat 形状" —— 但这里测的是"无 marker"等价于"无启用包",
    // 因 js bins 全在 base, allowlist 与今天一致, 示例与今天一致 (无 marker 不触发条件化分支)。
    // 这是 fail-open 的另一面: 没证据 ≠ 反证据, 允许它按今天的形状写。
    const root = freshRoot();
    // 空目录 = 无 marker
    const prompt = classifyPrompt('随便一个目标', { repoRoot: root });
    expect(prompt.split('\n').some((l) => l.includes('bun test'))).toBe(true);
    expect(prompt.split('\n').some((l) => l.includes('tsc --noEmit'))).toBe(true);
  });
});

describe('E-T1: 测试套仓强偏执行型 (bench 批7/8 docs-only 病的上游修)', () => {
  // 反向自检: 删掉 classifyPrompt 里的强偏段 → 前两条当场红。
  test('检出语言包的仓 → prompt 含强偏执行型段, 且「拿不准选 exploratory」被条件反转', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    const prompt = classifyPrompt('修一个 bug', { repoRoot: root });
    expect(prompt).toContain('强烈偏向 "executable"');
    // 反转句: 有测试套证据时不再教"拿不准就选 exploratory"
    expect(prompt).toContain('先在测试套里找锚');
  });

  test('js 仓同样强偏 (证据 = 任一语言包 marker)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '{}');
    const prompt = classifyPrompt('修一个 bug', { repoRoot: root });
    expect(prompt).toContain('强烈偏向 "executable"');
  });

  // 2026-08-29 code80 批: 80 个仓里 54 个检不出 marker, 于是 67% 的题吃的是**反向**教学句
  // (「拿不准就选 exploratory」)。其中 25 个仓有 setup.py/setup.cfg/tox.ini/pytest.ini ——
  // 它们全是 python 测试基建的证据, 只是没写进包表。
  for (const marker of ['setup.py', 'setup.cfg', 'tox.ini', 'pytest.ini']) {
    test(`setuptools 时代的 marker (${marker}) 同样触发强偏, 且示例改教 pytest`, () => {
      const root = freshRoot();
      writeFileSync(join(root, marker), '');
      const prompt = classifyPrompt('修一个 bug', { repoRoot: root });
      expect(prompt).toContain('强烈偏向 "executable"');
      expect(prompt).not.toContain('拿不准就选 "exploratory"');
      expect(prompt).toContain('pytest -q');
    });
  }

  test('无 marker 仓 / 无 probe → 强偏段 0 处 (存量教学面不变)', () => {
    const root = freshRoot();
    expect(classifyPrompt('目标', { repoRoot: root })).not.toContain('强烈偏向 "executable"');
    expect(classifyPrompt('目标')).not.toContain('强烈偏向 "executable"');
  });
});

describe('E-T1b: marker 仓探索型机械追问一次 (散文偏置批9实证不够, 做成会红的闸)', () => {
  // 反向自检: 删掉 classifyGoal 里的 marker-仓探索型追问分支 → 第一条当场红 (calls=1)。
  const exploratoryJson = JSON.stringify({ tier: 'simple', acceptance_kind: 'exploratory', learning_goal: '摸清结构', affordable_loss: '1轮' });
  const executableJson = JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'pytest -q', expected_exit: 0 });

  test('marker 仓首答探索型 → 恰好追问 1 次, 追问文含测试套自证要求, 二答照收', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      calls.push(String((req.messages[0] as { content: string }).content));
      return { text: exploratoryJson } as never;
    };
    const c = await classifyGoal('修一个 bug', { generate, model: 'faux:clf', repoRoot: root });
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('测试套');
    expect(c.acceptance.kind).toBe('exploratory');
  });

  test('marker 仓首答执行型 → 不追问 (calls=1)', async () => {
    const root = freshRoot();
    // pyproject + pytest 判据: 语言一致 (js 仓给 pytest 会被 lang-mismatch 闸拦, 那是另一条闸的活)
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      calls.push(String((req.messages[0] as { content: string }).content));
      return { text: executableJson } as never;
    };
    const c = await classifyGoal('修一个 bug', { generate, model: 'faux:clf', repoRoot: root });
    expect(calls.length).toBe(1);
    expect(c.acceptance.kind).toBe('executable');
  });

  test('无 marker 仓首答探索型 → 不追问 (存量语义, calls=1)', async () => {
    const root = freshRoot();
    const calls: string[] = [];
    const generate: GenerateFn = async () => { calls.push('x'); return { text: exploratoryJson } as never; };
    const c = await classifyGoal('摸清一个领域', { generate, model: 'faux:clf', repoRoot: root });
    expect(calls.length).toBe(1);
    expect(c.acceptance.kind).toBe('exploratory');
  });

  test('二答转执行型 → 收执行型 (追问真的能翻案)', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    let n = 0;
    const generate: GenerateFn = async () => {
      n++;
      return { text: n === 1 ? exploratoryJson : executableJson } as never;
    };
    const c = await classifyGoal('修一个 bug', { generate, model: 'faux:clf', repoRoot: root });
    expect(n).toBe(2);
    expect(c.acceptance.kind).toBe('executable');
  });
});
