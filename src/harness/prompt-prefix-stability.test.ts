/**
 * C-8 前缀稳定性探针 (SDD 2026-08-11 卡与profile分工)。
 *
 * ## 为什么是这把尺子, 不是 cacheRead 比例
 *
 * SDD 原文把 C-8 写成「同一张图跑两次 (迁移前/后), 量同卡 sibling 第 2..N 发的 `cacheRead / in` 比例」。
 * 实核 (2026-08-12) 把那条判死了:`~/.omd/dag-runs.db` **0 行**, 且 `usage` 是整 run 一个 JSON blob、
 * 没有 per-card 分组 —— 那把尺子今天既没有当下读数、也没有可回溯的基线。更要命的是它的依赖是**反的**:
 * 「迁移前」那一臂必须在动 `agent-leaf.ts` 之前量, 而 T2 一落地基线就永久丢失。
 *
 * cacheRead 比例本来只是**代理指标**, 它代理的真东西是「同卡 sibling 的 prompt 前缀是否逐字节相同」——
 * 而后者是 `buildLeafPrompt` (纯函数) 的性质, 可以零模型、零成本、两臂同场地直接量。
 *
 * **这把尺子量不到什么, 明写**: provider 侧真实 cache 命中 (它们的 cache 策略、暖发时序、TTL) 全在
 * 视野外。真跑 DAG 时的 cacheRead 仍然值得记, 但那是**确认**不是判据。
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from './conductor-plan';
import { buildLeafPrompt } from './dag/planner';

type PlanNode = ConductorPlan['nodes'][string];

/** 四个 sibling: goal 各不同 (天然分叉在后), 共享同一张卡。 */
const SIBLINGS: Array<{ id: string; node: PlanNode }> = [
  { id: 'fe-settings', node: { goal: '实装设置页', executor: 'agent', output_path: 'web/src/pages/Settings.tsx' } },
  { id: 'fe-inbox', node: { goal: '实装收件箱', executor: 'agent', output_path: 'web/src/pages/Inbox.tsx' } },
  { id: 'fe-runs', node: { goal: '实装 runs 列表', executor: 'agent', output_path: 'web/src/pages/Runs.tsx' } },
  { id: 'fe-theme', node: { goal: '抽主题变量', executor: 'agent', output_path: 'web/src/theme.css' } },
];

const CARD_BODY = ['You review ONE UI artifact.', 'Hard gates: contrast, states, motion.', 'Report findings only.'].join('\n');
const TASK = '把控制台三页实装出来。';

/** 一组字符串的最长公共前缀长度 (按 UTF-16 code unit 数 —— 与 String.slice 同口径)。 */
function commonPrefixLen(texts: string[]): number {
  if (texts.length === 0) return 0;
  let n = texts[0]!.length;
  for (const t of texts.slice(1)) {
    n = Math.min(n, t.length);
    let i = 0;
    while (i < n && texts[0]![i] === t[i]) i++;
    n = i;
  }
  return n;
}

/** 卡 body 段的结束偏移 (含闭合标签) —— 前缀至少要覆盖到这里, 整张卡才在同一个 cache 面里。 */
function cardBlockEnd(prompt: string): number {
  const close = '</agent-template>';
  const i = prompt.indexOf(close);
  expect(i).toBeGreaterThan(-1); // 卡没进 prompt 的话这条闸量的就不是它了
  return i + close.length;
}

describe('C-8 同卡 sibling 的 prompt 前缀稳定性', () => {
  test('冻结卡 (body 无运行期插值) → 四发的公共前缀覆盖整张卡 body', () => {
    const prompts = SIBLINGS.map(({ id, node }) => buildLeafPrompt(id, node, {}, { name: 'design-review', body: CARD_BODY }, TASK));
    const lcp = commonPrefixLen(prompts);
    const end = cardBlockEnd(prompts[0]!);

    // 实测 (2026-08-12): lcp=291, 卡段结束偏移=143, prompt 全长 699。
    // 公共前缀不止盖住卡, 还一路盖过 <original-task> (同 run 内那段字节相同), 直到各自的 id 行。
    expect(lcp).toBeGreaterThanOrEqual(end);

    // 分叉点确实晚到 id 行 —— 否则"盖住了"可能只是因为卡本身短。
    // ⚠ 不能断言公共前缀"不含 `[omd leaf:`": 四个 sibling 的 id 都以 `fe-` 开头, 公共前缀
    //   自然会吃进 `[omd leaf: fe-` (实测 lcp=291 正落在这里)。那不是缺陷, 是 id 的共同前缀。
    //   照那样写会得到一条**因测试数据而红**的假闸 —— 首次运行就是这么红的。
    const idLine = prompts[0]!.indexOf('[omd leaf:');
    expect(idLine).toBeGreaterThan(-1);
    expect(lcp).toBeGreaterThanOrEqual(idLine); // 卡 + 任务两段整个在公共前缀内
    expect(prompts[0]!.slice(lcp)).toContain('settings'); // 而各自的 id 尾巴确实分叉了
  });

  test('反向自检: 卡 body 带节点级插值 → 公共前缀塌到卡 body 之前', () => {
    // 「运行期插值」的真实形态 = 每个节点拿到的 body 不一样。字面量 `${id}` 写在 body 里只是数据,
    // 不会自己求值 —— 照那样写这条自检会假绿 (变异没施上而输出像读数, 图鉴 S-32 同族)。
    // 故这里**真的**按节点渲染 body, 并先把差异打印出来自证变异已施。
    const perNodeBody = (id: string) => `${CARD_BODY}\n本次节点: ${id}`;
    const mutated = SIBLINGS.map(({ id, node }) => buildLeafPrompt(id, node, {}, { name: 'design-review', body: perNodeBody(id) }, TASK));
    // 变异已施的自证: 四份 body 互不相同。
    expect(new Set(mutated.map((p) => p.slice(0, cardBlockEnd(p)))).size).toBe(4);

    const lcp = commonPrefixLen(mutated);
    const end = cardBlockEnd(mutated[0]!);
    // 实测 (2026-08-12): lcp=135 < 卡段结束偏移 161 —— 前缀在卡 body 内部就断了,
    // 整段模板的 cache 面白丢 (planner.ts:29-33 注释里那条 "id 行在前会让前缀在 ~12 字符处分叉" 的同族)。
    expect(lcp).toBeLessThan(end);
  });
});
