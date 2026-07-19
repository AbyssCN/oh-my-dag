import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentTemplates, templateRoster, type AgentTemplate } from '../../src/harness/agent-templates';
import { BUILTIN_AGENT_TEMPLATES } from '../../src/harness/agent-templates-builtin';
import { conductorSystemPrompt, parsePlan } from '../../src/harness/conductor-plan';
import { buildLeafPrompt } from '../../src/harness/executor-dag-planner';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';

// agent 模板注册表 (本地 Agent Registry): 内置+项目卡加载 → 规划期 enum 校验 (TPL-2) →
// 执行期 body 注入 leaf prompt 前缀 + 卡片 model 路由 (TPL-3)。全程 fake generate, 不碰 live 模型。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

/** 隔离的 tmp repoRoot (可选写入项目卡)。 */
function tmpRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-agent-tpl-'));
  if (Object.keys(files).length > 0) {
    mkdirSync(join(root, '.omd', 'agents'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, '.omd', 'agents', name), content);
    }
  }
  return root;
}

describe('agent-templates loader', () => {
  test('无项目卡目录 → 纯内置 5 卡', () => {
    const t = loadAgentTemplates({ root: tmpRoot() });
    expect(t.size).toBe(BUILTIN_AGENT_TEMPLATES.length);
    for (const b of BUILTIN_AGENT_TEMPLATES) expect(t.get(b.name)?.description).toBe(b.description);
  });

  test('项目卡: 新卡并入 + 同名覆盖内置 + model frontmatter (TPL-3 载体)', () => {
    const root = tmpRoot({
      'payments-reviewer.md': [
        '---',
        'name: payments-reviewer',
        'description: Payment-flow risk review',
        'model: deepseek:deepseek-v4-pro',
        '---',
        'You are a payments risk reviewer.',
      ].join('\n'),
      // 同名覆盖内置 code-reviewer
      'code-reviewer.md': ['---', 'name: code-reviewer', 'description: OVERRIDDEN', '---', 'custom body'].join('\n'),
    });
    const t = loadAgentTemplates({ root });
    expect(t.get('payments-reviewer')).toEqual({
      name: 'payments-reviewer',
      description: 'Payment-flow risk review',
      model: 'deepseek:deepseek-v4-pro',
      body: 'You are a payments risk reviewer.',
    });
    expect(t.get('code-reviewer')?.description).toBe('OVERRIDDEN'); // 项目卡赢
  });

  test('TPL-1 fail-open: 缺 description / 空 body / README 均跳过, 不阻断', () => {
    const root = tmpRoot({
      'no-desc.md': ['---', 'name: no-desc', '---', 'body'].join('\n'),
      'no-body.md': ['---', 'name: no-body', 'description: d', '---', '   '].join('\n'),
      'README.md': '# not a card',
      'name-from-filename.md': ['---', 'description: named by file', '---', 'body'].join('\n'),
    });
    const t = loadAgentTemplates({ root });
    expect(t.has('no-desc')).toBe(false);
    expect(t.has('no-body')).toBe(false);
    expect(t.has('README')).toBe(false);
    expect(t.get('name-from-filename')?.description).toBe('named by file'); // name 缺省取文件名
  });
});

describe('conductor prompt + parsePlan (规划层)', () => {
  const registry: AgentTemplate[] = [{ name: 'card-a', description: 'does A', body: 'BODY-A' }];

  test('注册表段: 只进 description 行, body 不进规划上下文', () => {
    const sys = conductorSystemPrompt({ templates: registry.map((t) => ({ name: t.name, description: t.description })) });
    expect(sys).toContain('- "card-a": does A');
    expect(sys).toContain('"template"?: string'); // 输出契约含 template 字段
    expect(sys).not.toContain('BODY-A');
    // 无注册表 → 无该段 (宿主路径 BC)
    expect(conductorSystemPrompt({})).not.toContain('Agent template cards');
  });

  test('TPL-2: 未知 template 名整 plan 拒 (含 map 子模板), 已知/无 opts 通过', () => {
    const mk = (tpl: string) => JSON.stringify({ name: 'p', nodes: { n: { agent: 'x', goal: 'g', template: tpl } } });
    const known = new Set(['card-a']);
    expect(parsePlan(mk('card-a'), { knownTemplates: known }).ok).toBe(true);
    const bad = parsePlan(mk('ghost'), { knownTemplates: known });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('ghost');
    expect(parsePlan(mk('ghost')).ok).toBe(true); // 无 opts = 不校验 (宿主宏观引擎路径 BC)
    // map 子模板同受校验
    const mapPlan = JSON.stringify({
      name: 'p',
      nodes: {
        m: {
          agent: 'x',
          executor: 'map',
          map: { lister: { goal: 'list' }, over: 'items', itemVar: 'item', template: { goal: 'do ${item}', template: 'ghost' } },
        },
      },
    });
    expect(parsePlan(mapPlan, { knownTemplates: known }).ok).toBe(false);
  });
});

