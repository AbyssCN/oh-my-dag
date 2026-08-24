/**
 * #248 / 契约片 1 — conductor prompt shape 四字段 + registry declared 翻真 (新建, INV-5b)。
 *
 * 起因 (2026-08-24, Opus 一发出图 11 节点, 全对编排形状, 但四字段全省略 —— shape 块没有,
 * 散文教化无效)。活图喂活规划环 (parsePlan 之后) → plan-critic 22×PP-I02, 闸在而活环没接。
 *
 * ## INV-5b (执行契约): 此文件实装前**不存在**, 因此 verify 首段 (`bun test
 * src/harness/conductor-prompt-fields.test.ts`) 单独跑时实装前 exit 1, 与既有守护测试拆
 * 两段以防多 filter 被 bun 静默忽略后的假 done (run bca0a0c7 教训)。**禁止把断言塞进既有
 * 文件** (schema-field-registry.test.ts / empty-knobs.test.ts / conductor-prompt-snapshot.test.ts)
 * 替代本测试 —— 那等于让 INV-5b 的"实装前天然红"失效。
 *
 * 闸要守的事:
 *  - INV-1: full/lean 两档 shape 段含四字段字面; bare 不动
 *  - INV-3: declaredFields() 正则改 camelCase 后, 四个字段进闸 + registry declared:true 翻真
 *  - INV-4: L2 教化段 (DECISION_EDUCATION_CANONICAL) 字节不动, prompt-lint 必绿样本不受影响
 *
 * 命名 / 措辞 / 枚举与 zod PlanSchema 逐字一致 (D-1); 与 plan-critic.criticizePlan 的诊断码
 * (PP-O01 / PP-T01 / PP-I01 / PP-I02) 互为契约 (D-2 / C-2 #247 活环 enforce 子集真源)。
 */
import { describe, expect, test } from 'bun:test';
import { bareConductorSystemPrompt, conductorSystemPrompt } from './conductor-plan';
import { REGISTRY } from './schema-field-registry';

const FOUR_FIELDS = ['oracleKind', 'toolRefs', 'whyNoFanout', 'budgetBasis'] as const;

/** 取 `"nodes"` 之后那一段 (shape 段 = conductor 逐字照抄的契约)。 */
function shapeSection(profile: 'full' | 'lean' | 'bare'): string {
  const p =
    profile === 'bare' ? bareConductorSystemPrompt() : conductorSystemPrompt({ profile });
  const start = p.indexOf('"nodes"');
  expect(start).toBeGreaterThan(-1); // 防御: shape 段还在, 否则本闸空转
  return p.slice(start);
}

