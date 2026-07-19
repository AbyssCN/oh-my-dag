/**
 * design-vocab — 深模块设计共享词汇 (单一真相源)。
 *
 * dag-deepen(找该加深什么) 与 dag-slim(找该删什么) 的 prompt 共用这套词汇, 不许漂移成
 * component/service/API/boundary。词汇学自 mattpocock/skills codebase-design (本质出处:
 * Ousterhout《软件设计的哲学》+ Feathers 的 seam)。"引导词"哲学: 用模型预训练已懂的精确
 * 概念激活行为, 省解释、更可预测。skills/codebase-design/SKILL.md 是同一内容的人读版。
 */

/** 注入 reviewer/scanner prompt 的词汇表 (英文术语保持原词, 解释走中文)。 */
export const DESIGN_VOCAB = `<design-vocab authority="single-source: 与 skills/codebase-design 同步">
用且只用这些术语 (禁用 component/service/API/boundary — 一致的语言就是重点):

- **module**: 任何"接口+实现"之物, 刻意尺度无关 (函数/类/包/跨层切片)。
- **interface**: 调用方正确使用所需知道的一切 — 类型签名之外还含不变量/顺序约束/错误模式/
  必需配置/性能特征。
- **implementation**: 模块内部的代码体。
- **depth**: 接口处的杠杆 — 调用方每学一单位接口能撬动多少行为。
  **deep** = 小接口藏大行为; **shallow** = 接口几乎和实现一样复杂 (避免)。
- **seam** (Feathers): 不改某处代码即可改变该处行为的位置 = 接口所在之处。seam 放哪是独立
  设计决策。
- **adapter**: 在某 seam 处满足某接口的具体物 — 描述角色非内容。
  一个 adapter = 假想 seam, 两个 = 真 seam。
- **leverage**: depth 给调用方的回报 — 一份实现在 N 个调用点 + M 个测试里反复还本。
- **locality**: depth 给维护者的回报 — 改动/bug/知识/验证集中一处; 修一次, 处处修好。

判定法:
- **删除测试 (deletion test)**: 假设删掉此模块、逻辑摊回调用方 — 整体复杂度暴涨 = 它真吸收了
  复杂度 (deep); 几乎不变 = 复杂度没被吸收 (shallow, 或纯属废话该删)。
- **接口即测试面**: 测不动的接口就是设计坏味; 深模块经其小接口即可测穿大行为。
</design-vocab>`;

/** ponytail 全局纪律 (bluebell v2 改良): dag-slim 的 prompt 注入块。 */
export const PONYTAIL_DISCIPLINE = `<ponytail-discipline version="v2 (全局>局部)">
lazy = 高效不 = 敷衍。最好的代码是没写的代码 — 但**最小化的是系统, 不是代码片**:

- **复用 > 本地最小**: 已有 module/helper/依赖优先; 第 5 份"最小"手写副本 = 全局膨胀。
- **守契约**: 只见一角时永不重定结构 — 在既定 interface/types/seams 之内做最小实现。
- **已规划 ≠ 投机**: 文档化的 DEFER、契约面、刻意的扩展 seam 是选定的架构 — 保留。
  YAGNI 砍的是"没人要过的", 不砍"计划好的"。
- **少行数, 不少 case**: 为显小而丢边界 case/类型/校验/错误路径 = bug, 不是简化。
- 🔴 **全局删除 (整模块/合并平行实现/去层) 才是真赢** — 但需全系统视野, 属全局审查遍,
  单点编辑只做受约束的局部遍。
</ponytail-discipline>`;
