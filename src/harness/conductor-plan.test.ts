/**
 * conductor-plan 提取/解析回归测试 (PLAN-2 弱模型不可信)。
 * 起因 (2026-07-25): 惰性 ```…``` fence 正则被字符串值里的 ``` 提前截断 —— k3 goal 引用
 * spec 的 "不含 ``` 围栏" → 提取物切在字符串中间 → Unterminated string 整轮报废。
 * 修后: fence 只定位起点, 终点一律括号平衡扫描。
 */
import { describe, expect, test } from 'bun:test';
import { conductorPatchSystemPrompt, conductorSystemPrompt, extractPlanJson, parsePlan } from './conductor-plan';
import { DEFAULT_COMMAND_ALLOWLIST } from './command-leaf';
import { topoLevels } from './dag/planner';

const PLAN = { name: 'p', nodes: { a: { goal: 'x' } } };

describe('extractPlanJson', () => {
  test('字符串值内含 ``` 的 fenced JSON 不被截断 (k3 实证回归)', () => {
    const inner = { name: 'p', nodes: { a: { goal: '输出 Mermaid 文本 (不含 ``` 围栏), 保持纯文本' } } };
    const text = '```json\n' + JSON.stringify(inner, null, 2) + '\n```';
    expect(JSON.parse(extractPlanJson(text))).toEqual(inner);
    expect(parsePlan(text).ok).toBe(true);
  });

  test('普通 fenced JSON', () => {
    const text = '```json\n' + JSON.stringify(PLAN) + '\n```';
    expect(JSON.parse(extractPlanJson(text))).toEqual(PLAN);
  });

  test('无 fence 裸 JSON + 尾随含花括号 prose (G2 P2 回归)', () => {
    const text = JSON.stringify(PLAN) + '\nNote: {this} trails';
    expect(JSON.parse(extractPlanJson(text))).toEqual(PLAN);
  });

  test('fence 前含花括号 prose → 从 fence 后取起点', () => {
    const text = 'thinking {draft} above\n```json\n' + JSON.stringify(PLAN) + '\n```';
    expect(JSON.parse(extractPlanJson(text))).toEqual(PLAN);
  });

  test('裸 JSON (无 fence) 字符串值内含 ``` → 不把它当 fence 锚点跳进正文 (k3-fail-rep6 回归)', () => {
    const inner = {
      name: 'p',
      nodes: {
        a: { goal: '输出 Mermaid 文本 (不含 ``` 围栏)' },
        gate: { executor: 'command', command: 'bun test', postcondition: { method: 'structural' } },
      },
    };
    const text = JSON.stringify(inner, null, 2);
    expect(JSON.parse(extractPlanJson(text))).toEqual(inner);
    expect(parsePlan(text).ok).toBe(true);
  });

  test('无闭合 fence 的截断输出 → 余文交 JSON.parse 报错 (parsePlan 返回 ok:false 不抛)', () => {
    const text = '```json\n{"name": "p", "nodes": {"a": {"goal": "截断';
    const r = parsePlan(text);
    expect(r.ok).toBe(false);
  });
});

// ── SDD v2 S5: conductor prompt motif (G-9) ──────────────────────────────────

