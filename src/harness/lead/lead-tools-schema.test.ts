/**
 * lead-tools-schema.test —— INV-2:七张卡 schema 全部 `.strict()`,调度字段(D-4)必拒。
 *
 * 怎么让它红:目录 `src/harness/lead/` 还不存在时(实装前),这些 import 全部 module-not-found,
 * 整个文件红。任何一张卡的 schema 放开一个调度字段(去掉 `.strict()` 或加一个显式字段)即红。
 */
import { describe, expect, test } from 'bun:test';
import { renderManual } from './render-manual';
import { bestOfTool } from './tools/best-of';
import { decomposeTool } from './tools/decompose';
import { exploreTool } from './tools/explore';
import { eraseLeadTool, formatRejection, invokeLeadTool, LEAD_TOOL_NAMES } from './tools/index';
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

const TOOLS: readonly LeadTool[] = [
  eraseLeadTool(workTool),
  eraseLeadTool(spawnTool),
  eraseLeadTool(mapTool),
  eraseLeadTool(exploreTool),
  eraseLeadTool(bestOfTool),
  eraseLeadTool(researchTool),
  eraseLeadTool(decomposeTool),
];

/** 每张卡的一份最小合法样本(D-4 全矩阵测试要在此基础上叠加调度字段)。 */
const VALID_PARAMS: Record<LeadToolName, Record<string, unknown>> = {
  work: { goal: '修一个 bug', brief: 'x'.repeat(40) },
  spawn: { tasks: [{ goal: 'a', brief: 'b' }, { goal: 'c', brief: 'd' }] },
  map: { list_from: 'ls src', per_item: 'process {item}' },
  explore: { questions: ['谁在调用 foo()?'] },
  best_of: { n: 2, goal: '优化性能', brief: 'y'.repeat(40) },
  research: { question: '这个库怎么用?' },
  decompose: { goal: '一个还拆不出来的目标' },
};

// D-4:调度字段一律不进 schema —— executor/depends_on/tier/maxFanout/thinking/cluster/requires。
const SCHEDULING_FIELDS: Record<string, unknown> = {
  executor: 'agent',
  depends_on: ['x'],
  tier: 'strong',
  maxFanout: 8,
  thinking: 'high',
  cluster: 'c1',
  requires: 'all',
};

describe('lead-tools-schema (INV-2)', () => {
  test('七张卡名字与 LEAD_TOOL_NAMES 一致', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...LEAD_TOOL_NAMES].sort());
  });

  for (const tool of TOOLS) {
    test(`${tool.name}: 最小合法样本过 schema`, () => {
      expect(tool.schema.safeParse(VALID_PARAMS[tool.name]).success).toBe(true);
    });

    for (const [field, value] of Object.entries(SCHEDULING_FIELDS)) {
      test(`${tool.name}: 调度字段 '${field}' 进参数即拒(.strict())`, () => {
        const bad = { ...VALID_PARAMS[tool.name], [field]: value };
        expect(tool.schema.safeParse(bad).success).toBe(false);
      });
    }
  }

  for (const tool of TOOLS) {
    test(`${tool.name}: 缺必填字段 → 拒绝体首行 === 该卡 manual 首行`, () => {
      const result = invokeLeadTool(tool, {}, CTX);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      const rejectionBody = formatRejection(result);
      const manualFirstLine = renderManual(tool.name).split('\n')[0]!;
      expect(rejectionBody.startsWith(manualFirstLine)).toBe(true);
      expect(result.manual).toBe(renderManual(tool.name));
    });
  }
});
