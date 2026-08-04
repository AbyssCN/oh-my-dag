/**
 * tool-renames —— 三层改名装配层变换的契约(t7, owner 2026-08-04)。
 *
 * 钉三件事:
 * 1. 表内工具挂新名, 描述/schema/handler 原样(改名不改行为)。
 * 2. 旧名仍在注册面上(deprecated alias), 与新名**共享同一个 handler 引用** ——
 *    alias 是同一扇门的旧门牌, 不是第二扇门。
 * 3. 真实装配面经变换后: 新名全在、旧名全在、无重名(server.registerTool 重名会炸)。
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_RENAMES, applyToolRenames } from './tool-renames';
import type { OmdMcpTool } from './server';

const fake = (name: string): OmdMcpTool => ({
  name,
  description: `desc-${name}`,
  inputSchema: {},
  handler: (async () => ({ content: [] })) as never,
});

describe('applyToolRenames', () => {
  test('表内工具: 新名为主, 旧名成 deprecated alias, 共享 handler', () => {
    const [primary, alias] = applyToolRenames([fake('dag_goal')]);
    expect(primary!.name).toBe('solve');
    expect(primary!.description).toBe('desc-dag_goal'); // 改名不改描述
    expect(alias!.name).toBe('dag_goal');
    expect(alias!.description.startsWith('[deprecated → solve]')).toBe(true);
    expect(alias!.description.length).toBeLessThanOrEqual(120); // alias 不拖原文 (D-11 一行税)
    expect(alias!.handler).toBe(primary!.handler); // 同一扇门
  });

  test('表外工具原样通过, 不增不改', () => {
    const out = applyToolRenames([fake('dag_status')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('dag_status');
    expect(out[0]!.description).toBe('desc-dag_status');
  });

  test('全表变换: 9 条改名 → 面上多 9 个 alias, 无重名', () => {
    const olds = Object.keys(TOOL_RENAMES);
    const out = applyToolRenames(olds.map(fake));
    expect(out).toHaveLength(olds.length * 2);
    const names = out.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // 重名注册会在 server 层炸
    for (const [old, next] of Object.entries(TOOL_RENAMES)) {
      expect(names).toContain(old);
      expect(names).toContain(next);
    }
  });

  test('三层承诺名就位: map_* ⊃ solve ⊃ run', () => {
    const values = Object.values(TOOL_RENAMES);
    expect(values).toContain('solve');
    expect(values).toContain('run');
    expect(values.filter((v) => v.startsWith('map_'))).toHaveLength(7);
  });
});