describe('S5 conductor prompt: SDD v2 字段 + 前端 motif (G-9)', () => {
  const full = conductorSystemPrompt();
  const lean = conductorSystemPrompt({ profile: 'lean' });

  test('两档均含调度/分配字段指引 (环境事实, lean 不裁)', () => {
    for (const p of [full, lean]) {
      expect(p).toContain('"requires"');
      expect(p).toContain('"cluster"');
      expect(p).toContain('"tier"');
      expect(p).toContain('"attach_media"');
      expect(p).toContain('Plan-level "outputs"');
    }
  });

  // 2026-07-26: shape 段从散文改成 src/harness/shapes 的渲染 (单一真源, 同时喂 conductor 与
  // 组合模式下的外部 agent)。断言改成"数据里的每个 shape 都出现在 prompt 里 + 硬闸标注在"。
  test('两档均含全部 shape (含反例行) 与 UI 证据链的零模型硬闸', () => {
    for (const p of [full, lean]) {
      expect(p).toContain('Graph shapes');
      expect(p).toContain('ui-evidence');
      expect(p).toContain('full-stack');
      expect(p).toContain('one-decision-then-fanout');
      expect(p).toContain('NOT when:'); // 反例是数据化强制多出来的那一栏
      expect(p).toContain('omd-shots-verify'); // 硬规则 = 零模型闸
      expect(p).toContain('ENFORCED:'); // 建议与硬闸必须可分辨
      expect(p).toContain('cross-review');
    }
  });

  test('输出 schema 块列出新字段 (plan outputs + requires/cluster/tier/attach_media/output_path)', () => {
    for (const p of [full, lean]) {
      expect(p).toContain('"outputs"?: string[]');
      expect(p).toContain('"requires"?: "all"|"any"|number');
      expect(p).toContain('"tier"?: "strong"|"mid"|"cheap"');
      expect(p).toContain('"output_path"?: string');
    }
  });

  test('schema 块不再明示 "skill" (执行层无加载器, 防回归重新邀请无载荷字段)', () => {
    for (const p of [full, lean]) expect(p).not.toContain('"skill"?');
  });

  test('G-9 结构验收: motif 形状的前端图 parse 通过且无环, 分层符合 motif 序', () => {
    const motifPlan = {
      name: 'frontend-sdd',
      outputs: ['cross_review'],
      nodes: {
        r_domain: { goal: '领域调研', cluster: 'research' },
        r_ux: { goal: 'UX 对标调研', cluster: 'research' },
        contract: { goal: '产 API/props 契约文本', depends_on: ['r_domain', 'r_ux'], requires: 'all' },
        be_impl: { goal: '实装 API', executor: 'agent', output_type: 'file', output_path: 'src/api.ts', depends_on: ['contract'], cluster: 'backend' },
        fe_impl: { goal: '实装 UI', executor: 'agent', output_type: 'file', output_path: 'src/ui.tsx', depends_on: ['contract'], cluster: 'frontend' },
        render: { goal: '构建并截图', executor: 'command', command: 'bun run build && bun scripts/shot.ts', depends_on: ['fe_impl'] },
        mm_review: { goal: 'UI/UX 像素审查', depends_on: ['render'], attach_media: true, tier: 'strong' },
        cross_review: { goal: '契约违反与遗漏交叉审查', depends_on: ['contract', 'be_impl', 'fe_impl', 'mm_review'] },
      },
    };
    const r = parsePlan(JSON.stringify(motifPlan));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const levels = topoLevels(r.plan); // 无环 (有环会抛)
    expect(levels[0]!.sort()).toEqual(['r_domain', 'r_ux']); // research 簇并行根
    expect(levels[1]).toEqual(['contract']); // 契约 = 同步点
    expect(levels[2]!.sort()).toEqual(['be_impl', 'fe_impl']); // 前后端簇并行
    const idx = (id: string): number => levels.findIndex((l) => l.includes(id));
    expect(idx('render')).toBeGreaterThan(idx('fe_impl'));
    expect(idx('mm_review')).toBeGreaterThan(idx('render'));
    expect(idx('cross_review')).toBeGreaterThan(idx('mm_review'));
  });
});

/**
 * **两份 prompt 都得看得见 command leaf 的闸** (2026-08-01, live 抓出来的洞)。
 *
 * 白名单当初进规划 prompt 的判据是「conductor 只能猜, 猜错就是假红 (合法验证步被闸拒)」——
 * 当时只补了规划那一条路。补丁重规划 prompt 是自足的十几行, 这段事实一个字都没有, 于是
 * **escalation 轮的 conductor 对闸是瞎的**, 而修复轮恰恰专门在改被判失败的验证节点。
 *
 * live 三跑 3/3 复现: 它把 `expect_exit:1` 的节点改写成 `grep …; rc=$?; test "$rc" -eq 1`
 * (规划 prompt 明文禁止的 shell 取反), 把另一个改写成 `$(cat …)` —— 双双撞注入闸 → 假红。
 */
describe('command 闸的环境事实 = 两份 prompt 的单一真源', () => {
  const cases: Array<[string, string]> = [
    ['规划 prompt', conductorSystemPrompt()],
    ['补丁重规划 prompt', conductorPatchSystemPrompt()],
  ];
  for (const [label, prompt] of cases) {
    test(`${label} 带白名单全表 + 元字符禁令 + expect_exit 的正确表达`, () => {
      for (const bin of DEFAULT_COMMAND_ALLOWLIST) expect(prompt).toContain(bin);
      expect(prompt).toContain('expect_exit');
      // 「别在 shell 里取反」—— 被改写掉的那两条命令用的正是 `;` `$?` `$()`。
      expect(prompt).toContain('$?');
      expect(prompt).toMatch(/rejected/i);
    });
  }
});
