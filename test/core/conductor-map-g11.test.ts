import { describe, expect, test } from 'bun:test';
import { conductorSystemPrompt, PlanSchema } from '../../src/harness/conductor-plan';
import { RESEARCH_LENS_TEMPLATE, RESEARCH_LENS_STAGES } from '../../src/harness/research/lens-template';
import { expandMapNode, type MapSpecLike } from '../../src/harness/plan/map-expand';

// ── G11 反幻觉验收 (SDD 0009 §6 主锚 · P3 分解器统一) ─────────────────────────────
//
// 根因 (T2 硬命中): conductor 面对"逐模块审计"这种**运行时才知道的工作清单**, 因 system prompt
// 只教了 leaf|agent|command, **不知道能 emit map 节点**, 只能把整个 fan-out 塌进一条**编造的命令**
// (dag-T2-audit.json 里的 `tools/audit-errors.ts` —— 已核实无此文件、无 tools/ 目录)。
// P3 修法: system prompt 教 map-over-worklist → conductor emit `executor:'map'` 而非幻觉造工具。
//
// 接受判据 (0009 §6): 无幻觉命令 + emit map over 模块 + 子节点数 = 真实模块数 + resume 只重跑改动模块。
// 本测试断言其**可确定验证的结构半**; LLM 真实 emission 半是 M6 实测 smoke (见文末), 非单测。

// T2 场景: "审计 src/omd 全仓每个模块的错误处理" —— 工作清单 author-time 未知。
const t2ModulePaths = [
  'src/omd/executor-dag',
  'src/omd/conductor-plan',
  'src/omd/primitive-registry',
  'src/omd/research/fanout',
  'src/omd/plan/discovery',
];

/** 正解 = 一个 map 节点: lister 复用 codegraph (indexed infra) 列模块, per-module 审计 template。 */
const t2MapPlan = {
  name: 't2-audit',
  nodes: {
    audit: {
      executor: 'map',
      map: {
        lister: { executor: 'command', command: 'codegraph files src/omd' },
        over: 'modules',
        itemVar: 'm',
        keyBy: 'path',
        template: {
          executor: 'agent',
          goal: '审计 ${m.path} 的错误处理: 列出未捕获异常 / 静默吞错 / 缺边界检查',
          output_type: 'file',
          output_path: 'audit.md',
        },
      },
    },
  },
};

const t2MapSpec = t2MapPlan.nodes.audit.map as unknown as MapSpecLike;

describe('G11-a · system prompt 教 map (根因修: conductor 知道能 emit map)', () => {
  const prompt = conductorSystemPrompt();

  test('output schema executor 枚举含 "map"', () => {
    expect(prompt).toContain('"leaf"|"agent"|"command"|"map"');
  });

  test('显式警告"勿把扇出塌进编造命令" + 给出 map 替代', () => {
    expect(prompt).toContain('executor:"map"');
    expect(prompt).toMatch(/hallucinate|fabricat/i); // 反幻觉措辞在场
    expect(prompt).toContain('lister'); // map 形状 (lister → 运行时数组)
  });

  test('研究镜头情形具名引用 RESEARCH_LENS_TEMPLATE (引用不现推 · 防丢质量)', () => {
    expect(prompt).toContain('RESEARCH_LENS_TEMPLATE');
  });

  test('回归: 旧的 leaf/agent/command 教学仍在 (未破坏自由 node-graph 路径)', () => {
    expect(prompt).toContain('You are the CONDUCTOR');
    expect(prompt).toContain('executor:"agent"');
  });
});

describe('G11-b · T2 正解 map plan 校验通过 (非幻觉造工具)', () => {
  test('map-over-模块 plan 过 PlanSchema (conductor 现在能合法 emit 它)', () => {
    const r = PlanSchema.safeParse(t2MapPlan);
    expect(r.success).toBe(true);
  });

  test('lister 复用 indexed infra (codegraph command), 非模型 guess / 非编造脚本', () => {
    const lister = t2MapPlan.nodes.audit.map.lister;
    expect(lister.executor).toBe('command');
    expect(lister.command).toContain('codegraph');
    // 反例锚: 旧幻觉是 `tools/audit-errors.ts` 类不存在脚本 —— 正解 lister 不引用 tools/ 编造物。
    expect(lister.command).not.toContain('tools/audit');
  });
});

