/**
 * src/harness/lead/coverage —— 原语覆盖三分法(P3 契约 D-23,2026-09-02)。
 *
 * `PRIMITIVE_IDS`(`primitive-registry.ts`)实测恰 13 个;七张卡不可能字面覆盖全部。
 * 上一版契约草案把覆盖测试写成「并集 = 全集减去显式排除项」,而排除表无界 ——
 * worker 唯一的通过路径就是把够不着的也写进排除表,测试当场退化成恒真式
 * (仓规:一条永远绿的闸不是闸)。这里改成**三张表两两不相交、并集恰为全集**的
 * 字面量三分法,`PRIMITIVE_EXCLUDED` 与契约 D-23 逐元素相等 —— 改它 = 改契约,
 * 必须回流,不许在这个文件里就地加宽。
 */
import type { LeadToolName } from './types';

/**
 * 被某张卡直接覆盖的原语:卡的 compile() 产物在语义上顶替了这个原语要解决的问题
 * (即便实现手法不同,如 spawn 编译到 N 个 DAG 兄弟而不是单个 `kind:'primitive'` 节点)。
 * D-23 字面量:5 项。
 */
export const CARD_COVERED: Readonly<Record<string, LeadToolName>> = {
  parallel: 'spawn',
  discovery: 'explore',
  judge: 'best_of',
  tournament: 'best_of',
  escalation: 'decompose',
};

/**
 * 由编译器(而非某张卡)直接消费的原语:循环本体与收尾节点,属于
 * `compileOrchestratingLoop`(S6b)的内部机制,不是 lead 模型能点的卡。D-23 字面量:2 项。
 */
export const COMPILER_COVERED: readonly string[] = ['loop-until', 'verify'];

/**
 * 今天没有卡、也没有编译器消费点的原语 —— 每一项都要有一行「为什么不做卡」
 * (D-23 决策正文 + 契约 Open 段逐条给了理由,这里原样落地,不是拍脑袋排除)。
 */
export const PRIMITIVE_EXCLUDED: readonly string[] = [
  // 编译器用串边(depends_on 链)替代 pipeline 原语的语义,不需要模型点一个 pipeline 卡。
  'pipeline',
  // "重跑直到收敛"由外层 fixpoint / 循环本体覆盖,不需要单独一张卡再造一遍。
  'iterate',
  // 今天没有用例撑起一张 router 卡(不是结构上不需要,是还没有需求逼出接口形状)。
  'router',
  // 今天没有用例撑起一张 race 卡;best_of 的 mode:'first-green' 已经覆盖了「抢第一个绿」的需求。
  'race',
  // 今天没有用例撑起一张 saga 卡(补偿回滚属维二红线场景,还没有 lead 层需求)。
  'saga',
  // 逃生舱默认关(gated),Router 永不自动选 —— 给它一张常驻卡等于把默认关的口子摆到台面上。
  'escape-hatch',
];
