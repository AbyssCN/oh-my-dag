/**
 * scale-fixture 的**输入面自证** (2026-08-27, S2 规模实验先决件)。
 *
 * 规模实验的四要素里,「其他输入与环境冻结」(契约 D-8) 全靠发生器确定性成立。
 * 所以这组测试钉的不是"发生器好用", 是**实验前提本身**:
 *   · 条目 schema 合法 → 否则量的是垃圾;
 *   · 逐字节确定性 → 否则同一档两次跑出的数不可比;
 *   · 档间嵌套 (20 是 50 的前缀) → 否则四档是四组无关样本, 不是单变量;
 *   · 单变量 → 默认零歧义对, 规模是唯一动的东西。
 *
 * ## 反向自检 (每条真跑过一次)
 * · 给 `content_sha256` 塞随机值 → 「两次调用逐字节相同」当场红。
 * · 让 when_to_use 恒定不随 k 变 → 「体积随规模单调增」仍绿 (它不该守这个),
 *   但「档间嵌套」不受影响 —— 故意留着这条对照, 免得靠"全都相同"作弊通过。
 * · 把 ambiguousPairs 默认改成 1 → 「默认零歧义」红。
 */
import { describe, expect, test } from 'bun:test';
import { InventoryEntrySchema } from './inventory';
import { makeScaleInventory, measureBulk, assertAllValid, SCALE_STEPS } from './scale-fixture';

describe('scale-fixture: 实验输入面自证', () => {
  test('★ 四档条目全部过 schema (输入面合法, 否则量的是垃圾)', () => {
    for (const n of SCALE_STEPS) {
      const e = makeScaleInventory(n);
      expect(e).toHaveLength(n);
      expect(() => assertAllValid(e)).not.toThrow();
    }
  });

  test('★ 逐字节确定性: 同一 n 两次调用结果相同 (冻结的前提)', () => {
    for (const n of SCALE_STEPS) {
      expect(JSON.stringify(makeScaleInventory(n))).toBe(JSON.stringify(makeScaleInventory(n)));
    }
  });

  test('★ 档间嵌套: 小档是大档的前缀 (四档才算单变量, 不是四组无关样本)', () => {
    const big = makeScaleInventory(200);
    for (const n of SCALE_STEPS) {
      expect(JSON.stringify(makeScaleInventory(n))).toBe(JSON.stringify(big.slice(0, n)));
    }
  });

  test('★ 默认零歧义对: 规模是唯一变量 (裸名全局唯一)', () => {
    const e = makeScaleInventory(200);
    const bare = e.map((x) => x.name);
    expect(new Set(bare).size).toBe(bare.length);
  });

  test('★ ambiguousPairs 显式给才造歧义 (留给 F17/PP-T02 的另一个实验)', () => {
    const e = makeScaleInventory(20, { ambiguousPairs: 3 });
    const counts = new Map<string, number>();
    for (const x of e) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
    expect([...counts.values()].filter((c) => c === 2)).toHaveLength(3);
    // 歧义条目的 id 必须真的不同源, 否则 F17 判不出歧义。
    const amb = e.filter((x) => x.name.startsWith('amb-'));
    expect(new Set(amb.map((x) => x.id)).size).toBe(amb.length);
    expect(() => assertAllValid(e)).not.toThrow();
  });

  test('★ 非法入参当场拒 (n 负数 / 歧义对超额)', () => {
    expect(() => makeScaleInventory(-1)).toThrow(/非负整数/);
    expect(() => makeScaleInventory(4, { ambiguousPairs: 3 })).toThrow(/超过/);
  });
});

describe('scale-fixture: 体积读数 (重测「39 工具≈15k token」那条外部主张)', () => {
  test('★ 体积随规模单调增, 且 200 档与 20 档的比落在条目数比附近', () => {
    const m = SCALE_STEPS.map((n) => measureBulk(makeScaleInventory(n)));
    for (let i = 1; i < m.length; i++) {
      expect(m[i]!.jsonBytes).toBeGreaterThan(m[i - 1]!.jsonBytes);
      expect(m[i]!.promptFacingBytes).toBeGreaterThan(m[i - 1]!.promptFacingBytes);
    }
    // 线性度粗核: 条目数 ×10, 体积应在 ×5 与 ×20 之间 (when_to_use 长度随 k 变, 不强求严格线性)。
    const ratio = m[3]!.promptFacingBytes / m[0]!.promptFacingBytes;
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(20);
  });

  test('★ measureBulk 的 entries 与真实条目数一致 (读数不许自己编)', () => {
    for (const n of SCALE_STEPS) {
      expect(measureBulk(makeScaleInventory(n)).entries).toBe(n);
    }
  });

  test('★ 单条也能量 (n=1 不特殊, 边界不炸)', () => {
    const one = makeScaleInventory(1);
    expect(() => InventoryEntrySchema.parse(one[0])).not.toThrow();
    expect(measureBulk(one).entries).toBe(1);
    expect(measureBulk([]).entries).toBe(0);
  });
});
