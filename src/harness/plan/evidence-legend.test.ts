/**
 * 证据词表的**跨文件一致性闸** (2026-08-03)。
 *
 * 词表(`llm-judge.EVIDENCE_LEGEND`)在给 judge 解释视图里各块的来源, 而那些块的标记
 * 是**另一个文件**渲染出来的(`conductor-judge.renderRoundForJudge` + `judge-artifacts`)。
 * 两边各自能改, 没有任何东西比对 —— 一旦标记改名而词表没跟, 词表就**静默变成一段谎话**:
 * 它教 judge 去认一个视图里根本不存在的标记, 而**这比没有词表更坏**(judge 会以为
 * "既然没看到 `[引擎实测]`, 那就是没有引擎证据")。
 *
 * 所以闸的判据取自**真渲染出来的字符串**, 不是把标记常量抄一份来比对 ——
 * 抄一份就是又一处会漂的重复(15 号那条教训), 而这里要守的恰恰是"渲染面变了没有"。
 */
import { describe, expect, test } from 'bun:test';
import { EVIDENCE_LEGEND } from './llm-judge';
import { renderRoundForJudge } from './conductor-judge';

/** 一段真视图: 三种块都出现(引擎实测 / 产物内容 / 自述)。 */
const view = renderRoundForJudge([
  {
    id: 'exec::probe',
    originalId: 'exec::probe',
    status: 'done',
    output: '我把活干完了。',
    facts: ['写入文件: docs/x.md'],
    artifacts: [{ path: 'docs/x.md', body: '# x\n', readable: true, truncated: false }],
  },
]);

describe('证据词表与真视图的标记一致', () => {
  test('词表提到的每个标记, 都真的出现在渲染结果里', () => {
    // 词表里用反引号括起来的片段 = 它教 judge 去认的标记。
    const marks = [...EVIDENCE_LEGEND.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      // 带占位符的写法(`--- <路径> ---`)按**字面片段**逐段比 —— 整串比会拿 "---  ---" 去找,
      // 那是我第一版的写法, 闸当场把它抓出来了(真视图里是 `--- docs/x.md ---`)。
      const literals = mark
        .split(/<[^>]*>/)
        .map((s) => s.replace(/…/g, '').trim())
        .filter(Boolean);
      expect(literals.length, `词表里的 \`${mark}\` 全是占位符, 比不出东西`).toBeGreaterThan(0);
      for (const lit of literals) {
        expect(view.includes(lit), `词表提到 \`${mark}\`, 但真视图里没有 "${lit}"`).toBe(true);
      }
    }
  });

  test('反向自检: 捏造一个视图里没有的标记 → 上面那条会红', () => {
    const fake = '`[引擎臆测]`';
    const marks = [...fake.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(view.includes(marks[0]!)).toBe(false);
  });

  test('词表只讲来源, 不替 judge 定裁决方向', () => {
    // 「所以你该判 converged=true」这类指示会把假阴性换成假阳性(毒的那一侧)。
    // 唯一允许的方向性表述是"引擎读到了内容就别再判它没真做" —— 它否定的是一个**事实错误**,
    // 不是在放宽标准。所以这里禁的是**裁决词**本身出现在词表里。
    for (const banned of ['converged=true', 'converged = true', '判为收敛', '应当通过', '直接通过']) {
      expect(EVIDENCE_LEGEND.includes(banned), `词表不该出现裁决指示 "${banned}"`).toBe(false);
    }
  });
});
