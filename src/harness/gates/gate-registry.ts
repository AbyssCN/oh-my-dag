/**
 * src/harness/gates/gate-registry.ts —— 「判生死的图级闸」登记 + 对账闸
 *
 * 表只登记稳定 id；判词原文从引擎源码里的 id 化判词串派生。这样改文案不再要求同步抬表，
 * 同一 id 的多个出口也不需要维护脆弱的出现次数。
 */

/** 引擎侧判词前缀。完整形状为 `[omd/executor-dag][<id>] <原文>`。 */
export const VERDICT_PREFIX = '[omd/executor-dag]';

export interface GateEntry {
  id: string;
  family: string;
  file: string;
}

/** 判生死的图级闸；一道闸可能在多个出口打印同一条 id 化判词。 */
export const GATE_REGISTRY: readonly GateEntry[] = [
  {
    id: 'artifact-empty',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'artifact-verdict',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'artifact-broken',
    family: '产物闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'heartbeat',
    family: '心跳闸',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-action',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-judge',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-spin',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'fuse-samecause',
    family: '空转熔断',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'oracle-exit-miss',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'oracle-exit-scope',
    family: 'expect_exit',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'writescope-drop',
    family: '写域越界',
    file: 'src/harness/dag/engine.ts',
  },
  {
    id: 'false-completion',
    family: '谎报完成',
    file: 'src/harness/dag/engine.ts',
  },
];

const GATE_VERDICT_LITERAL = /(['"`])\[omd\/executor-dag\]\[([a-z-]+)\]((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

/** 从源码里的 id 化字符串字面量派生 id → 判词原文；重复 id 直接归入同一 Map 项。 */
export function scanGateVerdicts(source: string): Map<string, string> {
  const verdicts = new Map<string, string>();
  for (const match of source.matchAll(GATE_VERDICT_LITERAL)) {
    verdicts.set(match[2]!, match[3]!.trim());
  }
  return verdicts;
}

/** 对账登记 id 与源码 id；不读盘，也不把重复出现次数当成漂移。 */
export function reconcileGateIds(source: string): {
  missing: string[];
  unregistered: string[];
  empty: string[];
} {
  const verdicts = scanGateVerdicts(source);
  const registered = new Set(GATE_REGISTRY.map((entry) => entry.id));

  return {
    missing: GATE_REGISTRY.filter((entry) => !verdicts.has(entry.id)).map((entry) => entry.id),
    unregistered: [...verdicts.keys()].filter((id) => !registered.has(id)),
    empty: [...verdicts].filter(([, verdict]) => verdict.length === 0).map(([id]) => id),
  };
}
