/**
 * core/research/lens-template —— `RESEARCH_LENS_TEMPLATE`: 深度研究扇出的**五阶段结构单源**
 * (SDD 0009 §5 D5 · P3 分解器统一)。
 *
 * 为什么存在(化解 Q2 张力 = 一个分解器 + 质量结构不丢):
 *   P3 之前有**两个分解器** —— (1) conductor 吐 DAG,(2) `authorFanoutSpec` 每次调用**现推**
 *   researchFanout 的五阶段镜头结构。第二条路每次重新 author 结构 = 出错源(漏阶段 / 篡改 /
 *   幻觉模型名),且是重复的"第二真理源"。P3 收口成**一个分解器**: conductor 需要研究扇出时
 *   **引用本冻结模板** emit 一个 `executor:'map'` over-lenses 节点,**不现推**结构 → 质量层
 *   (per-lens reduce / M-framing 综合 / K-judge panel / graft)由 researchFanout 保留,不被
 *   塌成一条扁平 map 而丢失(spec 红字「防丢质量」)。
 *
 * 单源纪律: fanout.ts 定**执行**(researchFanout 五阶段管线),本件定**结构描述**(conductor
 * 引用的 author-time 指引)。二者同源不重复 —— 本常量是 author-spec 旧 SYSTEM_PROMPT 里"如何
 * 把 goal 解构成镜头"那段知识的冻结落点,author-spec(第二分解器)随 P3 退役。
 *
 * 字节稳定(冻结前缀语义): 无时间戳 / 无随机 / 无插值 → prompt-cache 友好,跨轮命中。
 * 改本常量语义等价于改分解器行为契约,须连带核对 G11 反幻觉验收。
 */

/** researchFanout 的五阶段(gen → reduce → synth → judge → graft),供 map-over-lenses 引用不现推。 */
export const RESEARCH_LENS_STAGES = [
  'gen: L 镜头 × V 个**不同** sub-angle(非重采样)→ L×V 个并行 leaf,各注 persona + 领域抽象 + groundTruth',
  'reduce: 每镜头 V→1 首席 judge 合成冠军(取最强骨架 + 嫁接各 sub-angle 碎片)',
  'synth: M 个不同 framing 各综合一份完整候选',
  'judge: K 个评判维度 panel(跨维 adversarial,降单 judge 偏见)+ fusion 5-tuple 融合',
  'graft: 终审据 panel + fusion 合成唯一最终方案(显式消解矛盾、补齐盲点)',
] as const;

/**
 * 冻结的五阶段镜头分解结构 —— conductor emit map-over-lenses 时**引用本模板**,不 author-time 现推。
 * 内容 = 「如何把高层研究 goal 解构成一组专家镜头」的单源指引(承 author-spec 旧 SYSTEM_PROMPT)。
 *
 * 用法: conductor 面对"研究/审议 EACH 视角"型工作清单时,emit 一个 `executor:'map'` 节点,其
 * lister 按本模板列出 lenses 数组,per-element template = 一个 per-lens 研究 leaf。四个结构键
 * (lenses / subAngles / synthesisFramings / judgeCriteria)的语义与 ResearchFanoutConfig 对齐
 * (见 fanout.ts),conductor 只填**内容**、不重画**结构**。
 */
export const RESEARCH_LENS_TEMPLATE = [
  '研究扇出的五阶段结构(冻结,引用不现推 —— 保证质量层不丢):',
  ...RESEARCH_LENS_STAGES.map((s, i) => `${i + 1}. ${s}`),
  '',
  '把高层研究 goal + ground-truth 解构成镜头时,填以下四个结构键的**内容**(结构本身不改):',
  '- lenses: 一组**真专家视角**(领域自激活: 会计→注册会计师 / 分布式→系统架构师 / 安全→安全研究员 /',
  '  harness→harness 工程师 / UI→首席设计师 / 业务→战略思考者)。每个 lens:',
  '    · persona: 专家身份条件化(身份 + 领域 + 视角 —— 一行,越锐利搬的概率质量越多)',
  '    · subAngles: 该镜头内 V 个**不同** sub-angle(每 leaf 一个,不重采样、不重复)',
  '    · abstraction(可选): 高阶领域框架注入(如 "Build Systems à la Carte: applicative vs monadic")',
  '- synthesisFramings: M 个不同立场/方法学的综合 framing(供后续综合产出候选)',
  '- judgeCriteria: K 个评判维度(adversarial panel,降单 judge 偏见)',
  '',
  '纪律(为什么这么切): 多样性 > 体积(sub-angle 是不同角度不是重采样,后者边际递减);',
  'persona conditioning 把弱模型从通用区拉进专家区; K-judge panel 治单 judge 系统偏见。',
  '不选模型 —— 模型分配是编排策略,由 config 控制,不归分解器(现推模型名会让 reduce/judge 阶段全失败)。',
].join('\n');
