/**
 * lead-tools-compile.test —— INV-3(格式面)+ D-6/D-11/D-23 一带各卡的拒绝语义。
 *
 * 怎么让它红:实装前(无 tools/*、无 compile)整个文件 module-not-found,全红。
 * 之后:任一卡的合法样本 compile 产物过不了 `parsePlan` 即红;spawn 写集重叠 / best_of 缺
 * scorer / research 缺 provider 三条不拒即红;help:true 分支若真的调了 compile 即红。
 */
import { describe, expect, test } from 'bun:test';
import { spyOn } from 'bun:test';
import { parsePlan } from '../conductor-plan';
import { shapeById } from '../shapes';
import { checkWriteAllowed, resolveNodeWriteAllow } from '../writeset/write-allow';
import { renderManual } from './render-manual';
import { bestOfTool } from './tools/best-of';
import { decomposeTool } from './tools/decompose';
import { exploreTool } from './tools/explore';
import { eraseLeadTool, invokeLeadTool } from './tools/index';
import { mapTool } from './tools/map';
import { researchTool } from './tools/research';
import { spawnTool } from './tools/spawn';
import { workTool } from './tools/work';
import type { LeadCtx, LeadTool, LeadToolName } from './types';

const CTX: LeadCtx = {
  cwd: '/tmp/lead-tools-test',
  writeRoot: '/tmp/lead-tools-test',
  acceptance: { command: 'bun test', expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'worker-seat', escalation: 'escalation-seat', verify: 'verify-seat' },
  researchAvailable: true,
};

const NO_ACCEPTANCE_CTX: LeadCtx = { ...CTX, acceptance: undefined };
const NO_RESEARCH_CTX: LeadCtx = { ...CTX, researchAvailable: false };

const TOOLS: readonly LeadTool[] = [
  eraseLeadTool(workTool),
  eraseLeadTool(spawnTool),
  eraseLeadTool(mapTool),
  eraseLeadTool(exploreTool),
  eraseLeadTool(bestOfTool),
  eraseLeadTool(researchTool),
  eraseLeadTool(decomposeTool),
];

const VALID_PARAMS: Record<LeadToolName, Record<string, unknown>> = {
  work: { goal: '修一个 bug', brief: 'x'.repeat(40) },
  spawn: { tasks: [{ goal: 'a', brief: 'b' }, { goal: 'c', brief: 'd' }] },
  map: { list_from: 'ls src', per_item: 'process {item}' },
  explore: { questions: ['谁在调用 foo()?'] },
  best_of: { n: 2, goal: '优化性能', brief: 'y'.repeat(40), write_set: ['src/x.ts'] },
  research: { question: '这个库怎么用?' },
  decompose: { goal: '一个还拆不出来的目标' },
};

