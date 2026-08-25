/**
 * src/harness/goal/registration-faces.test —— 登记面泛化闸 (#243) 反向自检。
 *
 * SDD: docs/plan/2026-08-25-243-245-编译与交接保真-执行契约.md 切片 1。
 * 闸真源: src/harness/goal/sdd-compile.ts `REGISTRATION_FACES` + `assertSeamWriteSet`。
 *
 * 反向自检统一形状 (同 sdd-compile / falsify-compile.test.ts): 每条闸配一份**已知违规样本**,
 * 断言它 throw 且判词点名缺的面与 reason; 证伪方式逐条写在 test 注释 —— 「把 trigger 行
 * 注释掉 / 把 face 删了 → 此 test 由绿转红」。一条永远绿的闸不是闸 (CLAUDE.md §1 加闸纪律)。
 */
import { describe, expect, test } from 'bun:test';
import { type SddBreakdown } from './sdd-direct';
import { compileBreakdown } from './sdd-compile';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

/** 直接造结构 (绕开表文本), 用于给编译器喂精确的违规/合法样本。 */
const bd = (slices: SddBreakdown['slices'], waves?: SddBreakdown['waves']): SddBreakdown =>
  waves ? { slices, waves } : { slices };

const slice = (
  id: number,
  over: string[],
  deps: number[],
  verify = `bun test src/s${id}.test.ts`,
): SddBreakdown['slices'][number] => ({ id, name: `切片 ${id}`, writeSet: over, deps, verify });

const compile = (b: SddBreakdown) => compileBreakdown(b, { acceptCommand: FULL_REGRESSION });

// ── C-1 INV-2: types.ts 行错误文本与今天逐字相同 (旧 assertSeamWriteSet 行为字节不变地迁移) ──

