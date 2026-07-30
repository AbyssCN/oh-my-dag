/**
 * S1 产物内容进 judge 视图 —— 第一张网 (2026-08-03)。
 *
 * 被测行为的来历: 两次带种 live 交付物**全对**却判 3 轮未收敛。读判词全文才知道 judge 没冤枉谁 ——
 * `[引擎实测]` 只给存在性 (`写入文件: X`), 而目标要的是内容, 于是它被要求裁决看不见的东西,
 * fail-closed。这里钉的是"补进来的那份内容**不许骗人**": 读不到就说读不到, 超预算就说超预算,
 * 截断了就标出来。任何一条改成沉默, 都是把老毛病换个位置重犯。
 */
import { describe, expect, test } from 'bun:test';
import {
  collectJudgeArtifacts,
  renderJudgeArtifacts,
  DEFAULT_ARTIFACT_BUDGET,
  type ArtifactReader,
} from './judge-artifacts';

const reader = (files: Record<string, string>): ArtifactReader => (p) => files[p] ?? null;

describe('collectJudgeArtifacts', () => {
  test('常态: 正文原样搬进来, 一个字不加工', () => {
    const [a] = collectJudgeArtifacts(['docs/a.md'], reader({ 'docs/a.md': '单次上限 100 条' }));
    expect(a).toEqual({ path: 'docs/a.md', body: '单次上限 100 条', readable: true });
  });

  test('声称写了但引擎读不到 → **如实写进视图**, 这本身就是判据', () => {
    // 最该让 judge 看见的那种: 节点说"已写入 docs/x.md", 盘上没有。悄悄跳过 = judge 只看到
    // 一句自述, 又回到"裁决看不见的东西"。
    const [a] = collectJudgeArtifacts(['docs/x.md'], reader({}));
    expect(a!.readable).toBe(false);
    expect(a!.body).toContain('未能读到');
  });

  test('非文本不往视图里灌字节', () => {
    const [a] = collectJudgeArtifacts(['out/bin'], reader({ 'out/bin': 'PNG\0\0\0IHDR' }));
    expect(a!.readable).toBe(false);
    expect(a!.body).toContain('非文本');
  });

  test('超单文件预算 → 截断 + 标出实际展示了多少', () => {
    const long = 'x'.repeat(500);
    const [a] = collectJudgeArtifacts(['big.md'], reader({ 'big.md': long }), { perFile: 100, total: 1000 });
    expect(a!.truncated).toBe(true);
    expect(a!.body).toHaveLength(100);
    expect(renderJudgeArtifacts([a!])).toContain('已截断');
  });

  test('合计预算用尽 → 剩下的文件**列出来说明未展示**, 不静默丢掉 (no-silent-caps)', () => {
    const files = { 'a.md': 'A'.repeat(80), 'b.md': 'B'.repeat(80), 'c.md': 'C'.repeat(80) };
    const got = collectJudgeArtifacts(['a.md', 'b.md', 'c.md'], reader(files), { perFile: 100, total: 100 });
    expect(got).toHaveLength(3); // 三个都在视图里 —— 少一个 judge 就在看一份残清单而不自知
    expect(got[0]!.readable).toBe(true);
    expect(got[2]!.readable).toBe(false);
    expect(got[2]!.body).toContain('预算');
  });

  test('默认预算是个有限数 (它进的是每一次 judge 调用)', () => {
    expect(DEFAULT_ARTIFACT_BUDGET.total).toBeGreaterThan(0);
    expect(DEFAULT_ARTIFACT_BUDGET.perFile).toBeLessThanOrEqual(DEFAULT_ARTIFACT_BUDGET.total);
  });
});

describe('renderJudgeArtifacts', () => {
  test('只有路径与字节, **一个结论词都没有**', () => {
    // 与 `[引擎实测]` 刻意不写 "3/3 通过" 同一条纪律: 2026-07-29 实测证明, 视图里任何
    // "都好着呢"的暗示都会换来谎报完成 (那次的代价是三成)。事实与判词必须分开。
    const text = renderJudgeArtifacts(
      collectJudgeArtifacts(['docs/a.md'], reader({ 'docs/a.md': '正文' })),
    );
    expect(text).toContain('docs/a.md');
    expect(text).toContain('正文');
    for (const word of ['成功', '通过', '正确', '符合', '✅', '已达成']) {
      expect(text).not.toContain(word);
    }
  });

  test('空产物 → 空串 (不给 judge 一个空标题去解读)', () => {
    expect(renderJudgeArtifacts([])).toBe('');
  });
});
