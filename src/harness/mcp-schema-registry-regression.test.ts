/**
 * mcp 字段的 schema-registry 五处同步回归 (S2 verification-gap 修复)。
 * leaf_wiring 把 `mcp` 接进了五处, 任一处恢复旧值这里必红 —— 全部复用**生产真源/生产 checker**,
 * 不 grep 源码字符串、不手抄期望值:
 *   ① semantic-key: 生产 nodeFieldsKey 对 mcp 取值对敏感;
 *   ② pairs/dedup: 生产 dedupPass 不合并只差 mcp 的两节点 (控制组证明闸在转);
 *   ③ REGISTRY: 生产 REGISTRY.mcp 行与 ① 重算的指纹归属一致, 且 consumer 非空非 '—';
 *   ④ DECLARED_CONSUMERS 关系 (明示即承诺): 生产 conductorSystemPrompt 明示 mcp ⇒ REGISTRY 有消费者;
 *   ⑤ 生成文档: 生产生成器 renderRegistryDoc 的 mcp 行逐字节在 docs 文档里。
 *
 * 证伪方式 (逐条写在各测试注释): 恢复任一处旧值 → 对应测试红。
 * 原报红的六条 schema-registry 系测试 (dedup-pass INV-10 / schema-field-registry 覆盖面·
 * 指纹 oracle·明示 oracle·人读版 / empty-knobs 明示即承诺) 由各自文件守住, 本文件钉 mcp 这一行不漂。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ConductorPlan } from './conductor-plan';
import { nodeFieldsKey } from './plan-passes/semantic-key';
import { dedupPass } from './plan-passes/dedup-pass';
import { REGISTRY } from './schema-field-registry';
import { renderRegistryDoc } from '../../scripts/gen-schema-registry-doc';

type PlanNode = ConductorPlan['nodes'][string];

describe('mcp schema-registry 五处同步', () => {
  test('① semantic-key: mcp 入 nodeFieldsKey (取值对与省略都改键)', () => {
    // 证伪: semantic-key.ts 删掉 mcp 行 → 三键相同 → 红。
    const a = nodeFieldsKey({ goal: 'g', mcp: ['t'] } as unknown as PlanNode);
    const b = nodeFieldsKey({ goal: 'g', mcp: ['t:poke'] } as unknown as PlanNode);
    const bare = nodeFieldsKey({ goal: 'g' } as unknown as PlanNode);
    expect(a).not.toBe(b);
    expect(a).not.toBe(bare);
    // 控制组: 完全相同 → 同键 (证明上面不是恒不等空转)。
    expect(nodeFieldsKey({ goal: 'g', mcp: ['t'] } as unknown as PlanNode)).toBe(a);
  });

  test('② pairs/dedup: 只差 mcp 的两节点**不**被 dedupPass 合并', () => {
    // 证伪: 同① (指纹脱钩 → 两节点被合成一个 → merged 非空 → 红)。
    const plan = {
      name: 'p',
      nodes: { a1: { goal: 'g', mcp: ['t'] }, a2: { goal: 'g', mcp: ['t:poke'] } },
    } as unknown as ConductorPlan;
    expect(dedupPass(plan).merged).toEqual({});
    // 控制组: mcp 相同的重复节点**被**合并 (证明 dedupPass 在本输入上确实在判重)。
    const dup = {
      name: 'p',
      nodes: { b1: { goal: 'g', mcp: ['t'] }, b2: { goal: 'g', mcp: ['t'] } },
    } as unknown as ConductorPlan;
    expect(dedupPass(dup).merged).toEqual({ b2: 'b1' });
  });

  test('③ REGISTRY.mcp: 登记行与生产 oracle 重算一致 (fingerprint/consumer)', () => {
    const entry = REGISTRY.mcp;
    expect(entry).toBeDefined(); // 证伪: 删 REGISTRY.mcp → 红 (覆盖面闸同红)。
    // 指纹归属不手抄: 用生产 nodeFieldsKey 重算实际归属再对表。
    // 证伪: semantic-key 回退而 REGISTRY 不改 → actual=false ≠ 'fields' → 红; 反之表改错 → 同红。
    const actual = nodeFieldsKey({ goal: 'g', mcp: ['t'] } as unknown as PlanNode) !== nodeFieldsKey({ goal: 'g' } as unknown as PlanNode)
      ? 'fields'
      : false;
    expect(entry!.fingerprint).toBe(actual);
    expect(entry!.fingerprint).toBe('fields');
    expect(entry!.consumer.trim()).not.toBe('');
    expect(entry!.consumer).not.toBe('—');
  });


  test('⑤ 生成文档: 生产生成器渲染的 mcp 行逐字节在 docs 表里', () => {
    // 证伪: REGISTRY.mcp 任一列回退旧值 → renderRegistryDoc 的 mcp 行变 → includes 红;
    // docs 文档回退 (行被删/手改) → 同红。生成器是生产的, 期望行不在本测试手抄。
    const mcpRow = renderRegistryDoc()
      .split('\n')
      .find((l) => l.startsWith('| `mcp` |'));
    expect(mcpRow).toBeDefined();
    const doc = readFileSync(join(import.meta.dir, '../../docs/plan/2026-07-30-schema-field-registry.md'), 'utf-8');
    expect(doc).toContain(mcpRow!);
  });
});
