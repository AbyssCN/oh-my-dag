/**
 * src/memory/safeguards/continuity-namespace —— session 交接快照的 namespace pack (#206)。
 *
 * ## 它补的是哪一格
 *
 * `harness/session/sink.ts` 早就会 `writeFact({ namespace:'continuity', … })`,而
 * `UNIVERSAL_SAFEGUARD` 的 allowedNamespaces 里**没有 continuity** —— 记忆层是 REJECT-by-default,
 * 于是每一次镜像写入都被闸掉,而 sink 全程 fail-open 只回 `{ok:false}`。症状:代码在、调用在、
 * `facts` 表里 continuity 一行都没有。这个 pack 就是那格缺失的注册。
 *
 * ## 为什么单开一个 pack 而不是塞进 UNIVERSAL
 *
 * universal pack 的设计律写着「克制的 facet 类型 → 覆盖广而不堆 namespace("太多数据"是失败模式,
 * the owner 锁)」,它面向的是**每一个 omd instance 都该自带**的东西:记住用户、记住自己。
 * session 交接快照不是那类记忆,它是 omd 自己的一条**机制**的镜像层 —— 按 kernel 注释给的扩展缝
 * (「a sibling project 行为需调用边界显式注入」),由**调用边界**装配进去,而不是塞进通用底座。
 *
 * ## 为什么 fact 里**不存** md 全文
 *
 * ① `CheckpointRow` / `rowOf` 一个字段都不读它 —— 零消费者的东西不建;
 * ② markdown 文件本身就是真源,且 `checkpointPath` 已经把地址存下来了,再存一份就是**副本**,
 *    而这张地图的判据之一正是「有会自己更新的载体就别存副本」(DSH 附论②);
 * ③ `factToText` 把每个声明字段都拼进 embedding 与 FTS 文本 —— 几 KB 的 markdown 灌进去会把
 *    intent/next 那点真正的召回信号淹掉。
 *
 * 于是 `md` **不声明**在 schema 里;`CheckpointSinkInput.md` 仍然收(调用方从它切 §1/§2),
 * 但不往 `writeFact` 传 —— Zod 会静默剥掉未声明键,让"传了但没落"变成一个看不见的洞。
 *
 * @module
 */
import { z } from 'zod';
import {
  sourceAnchor,
  confidenceField,
  assembleSafeguard,
  type NamespacePack,
  type AssembledSafeguard,
} from './namespace-kernel';

/** checkpoint 的三种触发时机(与 `harness/session/writer` 的 `WriterMode` 同值域)。 */
export const CONTINUITY_MODES = ['rolling', 'final', 'precompact'] as const;

const CONTINUITY_BRANCHES = [
  z.object({
    namespace: z.literal('continuity'),
    /**
     * sessionId。字段名叫 `id` 是**既有写入侧的形状**(`sink.ts` 传 `id: input.sessionId`,
     * `rowOf` 读 `fact.id`),这里逐字对齐而不是趁机改名 —— 改名要同时动写入侧与读回侧,
     * 属另一张票的活。
     */
    id: z.string().min(1),
    mode: z.enum(CONTINUITY_MODES),
    /** §1 摘要 —— 语义召回主要就靠它。 */
    intent: z.string().min(1).optional(),
    /** §2 下一步。 */
    next: z.string().min(1).optional(),
    /**
     * checkpoint 当时的 ctx 真值。**可为 null**:「没量到」与「量到 0」不是一回事,
     * 塌成同一个值就永远分不开了(本仓坑① NULL≠0)。
     */
    ctxTokens: z.number().nullable().optional(),
    /** 机械降级版标记(蒸馏失败时 md 以 `<!-- DEGRADED` 开头)。 */
    degraded: z.boolean().optional(),
    /** checkpoint.md 绝对路径 —— **resume 真源的指针**,不是它的副本。 */
    checkpointPath: z.string().min(1).optional(),
    ...sourceAnchor,
    ...confidenceField,
  }),
];

/**
 * supersede 身份 = sessionId 单键:**同一个 session 反复写 = 演化更新一行**,
 * 而不是每次 checkpoint 堆一条新的(rolling 模式一个 session 能写几十次)。
 */
export const CONTINUITY_NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  continuity: ['id'],
};

export const CONTINUITY_NAMESPACE_PACK: NamespacePack = {
  branches: CONTINUITY_BRANCHES,
  allowedNamespaces: ['continuity'],
  identityFields: CONTINUITY_NAMESPACE_IDENTITY_FIELDS,
  banGlobs: [],
};

/**
 * session 交接写入侧专用装配(**只有** continuity)。
 *
 * 刻意不并 user / omd 两族:这个 memory 实例只服务 `sinkCheckpoint` 一个写手,多给一格
 * allowedNamespaces 就是多一格没人要的写入面。读回侧(`listCheckpoints` / recall)走的是
 * 库,不走这个闸。
 */
export const CONTINUITY_SAFEGUARD: AssembledSafeguard = assembleSafeguard([CONTINUITY_NAMESPACE_PACK]);
