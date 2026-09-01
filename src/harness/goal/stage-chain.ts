/**
 * src/harness/goal/stage-chain —— 阶段链 IR + 确定性编译器 (D4 切片, 2026-08-31)
 *
 * 承 `docs/plan/2026-08-31-dynamic-workflow-design.md` §6 R1–R9: solve 规划期加一层
 * 「路由 + 阶段链编译」, 命中时图拓扑由本编译器产出, conductor 只填文本槽。
 *
 * ## 决策 (D-1 / D-2 / D-3 / D-5 / D-7 落地)
 *
 * - D-1 载体 = 新增小 IR (StageChain) + 编译器, 编译目标 = 现有 `ConductorPlan` JSON,
 *   原样过 `parsePlan` (conductor-plan.ts) 全部闸; 引擎执行侧零改动。
 * - D-2 数据流两种绑定:
 *     · 文本绑定 = `depends_on` 边 (上游输出自动注入下游原语, 引擎已有, 见 engine.ts)
 *     · 清单绑定 = 编译成 map 节点 + lister 子步 (静态槽禁接运行时清单, 编译器强制换写)
 * - D-3 链形状 v1 = 线性 (分支/classify-and-act 不进 v1, 见设计文档)
 * - D-5 词表 v1 共 8 词, 见 `STAGE_WORDS`; primitive 直通 vetted 13 枚举 (conductor-plan.ts)。
 * - D-7 越界红线: 本活不改 conductor plan 的 zod 值域、不改 engine.ts、不改 primitive-registry。
 *
 * ## 三件套
 *
 *   ① types (`StageWord` / `Stage` / `StageChain`)  →  切片 2 路由器消费的冻结接口
 *   ② `validateChain(chain)`                          →  抛 Error 含可定位判词
 *   ③ `compileChain(chain)`                           →  ConductorPlan (过 `parsePlan`)
 *
 * ## 反向自检的统一形状 (本仓惯例, 同 flat-plan.test)
 *
 *   INV-1/2/3/5 各配一份「已知违规样本」, 闸摘掉 → test 当场由绿转红。证伪方式写在
 *   test 注释里, 一行一锚。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';

// ── 公开类型 (S1 / S2 冻结接口, 实装偏离 = 回流改契约) ───────────────────────

/** v1 词表 8 词 (D-5)。按语义角色排, 不按出现频率。 */
export const STAGE_WORDS = [
  'research',
  'command',
  'agent',
  'map',
  'verify',
  'judge',
  'synthesize',
  'primitive',
] as const;

export type StageWord = (typeof STAGE_WORDS)[number];

/**
 * 阶段 = 链上一个节点的「语义角色 + 槽」。链上 id 稳定, 进 plan 节点 id 派生用
 * 同一个值 (零回退)。
 */
export interface Stage {
  /** 稳定 id, 进 plan 节点 id 派生; 链内唯一。 */
  id: string;
  /** 语义角色 (词表 8 词)。 */
  word: StageWord;
  /** 文本槽: agent / research / verify / judge / synthesize 必填 (其余看 word)。 */
  goal?: string;
  /** word:'command' 专用槽, 跑什么确定性命令。 */
  command?: string;
  /** word:'primitive' 专用槽: 原语 id + 参数 (深校验在执行期走 compilePrimitive)。 */
  primitive?: { id: string; params: Record<string, unknown> };
  /** 仅 word:'map' 合法: 运行时清单来源 = 哪个阶段 + 用什么确定性命令抽取。 */
  listFrom?: { stage: string; extractor: string };
  /** 仅 word:'map' 合法: 每元素子节点的 goal 模板 (模板里 ${item} 由引擎插值)。 */
  perItem?: string;
}

/** 线性阶段链 (D-3: v1 不分支)。 */
export interface StageChain {
  stages: Stage[];
}

// ── 不变量与闸 (INV-1..6, GWT-1/2/3/5 落地点) ──────────────────────────────

/** INV-3 闸: 词表外 word 拒, 错误文本含全部 8 词 (GWT-3 逐字要求)。 */
function assertWordInVocab(word: string, where: string): void {
  if (!STAGE_WORDS.includes(word as StageWord)) {
    throw new Error(
      `${where} word "${word}" 不在 v1 词表 (INV-3)。合法词 = ${STAGE_WORDS.join(', ')}`,
    );
  }
}

