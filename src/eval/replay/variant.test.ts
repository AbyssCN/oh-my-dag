/**
 * `src/eval/replay/variant.ts` 契约 C-1 / INV-1 真值链断言 (P2 切片 1, 2026-09-01)。
 *
 * 真值链 (三段):
 *   · 磁盘格式: readVariant / writeVariant round-trip 同字段同字节; 文件不存在 → null;
 *   · 转换层: variantSpecToPromptOpts(spec=null | 全字段缺省) → undefined; 任一字段在场
 *     → 该字段进 opts; 全 undefined → opts 是空对象且函数返 undefined;
 *   · 装配守恒: `conductorSystemPrompt({profile})` 与 `conductorSystemPrompt({profile, variant: undefined})`
 *     **逐字节相同** (`toBe` 字符串相等, 不是浅 toEqual); 任一字段在场 → 注入预期内容。
 *
 * 反向自检 (锁死判据力):
 *   - VARIANT_BYTE_STABLE: 把 `conductorSystemPrompt({variant: undefined})` 调用中的
 *     `variant: undefined` 删掉 → 这条仍然绿 (两条同真值), 故本断言不能是恒真;
 *     真实判据 = 两条串联:
 *       ① 无 opts.variant 与有 opts.variant:undefined → 字节相同
 *       ② 无 opts.variant 与有 opts.variant:{fewShotCards:[...]} → 字节不同
 *     这两条一起锁住"undefined 不是 absent"。
 *   - 把 variantSpecToPromptOpts 改成不传 fewShotCards → full 档 fewShotCards 注入测
 *     红 (opts 没传, 但 spec 有; 真值链失守)。
 *   - 把 readVariant 的 version 校验删掉 → load 一个 version:2 的 spec 不抛红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VARIANT_DIR,
  VARIANT_BYTE_STABLE,
  readVariant,
  variantSpecToPromptOpts,
  writeVariant,
  type VariantFewShotCard,
  type VariantSpec,
} from './variant';
import { conductorSystemPrompt } from '../../harness/conductor-plan';

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'variant-test-'));
  tmpRoot = root;
  return root;
}

// =====================================================================
// DISK_FORMAT — 磁盘读写与缺席语义
// =====================================================================
describe('DISK_FORMAT — variant 磁盘格式 (P2 C-1)', () => {
  test('writeVariant → readVariant round-trip 同字段同字节', () => {
    const dir = freshDir();
    const spec: VariantSpec = {
      version: 1,
      name: 'dense-fanout',
      fewShotCards: [{ id: 'c1', name: 'fanout-3', body: 'plan with 3 parallel leaves' }],
      extraAppend: ['Variant note A', 'Variant note B'],
    };
    const path = writeVariant(dir, spec);
    // 写出路径 = dir/<name>.json
    expect(path).toBe(join(dir, 'dense-fanout.json'));
    const reloaded = readVariant(dir, 'dense-fanout');
    expect(reloaded).toEqual(spec);
    // 字节级: round-trip 后内容不变
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(spec));
  });

  test('readVariant 文件不存在 → null (C-1 缺席语义)', () => {
    const dir = freshDir();
    expect(readVariant(dir, 'absent')).toBeNull();
  });

  test('readVariant JSON parse 错 → throw (不静默回落)', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'bad.json'), '{not valid json', 'utf8');
    expect(() => readVariant(dir, 'bad')).toThrow(/JSON parse/);
  });

  test('readVariant version 不匹配 → throw (防版本漂移)', () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, 'old.json'),
      `${JSON.stringify({ version: 2, name: 'old' }, null, 2)}\n`,
      'utf8',
    );
    expect(() => readVariant(dir, 'old')).toThrow(/version/);
  });

  test('writeVariant mkdir -p: 深层目录不存在 → 自动建', () => {
    const dir = freshDir();
    const deep = join(dir, 'a', 'b', 'c');
    const spec: VariantSpec = { version: 1, name: 'v' };
    writeVariant(deep, spec);
    expect(readVariant(deep, 'v')).toEqual(spec);
  });

  test('DEFAULT_VARIANT_DIR 锁死合同约定的 `runs/autoresearch/variants/`', () => {
    expect(DEFAULT_VARIANT_DIR).toBe('runs/autoresearch/variants');
  });
});

// =====================================================================
// SPEC_TO_OPTS — VariantSpec → VariantPromptOpts 转换层
// =====================================================================
describe('SPEC_TO_OPTS — spec ↦ opts 转换 (P2 C-1)', () => {
  test('null spec → undefined (全字段缺席语义)', () => {
    expect(variantSpecToPromptOpts(null)).toBeUndefined();
  });

  test('全字段缺省的 spec → undefined (等价 null, 缺席 = 不覆盖)', () => {
    const bare: VariantSpec = { version: 1, name: 'x' };
    expect(variantSpecToPromptOpts(bare)).toBeUndefined();
  });

  test('fewShotCards 在场 → 进 opts', () => {
    const cards: VariantFewShotCard[] = [{ id: 'a', name: 'A', body: 'a-body' }];
    const spec: VariantSpec = { version: 1, name: 'x', fewShotCards: cards };
    const opts = variantSpecToPromptOpts(spec);
    expect(opts).toBeDefined();
    expect(opts!.fewShotCards).toEqual(cards);
    expect(opts!.extraAppend).toBeUndefined();
  });

  test('extraAppend 在场 → 进 opts', () => {
    const spec: VariantSpec = { version: 1, name: 'x', extraAppend: ['a', 'b'] };
    const opts = variantSpecToPromptOpts(spec);
    expect(opts).toBeDefined();
    expect(opts!.extraAppend).toEqual(['a', 'b']);
    expect(opts!.fewShotCards).toBeUndefined();
  });

  test('profileOverride 是 spec 字段, 不进 prompt opts (走调用方 caller 链)', () => {
    const spec: VariantSpec = { version: 1, name: 'x', profileOverride: 'lean' };
    const opts = variantSpecToPromptOpts(spec);
    expect(opts).toBeUndefined(); // opts 只看 fewShotCards / extraAppend, profileOverride 由 caller 链消费
  });
});

// =====================================================================
// VARIANT_BYTE_STABLE — 装配守恒 (P2 INV-1, 2026-09-01)
// 锁住: 无 variant / variant:undefined / 全字段缺省三种"在场但不覆盖"形态, 输出逐字节相同。
// =====================================================================
describe(`${VARIANT_BYTE_STABLE} — conductorSystemPrompt 装配守恒 (P2 INV-1)`, () => {
  const PROFILES = ['full', 'lean', 'lean-kb'] as const;

  for (const profile of PROFILES) {
    test(`${profile} 档: 无 opts.variant 与 opts.variant:undefined 字节相同 (C-1 守恒)`, () => {
      const baseline = conductorSystemPrompt({ profile });
      const withExplicitUndef = conductorSystemPrompt({ profile, variant: undefined });
      expect(withExplicitUndef).toBe(baseline); // toBe 字符串逐字节相等
      expect(withExplicitUndef.length).toBe(baseline.length);
    });

    test(`${profile} 档: 全字段缺省 spec 转的 opts 与 undefined opts 字节相同 (缺席 = 不覆盖)`, () => {
      const baseline = conductorSystemPrompt({ profile });
      const emptyOpts = variantSpecToPromptOpts({ version: 1, name: 'x' });
      expect(emptyOpts).toBeUndefined();
      const withEmpty = conductorSystemPrompt({ profile, variant: emptyOpts });
      expect(withEmpty).toBe(baseline);
    });

    test(`${profile} 档: variant fewShotCards 在场 → 输出不同 + 含卡内容`, () => {
      const baseline = conductorSystemPrompt({ profile });
      const card: VariantFewShotCard = {
        id: 'fewshot-test',
        name: 'three-parallel-fanout',
        body: 'VARIANT_BYTE_STABLE: this is a synthetic few-shot card body for the test',
      };
      const opts = { fewShotCards: [card] };
      const withVariant = conductorSystemPrompt({ profile, variant: opts });
      // 注入 → 不同字节
      expect(withVariant).not.toBe(baseline);
      // 卡内容真进了 prompt
      expect(withVariant).toContain(card.body);
      expect(withVariant).toContain(card.name);
      expect(withVariant).toContain(card.id);
    });

    test(`${profile} 档: variant extraAppend 在场 → 追加段 (在 TRUST_FENCE_RULE 之前)`, () => {
      const baseline = conductorSystemPrompt({ profile });
      const lines = ['extra-line-1', 'extra-line-2'];
      const opts = { extraAppend: lines };
      const withVariant = conductorSystemPrompt({ profile, variant: opts });
      expect(withVariant).not.toBe(baseline);
      // 两段追加都进了 prompt
      for (const l of lines) expect(withVariant).toContain(l);
      // TRUST_FENCE_RULE 仍然在场 (variant 不替换, 只追加)
      expect(withVariant).toContain('信任 token');
    });
  }

  test('bare 档: opts.variant:undefined 与无 variant opts 字节相同 (C-1 守恒)', () => {
    // bare 档走单独的 bareConductorSystemPrompt, 无 variant 注入; 但 opts.variant 字段
    // 在场 (即使是 undefined) 也不应改变输出 —— 这是与 full/lean 同款的纪律。
    const baseline = conductorSystemPrompt({ profile: 'bare' });
    const withExplicitUndef = conductorSystemPrompt({ profile: 'bare', variant: undefined });
    expect(withExplicitUndef).toBe(baseline);
  });

  test('bare 档: variant fewShotCards 在场 → 字节仍同 bare (bare 不注入, 零附加内容基线)', () => {
    // bare = 零附加内容基线 (INV-1 #182); 即便 opts.variant 有内容也不注入
    const baseline = conductorSystemPrompt({ profile: 'bare' });
    const card: VariantFewShotCard = { id: 'b', name: 'B', body: 'B-body' };
    const withVariant = conductorSystemPrompt({ profile: 'bare', variant: { fewShotCards: [card] } });
    expect(withVariant).toBe(baseline); // bare 早返, 不触注入
  });

  test('CONTROL: 同 opts.variant 两跑 → 字节相同 (snapshot 内不变性)', () => {
    const opts = {
      extraAppend: ['same'],
      fewShotCards: [{ id: 'x', name: 'X', body: 'X-body' }],
    };
    const a = conductorSystemPrompt({ profile: 'full', variant: opts });
    const b = conductorSystemPrompt({ profile: 'full', variant: opts });
    expect(a).toBe(b);
  });
});