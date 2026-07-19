/**
 * arch/deepen-plan —— dag-deepen 的**预构造 ConductorPlan** 工厂 (零 conductor LLM)。
 *
 * 图形状固定: 每热点 1 个 executor:'agent' 扫描叶 (要读真文件 → 必须带工具) + 1 个 synthesis
 * inproc 叶依赖全部扫描叶 (跨热点去重 + 按 leverage 排名)。产出直接喂 runExecutorDagWithPlan
 * (executor-dag 的 D-7 预构造入口) — 图形状是代码定的, 不需要模型来"规划", 这正是预构造入口
 * 的用武之地 (dogfooding P1)。
 *
 * prompt 词汇走 review/design-vocab 的 DESIGN_VOCAB (单一真相源, 与 dag-slim/codebase-design
 * 同步): shallow module / deletion test / deep interface / leverage / locality。
 *
 * ⚠️ 扫描叶是**只读探查**: goal 措辞刻意避开 executor-dag 的 producesFiles 强写信号
 * (实现/创建/新建/写入/生成/修改/实装/落地 + 文件后缀) — 命中会触发产物校验闸, 把零改动的
 * 只读叶误判成 empty-done failed。deepen-plan.test.ts 对此有回归守卫。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import { DESIGN_VOCAB } from '../review/design-vocab';
import type { Hotspot } from './hotspots';

/** 综合节点固定 id (脚本收结果 + 测试都锚它)。 */
export const SYNTH_NODE_ID = 'synthesis';

/** 每个扫描叶 prompt 里列出的组内文件上限 (护 prompt 尺寸; 叶自己可再探目录)。 */
const MAX_FILES_IN_PROMPT = 10;

/**
 * 候选输出的固定标题格式 (扫描叶 → synthesis → 报告渲染器共用的**结构契约**)。
 * 渲染器按 `## ` 切卡片, 按 `- **字段**:` 认字段 — prompt 与 parser 引同一常量防漂移。
 */
export const CANDIDATE_FORMAT = `## C<序号>: <候选一句话名字>
- **files**: <涉及文件, 逗号分隔>
- **friction**: <观察到的摩擦: 理解一个概念要在哪些文件间弹跳 / 哪里测不穿>
- **deletion-test**: <deep|shallow 判定 + 一句理由 (删掉后复杂度摊回调用方会不会暴涨)>
- **before/after**: <现接口 → 提案深接口的草图; 关系形的用 \`\`\`mermaid 围栏画, 否则文字>
- **leverage/locality**: <预期回报: 多少调用点受益 / 改动会不会集中一处>
- **strength**: <strong|moderate|speculative>`;

export interface DeepenPlanOptions {
  /** synthesis 保留的候选上限 (默认 8)。 */
  maxCandidates?: number;
}

/** 单热点扫描叶的 goal (只读探查, 见文件头 producesFiles 措辞警告)。 */
function scanGoal(h: Hotspot): string {
  const fileLines = h.files
    .slice(0, MAX_FILES_IN_PROMPT)
    .map((f) => `- ${f.path} (近期触碰 ${f.touches} 次)`)
    .join('\n');
  const more = h.files.length > MAX_FILES_IN_PROMPT ? `\n(另有 ${h.files.length - MAX_FILES_IN_PROMPT} 个文件, 可自行探查)` : '';
  return [
    `你在做**只读架构探查** — 绝对不许改任何文件, 只用 read/ls/grep 类工具看代码。`,
    ``,
    `热点 module: ${h.dir} (近期 commit 触碰合计 ${h.touches} 次${h.files.length ? '' : '; git 日志无明细, 请自行探查该目录'})`,
    fileLines ? `组内文件:\n${fileLines}${more}` : '',
    ``,
    DESIGN_VOCAB,
    ``,
    `任务: 通读该热点的代码, 找 **shallow module** (接口复杂度 ≈ 实现复杂度之物), 对每个疑似者跑`,
    `**deletion test**; 记录摩擦证据 (理解一个概念要在几个文件间弹跳 / 经接口测不穿的逻辑); 对值得`,
    `加深 (deepen) 的, 给 before/after 接口草图。宁缺毋滥: 0-3 个候选, 没有就明说 "无候选"。`,
    ``,
    `每个候选严格用这个格式输出 (标题格式是下游解析契约, 不许变体):`,
    CANDIDATE_FORMAT,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** synthesis 叶的 goal: 跨热点去重 (全局赢面) + 按 leverage 排名 + 截前 K。 */
function synthGoal(maxCandidates: number): string {
  return [
    `你收到多个热点的架构探查结果 (见 upstream)。做三件事:`,
    ``,
    `1. **跨热点去重/合并**: 同一段逻辑在 N 个热点各手搓一份 = 合并成**一个** shared-util 深模块候选`,
    `   (标注"跨热点"并列出所有出现处) — 这是单热点视角看不见的全局赢面, 是你存在的理由。`,
    `2. **按 leverage 排名**: 受益调用点多、改动集中一处 (locality 好) 的排前; deletion-test 判为`,
    `   shallow 且证据硬的优先于 speculative。`,
    `3. **截取前 ${maxCandidates} 个**, 重新编号 C1..C${maxCandidates}, 每个严格用这个格式 (下游按它解析, 不许变体):`,
    CANDIDATE_FORMAT,
    ``,
    `上游说 "无候选" 的热点直接忽略。除候选区块外不要输出别的段落。`,
  ].join('\n');
}

/**
 * 构造 dag-deepen 的预构造 plan: 每热点一个 agent 扫描叶 + synthesis 依赖全部。
 * 返回前过 PlanSchema.parse — 图形状坏在构造期炸, 不流进执行器。
 */
export function buildDeepenPlan(hotspots: Hotspot[], opts: DeepenPlanOptions = {}): ConductorPlan {
  if (hotspots.length === 0) throw new Error('buildDeepenPlan: 至少需要 1 个热点');
  const maxCandidates = opts.maxCandidates ?? 8;

  const nodes: Record<string, unknown> = {};
  const scanIds: string[] = [];
  hotspots.forEach((h, i) => {
    const id = `scan_${i + 1}`;
    scanIds.push(id);
    nodes[id] = {
      executor: 'agent', // 要读真文件 → 带工具; goal 已钉只读纪律
      goal: scanGoal(h),
      persona: '软件设计审读者 (Ousterhout 深模块/删除测试视角, 证据优先宁缺毋滥)',
    };
  });
  nodes[SYNTH_NODE_ID] = {
    executor: 'leaf', // 纯文本综合, 单发 inproc 即可
    goal: synthGoal(maxCandidates),
    depends_on: scanIds,
    creative: true, // 交付物 prose → 关 caveman 压缩护质量
  };

  return PlanSchema.parse({
    name: 'dag-deepen',
    description: `架构加深候选扫描: ${hotspots.length} 个热点并发探查 → 跨热点综合排名 (top ${maxCandidates})`,
    nodes,
  });
}
