/**
 * conductor-plan 提取/解析回归测试 (PLAN-2 弱模型不可信)。
 * 起因 (2026-07-25): 惰性 ```…``` fence 正则被字符串值里的 ``` 提前截断 —— k3 goal 引用
 * spec 的 "不含 ``` 围栏" → 提取物切在字符串中间 → Unterminated string 整轮报废。
 * 修后: fence 只定位起点, 终点一律括号平衡扫描。
 */
import { describe, expect, test } from 'bun:test';
import { extractPlanJson, parsePlan } from './conductor-plan';
import { topoLevels } from './dag/planner';

const PLAN = { name: 'p', nodes: { a: { goal: 'x' } } };

describe('extractPlanJson', () => {
  test('字符串值内含 ``` 的 fenced JSON 不被截断 (k3 实证回归)', () => {
    const inner = { name: 'p', nodes: { a: { goal: '输出 Mermaid 文本 (不含 ``` 围栏), 保持纯文本' } } };
    const text = '```json\n' + JSON.stringify(inner, null, 2) + '\n```';
    expect(JSON.parse(extractPlanJson(text))).toEqual(inner);
    expect(parsePlan(text, { knownServers: new Set() }).ok).toBe(true);
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
    expect(parsePlan(text, { knownServers: new Set() }).ok).toBe(true);
  });

  test('无闭合 fence 的截断输出 → 余文交 JSON.parse 报错 (parsePlan 返回 ok:false 不抛)', () => {
    const text = '```json\n{"name": "p", "nodes": {"a": {"goal": "截断';
    const r = parsePlan(text, { knownServers: new Set() });
    expect(r.ok).toBe(false);
  });
});


// ── 开放生态 D-3: 节点 mcp 声明通道 ──────────────────────────────────────────

describe('节点 mcp 声明 (开放生态 D-3)', () => {
  const SERVERS = new Set(['filesystem', 'playwright']);

  test('合法 mcp 字段 (server 名 + server:tool, 含 map 子模板) 解析 ok', () => {
    const plan = {
      name: 'p',
      nodes: {
        a: { goal: 'x', mcp: ['filesystem', 'playwright:shot'] },
        fan: {
          executor: 'map',
          map: {
            lister: { goal: 'list' },
            over: 'items',
            itemVar: 'item',
            template: { goal: 'y', mcp: ['filesystem'] },
          },
        },
      },
    };
    const r = parsePlan(JSON.stringify(plan), { knownServers: SERVERS });
    expect(r.ok).toBe(true);
  });

  test('声明未注册 server → 整 plan 不 ok 且错误含该 server 名 (★ 坏样本证红)', () => {
    // 证伪方式: 删掉 parsePlan 的 knownServers 检查 (或只留 knownTemplates), 本测试必红 ——
    // r.ok 变 true, 错误文本里也没有未注册名。它就是「声明了未注册 server 必须被拒」的回归。
    const plan = { name: 'p', nodes: { a: { goal: 'x', mcp: ['filesystem', 'ghost:tool'] } } };
    const r = parsePlan(JSON.stringify(plan), { knownServers: SERVERS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ghost');
  });

  test('空注册表 → 任何 mcp 声明都被拒 (knownServers 必传 = fail-closed, 无省略即跳过的路径)', () => {
    // 惰性闸修复 (D-3): knownServers 是 parsePlan 的必传参 —— 旧版可选时省略即静默跳过校验。
    // 证伪: 把签名改回可选 / 校验块删掉 → 本条 r.ok 变 true → 红。
    const plan = { name: 'p', nodes: { a: { goal: 'x', mcp: ['ghost'] } } };
    const r = parsePlan(JSON.stringify(plan), { knownServers: new Set() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ghost');
  });
});

/**
 * 环 → schema 判死 (issue #25, 2026-08-14)。
 *
 * **为什么闸在 schema 层而不在 parsePlan 里**: 造 plan 的入口不止一个 —— plan-patch 的 merge、
 * pathfinder 的 slice-compiler、arch/deepen-plan、slim/local-plan 全都过 `PlanSchema` 而各自没有
 * 环检。放这里一处等于同时给它们全都上闸。
 *
 * **为什么是 fail-closed 而不是 report-only** (与同一分支上的悬空依赖相反): 环没有 intentional
 * 消费方 —— 运行时子图对环早就是拒整份 (conductor-expand 的 status:'cycle'), 顶层反而最宽。
 *
 * **反向自检 (实跑过)**: 注掉 `PlanSchema` superRefine 里的 `findGraphCycle` 那一段 →
 * 本 describe 的三条报环用例全红 (parsePlan 返 ok:true), 而"无环图照过"那条仍绿。
 */
describe('依赖环 → parsePlan 拒 (fail-closed)', () => {
  const parse = (nodes: Record<string, unknown>) =>
    parsePlan(JSON.stringify({ name: 'p', nodes }), { knownServers: new Set() });

  test('二元环 A↔B → ok:false 且判词点名环路', () => {
    const r = parse({ A: { goal: 'a', depends_on: ['B'] }, B: { goal: 'b', depends_on: ['A'] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('依赖环');
    expect(r.error).toContain('A');
    expect(r.error).toContain('B');
  });

  test('自环 → 同样拒 (不靠"没人会这么画"兜)', () => {
    expect(parse({ A: { goal: 'a', depends_on: ['A'] } }).ok).toBe(false);
  });

  test('三元环 → 拒', () => {
    const r = parse({
      a: { goal: 'a', depends_on: ['c'] },
      b: { goal: 'b', depends_on: ['a'] },
      c: { goal: 'c', depends_on: ['b'] },
    });
    expect(r.ok).toBe(false);
  });

  test('无环图照过 (证明上面不是恒拒的空转断言)', () => {
    expect(parse({ a: { goal: 'a' }, b: { goal: 'b', depends_on: ['a'] } }).ok).toBe(true);
  });

  test('幻象 dep 不算边 → 不误判成环 (它归 static-lint 的 report-only, 不在这道 fail-closed 闸里)', () => {
    const r = parse({ research: { goal: 'r' }, syn: { goal: 's', depends_on: ['reserach'] } });
    expect(r.ok).toBe(true);
  });

  test('拒出去的环**不会**再走到执行入口 topoLevels 那道兜底 (两道闸判据一致)', () => {
    const cyclic = { name: 'p', nodes: { A: { goal: 'a', depends_on: ['B'] }, B: { goal: 'b', depends_on: ['A'] } } };
    expect(parsePlan(JSON.stringify(cyclic), { knownServers: new Set() }).ok).toBe(false);
    // topoLevels 那道保留是因为运行期挂进图的子节点 (map/conductor 展开) 不过 schema。
    expect(() => topoLevels(cyclic as never)).toThrow(/cycle/);
  });
});
