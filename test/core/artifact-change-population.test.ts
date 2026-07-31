/**
 * **N7 —— 两条检测器的 population 边界** (2026-07-31)。
 *
 * 台账上的原话:`loop-no-artifact-change` 两跑都 0,而**两个 0 的成因不同** ——
 * 一跑没产物(population 闸);二跑第 2 轮的写方被产物闸判 `empty-artifact` → 本轮产物集为空
 * → 同样不判。后者**其实就是**"盘上没位移",只是被一个更具体的仪表先接住了。
 *
 * 也就是说 `empty-artifact` 会**系统性地**吃掉一部分本该命中的样本 —— 而 G5 正解要不要从
 * 「只报」升成「BLOCKED」、K 取几,全靠这条检测器的命中分布。**分布被系统性咬掉一块,
 * 定出来的 K 就是错的。**
 *
 * 这份网钉的就是那一格:声明了产物却没写出来,连着两轮 → **判为没位移**,而不是静默跳过。
 */
import { describe, expect, test } from 'bun:test';
import { ARTIFACT_ABSENT, detectNoArtifactChange } from '../../src/harness/plan/observers';

const round = (hashes: Record<string, string | null>) => ({ hashes });

describe('N7 · 「声明了却没写出来」不再被吃掉', () => {
  test('★ 连着两轮都 absent → 判为没位移 (此前 population 归零 → 静默不判)', () => {
    const obs = detectNoArtifactChange(round({ 'docs/a.md': ARTIFACT_ABSENT }), round({ 'docs/a.md': ARTIFACT_ABSENT }));
    expect(obs?.kind).toBe('loop-no-artifact-change');
    // 措辞要点破**更糟的那件事**: 不是"写了但没变", 是"连东西都没产出来"。
    // 下一轮读它的是 conductor —— 给它的动作因此也不同 (先把文件真写出来, 别再排步骤)。
    expect(obs?.message).toContain('一个都不在盘上');
  });

  test('上一轮写出来了、这一轮变成 absent → 有位移 (被删/换路径也是动静), 不报', () => {
    expect(detectNoArtifactChange(round({ 'docs/a.md': 'h1' }), round({ 'docs/a.md': ARTIFACT_ABSENT }))).toBeNull();
  });

  test('absent → 真写出来了 → 有位移, 不报', () => {
    expect(detectNoArtifactChange(round({ 'docs/a.md': ARTIFACT_ABSENT }), round({ 'docs/a.md': 'h1' }))).toBeNull();
  });
});

describe('N7 · 三个"看起来都像没东西"的值必须分得开', () => {
  test('null (量不到) 仍然一票否决 —— 它不是证据', () => {
    // ⚠ 与 ARTIFACT_ABSENT 的分野是这份改动的**全部要害**:
    //   读文件出错 = 我们不知道盘上是什么 → 不判;
    //   声明了而文件不存在 = 我们**确切知道**盘上没有 → 可比较。
    //   把两者合成一个值, 要么丢掉整类真信号 (都当 null), 要么拿缺失冒充证据 (都当 absent)。
    expect(detectNoArtifactChange(round({ 'a.md': null }), round({ 'a.md': null }))).toBeNull();
    expect(detectNoArtifactChange(round({ 'a.md': ARTIFACT_ABSENT }), round({ 'a.md': null }))).toBeNull();
  });

  test('population 为空 (纯分析轮, 压根没有产物声明) 仍然不判 —— 那是 Unobserved 不是没位移', () => {
    expect(detectNoArtifactChange(round({}), round({}))).toBeNull();
    expect(detectNoArtifactChange(round({ 'a.md': 'h' }), round({}))).toBeNull();
  });

  test('内容真没变 (两轮同 hash) 走原来那条措辞, 不与 absent 那条混用', () => {
    const obs = detectNoArtifactChange(round({ 'a.md': 'h1' }), round({ 'a.md': 'h1' }));
    expect(obs?.kind).toBe('loop-no-artifact-change');
    expect(obs?.message).toContain('逐字节相同');
    expect(obs?.message).not.toContain('一个都不在盘上');
  });

  test('混合: 一个 absent 一个有内容且都没变 → 仍判没位移, 但用通用措辞', () => {
    const prev = round({ 'a.md': ARTIFACT_ABSENT, 'b.md': 'h1' });
    const cur = round({ 'a.md': ARTIFACT_ABSENT, 'b.md': 'h1' });
    const obs = detectNoArtifactChange(prev, cur);
    expect(obs?.kind).toBe('loop-no-artifact-change');
    // 不是"全 absent" → 不该说"一个都不在盘上"(那句会变成假话)
    expect(obs?.message).toContain('逐字节相同');
  });
});