describe('#248 / 契约片 1 — conductor prompt shape 四字段', () => {
  describe('INV-1: full / lean 两档 shape 段含四字段字面', () => {
    for (const profile of ['full', 'lean'] as const) {
      test(`${profile} 档 shape 段含 oracleKind / toolRefs / whyNoFanout / budgetBasis 字面`, () => {
        const shape = shapeSection(profile);
        for (const f of FOUR_FIELDS) {
          expect(shape, `${profile} 档 shape 段缺 "${f}" 字面 (D-1: 邀请 conductor 写它必须进 shape)`)
            .toContain(`"${f}"`);
        }
      });

      test(`${profile} 档 oracleKind 枚举措辞与 zod PlanSchema 逐字一致 (D-1)`, () => {
        const shape = shapeSection(profile);
        // zod oracleKind enum = ['cheap', 'render', 'judge', 'none', 'self_built']
        expect(shape).toContain('"cheap"');
        expect(shape).toContain('"render"');
        expect(shape).toContain('"judge"');
        expect(shape).toContain('"none"');
        expect(shape).toContain('"self_built"');
      });

      test(`${profile} 档 toolRefs 元素形 = ["<source>:<name>@<ver>"] (D-1)`, () => {
        const shape = shapeSection(profile);
        // 与 inventory registerId 形同源 (resolveQuery 的 source/name/ver)
        expect(shape).toMatch(/"toolRefs"\?:\s*\["<source>:<name>@<ver>"\]/);
      });

      test(`${profile} 档 budgetBasis 子字段 = calls/tokensIn/tokensOut/costUsdCeiling/estimatedBy (D-1)`, () => {
        const shape = shapeSection(profile);
        for (const k of ['calls', 'tokensIn', 'tokensOut', 'costUsdCeiling', 'estimatedBy']) {
          expect(shape, `${profile} 档 budgetBasis 缺 "${k}" 子字段`).toContain(`"${k}"`);
        }
      });
    }
  });

  describe('INV-1 镜像: bare 档不动 (无教化基线, 加字段 = 改 bare 契约)', () => {
    test('bare 档 shape 段不含四字段字面', () => {
      const shape = shapeSection('bare');
      for (const f of FOUR_FIELDS) {
        expect(shape, `bare 档不该含 "${f}" (INV-1: bare 是无教化基线)`).not.toContain(`"${f}"`);
      }
    });

    test('bare 档经 conductorSystemPrompt 分派到 bareConductorSystemPrompt (零行为变更)', () => {
      // 防回归: bare 路径必须走单独的零附加内容基线, 不被 full/lean 分支污染
      expect(conductorSystemPrompt({ profile: 'bare' })).toBe(bareConductorSystemPrompt());
    });
  });

  describe('INV-3: declared 翻真 (registry 与 prompt 实际一致)', () => {
    test('registry 四字段 declared: true (D-5)', () => {
      for (const f of FOUR_FIELDS) {
        const e = REGISTRY[f];
        expect(e, `registry 缺 ${f} 登记`).toBeDefined();
        expect(e!.declared, `${f}.declared 应为 true (D-5: shape 段明示后翻真)`).toBe(true);
      }
    });

    test('registry 四字段 consumer 列 = plan-critic.criticizePlan (明示即承诺)', () => {
      for (const f of FOUR_FIELDS) {
        const e = REGISTRY[f]!;
        expect(e.consumer, `${f}.consumer 必含 plan-critic (四字段活环消费的单一真源)`).toContain(
          'plan-critic',
        );
      }
    });

    test('declaredFields() 正则收 camelCase 后能命中四字段 (与表逐字段一致)', () => {
      // 内联复刻 schema-field-registry.test.ts 的 declaredFields() 逻辑 —— 同正则必须看得见
      // camelCase, 否则即便声明 + 翻真都做了, 这条闸照样不抓。
      const out = new Set<string>();
      for (const profile of ['full', 'lean'] as const) {
        const prompt = conductorSystemPrompt({ profile });
        const shape = prompt.slice(prompt.indexOf('"nodes"'));
        for (const m of shape.matchAll(/"([a-zA-Z_]+)"\??\s*:/g)) {
          const k = m[1]!;
          if (
            ['nodes', 'name', 'description', 'outputs', 'lister', 'over', 'itemvar', 'keyby', 'maxitems'].includes(
              k,
            )
          )
            continue;
          out.add(k);
        }
      }
      for (const f of FOUR_FIELDS) {
        expect(out, `declaredFields() 正则应见 "${f}" (前版只认 [a-z_]+ 漏 camelCase)`).toContain(f);
      }
    });
  });

  describe('INV-4: L2 教化段 (DECISION_EDUCATION_CANONICAL) 字节不动', () => {
    test('full / lean 两档 L2 教化段关键判定位仍在 (D8 prompt-lint 必绿样本)', () => {
      for (const profile of ['full', 'lean'] as const) {
        const p = conductorSystemPrompt({ profile });
        // 照 prompt-lint.test.ts 的 6 行结构自证, 只取 invariant 字串
        expect(p).toContain('你产 DAG。');
        expect(p).toContain('oracleKind、whyNoFanout、toolRefs、budgetBasis');
        expect(p).toContain('plan-critic 在编译期做 schema 校验');
        expect(p).toContain('不要臆造工具路径');
      }
    });

    test('shape 段独立于 L2 教化段: shape 改动不破 prompt-lint.test.ts 的字符数 (290) 自证', () => {
      // 不变量: DECISION_EDUCATION_CANONICAL = 290 Unicode chars, ≤ LINT_MAX_DECISION_EDUCATION_CHARS=350
      // shape 段不在 lint 作用域 (prompt-lint.ts L57-59 显式声明) —— 本断言是防有人误把 shape 段
      // 搬进 DECISION_EDUCATION_CANONICAL 后被 compile-time 闸 throw 掉。
      const full = conductorSystemPrompt();
      const lean = conductorSystemPrompt({ profile: 'lean' });
      // 教化段就在 canonical 字符串, 不被 shape 段重复 (防止双倍 → 580 chars 红)
      const occFull = full.split('oracleKind、whyNoFanout、toolRefs、budgetBasis').length - 1;
      const occLean = lean.split('oracleKind、whyNoFanout、toolRefs、budgetBasis').length - 1;
      // 一处 = L2 教化段, 第二处 = shape 段中的 budgetBasis? 不在 shape (shape 走的是四字段各自字面),
      // 所以 occurrences = 1 (仅教化段点名四字段时的那一处)。
      expect(occFull).toBe(1);
      expect(occLean).toBe(1);
    });
  });
});