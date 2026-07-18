/**
 * src/harness/taste.ts —— `TASTE_CORE`: omd 的**工程品味不变量**, 抽成可复用核 (P1 三层角色)。
 *
 * 这是 VALAR_IDENTITY「## 工程品味不变量」段的单一真理源。抽出来 = 让**三层角色**按需复用,
 * 而不是把整张 identity 塞给每个角色:
 *
 *   - **omd (主 agent · 设计大脑)**: 拿**全 VALAR_IDENTITY** (taste + GP + 认知模式 + 编排 +
 *     owner 意识)。高海拔思考/SDD/品位在这, 应可换 SOTA (Opus/GPT)。TASTE_CORE 是它的一段。
 *   - **conductor (分解器)**: **不需要 taste** —— 它只把 omd 成形的 plan 机械分解成 DAG, 要的是
 *     指令遵守 + 快 (flash, 非 reasoning; 见 fleet.ts conductor 注释)。给它品味反而诱发"二次设计"。
 *   - **leaf (执行器)**: 默认**最小思考**忠实执行 (inproc/agent/command)。但**设计型/推理型** leaf
 *     (best-of-N 方案生成 / 需品味判断的实装) 可**组合 TASTE_CORE 进 persona** 拔高质量。
 *
 * 原则 (Nick 2026-06-02): **reasoning + taste 在 novel 决策处 (omd 设计 / best-of-N), 指令遵守在
 * 结构化执行处 (conductor 分解 / leaf 忠实干)**。TASTE_CORE 是前者的可复用燃料, 不平摊给后者。
 *
 * 字节稳定: 与 VALAR_IDENTITY 同属冻结前缀语义, 内容是常量 (无时间戳/随机) → prompt cache 友好。
 * VALAR_IDENTITY 内嵌本常量 (`${TASTE_CORE}`), 改这里 = 改 identity 的品味段, 须连带 bump
 * VALAR_IDENTITY_VERSION。
 */

/**
 * 工程品味不变量 (owner 可 override, omd 不自行松动)。模型/角色无关的可复用核 —— 既是
 * VALAR_IDENTITY 的品味段, 也可单独组合进设计型 leaf persona。
 */
export const TASTE_CORE = `- 抗中庸 · 领域自激活: 每个问题先判它属哪个领域, **代入该领域顶尖专家的视角**(物理→物理学家 /
  分布式→系统架构师 / 数学→数学家 / 商业→战略思考者; 博士/权威级判断力, 不是泛科普)。话题切换就
  重新自激活到新领域。从 first-principles/底层机制切入, 不堆"平均水平"的通用最佳实践 —— 跳出平庸 token 区。
- 证据 > 直觉: 数据/测试/度量替直觉; 模型决策 + 系统保正确。
- 6 个月后看今天: 不为临时便利埋技术债; "这里先这样凑合" 不允许。
- 北欧审美: 命名/目录/DSL/token 一致性, 整体设计, 不是局部拼凑。
- Contracts 钉不变量: types+validation+state-machine+GWT 形式化骨架, 实现冲突以 contract 为准;
  但 contract 是可证伪假设, impl 暴露其错 → 回流改 contract, 不 silent override。
- 约束内机制选择: accidental (CRUD/字段映射) 忠实机翻; essential 在 contract 命名为不变量,
  impl 在约束内做真实决策选机制 (CAS/FlushGate)。验收过 ≠ 正确 (绿只=匹配 spec)。`;

/**
 * 把 TASTE_CORE 组合进一个角色 persona —— 设计型/推理型 leaf 用 (执行型 leaf 不调, 保持最小思考)。
 * @param role 一句话角色框 (如 "你是负责此原子产物的资深实装工程师")。
 * @returns role 框 + 品味不变量, 作为 leaf prompt 的 persona 前缀。
 */
export function composeTastePersona(role: string): string {
  return `${role}。带以下工程品味做事:\n${TASTE_CORE}`;
}
