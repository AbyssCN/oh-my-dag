/**
 * src/harness/gates/gate-allow.test.ts —— 引用语境豁免标记(2026-08-26, RED)。
 *
 * ## 起因: 解释一个禁止项, 几乎必然要引用它
 *
 * 模式型的闸(词表匹配 / 字面坐标 / 同句配对)只看字面, **不区分「使用」与「引用」**。
 * 于是「说明某个写法不该出现」这件事本身就会被判红。本 session 撞到五次, owner 与 leaf 各中:
 *
 *   - 契约里更正一个编造的符号名 —— 写出那个名字就被 coord-check 判「符号不在文件里」
 *   - 代码注释里说明「原实现用了某个占位坐标, 已删」—— 写出它就被 seat 闸判硬编码
 *   - model-router 的注释里举例「调用方可能塞某个前缀形式进来」—— 同上
 *
 * 五次全靠改述绕开。改述能work, 但它把「为什么不这么写」的信息也一并磨掉了 ——
 * 下一个人看不到反面教材, 于是再写一遍。
 *
 * ## 判据
 *
 * 同行出现 `gate-allow(<闸 id>): <理由>` 即豁免该行对该闸的判定。
 *
 *   - **闸 id 必须对上**: 给 seat 闸的豁免不能顺带豁免 coord-check。
 *   - **理由必须非空**: 空标记不生效。豁免是要留证据的动作, 不是消音开关 ——
 *     这条是本闸最重要的一格, 没有它, `gate-allow(x):` 会变成万能静音。
 *
 * **证伪**(实跑): 去掉 id 比对 ⇒ 第三条红; 去掉理由非空检查 ⇒ 第二条红。
 */
import { describe, expect, it } from 'bun:test';
import { gateAllowReason } from './gate-allow';
import { checkCoords } from '../goal/coord-check';

describe('引用语境豁免标记', () => {
  it('★ 带理由 → 返回理由(该行对该闸豁免)', () => {
    const line = "      // gate-allow(seat-coordinate): 这里是前缀哨兵判断, 不是要用某个坐标";
    expect(gateAllowReason(line, 'seat-coordinate')).toBe('这里是前缀哨兵判断, 不是要用某个坐标');
  });

  it('★ 理由为空 → 不豁免(豁免要留证据, 不是消音开关)', () => {
    expect(gateAllowReason('// gate-allow(seat-coordinate):', 'seat-coordinate')).toBeNull();
    expect(gateAllowReason('// gate-allow(seat-coordinate):   ', 'seat-coordinate')).toBeNull();
  });

  it('★ 闸 id 不对 → 不豁免(给 A 闸的豁免不顺带豁免 B 闸)', () => {
    const line = '// gate-allow(coord-check): 这条是给别的闸的';
    expect(gateAllowReason(line, 'seat-coordinate')).toBeNull();
  });

  it('★ 无标记 → null(零回归: 绝大多数行不带标记)', () => {
    expect(gateAllowReason('const x = 1;', 'seat-coordinate')).toBeNull();
    expect(gateAllowReason('// 普通注释', 'seat-coordinate')).toBeNull();
  });
});

/**
 * 接入面的活体自证 —— 光有 helper 不算数, 要证明两个闸真的认它。
 *
 * seat 闸那侧已用真实代码验过 (src/harness/model-router.ts 的 probe 前缀哨兵注释:
 * 带标记 4 pass / 去掉标记 3 pass 1 fail / 恢复 4 pass)。这里补 coord-check 侧。
 */
describe('引用语境豁免 · coord-check 接入面', () => {
  it('★ 带标记的行, 编造的符号名不再被判 identifier-not-in-file', () => {
    // ⚠ 符号与坐标必须**同行** —— coord-check 按同句共现配对, 分行就不配对, 那样测的是
    // 「配对没发生」而不是「豁免生效」, 是条假绿。第二条用例专门守住这点。
    const text =
      '- 草案原写作 `runIterate`, 真名 `iterateExecutorDag`(`src/harness/plan/iterate.ts:97`)。 gate-allow(coord-check): 引用的是被更正掉的错名';
    const findings = checkCoords(text, { root: process.cwd() });
    const bad = findings.filter((f) => f.raw === 'runIterate');
    expect(bad, '带标记的更正句不该再被判红').toEqual([]);
  });

  it('★ 去掉标记 → 同一句当场红(证明豁免不是恒真)', () => {
    const text =
      '- 草案原写作 `runIterate`, 真名 `iterateExecutorDag`(`src/harness/plan/iterate.ts:97`)。';
    const findings = checkCoords(text, { root: process.cwd() });
    expect(findings.some((f) => f.raw === 'runIterate')).toBe(true);
  });
});
