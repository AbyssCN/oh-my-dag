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
 *  - GWT-7: 12 条原文以整串仍在 engine.ts 里, 反向钉死「只插不改」
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_REGISTRY,
  VERDICT_PREFIX,
  scanGateVerdicts,
  reconcileGateIds,
  type GateEntry,
} from './gate-registry';

// 与 seam-catalog.test.ts 同构造: 从 src/harness/gates/ 上溯三层到仓根
const ROOT = join(import.meta.dir, '../../..');
const ENGINE_TS = join(ROOT, 'src/harness/dag/engine.ts');
const ENGINE_SRC = readFileSync(ENGINE_TS, 'utf8');

// 实扫 — 用于 GWT-1 / GWT-4 / GWT-7 (这些要求「扫真源码」)
const REAL_VERDICTS = scanGateVerdicts(ENGINE_SRC);

describe('GWT-1 — INV-1: 扫真 engine.ts 的 id 集合 ⊇ 表里全部 12 个 id', () => {
  test('登记的 12 个 id 都被实扫命中', () => {
    const registryIds = GATE_REGISTRY.map((e) => e.id);
    expect(registryIds).toHaveLength(12);
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

  // (b) 真源锚: 用真 engine.ts 文本跑 scanGateVerdicts + reconcileGateIds,
  //     必须断言 missing 为空且扫到的 id 集合含 'heartbeat'。
  //     删掉 engine.ts 里任意一条 `[heartbeat]` 标记 → 本测试当场红。
  //     (只验合成 fixture 的写法不合格)
  test('真 engine.ts: missing 为空 且 扫到的 id 集合含 heartbeat', () => {
    const verdicts = scanGateVerdicts(ENGINE_SRC);
    const reconciled = reconcileGateIds(ENGINE_SRC);
    expect(reconciled.missing).toEqual([]);
    expect(verdicts.has('heartbeat')).toBe(true);
  });
});

describe('GWT-4 — INV-4: 12 条原文都非空且不含换行', () => {
  test('实扫的每条 verdict .length > 0 且 !.includes(\\n)', () => {
    expect(REAL_VERDICTS.size).toBe(12);
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

  test('(兜底) 全表 12 项都不带 verdict / count', () => {
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

describe('GWT-7 — INV-7: 12 条原文以整串仍在 engine.ts 里 (保证只插不改)', () => {
  // 逐条钉死 — 不用扫描结果当期望值, 而是拿实扫结果作为「整串」
  // 反向断言: 这个整串必须出现在 engine.ts 源码里 (即扫描器没自己编)
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
  ] as const)('id=%s 整串仍在 engine.ts', (id, verdict) => {
    const needle = `${VERDICT_PREFIX}[${id}] ${verdict}`;
    expect(ENGINE_SRC.includes(needle)).toBe(true);
  });
});
