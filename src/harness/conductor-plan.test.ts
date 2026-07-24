/**
 * conductor-plan 提取/解析回归测试 (PLAN-2 弱模型不可信)。
 * 起因 (2026-07-25): 惰性 ```…``` fence 正则被字符串值里的 ``` 提前截断 —— k3 goal 引用
 * spec 的 "不含 ``` 围栏" → 提取物切在字符串中间 → Unterminated string 整轮报废。
 * 修后: fence 只定位起点, 终点一律括号平衡扫描。
 */
import { describe, expect, test } from 'bun:test';
import { extractPlanJson, parsePlan } from './conductor-plan';

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
