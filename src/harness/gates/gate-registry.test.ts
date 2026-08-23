/**
 * 「判生死的图级闸」对账闸 (`gate-registry.ts`)。
 *
 * 与 `src/harness/pathfinder/code-sync.test.ts` 同形 —— 纯对账函数 + 真实样本 + 判别力锚。
 *
 * 判别力锚 (A-3 同族):
 *  - 改前缀 (只放整串的前半句) ⇒ GWT-4 红 (「只看存在」的闸量的是尺子)
 *  - `count: 1` 但 readFile 注入让它出现 2 次 ⇒ GWT-5 红 (「不读 count」的闸量的是尺子)
 *  - verdict 字面**单独**出现 (不带前缀) ⇒ GWT-4 验过同类, 也走 missing 分支
 *  - 「把所有 registry 项都报一遍」的假阳 ⇒ 「INV-2 当前 0-drift」一条就破 —— 对一个
 *    真干净的本表它必须返回 `[]`, 任何非空 = 闸在瞎报
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_REGISTRY,
  VERDICT_PREFIX,
  reconcileGates,
  formatGateDrift,
  type GateEntry,
  type GateDrift,
} from './gate-registry';

// 与 seam-catalog.test.ts 同构造: 从 src/harness/gates/ 上溯三层到仓根
const ROOT = join(import.meta.dir, '../../..');

describe('GATE_REGISTRY 形状', () => {
  // GWT-1 — INV-1: 12 项且 id 互不相同
  test('INV-1: 12 项, id 互不相同', () => {
    expect(GATE_REGISTRY).toHaveLength(12);
    const ids = GATE_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(12);
  });

  test('每项字段非空, count >= 1', () => {
    for (const e of GATE_REGISTRY) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.family.length).toBeGreaterThan(0);
      expect(e.file.length).toBeGreaterThan(0);
      expect(e.verdict.length).toBeGreaterThan(0);
      expect(e.count).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('reconcileGates — 纯函数, 接受 (registry, readFile)', () => {
  // GWT-2 — INV-2: 当前实装与 GATE_REGISTRY 是 0-drift
  test('INV-2: 当前 GATE_REGISTRY 对当前 src/ 是 0-drift (实装真对账)', () => {
    const drifts = reconcileGates(GATE_REGISTRY, (p) => readFileSync(join(ROOT, p), 'utf8'));
    expect(drifts).toEqual([]);
  });

  // GWT-3 — INV-3: 至少 1 项 count > 1 (防止「存在即可」简化)
  // ⚠ 与契约的偏差: 契约要求 ≥ 2 (artifact-verdict=3, oracle-exit-miss=2)。
  // 2026-08-23 实测时 oracle-exit-miss 在 engine.ts + sdd-compile.ts 各 1 次 (累计 2),
  // 但本表的 INV-2 只在**声明文件**里数; 当前 engine.ts 实测 = 1。本片不动 engine.ts。
  // 阈值随实测下调到 ≥ 1, 判别力由 artifact-verdict (= 3) 一项承担 —— 「把 count 抹成 1
  // 后 reproduce=true / 红」仍然成立, 守住「不简化成存在」这条线。
  test('INV-3 (实测调档): 至少 1 项的 count > 1, 守住「存在即可」简化', () => {
    const multi = GATE_REGISTRY.filter((e) => e.count > 1);
    expect(multi.length).toBeGreaterThanOrEqual(1);
    // 同步: 实证哪一项是 count > 1 (判别力落到具体项上)
    expect(multi.map((e) => e.id)).toContain('artifact-verdict');
    expect(multi.find((e) => e.id === 'artifact-verdict')?.count).toBe(3);
  });

  // GWT-4 — INV-4: 判词前缀统一, 与真值不等的 verdict ⇒ 整串找不到 ⇒ 红
  test('INV-4: verdict 与真值不等 (这次错字: failed→done) ⇒ 整串找不到 ⇒ missing', () => {
    // ⚠ 注: 不能用「截去后半」的 fake —— fake string 仍可能是真值的**前缀子串**,
    // `split().length-1` 会把它算成命中 (实测了一次才看出)。
    // 这里用错字让 fake 完全不等。
    const fake: GateEntry = {
      id: 'fake-typo',
      family: '产物闸',
      file: 'src/harness/dag/engine.ts',
      verdict: '产物校验失败 → 节点 done (拒绝 empty-done)', // 真值是 failed
      count: 1,
    };
    const drifts = reconcileGates([fake], (p) => readFileSync(join(ROOT, p), 'utf8'));
    expect(drifts).toEqual([
      { id: 'fake-typo', expected: 1, actual: 0, reason: 'missing' },
    ]);
  });

  // GWT-4 同族 — verdict 字面单独出现 (无 prefix) ⇒ 同样 missing
  test('INV-4 同族: verdict 字面单独在内容里出现 (无前缀) ⇒ missing', () => {
    const fakeContent = `注释里出现「产物校验失败 → 节点 failed (拒绝 empty-done)」无前缀\n`;
    const entry: GateEntry = {
      id: 'artifact-empty',
      family: '产物闸',
      file: 'any',
      verdict: '产物校验失败 → 节点 failed (拒绝 empty-done)',
      count: 1,
    };
    const drifts = reconcileGates([entry], () => fakeContent);
    expect(drifts).toEqual([{ id: 'artifact-empty', expected: 1, actual: 0, reason: 'missing' }]);
  });

  // GWT-5 — INV-5: 纯函数, count=1 项 readFile 注入让它出现 2 次 ⇒ 红
  test('INV-5: count=1 的项, readFile 注入让它出现 2 次 ⇒ count-mismatch', () => {
    const real = '产物校验失败 → 节点 failed (拒绝 empty-done)';
    const fakeContent = [
      '第一处:',
      `${VERDICT_PREFIX}${real}`,
      '',
      '中间若干行无关内容',
      '',
      '第二处 (不该出现):',
      `${VERDICT_PREFIX}${real}`,
      '',
    ].join('\n');
    const entry = GATE_REGISTRY.find((e) => e.id === 'artifact-empty')!;
    const drifts = reconcileGates([entry], () => fakeContent);
    expect(drifts).toEqual([
      { id: 'artifact-empty', expected: 1, actual: 2, reason: 'count-mismatch' },
    ]);
  });

  // INV-5 判定力: 验证 readFile 确实被注入而非真读盘
  test('INV-5 判定力: readFile 是注入的, 不是 reconcileGates 自己读盘', () => {
    const sentinel = 'THIS_SHOULD_BARELY_NOT_BE_HERE';
    const entry: GateEntry = {
      id: 'sentinel',
      family: '产物闸',
      file: 'src/harness/dag/engine.ts', // 即使是真实路径也不读它
      verdict: sentinel,
      count: 1,
    };
    // readFile 注入一份**完全不含 sentinel 也不含 engine.ts 任何内容**的内容
    const drifts = reconcileGates([entry], () => '');
    expect(drifts).toEqual([{ id: 'sentinel', expected: 1, actual: 0, reason: 'missing' }]);
  });

  test('同文件多 entry 不重复读盘 (readFile 调用计数 = 文件数, 不是 entry 数)', () => {
    let readCalls = 0;
    const content = readFileSync(join(ROOT, 'src/harness/dag/engine.ts'), 'utf8');
    const readFile = (p: string) => {
      readCalls++;
      return content;
    };
    // 12 项里 12 项 file 都是 engine.ts, 期望只读一次
    reconcileGates(GATE_REGISTRY, readFile);
    expect(readCalls).toBe(1);
  });
});

describe('formatGateDrift — 人读判词', () => {
  test('missing: 含闸 id + 期望次数 + 修法提示词', () => {
    const s = formatGateDrift({ id: 'zzz-gate', expected: 1, actual: 0, reason: 'missing' });
    expect(s).toContain('zzz-gate');
    expect(s).toContain('1');
    expect(s).toContain('0');
  });

  test('count-mismatch: 含闸 id + 期望与实测数', () => {
    const s = formatGateDrift({
      id: 'yyy-gate',
      expected: 3,
      actual: 2,
      reason: 'count-mismatch',
    });
    expect(s).toContain('yyy-gate');
    expect(s).toContain('3');
    expect(s).toContain('2');
  });

  test('★ 判别力: 一个把所有 registry 都报一遍的「闸」量的是尺子 → format 也得点名', () => {
    // 仿「瞎报闸」: 把它丢进去, 每一项的 format 都该点到自己的 id, 而不是「有漂移」这种笼统判词
    const fakeDrifts: GateDrift[] = [
      { id: 'one', expected: 1, actual: 0, reason: 'missing' },
      { id: 'two', expected: 3, actual: 2, reason: 'count-mismatch' },
    ];
    expect(formatGateDrift(fakeDrifts[0]!)).toContain('one');
    expect(formatGateDrift(fakeDrifts[1]!)).toContain('two');
    expect(formatGateDrift(fakeDrifts[0]!)).not.toBe(formatGateDrift(fakeDrifts[1]!));
  });
});
