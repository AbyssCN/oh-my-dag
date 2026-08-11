/**
 * src/harness/write-set.test —— D-2 ex-ante 写集声明 + 跑后 diff 对账 (INV-2 反向自检)。
 *
 * SDD: docs/plan/2026-08-10-cairness-distill-comparison.md, D-2 + G-3 + G-4 + INV-3。
 * 落点说明: 同 delta-compare.test 的最小解释 —— 测试随新闸同置 (src/harness/**),
 * 不碰 src/eval/** 红线。
 *
 * INV-2 证伪方式 (逐条写进各 test): 每条已知违规样本 = 「声明了 A 却改了 B」(G-3 主路) /
 * 「历史声明试图授权新改动」(G-4) / 「无任何归属」。闸若缺失或放行, 越界写被当正常 ——
 * 断言 `red === true` + `orphans` 点名, 即当场证伪。阴性对照:
 * intentional 例外放行 (G-3 第二子句) / ambiguous 告警不红 (G-3 第三子句) /
 * 无声明 → undeclared 不红 (INV-3, NULL≠0)。
 * S-2 声明写集面 (run 级, docs/plan/2026-08-10-concurrent-sdd-execute-test.md run B):
 * 允许 src/harness/** · docs/silent-failures.md · 本 run 报告文件 (精确名, 非 docs/plan/** 通配);
 * 禁写 src/model/** · src/eval/** (并发 run C/A 写集面)。判定序 fail-closed: forbidden → allowed →
 * outside; 近形负例 (src/model.ts / src/harness.ts) 钉死 glob 语义不前缀匹配。
 *
 * 退出码语义 (INV-1): 闸红 = 非零退出码 —— 本函数面以 `red` 布尔承载, `red === true`
 * 即「该红了」, 断言等价于断言退出码非零; run-goal 挂点消费同一布尔。
 */
import { describe, expect, test } from 'bun:test';
import {
  attributeWriteSet,
  classifyWriteScope,
  describeWriteSet,
  SDD_DECLARED_WRITE_SET,
  SDD_REPORT_FILE,
  type WriteSetDeclaration,
  type WriteSetReport,
} from './write-set';

const decl = (nodeId: string, files: string[], status: WriteSetDeclaration['status'] = 'done'): WriteSetDeclaration =>
  ({ nodeId, files, status });

