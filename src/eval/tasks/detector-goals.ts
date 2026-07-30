/**
 * `detector` 自发使用率的固定语料 (P3 D-Q, 2026-07-30)。
 *
 * 量的是**一个 prompt 改动有没有真的改变行为**: `detector` 是 2026-07-30 才被迫进 conductor
 * 明示形状的 (它只在 conductor 画的子图里有消费者, 而子图只有 conductor 画得出来 —— 不告诉它
 * 就等于这个字段没有生产者)。明示之后的问题变成: 它会不会用? 会不会滥用?
 *
 * 语料分两半, **反例那一半同样重要**:
 *  - `worthy`: 几段产出之间的**一致性**才是交付物的成败, 而这种一致性**没有便宜的确定性 oracle**
 *    (口径/承诺/假设是否自洽, grep 判不了)。这正是检测者的用例。
 *  - `control`: 命令 oracle 就能判 (grep/test), 或者只有一个产出节点 (没有"相互对得上"可言),
 *    或者要判的是"这东西好不好" (那是轮末 judge 的活)。**这些上面出现 detector = 滥用**,
 *    每张图多一个节点就是多一次调用 —— 而 prompt 里 whenNot 写得比 when 长, 就是冲它来的。
 */

export interface DetectorGoalCase {
  id: string;
  /** 'worthy' = 该用检测者; 'control' = 不该用 (出现即滥用)。 */
  kind: 'worthy' | 'control';
  /** 喂给 conductor 的目标原文 (= 展开调用里 node.goal 的位置)。 */
  goal: string;
  /** 为什么归到这一半 —— 判据写下来, 免得下次改语料时凭感觉挪。 */
  why: string;
}

export const DETECTOR_GOAL_CASES: readonly DetectorGoalCase[] = [
  // ── 该用: 交付物的成败取决于几段产出**相互对得上**, 且没有便宜 oracle ──────────
  {
    id: 'two-audiences',
    kind: 'worthy',
    goal:
      '写两份面向不同读者的说明: docs/user.md (给用户) 与 docs/dev.md (给开发者), 各自介绍同一个功能"批量导出"。' +
      '两份必须在事实口径上完全一致 (支持的格式、上限条数、是否异步), 不许各说各的。',
    why: '两个写方独立产出, 一致性是成败; "口径是否一致"要读懂两段文字, grep 判不了。',
  },
  {
    id: 'zh-en-promise',
    kind: 'worthy',
    goal:
      '写 marketing/zh.md 与 marketing/en.md 两份文案, 介绍同一个退款政策。两份给出的**承诺**必须一致 ' +
      '(时限、适用范围、例外), 不能一边写"7 个工作日"另一边写"within a week"。',
    why: '跨语言的同一组承诺, 字面不同而语义必须相同 —— 确定性比较在这里没有意义。',
  },
  {
    id: 'three-modules-errors',
    kind: 'worthy',
    goal:
      '三个模块各写一段 API 说明 (docs/api-auth.md · docs/api-file.md · docs/api-job.md), ' +
      '每段都要列自己的错误码。三段之间的错误码**不许冲突** (同一个码不能在两处表示不同的错)。',
    why: '三方交叉约束, 冲突只有把三段放在一起看才发现; 单个节点看不见兄弟。',
  },
  {
    id: 'estimate-assumptions',
    kind: 'worthy',
    goal:
      '分别产出 plan/cost.md (成本估算) 与 plan/timeline.md (工期估算)。两份必须建立在**同一组假设**上 ' +
      '(团队人数、每周有效工时、是否含验收), 假设对不上时不许硬凑结论。',
    why: '两份估算各自自洽但假设可能打架 —— 典型的"边"上的错误, 没有 oracle。',
  },

  // ── 不该用: 有便宜 oracle / 单产出 / "好不好"是 judge 的活 ────────────────────
  {
    id: 'single-file-grep',
    kind: 'control',
    goal: '创建 notes/hello.md, 内容是一行 "hello omd", 然后确认写成功了。',
    why: '单产出 + `grep -qx` 就能判 —— 检测者在这里是白花一个节点。',
  },
  {
    id: 'typecheck-test',
    kind: 'control',
    goal: '给 src/util/slug.ts 补一个把中文标题转成 slug 的函数, 并让 typecheck 与测试都绿。',
    why: '纯 command oracle (tsc + test) 就是判据, 不需要任何"相互对得上"的检查。',
  },
  {
    id: 'one-design-doc',
    kind: 'control',
    goal: '写一份 docs/plan/cache-design.md, 说明一个 LRU 缓存该怎么设计 (取舍、失效策略、边界)。',
    why: '只有一个产出节点; 要判的是"写得好不好", 那是轮末 judge 的活, 不是检测者的。',
  },
];