/** INV-5 闸: 首阶段禁带 listFrom (GWT-5 逐字要求错误文本含「首阶段」)。 */
function assertFirstStageNoListFrom(chain: StageChain): void {
  if (chain.stages[0]?.listFrom) {
    throw new Error(
      `INV-5: 首阶段 (id="${chain.stages[0].id}") 禁带 listFrom — 链入口无上游可抽`,
    );
  }
}

/** INV-5 同一族的另一面: listFrom.stage 必须指向链内更早阶段 (否则环 / 未来引用)。 */
function assertListFromEarlier(chain: StageChain, idx: number, where: string): void {
  const stage = chain.stages[idx]!;
  if (!stage.listFrom) return;
  const refId = stage.listFrom.stage;
  const refIdx = chain.stages.findIndex((s) => s.id === refId);
  if (refIdx === -1) {
    throw new Error(
      `${where} listFrom.stage="${refId}" 不在链内 — 链必须自包含, 跨链引用不在 v1`,
    );
  }
  if (refIdx >= idx) {
    throw new Error(
      `${where} listFrom.stage="${refId}" (索引 ${refIdx}) 必须早于当前阶段 (索引 ${idx})`,
    );
  }
}

/** INV-2 闸: parallel / pipeline 静态槽禁接上游清单绑定 (D-2 结构性禁令)。
 *  错误文本逐字含 'map' (GWT-2)。 */
function assertPrimitiveNoUpstreamListBinding(stage: Stage, stages: readonly Stage[], where: string): void {
  if (stage.word !== 'primitive' || !stage.primitive) return;
  const id = stage.primitive.id;
  if (id !== 'parallel' && id !== 'pipeline') return;
  const listStageIds = new Set(stages.filter((s) => s.listFrom).map((s) => s.id));
  for (const v of Object.values(stage.primitive.params ?? {})) {
    if (typeof v === 'string' && listStageIds.has(v)) {
      throw new Error(
        `${where} primitive(${id}) 静态槽禁接上游清单绑定 (INV-2) — ` +
          `params 引用了 "${v}" 这个有 listFrom 的阶段。` +
          '静态槽接运行时清单是历次组合失败的根因; 强制换写为 map 节点。',
      );
    }
  }
}

/** 形态闸: map 阶段必带 listFrom + perItem; command 阶段必带 command; etc。 */
function assertSlotShape(stage: Stage, where: string): void {
  switch (stage.word) {
    case 'map':
      if (!stage.listFrom) throw new Error(`${where} word="map" 必带 listFrom (D-2)`);
      if (!stage.perItem) throw new Error(`${where} word="map" 必带 perItem (模板 goal)`);
      if (!stage.listFrom.extractor) {
        throw new Error(`${where} word="map" 的 listFrom.extractor 不可为空`);
      }
      break;
    case 'command':
      if (!stage.command) throw new Error(`${where} word="command" 必带 command 槽`);
      break;
    case 'primitive':
      if (!stage.primitive) throw new Error(`${where} word="primitive" 必带 primitive 槽`);
      break;
    default:
      // research / agent / verify / judge / synthesize: goal 是文本槽, 调用方提供
      if (!stage.goal) throw new Error(`${where} word="${stage.word}" 必带 goal 文本槽`);
  }
}

/** 链内 id 唯一性: 同 id 重复 = 节点键冲突, plan 无法构造。 */
function assertUniqueIds(chain: StageChain): void {
  const seen = new Set<string>();
  for (const stage of chain.stages) {
    if (seen.has(stage.id)) {
      throw new Error(`阶段链 id 重复: "${stage.id}" — 节点 id 必须链内唯一`);
    }
    seen.add(stage.id);
  }
}

/**
 * 链合法性总闸。按 INV 顺序过 — INV-3 (词表) 先于 INV-5 (首阶段), 早失败好定位。
 * 抛 Error, 文本逐字满足 GWT-2/3/5 的 `.includes(...)` 要求。
 */
export function validateChain(chain: StageChain): void {
  if (!chain.stages.length) {
    throw new Error('阶段链 stages 为空 — 至少 1 个阶段');
  }
  assertUniqueIds(chain);
  chain.stages.forEach((s, i) => {
    const where = `阶段 #${i + 1} (id="${s.id}")`;
    assertWordInVocab(s.word, where);
  });
  assertFirstStageNoListFrom(chain);
  chain.stages.forEach((s, i) => {
    const where = `阶段 #${i + 1} (id="${s.id}")`;
    assertSlotShape(s, where);
    assertListFromEarlier(chain, i, where);
    assertPrimitiveNoUpstreamListBinding(s, chain.stages, where);
  });
}

// ── 编译器: 阶段链 → ConductorPlan ─────────────────────────────────────────