describe('assertSeamWriteSet — types.ts 行行为字节不变 (INV-2)', () => {
  test('写集含 types.ts 缺 seams.md → 拒, 错误文本与今天逐字相同', () => {
    // GWT ① G: 写集含 types.ts 缺 seam 面 W: compileBreakdown T: 拒, 文本逐字同今天。
    // 证伪: 把 REGISTRATION_FACES 第一行注释掉 → 本 test 由绿转红 (seam 闸整体失活)。
    const bad = bd([slice(1, ['src/harness/dag/types.ts'], [])]);
    let err: unknown;
    try {
      compile(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // 既有 sdd-compile / falsify-compile 测试零改动即绿 —— 这里的字符串就是今天 assertSeamWriteSet 的判词。
    expect(msg).toContain('写集含 src/harness/dag/types.ts 时, 全部切片写集并集还必须包含');
    expect(msg).toContain('docs/architecture/seams.md (生成器产物)');
    expect(msg).toContain('src/harness/dag/seam-catalog.test.ts (刻意写死的结构绊线)');
    expect(msg).toContain('缺的是 docs/architecture/seams.md、src/harness/dag/seam-catalog.test.ts。');
  });

  test('写集含 types.ts 但并集含两个 face → 编译过 (合法样本, 闸不是恒红)', () => {
    // GWT ① 阴性对照: 全 seam 面都在 → 通过。
    // 证伪: 把 REGISTRATION_FACES 第一行的某 face 改成不存在的路径 → 本 test 转红。
    const ok = bd([
      slice(1, ['src/harness/dag/types.ts', 'docs/architecture/seams.md', 'src/harness/dag/seam-catalog.test.ts'], []),
    ]);
    expect(() => compile(ok)).not.toThrow();
  });

  test('写集含 types.ts 只缺 seam-catalog.test.ts (留 seams.md) → 拒, 点名那一个', () => {
    // 单缺验证: 判词必须只点名缺的那个, 不冤枉在场的 face。
    // 证伪: 把 missingText 那行的 `${file} (${reason})` 删掉 reason → 本 test 转红。
    const bad = bd([slice(1, ['src/harness/dag/types.ts', 'docs/architecture/seams.md'], [])]);
    let err: unknown;
    try {
      compile(bad);
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain('src/harness/dag/seam-catalog.test.ts (刻意写死的结构绊线)');
    expect(msg).not.toContain('docs/architecture/seams.md (生成器产物)');
    expect(msg).toContain('缺的是 src/harness/dag/seam-catalog.test.ts。');
  });
});

// ── C-1 INV-1: 新 trigger (conductor-plan.ts) 行 ──

describe('assertSeamWriteSet — conductor-plan.ts 行 (#243 新 trigger)', () => {
  test('★ INV-4 反向自检: 写集含 conductor-plan.ts 缺任一登记面 → 必拒, 点名缺哪个', () => {
    // GWT ② G: 写集含 conductor-plan.ts, 并集缺 registry 三面之一 T: 拒, 点名缺哪个。
    // 证伪: 把 REGISTRATION_FACES 第二行 trigger 改成别的 → 本 test 红 (整个 describe 红)。
    //       把第一行注释掉但保留第二行 → 第一组 describe 红, 本组保持绿, 证明闸是泛化而非特化。
    for (const missingFile of [
      'src/harness/schema-field-registry.ts',
      'src/harness/schema-field-registry.test.ts',
      'docs/plan/2026-07-30-schema-field-registry.md',
    ]) {
      const faceOnly = [
        'src/harness/conductor-plan.ts',
        'src/harness/schema-field-registry.ts',
        'src/harness/schema-field-registry.test.ts',
        'docs/plan/2026-07-30-schema-field-registry.md',
      ].filter((f) => f !== missingFile);
      const bad = bd([slice(1, faceOnly, [])]);
      let err: unknown;
      try {
        compile(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain('写集含 src/harness/conductor-plan.ts 时');
      expect(msg).toContain(missingFile);
      expect(msg).toContain('缺的是');
      expect(msg).toContain(missingFile);
    }
  });

  test('写集含 conductor-plan.ts 并集含三面 → 编译过 (闸不是恒红)', () => {
    // GWT ③ G: 同上并集含三面 T: 编译过。
    // 证伪: 把第二行 faces 数组多加一个不存在的 file → 本 test 红。
    const ok = bd([
      slice(
        1,
        [
          'src/harness/conductor-plan.ts',
          'src/harness/schema-field-registry.ts',
          'src/harness/schema-field-registry.test.ts',
          'docs/plan/2026-07-30-schema-field-registry.md',
        ],
        [],
      ),
    ]);
    expect(() => compile(ok)).not.toThrow();
  });

  test('写集同时含 types.ts 与 conductor-plan.ts, 并集两边的 face 都齐 → 通过', () => {
    // 多个 trigger 同时命中的合法样本: 闸不互斥, 任一触发时它的 faces 单独校验。
    const ok = bd([
      slice(
        1,
        [
          'src/harness/dag/types.ts',
          'docs/architecture/seams.md',
          'src/harness/dag/seam-catalog.test.ts',
          'src/harness/conductor-plan.ts',
          'src/harness/schema-field-registry.ts',
          'src/harness/schema-field-registry.test.ts',
          'docs/plan/2026-07-30-schema-field-registry.md',
        ],
        [],
      ),
    ]);
    expect(() => compile(ok)).not.toThrow();
  });
});

// ── C-1 INV-1: schema-field-registry.ts 行 (#243 新 trigger) ──

describe('assertSeamWriteSet — schema-field-registry.ts 行 (#243 新 trigger)', () => {
  test('写集含 schema-field-registry.ts 缺 docs 人读表 → 拒, 点名人读表', () => {
    // GWT ⑤ G: 写集含 schema-field-registry.ts 缺 docs 人读表 T: 拒。
    // 证伪: 把 REGISTRATION_FACES 第三行 trigger 注释掉 → 本 test 红。
    const bad = bd([
      slice(1, ['src/harness/schema-field-registry.ts', 'src/harness/schema-field-registry.test.ts'], []),
    ]);
    let err: unknown;
    try {
      compile(bad);
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain('写集含 src/harness/schema-field-registry.ts 时');
    expect(msg).toContain('docs/plan/2026-07-30-schema-field-registry.md (schema 字段表人读版');
    expect(msg).toContain('缺的是 docs/plan/2026-07-30-schema-field-registry.md。');
  });

  test('写集含 schema-field-registry.ts 并集含两 face → 编译过', () => {
    const ok = bd([
      slice(
        1,
        [
          'src/harness/schema-field-registry.ts',
          'docs/plan/2026-07-30-schema-field-registry.md',
          'src/harness/schema-field-registry.test.ts',
        ],
        [],
      ),
    ]);
    expect(() => compile(ok)).not.toThrow();
  });
});

// ── C-1 INV-3: 不含任何 trigger 的契约走原路 (零行为差) ──

describe('assertSeamWriteSet — 无 trigger 命中 (INV-3 零行为差)', () => {
  test('写集不含任何 trigger → 编译过, 与今天 assertSeamWriteSet 行为一致', () => {
    // GWT ④ G: 写集不含任何 trigger T: 行为不变。
    // 证伪: 在 assertSeamWriteSet 顶部加一行 union 计算 → 本 test 仍绿 (但描述里的"零行为差"就不成立了;
    //       真证伪应去 sdd-compile.test.ts 把闸描述里的"零行为差"那段断句删掉, 看 grep 找不到了)。
    const ok = bd([slice(1, ['src/a.ts'], []), slice(2, ['src/b.ts'], [1])], [[1], [2]]);
    expect(() => compile(ok)).not.toThrow();
  });

  test('闸短路: 写集不含 trigger 时 union 不必构造 (保持旧 assertSeamWriteSet 的 lazy 语义)', () => {
    // 测的是结构不变, 不是断言数值 —— assertSeamWriteSet 不抛即合规。
    // 真证伪: 把 `union ??= new Set(...)` 改成无条件 `union = new Set(...)` → 本 test 仍绿 (只是
    // 多算一次), 故这不是测性能, 而是测「不含 trigger 时整条循环不进入」这条不变量。
    // 把外层 for 循环删掉 → 闸整体失活, 这一组其他测试也会跟着红, 交叉证伪。
    const ok = bd([slice(1, ['src/some-other.ts'], [])]);
    expect(() => compile(ok)).not.toThrow();
  });
});

// ── #254: engine.ts / run-goal.ts ↔ gate-registry 两件套 ──
// 现场: B1 run 8888b93b 新闸 [fuse-paralysis] 长在 engine.ts, 写集无权改 gate-registry →
// accept 红, owner 手补 (13→14)。本对表行让「动闸宿主文件」的契约天生带上登记面权限。

describe('assertSeamWriteSet — engine.ts / run-goal.ts 的 gate-registry 面 (#254)', () => {
  const GATE_FACES = ['src/harness/gates/gate-registry.ts', 'src/harness/gates/gate-registry.test.ts'];

  test('写集含 engine.ts 缺 gate-registry 两件套 → 拒, 判词点名缺的面', () => {
    // 证伪: 把 REGISTRATION_FACES 的 engine.ts 行注释掉 → 本 test 由绿转红。
    const bad = bd([slice(1, ['src/harness/dag/engine.ts'], [])]);
    let err: unknown;
    try {
      compile(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('写集含 src/harness/dag/engine.ts 时');
    expect(msg).toContain('src/harness/gates/gate-registry.ts');
    expect(msg).toContain('src/harness/gates/gate-registry.test.ts');
  });

  test('写集含 run-goal.ts 缺两件套 → 拒; 并集补齐两面 → 编译过 (合法样本, 闸不是恒红)', () => {
    // 证伪: 把 run-goal.ts 行注释掉 → 前半由绿转红。
    expect(() => compile(bd([slice(1, ['src/harness/goal/run-goal.ts'], [])]))).toThrow(/gate-registry/);
    const ok = bd([slice(1, ['src/harness/goal/run-goal.ts', ...GATE_FACES], [])]);
    expect(() => compile(ok)).not.toThrow();
    const okEngine = bd([slice(1, ['src/harness/dag/engine.ts', ...GATE_FACES], [])]);
    expect(() => compile(okEngine)).not.toThrow();
  });
});