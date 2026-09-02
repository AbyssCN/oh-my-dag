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
  best_of: { n: 2, goal: '优化性能', brief: 'y'.repeat(40) },
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
});