/** word → PlanNode executor 映射。verify(走 verify 原语, D4.1 切片 3) / judge / synthesize
 *  走 agent (只有 goal 文本槽, 无 command; 解析走 goal 是 LLM 的事, 走 command 需额外槽, v1 不开)。 */
function executorOf(word: StageWord): 'research' | 'command' | 'agent' {
  switch (word) {
    case 'research':
      return 'research';
    case 'command':
      return 'command';
    case 'agent':
    case 'map':
    case 'verify':
    case 'judge':
    case 'synthesize':
    case 'primitive':
      // map / primitive 自己走自己的 schema (executor:'map' / kind:'primitive'),
      // 不进这个分支; 这里兜底给 verify(已下沉 verify 原语, 见 compileStageNode)/ judge / synthesize。
      return 'agent';
  }
}

/** 单阶段 → PlanNode 片段 (不含 depends_on, 由调用方收边)。 */
function compileStageNode(stage: Stage): Record<string, unknown> {
  switch (stage.word) {
    case 'research':
      return { executor: 'research', goal: stage.goal, depends_on: [] };
    case 'command':
      return {
        executor: 'command',
        command: stage.command,
        goal: stage.goal ?? `run: ${stage.command}`,
        expect_exit: 0,
        depends_on: [],
      };
    case 'agent':
      return { executor: 'agent', goal: stage.goal, depends_on: [] };
    case 'verify':
      // D4.1 切片 3 (INV-5): verify 词 → verify 原语节点 + gate 恒开。
      // 目标文本 (stage.goal) → claim 槽; gate:true 使下游节点 failed 可级联 skip, 修复轮接手。
      return {
        kind: 'primitive',
        primitive: 'verify',
        params: { claim: stage.goal!, gate: true },
        depends_on: [],
      };
    case 'judge':
    case 'synthesize':
      // 文本槽节点 — LLM-判的 judge/synthesize, 走 agent 让它读上游 + 出文本。
      return { executor: 'agent', goal: stage.goal, depends_on: [] };
    case 'map': {
      // listFrom = 数据流清单绑定: 编译成 executor:'map' + lister 子步 (D-2)。
      // lister 是 command 节点, extractor = 跑出数组的命令 (走白名单 / 危险命令闸)。
      // template = per-item 子节点 (按元素展开, 形态闸 INV-U5 由 schema 兜底, 我们不进
      // map.template 的 executor 校验 — 让 PlanSchema 的 superRefine 来判)。
      return {
        executor: 'map',
        map: {
          lister: {
            executor: 'command',
            command: stage.listFrom!.extractor,
          },
          // over = 取 lister 输出里的哪个键作为数组; v1 固定 'items', 与上游命令约定。
          // keyBy 缺席 → 元素内容 hash (INV-U2 默认语义, 同 plan/map-expand 现有约定)。
          over: 'items',
          itemVar: 'item',
          template: {
            executor: 'agent',
            goal: stage.perItem,
          },
        },
        depends_on: [],
      };
    }
    case 'primitive':
      // primitive 直通 (D-5): kind + primitive + params, 深校验在执行期走 compilePrimitive。
      return {
        kind: 'primitive',
        primitive: stage.primitive!.id,
        params: stage.primitive!.params,
        depends_on: [],
      };
  }
}

/**
 * 阶段链 → ConductorPlan。线性 = 文本绑定沿链 (stage[i].depends_on ⊇ {stage[i-1].id});
 * 清单绑定额外加 listFrom.source 到 depends_on (去重)。compile 后过 PlanSchema.parse:
 * 任何结构违例 (环 / 字段值域 / map 互 required) 在这里被 schema 兜底拒, 错误冒泡给
 * 调用方。
 */
export function compileChain(chain: StageChain): ConductorPlan {
  validateChain(chain);
  const nodes: Record<string, Record<string, unknown>> = {};
  chain.stages.forEach((stage, i) => {
    const node = compileStageNode(stage);
    const deps = new Set<string>();
    // 文本绑定: 接前一阶段 (线性, D-3)。
    if (i > 0) deps.add(chain.stages[i - 1]!.id);
    // 清单绑定: map 阶段额外依赖 listFrom.source (供 lister 输出接住)。
    if (stage.listFrom) deps.add(stage.listFrom.stage);
    node.depends_on = [...deps];
    nodes[stage.id] = node;
  });
  return PlanSchema.parse({
    name: `stage-chain:${chain.stages.map((s) => s.id).join('->')}`,
    description: 'compiled from StageChain (deterministic, no conductor)',
    nodes,
  });
}
