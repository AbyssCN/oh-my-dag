/**
 * 「判生死的图级闸」对账闸 (`gate-registry.ts`)。
 *
 * 与 `src/harness/pathfinder/code-sync.test.ts` 同形 —— 纯对账函数 + 真实样本 + 判别力锚。
 *
 * 判别力锚:
 *  - GWT-2: 注入一段假源码含 `[omd/executor-dag][not-registered] …` ⇒ `unregistered` 点名它
 *    (对干净本表应返回 `[]`; 任何非空 = 闸在瞎报)
 *  - GWT-3: 注入一段假源码**缺** heartbeat ⇒ `missing` 点名它
 *  - GWT-5: 第一项不含 `verdict`/`count` 字段 (旧 API 已删)
 *  - GWT-6: `scanGateVerdicts` 不读盘, 注入纯假内容应逐条一致
 *  - GWT-7: 13 条原文以整串仍在 entry.file 里, 反向钉死「只插不改」
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COVERAGE_DEBT,
  GATE_REGISTRY,
  VERDICT_PREFIX,
  gateCoverage,
  scanGateVerdicts,
  reconcileGateIds,
  type GateEntry,
} from './gate-registry';
import { readdirSync, statSync } from 'node:fs';

// 与 seam-catalog.test.ts 同构造: 从 src/harness/gates/ 上溯三层到仓根
const ROOT = join(import.meta.dir, '../../..');

// 真源锚: 按每条 GateEntry 自己的 (file, prefix) 去对应源码里扫。13 条: 12 条走
// engine.ts + [omd/executor-dag], 第 13 条 o6-vacuous-verify 走 run-goal.ts + [run-goal]。
// 用 scanGateVerdicts 的 Record 入参形态 —— 库内已按 (file, prefix) 去重 + 派发,
// 不在测试侧再开一份并行调度。Record 的 key 必须与 entry.file 一字不差 (仓根相对路径)。
const SOURCE_BY_FILE: Readonly<Record<string, string>> = {
  'src/harness/dag/engine.ts': readFileSync(join(ROOT, 'src/harness/dag/engine.ts'), 'utf8'),
  'src/harness/goal/run-goal.ts': readFileSync(join(ROOT, 'src/harness/goal/run-goal.ts'), 'utf8'),
};

// 实扫 — 用于 GWT-1 / GWT-4 / GWT-7 (这些要求「扫真源码」)
const REAL_VERDICTS = scanGateVerdicts(SOURCE_BY_FILE);

describe('GWT-1 — INV-1: 扫真源 (engine.ts + run-goal.ts) 的 id 集合 ⊇ 表里全部 23 个 id', () => {
  test('登记的 23 个 id 都被实扫命中', () => {
    const registryIds = GATE_REGISTRY.map((e) => e.id);
    expect(registryIds).toHaveLength(23); // 2026-08-25 #249 fuse-paralysis 入表 (13→14); S2 片 3 spin-rung2-ladder 入表 (14→15); S3 片 5 retry-domain-mask + verifier-ledger + partial-quorum-failure 入表 (15→18); 2026-08-28 G2 contract-gate 入表 (18→19) + ask-owner 入表 (19→20); 2026-08-30 刀① artifact-echo + artifact-drift + artifact-foreign 入表 (20→23)
    for (const id of registryIds) {
      expect(REAL_VERDICTS.has(id)).toBe(true);
    }
  });

  test('实扫的 id 数量与表一致 (顺手钉: 没多打 id, 没少打 id)', () => {
    expect(REAL_VERDICTS.size).toBe(GATE_REGISTRY.length);
  });
});

describe('GWT-2 — INV-2: 判别力锚 (未登记 id 必须被点出)', () => {
  // 注入一条未登记 id (作为合法字符串字面量) ⇒ unregistered 点名它
  test('假源码含 [omd/executor-dag][not-registered] ⇒ unregistered 含 not-registered', () => {
    const fakeSrc = `'${VERDICT_PREFIX}[not-registered] 这是一条未登记的判词'`;
    const result = reconcileGateIds(fakeSrc);
    expect(result.unregistered).toContain('not-registered');
  });
});

describe('GWT-3 — INV-3: 判别力锚 + 真源锚 (缺 heartbeat 必红; 真 engine.ts 里 heartbeat 在场)', () => {
  // (a) 判别力锚: 注入一段**缺** heartbeat 的假源码 (给其它 id 一条合法字面量, 但故意不给 heartbeat) ⇒ missing 点名 heartbeat
  test('假源码缺 heartbeat 那条 ⇒ missing 含 heartbeat', () => {
    const fakeSrc = `'${VERDICT_PREFIX}[fuse-action] 假判词 (与 heartbeat 无关)'`;
    const result = reconcileGateIds(fakeSrc);
    expect(result.missing).toContain('heartbeat');
  });

  // (b) 真源锚: 用真 engine.ts + run-goal.ts 双源跑 scanGateVerdicts + reconcileGateIds,
  //     必须断言 missing 为空且扫到的 id 集合含 'heartbeat'。
  //     删掉 engine.ts 里任意一条 `[heartbeat]` 标记 → 本测试当场红。
  //     删掉 run-goal.ts 里那段 `[run-goal][o6-vacuous-verify]` ⇒ 同红 (13 条登记全收)。
  //     (只验合成 fixture 的写法不合格)
  test('真源 (engine.ts + run-goal.ts): missing 为空 且 扫到的 id 集合含 heartbeat', () => {
    const verdicts = scanGateVerdicts(SOURCE_BY_FILE);
    const reconciled = reconcileGateIds(SOURCE_BY_FILE);
    expect(reconciled.missing).toEqual([]);
    expect(verdicts.has('heartbeat')).toBe(true);
  });
});

describe('GWT-4 — INV-4: 13 条原文都非空且不含换行', () => {
  test('实扫的每条 verdict .length > 0 且 !.includes(\\n)', () => {
    expect(REAL_VERDICTS.size).toBe(GATE_REGISTRY.length);
    for (const [id, verdict] of REAL_VERDICTS) {
      expect(verdict.length).toBeGreaterThan(0);
      expect(verdict.includes('\n')).toBe(false);
    }
  });
});

describe('GWT-5 — INV-5: GateEntry 不再带 verdict / count', () => {
  test('第一项既无 verdict 也无 count 字段', () => {
    const first = GATE_REGISTRY[0] as unknown as Record<string, unknown>;
    expect('verdict' in first).toBe(false);
    expect('count' in first).toBe(false);
  });

  test('(兜底) 全表 13 项都不带 verdict / count', () => {
    for (const entry of GATE_REGISTRY as unknown as Record<string, unknown>[]) {
      expect('verdict' in entry).toBe(false);
      expect('count' in entry).toBe(false);
    }
  });
});

describe('GWT-6 — INV-6: scanGateVerdicts 纯函数, 不读盘, 逐条一致', () => {
  test('注入纯假源码 → 返回 Map 与注入内容逐条一致', () => {
    // 故意混用三种引号 + 含逗号/冒号/括号/em-dash/§/ASCII — 证明字符类不挑食
    const entries = [
      ['alpha', '判词甲 — 含连字符 与逗号, 也含 §'],
      ['beta', '判词乙 含括号 (a) 与冒号:'],
      ['gamma', '判词丙 含 ASCII 字母 abc123 与点 a.b.c'],
    ] as const;
    const fakeSrc = [
      `'[omd/executor-dag][alpha] 判词甲 — 含连字符 与逗号, 也含 §'`,
      `"[omd/executor-dag][beta] 判词乙 含括号 (a) 与冒号:"`,
      `"[omd/executor-dag][gamma] 判词丙 含 ASCII 字母 abc123 与点 a.b.c"`,
    ].join('\n');

    const got = scanGateVerdicts(fakeSrc);
    expect(got.size).toBe(entries.length);
    for (const [id, verdict] of entries) {
      expect(got.get(id)).toBe(verdict);
    }
  });
});

describe('GWT-7 — INV-7: 13 条原文以整串仍在 entry.file 里 (保证只插不改)', () => {
  // 逐条钉死 — 不用扫描结果当期望值, 而是拿实扫结果作为「整串」
  // 反向断言: 这个整串必须出现在 entry.file 指向的源码里 (即扫描器没自己编)。
  // Prefix 优先用 entry.prefix (post-impl 字段), 缺省 = VERDICT_PREFIX。
  // 第 13 行 (o6-vacuous-verify) 故意只用前缀切片, 避开 ` 字符在 TS 字面量里的转义噪音
  // —— 这条只验前缀 + 起步文案确实落在 run-goal.ts 源码里, 全文仍由 GWT-1 / GWT-4 实扫覆盖。
  test.each([
    ['artifact-empty', '产物校验失败 → 节点 failed (拒绝 empty-done)'],
    ['artifact-verdict', '产物闸判定 (declaredArtifact 节点; entry = 进闸条数)'],
    ['artifact-broken', '写后即验: 节点写完之后文件语法解析不过 → 节点 failed (部分写入损坏)'],
    ['heartbeat', 'agent leaf 停摆 (心跳闸) → 节点 failed'],
    ['fuse-action', '动作级熔断 → 环提前退出 (§8.4)'],
    ['fuse-judge', '闸级熔断 → 环提前退出 (infra-error, 不烧剩余轮数)'],
    ['fuse-spin', 'agent leaf 空转熔断 → 节点 failed'],
    ['fuse-samecause', 'D-6 同因熔断 → 停止重试 (连撞同一根因), STALLED 交人'],
    ['oracle-exit-miss', 'command 节点未命中 expect_exit → failed (D-K)'],
    ['oracle-exit-scope', 'expect_exit 只对 executor:command 生效 → 本节点忽略 (D-K)'],
    ['writescope-drop', '产物闸写域外路径剔除 (不参与判死, 仅记账; s1 Step C)'],
    ['false-completion', 'D-4 谎报完成闸: 声称完成而验收命令实败 → 判未收敛'],
    ['spin-rung2-ladder', '档 2 再次空转 → 节点终止 (越过 max_retry 预算)'],
    ['retry-domain-mask', 'oracle 域判否 → 越过 max_retry, 节点终止 (D-2 / INV-2)'],
    ['verifier-ledger', 'verdict 账本追加 (round=${attempts}, kind=${kind})'],
    ['partial-quorum-failure', '部分失败 join 留结构化观察 (D-7 / INV-9, 只报不拦)'],
    ['o6-vacuous-verify', '切片 ${s.id} 的 verify 实装前已绿'],
  ] as const)('id=%s 整串仍在 entry.file', (id, verdict) => {
    const entry = GATE_REGISTRY.find((e) => e.id === id);
    expect(entry).toBeDefined();
    const src = SOURCE_BY_FILE[entry!.file];
    expect(src).toBeDefined();
    const prefix = (entry as GateEntry & { prefix?: string }).prefix ?? VERDICT_PREFIX;
    const needle = `${prefix}[${id}] ${verdict}`;
    expect(src!.includes(needle)).toBe(true);
  });
});

// ── 片 5c: 覆盖对账 —— 每道闸有没有「它真的开火过」的用例 ────────────────────
//
// 判据刻意是**整串** `[omd/executor-dag][<id>]`: 它只可能来自捕获到的判词。
// ⚠ 不用关键词共现 —— 实测 `expect_exit` 在 35 个测试文件里出现过, 证明不了任何事。
const collectTestSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.omd')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.test.ts') && !full.endsWith('gate-registry.test.ts')) {
        out.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'test'));
  return out;
};

describe('片 5c — 覆盖对账: 每道闸有没有「真开火过」的用例', () => {
  test('★ 判别力: 注入一份含 marker 的假测试 ⇒ 该 id 算被覆盖, 别的不算', () => {
    const fake = [`expect(lines).toContain('${VERDICT_PREFIX}[heartbeat] 随便什么');`];
    const { covered, uncovered } = gateCoverage(fake);
    expect(covered).toEqual(['heartbeat']);
    expect(uncovered).toContain('artifact-empty');
    // 反向: 只提 id 这个词、不带整串 ⇒ 不算覆盖 (co-occurrence 不是证据)
    expect(gateCoverage(['测试里提到了 heartbeat 这个词']).covered).toEqual([]);
  });

  test('★ 未覆盖的闸必须逐条登记在 COVERAGE_DEBT 里 (不许有隐形欠账)', () => {
    const { uncovered } = gateCoverage(collectTestSources());
    const unlisted = uncovered.filter((id) => !(id in COVERAGE_DEBT));
    expect(
      unlisted,
      `这些闸没有「真开火过」的用例, 也没登记进 COVERAGE_DEBT: ${unlisted.join(', ')}\n` +
        '修法二选一: ① 在覆盖它的测试里捕判词并断言整串 `' +
        VERDICT_PREFIX +
        '[<id>] …`; ② 登记进 COVERAGE_DEBT 并写明**为什么还没覆盖**。',
    ).toEqual([]);
  });

  test('★ 绊线: COVERAGE_DEBT 只许缩不许涨 (今天 10 条)', () => {
    // 刻意写死字面量 —— 派生成 length 就成恒真式 (同 seam-catalog 的 8/50 先例)。
    // 补上一条覆盖 ⇒ 从名单里删掉它 ⇒ 这个数跟着降。**它只许降。**
    expect(Object.keys(COVERAGE_DEBT).length).toBeLessThanOrEqual(10);
  });

  test('★ 欠账登记不许收留已经覆盖的闸 (防名单变垃圾桶)', () => {
    const { covered } = gateCoverage(collectTestSources());
    const needless = covered.filter((id) => id in COVERAGE_DEBT);
    expect(needless, `这些闸已经有真开火用例, 该从 COVERAGE_DEBT 里删掉: ${needless.join(', ')}`).toEqual([]);
  });

  test('每条欠账都写了理由 (写不出「为什么还没覆盖」= 它不该在名单里)', () => {
    const empty = Object.entries(COVERAGE_DEBT).filter(([, why]) => why.trim().length < 20).map(([id]) => id);
    expect(empty, `这些欠账没写理由: ${empty.join(', ')}`).toEqual([]);
  });

  test('欠账名单不含表外的 id (删了闸要同步删登记)', () => {
    const ids = new Set(GATE_REGISTRY.map((e) => e.id));
    const stale = Object.keys(COVERAGE_DEBT).filter((id) => !ids.has(id));
    expect(stale, `COVERAGE_DEBT 登记了表里没有的 id: ${stale.join(', ')}`).toEqual([]);
  });
});
