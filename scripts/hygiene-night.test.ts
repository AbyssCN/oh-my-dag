/**
 * hygiene-night.test —— INV-6「拓扑固定」(GWT-6) + 证伪 driver 的合流。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · 往 `buildHygieneChain` 里加/删一个 stage → 「节点 id 集合 = 6 个」那条红。
 *   · 把 `triage` 的 word 从 'map' 改成 'agent' → 「triage 编译成 executor:'map'」那条红。
 *   · 把 `decorateHygienePlan` 的 write_set 写成字符串而不是数组 → 「装饰后仍过 parsePlan」那条红。
 *   · 把 extractor 里的 `[:30]` 截断去掉 → 「每叶上限进 extractor 而不是靠嘱咐」那条红。
 *   · 让 `runRefutePass` 直接信 triage 的 delete (不跑 refuteDelete) → 「refuted 不进 files」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileChain } from '../src/harness/goal/stage-chain';
import { parsePlan } from '../src/harness/conductor-plan';
import { MAX_ITEMS_PER_LEAF, emptyCounts, type HygieneScan } from '../src/harness/hygiene/types';
import {
  BRANCH_PREFIX,
  HYGIENE_NODE_IDS,
  buildHygieneChain,
  decorateHygienePlan,
  runRefutePass,
} from './hygiene-night';

const OPTS = { date: '2026-09-02', cwd: '/repo', maxItemsPerLeaf: MAX_ITEMS_PER_LEAF };

describe('INV-6 GWT-6 拓扑固定', () => {
  const chain = buildHygieneChain(OPTS);
  const plan = compileChain(chain);

  test('节点 id 集合 = 契约那 6 个, 顺序也一致', () => {
    expect(chain.stages.map((s) => s.id)).toEqual([...HYGIENE_NODE_IDS]);
    expect(Object.keys(plan.nodes).sort()).toEqual([...HYGIENE_NODE_IDS].sort());
  });

  test("triage 编译成 executor:'map' 且 depends_on 含 scan", () => {
    const triage = plan.nodes.triage as Record<string, unknown>;
    expect(triage.executor).toBe('map');
    expect(triage.depends_on).toContain('scan');
    expect((triage.map as { lister: { command: string } }).lister.command).toContain('scan.json');
  });

  test(`每叶上限 ${MAX_ITEMS_PER_LEAF} 项写在 extractor 里 (不是靠嘱咐模型少写)`, () => {
    const triage = plan.nodes.triage as { map: { lister: { command: string } } };
    expect(triage.map.lister.command).toContain(`[:${MAX_ITEMS_PER_LEAF}]`);
  });

  test('verify 段是 gate 恒开的 verify 原语 (D-6 异族终审的挂点)', () => {
    const v = plan.nodes.verify as Record<string, unknown>;
    expect(v.primitive).toBe('verify');
    expect((v.params as { gate: boolean }).gate).toBe(true);
  });

  test('apply 的硬约束 / 提示分两区, 且钉死分支名 (§0 verifier 读软措辞的实测对策)', () => {
    const apply = plan.nodes.apply as { goal: string };
    expect(apply.goal).toContain('## 硬约束');
    expect(apply.goal).toContain('## 提示');
    expect(apply.goal).toContain(`${BRANCH_PREFIX}${OPTS.date}`);
  });

  test('链节点一个都不填 model (D-9 座位不写字面)', () => {
    for (const node of Object.values(plan.nodes)) {
      expect(JSON.stringify(node)).not.toContain('model');
    }
  });

  test('两次 parsePlan 都过 (编译后一次, 装饰后一次)', () => {
    expect(parsePlan(JSON.stringify(plan), { knownServers: new Set<string>() }).ok).toBe(true);
    const decorated = decorateHygienePlan(plan, ['src/a.ts', 'src/b.ts']);
    expect(parsePlan(JSON.stringify(decorated), { knownServers: new Set<string>() }).ok).toBe(true);
  });

  test('装饰只动 apply.write_set, 别的节点逐字节不变', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const decorated = decorateHygienePlan(plan, files);
    expect((decorated.nodes.apply as { write_set: string[] }).write_set).toEqual(files);
    for (const id of HYGIENE_NODE_IDS.filter((i) => i !== 'apply')) {
      expect(JSON.stringify(decorated.nodes[id])).toBe(JSON.stringify(plan.nodes[id]));
    }
  });

  test('空清单也装 [] —— "这次没得删"与"忘了声明写集"是两件事', () => {
    expect((decorateHygienePlan(plan, []).nodes.apply as { write_set: string[] }).write_set).toEqual([]);
  });
});

describe('证伪 driver 合流 triage → worklist', () => {
  /** 摆一个 <hy> 目录: scan.json + 两份 triage-*.json。 */
  function makeHy(): string {
    const hy = mkdtempSync(join(tmpdir(), 'hy-'));
    mkdirSync(hy, { recursive: true });
    const counts = emptyCounts();
    counts['knip-files'] = 2;
    counts.todo = 1;
    const scan: HygieneScan = {
      version: 1,
      generatedAt: '2026-09-02T00:00:00Z',
      sha: 'abc',
      counts,
      items: [
        { id: 'knip-files:src/dead.ts', source: 'knip-files', path: 'src/dead.ts', summary: 'd', evidence: [] },
        { id: 'knip-files:src/live.ts', source: 'knip-files', path: 'src/live.ts', summary: 'd', evidence: [] },
        { id: 'todo:src/a.ts#1', source: 'todo', path: 'src/a.ts', summary: 't', evidence: [] },
      ],
      errors: [],
    };
    writeFileSync(join(hy, 'scan.json'), JSON.stringify(scan));
    writeFileSync(
      join(hy, 'triage-knip-files.json'),
      JSON.stringify([
        { itemId: 'knip-files:src/dead.ts', disposition: 'delete', reason: '无引用', reproCmd: 'ugrep -c -F dead src' },
        { itemId: 'knip-files:src/live.ts', disposition: 'delete', reason: '无引用', reproCmd: 'ugrep -c -F live src' },
      ]),
    );
    // 坏 JSON → 该类整批回退成 ticket (D-3), 一条 delete 都不该出
    writeFileSync(join(hy, 'triage-todo.json'), '模型这批没答出来');
    return hy;
  }

  const run = (cmd: string): { code: number; out: string } =>
    // live.ts 仍被引用 (第二核抓到); dead.ts 真无引用。
    cmd.includes('-w -F "live"') ? { code: 0, out: 'src/user.ts\n' } : { code: 1, out: '' };

  const res = runRefutePass(makeHy(), { run, nowIso: '2026-09-02T01:00:00Z' });

  test('只有过双核的 delete 进施工清单', () => {
    expect(res.files).toEqual(['src/dead.ts']);
    expect(res.confirmed).toBe(1);
    expect(res.refuted).toBe(1);
  });

  test('坏 JSON 的那一类整批回退, 一条 delete 都不出', () => {
    expect(res.fallbackIds).toContain('todo:src/a.ts#1');
    expect(res.verdicts.some((v) => v.itemId.startsWith('todo:'))).toBe(false);
  });

  test('verdicts 逐条留 checks (人能看到为什么被驳)', () => {
    const refuted = res.verdicts.find((v) => v.verdict === 'refuted')!;
    expect(refuted.checks.some((c) => !c.ok)).toBe(true);
  });
});