describe('buildLeafPrompt (执行层注入)', () => {
  test('模板 body 前置于 [omd leaf: id] (cache 前缀共享), persona 仍叠加', () => {
    const node = { agent: 'x', goal: 'g', persona: '支付风控视角' } as Parameters<typeof buildLeafPrompt>[1];
    const p = buildLeafPrompt('n1', node, {}, { name: 'card-a', body: 'BODY-A' });
    expect(p.indexOf('<agent-template name="card-a">')).toBe(0);
    expect(p.indexOf('BODY-A')).toBeLessThan(p.indexOf('[omd leaf: n1]'));
    expect(p).toContain('<persona>支付风控视角</persona>');
    // 无模板 → 老行为不变 (BC)
    expect(buildLeafPrompt('n1', node, {}).startsWith('[omd leaf: n1]')).toBe(true);
  });
});

describe('executor-dag e2e (fake model)', () => {
  const TPL: AgentTemplate = { name: 'skeptic-verifier', description: 'refute claims', model: 'prov:tpl-model', body: 'TPL-BODY-MARK' };
  const templates = new Map([[TPL.name, TPL]]);
  const planWith = (node: Record<string, unknown>) => JSON.stringify({ name: 'p', nodes: { a: { agent: 'x', goal: 'g', ...node } } });

  function makeFake(planText: string) {
    const calls: { model: string; prompt: string }[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      calls.push({ model, prompt: messages.map((m) => m.content).join('\n') });
      if (model === CONDUCTOR) return { text: planText, usage: { in: 1, out: 1 } };
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    return { gen, calls };
  }

  test('注册表进 conductor prompt; 模板 body 注入 leaf; 卡片 model 路由 (TPL-3)', async () => {
    const { gen, calls } = makeFake(planWith({ template: 'skeptic-verifier' }));
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, agentTemplates: templates });
    expect(res.results.a!.status).toBe('done');
    const conductorCall = calls.find((c) => c.model === CONDUCTOR)!;
    expect(conductorCall.prompt).toContain('- "skeptic-verifier": refute claims');
    expect(conductorCall.prompt).not.toContain('TPL-BODY-MARK'); // body 不进规划上下文
    const leafCall = calls.find((c) => c.model !== CONDUCTOR)!;
    expect(leafCall.model).toBe('prov:tpl-model'); // template.model 生效
    expect(leafCall.prompt).toContain('TPL-BODY-MARK');
    expect(res.results.a!.model).toBe('prov:tpl-model');
  });

  test('TPL-3: node.model 显式 > template.model', async () => {
    const { gen, calls } = makeFake(planWith({ template: 'skeptic-verifier', model: 'prov:explicit' }));
    await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, agentTemplates: templates });
    expect(calls.find((c) => c.model !== CONDUCTOR)!.model).toBe('prov:explicit');
  });

  test('TPL-2 规划层: conductor 引用未知模板 → 重试耗尽抛错', async () => {
    const { gen } = makeFake(planWith({ template: 'ghost' }));
    await expect(
      runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, agentTemplates: templates, maxPlanRetries: 0 }),
    ).rejects.toThrow(/unknown template/);
  });

  test('TPL-2 执行层兜底: 预构造 plan 带未知模板 → 忽略继续跑 (fail-open)', async () => {
    const { runExecutorDagWithPlan } = await import('../../src/harness/executor-dag');
    const { gen, calls } = makeFake('unused');
    const res = await runExecutorDagWithPlan(
      { name: 'p', nodes: { a: { agent: 'x', goal: 'g', template: 'ghost' } } },
      { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, agentTemplates: templates },
    );
    expect(res.results.a!.status).toBe('done');
    expect(calls.find((c) => c.model !== CONDUCTOR)!.prompt).not.toContain('agent-template'); // 未注入
  });
});