describe('D-2 归属阶梯 — G-3 主路: 声明了 A 却改了 B → B 走完阶梯无归属 = orphan 红', () => {
  test('G-3: 声明 [a.ts] 而 diff 含 a.ts+b.ts → b.ts orphan 红, 逐文件点名归属', () => {
    // 证伪: 若实现把 b.ts 放行 → 越界写被当正常, 闸形同虚设 (G-3 主路)。
    const r = attributeWriteSet({
      diffFiles: ['a.ts', 'b.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
    });
    expect(r.verdict).toBe('reconciled');
    expect(r.red).toBe(true);
    expect(r.orphans).toEqual(['b.ts']);
    expect(r.files).toEqual([
      { file: 'a.ts', kind: 'node-owned', declaredBy: ['execute'] },
      { file: 'b.ts', kind: 'orphan' },
    ]);
    expect(describeWriteSet(r)).toBe('写集越界 1 [b.ts]');
  });

  test('G-3 第二子句: b.ts 在 intentional 例外表 → 记 intentional 放行, 不红', () => {
    const r = attributeWriteSet({
      diffFiles: ['a.ts', 'b.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
      intentional: ['b.ts'],
    });
    expect(r.red).toBe(false);
    expect(r.orphans).toEqual([]);
    expect(r.files.find((f) => f.file === 'b.ts')!.kind).toBe('intentional');
    expect(describeWriteSet(r)).toBe('无越界');
  });

  test('阶梯 ②: b.ts 在 globalExempt 清单 → 记 global-exempt 放行, 不红', () => {
    const r = attributeWriteSet({
      diffFiles: ['b.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
      globalExempt: ['b.ts'],
    });
    expect(r.red).toBe(false);
    expect(r.files.find((f) => f.file === 'b.ts')!.kind).toBe('global-exempt');
  });

  test('阶梯序: 文件同时被声明且在 intentional 表 → 声明命中先于例外 (① 先于 ④)', () => {
    // 证伪: 若例外表压过声明 → 例外能洗白「声明了 A 却改了 B」里的 A 自己, 阶梯序塌。
    const r = attributeWriteSet({
      diffFiles: ['a.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
      intentional: ['a.ts'],
    });
    expect(r.files[0]!.kind).toBe('node-owned');
  });
  test('阶梯序: 文件同时被声明且在 globalExempt 表 → 声明命中先于豁免 (① 先于 ②)', () => {
    // 证伪: 若豁免压过声明 → 「声明了 A 却改 A」被豁免洗白, 阶梯 ②「只兜无主文件」破功。
    const r = attributeWriteSet({
      diffFiles: ['a.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
      globalExempt: ['a.ts'],
    });
    expect(r.files[0]!.kind).toBe('node-owned');
  });

  test('阶梯序: 文件同时在 globalExempt 与 intentional 表 → ② 先于 ④', () => {
    // 证伪: 若 intentional 先于豁免 → 例外表压过仓级豁免, 阶梯序 (②→④) 反了。
    const r = attributeWriteSet({
      diffFiles: ['b.ts'],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
      globalExempt: ['b.ts'],
      intentional: ['b.ts'],
    });
    expect(r.files[0]!.kind).toBe('global-exempt');
  });
});

describe('D-2 G-3 第三子句 — ambiguous: 声明命中两个在跑节点 → 记 ambiguous 并告警, 不红', () => {
  test('两个在跑节点声明同一文件 → ambiguous, declaredBy 点名双方, 摘要带歧义数', () => {
    // 证伪: 若实现把 ambiguous 判红 → 有归属的文件被当 orphan (INV-3: 只有无归属才红);
    // 若实现只认第一个命中 → 归属被静默裁给一方, 歧义消失。
    const r = attributeWriteSet({
      diffFiles: ['shared.ts'],
      declarations: [decl('a', ['shared.ts']), decl('b', ['shared.ts'])],
      activeNodeIds: ['a', 'b'],
    });
    expect(r.red).toBe(false);
    expect(r.orphans).toEqual([]);
    expect(r.ambiguous).toEqual(['shared.ts']);
    expect(r.files).toEqual([{ file: 'shared.ts', kind: 'ambiguous', declaredBy: ['a', 'b'] }]);
    expect(describeWriteSet(r)).toBe('归属歧义 1 [shared.ts]');
  });
});

describe('D-2 G-4 — 已完成节点不再授权后续改动 (deps.py:405-410 语义)', () => {
  test('历史 run 的 done 节点声明过 c.ts, 后续 diff 改 c.ts → 不因该历史声明放行, orphan 红', () => {
    // 证伪: 若实现按声明存在即放行 (不看 activeNodeIds) → 「归档当永久通行证」,
    // 历史声明变成对后续一切改动的空白授权, 正是 SDD 点名要堵的洞。
    // 对照: 只有历史声明而无在跑声明 → 整 run undeclared (INV-3), 也不红 ——
    // G-4 测的是「在跑声明在场时, 历史声明不得搭车授权」, 不是「无声明也红」。
    const r = attributeWriteSet({
      diffFiles: ['a.ts', 'c.ts'],
      // history 节点本轮**不在跑** (activeNodeIds 里没有它) —— 它的声明是上轮留下的;
      // execute 在跑且声明了 a.ts, 保证 run 处于 reconciled 面, 让 c.ts 的归属被单独裁。
      declarations: [decl('execute', ['a.ts']), decl('history', ['c.ts'], 'done')],
      activeNodeIds: ['execute'],
    });
    expect(r.verdict).toBe('reconciled');
    expect(r.red).toBe(true);
    expect(r.orphans).toEqual(['c.ts']);
    expect(r.files).toEqual([
      { file: 'a.ts', kind: 'node-owned', declaredBy: ['execute'] },
      { file: 'c.ts', kind: 'orphan' },
    ]);
  });

  test('同 run 在跑节点声明 → 正常授权 (阴性对照: G-4 只堵历史, 不堵当下)', () => {
    const r = attributeWriteSet({
      diffFiles: ['c.ts'],
      declarations: [decl('execute', ['c.ts'], 'done')],
      activeNodeIds: ['execute'],
    });
    expect(r.red).toBe(false);
    expect(r.files[0]).toEqual({ file: 'c.ts', kind: 'node-owned', declaredBy: ['execute'] });
  });
});

describe('D-2 INV-3 — 声明缺席 ≠ 违规 (NULL≠0, O-1 声明覆盖率读数)', () => {
  test('整 run 无节点声明 → verdict undeclared, diff 有文件也不红', () => {
    // 证伪: 若实现把无声明 run 判红 → 误伤 (声明是可选字段, 没声明 = 没进对账契约,
    // 那是 O-1 要量的声明覆盖率问题, 不是越界)。undeclared 不是「零越界」的同义词。
    const r = attributeWriteSet({ diffFiles: ['x.ts'], declarations: [], activeNodeIds: ['execute'] });
    expect(r.verdict).toBe('undeclared');
    expect(r.red).toBe(false);
    expect(r.orphans).toEqual([]);
    expect(r.declaredNodes).toBe(0);
    expect(describeWriteSet(r)).toBe('未声明');
  });

  test('有声明但 diff 为空 → reconciled 不红, 声明节点数入报告 (O-1 读数面)', () => {
    const r = attributeWriteSet({
      diffFiles: [],
      declarations: [decl('execute', ['a.ts'])],
      activeNodeIds: ['execute'],
    });
    expect(r.verdict).toBe('reconciled');
    expect(r.red).toBe(false);
    expect(r.declaredNodes).toBe(1);
  });
});
describe('D-2 声明写集面 (S-2) — 允许面: src/harness/** 与精确 docs 文件名', () => {
  test('src/harness/** 通配: 顶层与任意深度的 harness 文件 → allowed', () => {
    // 证伪: 若 `**` 实现成不跨目录 → 深层 harness 文件被裁 outside, 本 run 自己的
    // 测试落点全变越界, S-2 自伤。
    expect(classifyWriteScope('src/harness/write-set.test.ts')).toBe('allowed');
    expect(classifyWriteScope('src/harness/plan/deep/nested/x.test.ts')).toBe('allowed');
  });

  test('近形负例: src/harness.ts 是文件不是目录 → outside, 不误伤也不误放', () => {
    // 证伪: 若 glob 实现把 `src/harness/**` 退化成前缀匹配 → src/harness.ts 被放行,
    // 允许面外扩到仓根, 与 src/model.ts 并列的顶层文件全进声明面。
    expect(classifyWriteScope('src/harness.ts')).toBe('outside');
  });

  test('精确文件: docs/silent-failures.md 与本 run 报告文件名 → allowed (R-3 显式互异)', () => {
    // 证伪: 若实现把 docs/plan/** 当通配放行 → 三 run 报告文件名互异形同虚设,
    // R-3 想防的相撞 (并发 run 报告面) 直接在允许面上撞开。
    expect(SDD_REPORT_FILE).toBe('docs/plan/2026-08-10-cairness-distill-report.md');
    expect(classifyWriteScope('docs/silent-failures.md')).toBe('allowed');
    expect(classifyWriteScope(SDD_REPORT_FILE)).toBe('allowed');
  });

  test('近形负例: 精确文件名的变体 → outside (允许面不开前缀匹配)', () => {
    expect(classifyWriteScope('docs/silent-failures.bak')).toBe('outside');
    expect(classifyWriteScope('docs/silent-failures.md.bak')).toBe('outside');
  });
});

describe('D-2 声明写集面 (S-2) — 禁写面: 并发 run 的写集 = 已知越界写', () => {
  test('src/model/** (run C 写集面) → forbidden: 已知禁写样本必须红', () => {
    // 证伪方法 (INV-2): 若闸缺失/放行, classifyWriteScope 对 src/model/** 返回
    // allowed 或 outside → 该写被当正常, S-2 隔离性 (三分支 diff 两两不相交) 的第一
    // 道防线破: run C 的写集面被 run B 静默踩踏且不落 orphan 语料。断言 forbidden 即
    // 当场证伪 —— 禁写面唯一合法答案就是 forbidden (红), 无灰色放行。
    expect(classifyWriteScope('src/model/seat-quota.ts')).toBe('forbidden');
    expect(classifyWriteScope('src/model/a/b/c.ts')).toBe('forbidden');
  });

  test('src/eval/** (run A 写集面) → forbidden', () => {
    expect(classifyWriteScope('src/eval/runner.ts')).toBe('forbidden');
    expect(classifyWriteScope('src/eval/probe/x.test.ts')).toBe('forbidden');
  });

  test('近形负例: src/model.ts / src/eval.ts 不是目录 → outside, 禁写面不前缀匹配', () => {
    // 证伪: 若 glob 退化成前缀匹配 → src/model.ts 被裁 forbidden, 禁写面外扩,
    // 合法顶层文件被当越界写 (假阳), 最小权限面变形。
    expect(classifyWriteScope('src/model.ts')).toBe('outside');
    expect(classifyWriteScope('src/eval.ts')).toBe('outside');
    expect(classifyWriteScope('src/modelx/foo.ts')).toBe('outside');
  });
});

describe('D-2 声明写集面 (S-2) — 判定序: forbidden → allowed → outside (fail-closed, 不回溯)', () => {
  test('同文件同时命中 allowed 与 forbidden → forbidden 先裁, 禁写压过允许', () => {
    // 证伪: 若 allowed 先查 → 双命中文件被放行, 「禁写面与允许面不相交」退化成
    // 「恰好不相交」—— 声明面一旦日后相交, 越界写被当正常, fail-closed 序塌。
    const ws = { allowed: ['shared/x.ts', 'shared/**'], forbidden: ['shared/x.ts'] };
    expect(classifyWriteScope('shared/x.ts', ws)).toBe('forbidden');
  });

  test('真实声明面: src/harness/** 命中 allowed 即裁, 不落 outside (阶梯序对照)', () => {
    expect(classifyWriteScope('src/harness/write-set.test.ts', SDD_DECLARED_WRITE_SET)).toBe('allowed');
  });
});

describe('D-2 声明写集面 (S-2) — 未知路径: 不在声明面 = outside 读数, 不冒充零越界', () => {
  test('并发 run 的报告文件 (R-3 互异锚) → outside: 他 run 报告不进本 run 允许面', () => {
    // 证伪: 若 docs/plan/ 被当通配允许 → 并发 run A/C 的报告被裁 allowed, R-3
    // 「报告文件名显式互异」的隔离意义归零, S-2 ① 不相交判据在报告面上失效。
    expect(classifyWriteScope('docs/plan/2026-08-10-compression-experiment-report.md')).toBe('outside');
    expect(classifyWriteScope('docs/plan/2026-08-10-seats-doctor-report.md')).toBe('outside');
  });

  test('run C 允许面 (scripts/**) 与仓根未知文件 → outside (本 run 未声明, INV-3 读数)', () => {
    expect(classifyWriteScope('scripts/foo.ts')).toBe('outside');
    expect(classifyWriteScope('README.md')).toBe('outside');
  });
});
