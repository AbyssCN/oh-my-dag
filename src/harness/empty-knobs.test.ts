/**
 * 空旋钮闸 (INV-P2-1 泛化, 2026-07-28 全仓扫的产物)。
 *
 * 这次 session 里同一个缺陷形态撞见了五次, **没有一次是靠计划找到的**:
 *   `max_retry`/`on_failure`/`fallback` 零消费者 · `escalation` 座位纯装饰 · `postcondition` 被两个
 *   conductor prompt 反复明示却无人检查 · goal 路的 continuity 有机制零调用方 · INV-GOAL-3 的
 *   taint closure 写在契约里但代码没有。
 *
 * 共性: 声明面 (schema / 座位表 / prompt / 契约) 往前跑了, 消费面没跟上, **两边都不报错**。
 * 受害者要么是被误导的 conductor (照着明示写了没人看的字段), 要么是显式配了却被静默忽略的调用方。
 *
 * 这个文件把"靠撞"变成"靠红"。两条闸:
 *   1. **明示即承诺**: conductor prompt 里出现的每个 node 字段, 必须有引擎消费者。
 *   2. **座位即承诺**: `ALL_SEATS` 里的每个座位, 必须真的被解析过 (不是只被 auto-assign 派模型
 *      + 被起跑自检查凭证, 然后没人读)。
 *
 * 加字段/加座位而不登记消费点 → 这里红。要撤回一个已明示的东西, 从 prompt 里删掉即可
 * (zod 层留容忍不影响本闸 —— 容忍旧 plan 与"邀请 conductor 去写"是两回事)。
 */
import { describe, expect, test } from 'bun:test';
import { conductorSystemPrompt } from './conductor-plan';
import { ALL_SEATS } from '../model/role-models';
import { SEATS } from '../model/seats';

/**
 * conductor prompt 明示的每个 node 字段 → 它的引擎消费点。
 * 新增明示字段必须在这里登记 `file:line` 级的去处 (写不出来 = 它没有消费者 = 不该明示)。
 */
const DECLARED_CONSUMERS: Record<string, string> = {
  goal: 'executor-dag-planner.buildLeafPrompt',
  persona: 'executor-dag-planner.buildLeafPrompt',
  template: 'executor-dag (agentTemplates 查卡 → prompt 前缀)',
  args: 'executor-dag-planner.buildLeafPrompt',
  depends_on: 'executor-dag (拓扑/ready-set 调度)',
  executor: 'executor-dag (agent/command/research/map 分流)',
  command: 'executor-dag (commandRunner)',
  expect_exit: 'executor-dag (command 分支判 done 的期望退出码, D-K)',
  max_nodes: 'executor-dag.runConductorNode → plan/conductor-expand (子图硬顶, D-B/D-D)',
  creative: 'executor-dag (caveman 档位路由)',
  map: 'executor-dag.runMapNode',
  output_type: 'executor-dag (producesFiles 判定)',
  output_path: 'executor-dag (producesFiles 判定 + 产物闸)',
  requires: 'executor-dag (D-7v2 quorum 级联)',
  cluster: 'stamp pass (D-22 链亲和) + HUD 分组',
  tier: 'stamp pass (D-17 选池档位)',
  attach_media: 'executor-dag (D-14v2 多模态 content parts)',
  detector: 'executor-dag.runConductorRound (parseDetectorVerdict → 内环毒集 / BLOCKED 出口, D-Q)',
  kind: 'executor-dag.runPrimitiveNode',
  primitive: 'primitive-registry (compile + run)',
  params: 'primitive-registry (paramsSchema 深校验)',
};

/** 从明示的 JSON 形状里抠出 `"key"?:` / `"key":` 形态的字段名。 */
function declaredNodeFields(prompt: string): Set<string> {
  const shapeStart = prompt.indexOf('"nodes"');
  expect(shapeStart).toBeGreaterThan(-1); // 明示形状还在, 否则本闸空转
  const shape = prompt.slice(shapeStart);
  const out = new Set<string>();
  for (const m of shape.matchAll(/"([a-z_]+)"\??\s*:/g)) {
    const k = m[1]!;
    // 形状骨架自身的键 + map spec 的内部键 (它们不是 node 字段)
    if (['nodes', 'name', 'description', 'outputs', 'lister', 'over', 'itemvar', 'keyby', 'maxitems'].includes(k)) continue;
    out.add(k);
  }
  return out;
}

describe('明示即承诺 — conductor prompt 里的字段必须有消费者', () => {
  for (const profile of ['full', 'lean'] as const) {
    test(`${profile} 档: 明示的每个 node 字段都登记了消费点`, () => {
      const fields = declaredNodeFields(conductorSystemPrompt({ profile }));
      expect(fields.size).toBeGreaterThan(5); // 抠出来了, 不是空集空转
      const unbacked = [...fields].filter((f) => !(f in DECLARED_CONSUMERS));
      expect(unbacked).toEqual([]);
    });
  }

  test('已撤明示的三个字段确实不在 prompt 里 (skill / agent / postcondition)', () => {
    // 三个都是"引擎零消费者"; zod 层仍容忍旧 plan, 但不再邀请 conductor 去写。
    // postcondition 尤其: 明示它等于请 conductor 为正确性敏感节点写验证条件, 写完没人看 ——
    // 是验证的样子而不是验证, 还会把它从真的会跑的 command / judge 节点那条路上引开。
    for (const profile of ['full', 'lean'] as const) {
      const p = conductorSystemPrompt({ profile });
      expect(p).not.toContain('"postcondition"');
      expect(p).not.toContain('"skill"');
      expect(p).not.toContain('"agent"?:');
    }
  });

  test('roster 段只在宿主真给了 agents 名单时才提 "agent"', () => {
    expect(conductorSystemPrompt({})).not.toContain('roster');
    expect(conductorSystemPrompt({ agents: ['a1'] })).toContain('roster');
  });
});

/**
 * 座位 → 解析点。座位不是"auto-assign 派个模型 + 起跑自检查凭证"就算活着 —— 得有人真去解析它,
 * 否则 config 配了不生效 (INV-MODEL-1 要杀的正是这个)。
 *
 * ⚠ 2026-08-01: 这张表**从 `model/seats.ts` 派生**, 不再手抄。此前它是第二份必须记得同步的清单,
 * 而"记得同步"从来不是一个可靠机制 —— 座位的真源 (分档/消费点/effort/采样/建议模型) 现在只有一处。
 */
const SEAT_CONSUMERS: Record<string, string> = Object.fromEntries(
  SEATS.map((s) => [s.id, s.where.join(' + ')]),
);

describe('座位即承诺 — ALL_SEATS 里的每个座位都有解析点', () => {
  test('每个座位都登记了消费点', () => {
    const unbacked = ALL_SEATS.filter((s) => !(s in SEAT_CONSUMERS));
    expect(unbacked).toEqual([]);
  });

  test('登记表不含已不存在的座位 (删座位要同步删登记)', () => {
    const stale = Object.keys(SEAT_CONSUMERS).filter((s) => !(ALL_SEATS as readonly string[]).includes(s));
    expect(stale).toEqual([]);
  });
});
