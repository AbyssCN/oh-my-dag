/**
 * **上轮产出的载体通道闸** (2026-07-29, 承故障注入揪出的那条缺陷)。
 *
 * 缺陷本身: judge 拒过的产出**借一次崩溃复活** —— D-4 毒集闸只做在 `computeReuse` (D-21 通道),
 * 而 continuity 的 resume-skip 是**第二条**能把上轮产出带进本轮的路。修法 `dropPoisonedGreens`。
 *
 * 缺陷给的那句话比缺陷本身值钱: **上轮产出能进本轮的路不止一条, 只堵一条等于没堵。**
 * 而这条路**只有崩溃才走得到** —— 正常跑一轮不存在"上轮 checkpoint 还在但本轮还没重跑"的时刻,
 * 所以静态审查看不见它, 是故障注入问出来的。
 *
 * 已知通道 (交接文 `2026-07-29-session-handoff.md` 有同一张表):
 *   ① D-21 跨轮复用 `prior.results`     → `computeReuse(…, poisoned)`            ✅
 *   ② continuity resume-skip            → `dropPoisonedGreens` (executor-dag)     ✅
 *   ③ D-O 节点输出全文制品 `outputText` → 骑在②上, 同一个闸 (但赌注更高: 复活的是**完整**产物) ✅
 *   ④ `_goal.json` (`GoalStageJournal`) → **今天零调用方**, 无人堵                 ⚠ 本文件盯的就是它
 *
 * 本闸只做一件事: 让④**接线的那一刻变红**。它不是"禁止接线" —— 是逼接线的人先回答一个问题:
 * 崩溃后把上一轮的 repoContext / evidence / specPath 原样带回来时, 其中被 judge 拒过的那部分
 * 怎么办? `GoalStageJournal` 只有 goal 文本闸 (换个 goal 就整份作废), **没有"被拒"这个概念**。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
/** 通道④ 的两个入口。定义处自己不算调用方。 */
const CHANNEL_4_API = ['writeGoalJournal', 'loadGoalJournal'] as const;
/** 定义处 (不算调用方) —— 相对 src/ 的 posix 路径。 */
const DEFINITION_FILES = ['harness/continuity/checkpoint-manager.ts', 'harness/continuity/types.ts'];

/** src/ 下全部 .ts (排除测试与定义处)。 */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf-8' })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !DEFINITION_FILES.includes(p));
}

describe('载体通道④ — `_goal.json` 今天无人堵, 接线即红', () => {
  test('扫描面本身有效 (不是空转: 真扫到了成规模的源文件)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    // 定义处确实被排除了, 否则本闸恒红。
    expect(files).not.toContain('harness/continuity/checkpoint-manager.ts');
  });

  test('`writeGoalJournal` / `loadGoalJournal` 仍然零调用方', () => {
    const callers: string[] = [];
    for (const rel of sourceFiles()) {
      let body: string;
      try {
        body = readFileSync(join(SRC, rel), 'utf-8');
      } catch {
        continue; // 扫描期文件被删/权限 → 跳过, 本闸不该因此崩
      }
      for (const api of CHANNEL_4_API) {
        if (body.includes(`${api}(`)) callers.push(`${rel} → ${api}`);
      }
    }
    if (callers.length > 0) {
      throw new Error(
        [
          `\`_goal.json\` (GoalStageJournal) 被接线了: ${callers.join(', ')}`,
          '',
          '这不是"不许接" —— 是接之前必须先回答一个问题:',
          '  它是**第四条**能把上一轮产出带进本轮的通道 (前三条: D-21 复用 / continuity resume-skip /',
          '  D-O 输出全文制品)。崩溃后它会把上一轮的 repoContext / evidence / specPath 原样带回来,',
          '  而它只有 goal 文本闸 (换个 goal 整份作废), **没有"被 judge 拒过"这个概念**。',
          '',
          '2026-07-29 的故障注入实测证过同一个形态: 毒集闸只堵 D-21 一条, 于是被拒产出借一次崩溃复活',
          '(修法 executor-dag.dropPoisonedGreens)。**只堵一条等于没堵。**',
          '',
          '接线时要做的: ① 给这条通道加上与 dropPoisonedGreens 对位的失效判据 (被拒的阶段产出不得复用)',
          '② 更新 docs/plan/2026-07-29-session-handoff.md 的通道表 ③ 把本用例改成对新闸的断言。',
        ].join('\n'),
      );
    }
    expect(callers).toEqual([]);
  });
});