describe('lead-tools-compile (D-5/INV-3 格式面)', () => {
  for (const tool of TOOLS) {
    test(`${tool.name}: 合法样本 compile 产物过 parsePlan`, () => {
      const parsed = tool.schema.safeParse(VALID_PARAMS[tool.name]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const result = tool.compile(parsed.data, CTX);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parseResult = parsePlan(JSON.stringify(result.plan), { knownServers: new Set() });
      expect(parseResult.ok).toBe(true);
    });
  }

  test('spawn: 写集重叠 → compile 拒且判词含 write set', () => {
    const params = {
      tasks: [
        { goal: 'a', brief: 'b', write_set: ['src/x.ts'] },
        { goal: 'c', brief: 'd', write_set: ['src/x.ts'] },
      ],
    };
    const parsed = spawnTool.schema.safeParse(params);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = spawnTool.compile(parsed.data, CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('write set');
    expect(result.manual).toBe(renderManual('spawn'));
  });

  test('best_of: 无 scorer(ctx.acceptance 缺席) → 拒', () => {
    const parsed = bestOfTool.schema.safeParse(VALID_PARAMS.best_of);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = bestOfTool.compile(parsed.data, NO_ACCEPTANCE_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.manual).toBe(renderManual('best_of'));
  });

  test('best_of: N 个 attempt 串行链 + 共享 write_set(P1② 回归 —— 不许再是并发无写集兄弟)', () => {
    const params = { n: 3, goal: '修一个 flaky 测试', brief: 'y'.repeat(40), write_set: ['src/x.ts', 'src/y.ts'] };
    const parsed = bestOfTool.schema.safeParse(params);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = bestOfTool.compile(parsed.data, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = ['attempt-1', 'attempt-2', 'attempt-3'];
    expect(Object.keys(result.plan.nodes).sort()).toEqual([...ids].sort());
    // 怎么让它红: 去掉 depends_on 链或去掉 write_set 传导 —— N 个 attempt 又变回互不可达的
    // 并发写者, `serializeWriteRaces` 看得见重叠但这里不该依赖它兜底, 应直接声明式排定。
    expect(result.plan.nodes['attempt-1']!.depends_on ?? []).toEqual([]);
    expect(result.plan.nodes['attempt-2']!.depends_on).toEqual(['attempt-1']);
    expect(result.plan.nodes['attempt-3']!.depends_on).toEqual(['attempt-2']);
    for (const id of ids) expect(result.plan.nodes[id]!.write_set).toEqual(params.write_set);
    // 第 2/3 个 attempt 的 goal 必须带"已经赢了就别碰"的机械判据, 不能只是原样重复 goal/brief。
    expect(String(result.plan.nodes['attempt-2']!.goal)).toContain(CTX.acceptance!.command);
    expect(String(result.plan.nodes['attempt-2']!.goal)).toContain('git checkout');
  });

  test('research: researchAvailable=false → 拒', () => {
    const parsed = researchTool.schema.safeParse(VALID_PARAMS.research);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = researchTool.compile(parsed.data, NO_RESEARCH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.manual).toBe(renderManual('research'));
  });

  test('decompose: manual 原样携带既有 D-D 展开闸「子图不许再嵌 conductor 或 map」的规则', () => {
    const shape = shapeById('runtime-decomposition');
    expect(shape?.enforced).toBeTruthy();
    expect(renderManual('decompose')).toContain(shape!.enforced!);
  });

  test('explore: 只读承诺挡得住真实写目标(P1③ 回归 —— 空数组会被引擎 `.length` 折叠成闸缺席）', () => {
    const parsed = exploreTool.schema.safeParse(VALID_PARAMS.explore);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = exploreTool.compile(parsed.data, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = Object.values(result.plan.nodes)[0]!;
    // 怎么让它红: 把 explore.ts 的 write_set 换回 `[]` —— 下面这行会先红(length 应 >0,
    // 引擎才会把这道闸下发给 leaf;`[]` 时 engine.ts:4572 的 `.length` 判据会把它当闸缺席)。
    const allow = resolveNodeWriteAllow(node.write_set as string[] | undefined, undefined, CTX.cwd);
    expect(allow.length).toBeGreaterThan(0);
    // 任何真实写目标都不该被这份"哨兵写集"放行。
    expect(checkWriteAllowed('src/anything.ts', allow, CTX.cwd).allowed).toBe(false);
  });

  test('help:true → 只返 manual,compile 计数为 0', () => {
    const spy = spyOn(workTool, 'compile');
    try {
      const result = invokeLeadTool(workTool, { help: true }, CTX);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.manual).toBe(renderManual('work'));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // review-fix (P2⑤,2026-09-02): 上一版只在 workTool 上测过 help:true —— 七张卡的 schema 各自
  // `.strict()`,只测一张测不出「另外六张没声明 help 字段」这类漏网。这里逐卡过 `schema.safeParse`
  // 确认 `help:true` 与该卡的最小合法样本叠加后仍然过 schema(不是被 .strict() 拒收之后才被
  // isHelpRequest 捡到 —— 那样真实 MCP 客户端按发布的 JSON Schema 校验就永远走不到这条路)。
  for (const tool of TOOLS) {
    test(`${tool.name}: help:true 过 schema(不依赖 .strict() 拒收后才短路)`, () => {
      const withHelp = { ...VALID_PARAMS[tool.name], help: true };
      expect(tool.schema.safeParse(withHelp).success).toBe(true);
      const result = invokeLeadTool(tool, withHelp, CTX);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.manual).toBe(renderManual(tool.name));
    });
  }
});