describe('G11-c · 子节点数 = 真实模块数 (运行时宽度, 非 author-time 定)', () => {
  test('lister 出 N 模块 → N 子节点, 无截断 (N ≤ 64)', () => {
    const r = expandMapNode('audit', t2MapSpec, {
      modules: t2ModulePaths.map((path) => ({ path })),
    });
    expect(r.status).toBe('ok');
    expect(r.children).toHaveLength(t2ModulePaths.length);
    expect(r.truncated).toBe(0);
  });

  test('每子节点 = per-module 审计 (goal 插了真实模块路径)', () => {
    const r = expandMapNode('audit', t2MapSpec, { modules: [{ path: 'src/omd/executor-dag' }] });
    expect(r.children[0]!.node.goal).toContain('审计 src/omd/executor-dag 的错误处理');
    expect(r.children[0]!.node.executor).toBe('agent'); // file producer 是 agent, 非 leaf
  });
});

describe('G11-d · resume 只重跑改动模块 (keyBy 稳定身份)', () => {
  const idSet = (paths: string[]) =>
    new Set(expandMapNode('audit', t2MapSpec, { modules: paths.map((path) => ({ path })) }).children.map((c) => c.id));

  test('同模块集 → 同子 id 集 (未变模块不重跑)', () => {
    expect(idSet(t2ModulePaths)).toEqual(idSet(t2ModulePaths));
  });

  test('改一个模块 → 只该子 id 变, 其余稳定 (差集 = 1)', () => {
    const before = idSet(t2ModulePaths);
    const after = idSet([...t2ModulePaths.slice(0, -1), 'src/omd/plan/fixpoint']); // 换掉最后一个
    // 前 4 个未动 → id 稳定, 交集 = 4; 各自独有 = 1 (换掉的那个)。
    const shared = [...before].filter((id) => after.has(id));
    expect(shared).toHaveLength(t2ModulePaths.length - 1);
    expect([...after].filter((id) => !before.has(id))).toHaveLength(1);
  });
});

describe('G11-e · RESEARCH_LENS_TEMPLATE 冻结单源 (防丢质量, 引用不现推)', () => {
  test('五阶段结构 + 四结构键在场 (质量层不丢)', () => {
    expect(RESEARCH_LENS_TEMPLATE).toContain('reduce');
    expect(RESEARCH_LENS_TEMPLATE).toContain('judge');
    expect(RESEARCH_LENS_TEMPLATE).toContain('graft');
    expect(RESEARCH_LENS_TEMPLATE).toContain('subAngles');
    expect(RESEARCH_LENS_TEMPLATE).toContain('synthesisFramings');
    expect(RESEARCH_LENS_TEMPLATE).toContain('judgeCriteria');
  });

  test('五阶段单源锚定 (RESEARCH_LENS_STAGES 恰 5 阶段, 模板由其派生 → 不重复真理源)', () => {
    expect(RESEARCH_LENS_STAGES).toHaveLength(5);
    // 模板文本由 STAGES 派生 → 每阶段的锚词都进模板 (单源, 不各写一份)。
    for (const stage of RESEARCH_LENS_STAGES) {
      const anchor = stage.split(':')[0]!; // 'gen' / 'reduce' / 'synth' / 'judge' / 'graft'
      expect(RESEARCH_LENS_TEMPLATE).toContain(anchor);
    }
  });
});

// ── M6 实测 follow-on (非本单测覆盖) ────────────────────────────────────────────
// G11 主锚的 LLM 行为半 = "把 T2 审计 goal 重喂真实 conductor, 断言它 emit map-over-模块 而非
// 幻觉造 tools/audit-errors.ts"。这需真模型调用 (不确定性), 归 M6 实测 smoke, 不进确定性单测。
// 本文件确定性锚定: prompt 已教 map (G11-a) + 正解 plan 合法 (G11-b) + 运行时宽度对齐 (G11-c) +
// resume 增量 (G11-d) + 质量结构冻结 (G11-e) —— 结构侧已闭合, 只余 LLM emission 的经验确认。
