/**
 * src/harness/spin-route —— 空转档 1 路由的**纯函数核心**(SDD「自修环阶梯与空转路由」§4 片 S1)。
 *
 * ## 这条闸买的是什么
 *
 * leaf 在工具环内命中空转口径(同签名重复 ∧ touched 无增长,**沿用现尺不新造**)时,
 * pi 通道注入一次**证据包**(档 1),leaf 原地继续;SDK 通道响亮旁路;每次路由入账可读。
 * 判成/判败为具名判据 —— 不在 prompt 里写散文(I-8 口径)。
 *
 * 本模块只做**片 1 的纯函数**:buildSpinEvidencePack (零 LLM 零 IO 四件套 + 哈希) +
 * judgeRungOutcome (具名判据) + samePack (重复包拒注)。agent-leaf 接线在片 2。
 *
 * ## 方向:四件套缺槽如实,NULL ≠ 编造
 *
 * 判据 diff 这一槽在节点没有 self_check 史时(`failSetBefore === null`)**逐字**写
 * 「本节点无 self_check,无判据可 diff」 —— 静默凑出一个空数组会让 verifier 把
 * 「无证据」当成「证据稳定」放行,2026-08-25 已实测这个形状的假阴性。
 *
 * `packHash` 用 sha256(canonical JSON) —— 同输入同哈希,跨进程跨版本稳定;
 * 同包二次注入被 `samePack` 拒注(I-2 的 S1 化身:重复注入 = 白烧)。
 *
 * ## 与 SELF_CHECK 同款的命名取舍
 *
 * - 判据函数具名(`judgeRungOutcome`)而非塞进 prompt:本仓实测判据在 prompt 里会被
 *   模型自己改语义(2026-08-12),放成函数 = 改不到。
 * - 常数具名(`RUNG_1` / `SPIN_ROUTE_SDK_SKIP_LOG`): prompt 引用与测试断言共用同一份。
 * - 关闭开关走 env(`OMD_SPIN_ROUTE=0`): 与 `OMD_SELF_CHECK` 同模式(对照臂)。
 */
import { createHash } from 'node:crypto';
import { compareCriteriaFailures } from './self-repair-round';

// ── 常数 ──────────────────────────────────────────────────────────────────

/** 档 1 = 单次证据包注入(本切片唯一档位);档 2/3 在 S2/S3,本模块不预声明。 */
export const RUNG_1 = 1;

/** observation 的 kind 名 —— 与 grind/produce-by 同族,沿 leaf→engine 既有观测面。 */
export const SPIN_ROUTE_OBSERVATION_KIND = 'spin-route';

/** 路由事件的 outcome 取值并集(注入面四态:D-5 observation 字段)。 */
export const SPIN_ROUTE_OUTCOMES = ['injected', 'success', 'fail', 'sdk-bypass'] as const;
export type SpinRouteEventOutcome = (typeof SPIN_ROUTE_OUTCOMES)[number];

/** 判据函数返值(成/败二元,不含 'injected' / 'sdk-bypass' 这两个非判定态)。 */
export type SpinJudgeOutcome = 'success' | 'fail';

/**
 * SDK 通道命中空转时打一次的告警文案(I-6 必须有日志,照 SELF_CHECK_SDK_SKIP_LOG
 * 先例)。**档 1 注入面不可用 → 本节点空转将直接走现状熔断**(不在本切片范围,见 §现场)。
 */
export const SPIN_ROUTE_SDK_SKIP_LOG =
  '[agent-leaf] spin-route 档 1 在 SDK 通道不启用 (无注入通道, 与 SELF_CHECK 同边界) —— ' +
  '本节点空转将直接走现状熔断 (fuse-spin / grind 三档阶梯), 证据包不注入。' +
  '重写为 pi 通道或加 SDK 注入面 (SDD 待决 #d) 方可自修档 1。';

/** env `OMD_SPIN_ROUTE=0` ⇒ 整条空转路由关掉(对照臂,INV-3-3 开关模式)。其他值(含未设)= 默认开。 */
export function spinRouteEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMD_SPIN_ROUTE !== '0';
}

// ── 证据包形状 ────────────────────────────────────────────────────────────

/** 档 1 注入面两行 advisor 诊断(行 1 = 病因,行 2 = 下一步)。由调用方给,builder 不调模型。 */
export type AdvisorLines = readonly [string, string];

/**
 * 判据 diff 槽的两种形态 —— 显式判别,NULL ≠ 编造。
 *
 * - `no-history`: 本节点没有 self_check 史,**逐字**这一句(I-7 散文零容忍);
 * - `diff`: 有 self_check 史,数组均排序去重,added = 注入后新红的,removed = 注入后消红的。
 */
export type CriteriaDiff =
  | { kind: 'no-history'; literal: '本节点无 self_check,无判据可 diff' }
  | { kind: 'diff'; added: string[]; removed: string[] };

/** buildSpinEvidencePack 的输入。全部四件套由调用方填,builder 不查 drift/grind 内部态。 */
export interface SpinEvidenceInput {
  /** 败因签名:卡在哪个动作。drift 的 sig 原值,或 grind 的 action 原值。 */
  failSig: string;
  /** drift 的 sameCount / ringSize 原值(无 = undefined,不编 0)。 */
  sameCount?: number;
  /** 注入前的 (fail) 名字集;null = 本节点没有 self_check 史。 */
  failSetBefore: readonly string[] | null;
  /** 注入后的 (fail) 名字集;null = 本节点没有 self_check 史。 */
  failSetNow: readonly string[] | null;
  /** 观察者/看门狗 finding 原句(grind 档位行 / leaf-spin 记账行)。 */
  watchdogFinding: string;
  /** advisor 两行诊断(由 caller 异步拿到,builder 同步封箱)。 */
  advisorLines: AdvisorLines;
}

/** 档 1 注入的证据包 = 四件套 + 内容哈希。`packHash` 由 builder 计算,调用方只读。 */
export interface SpinEvidencePack {
  /** 败因签名原值。 */
  failSig: string;
  /** drift sameCount 原值(undefined = 没填)。 */
  sameCount?: number;
  /** 判据 diff 槽:有史为 diff,无史为字面 NULL。 */
  criteriaDiff: CriteriaDiff;
  /** 看门狗 finding 原句。 */
  watchdogFinding: string;
  /** advisor 两行诊断原值。 */
  advisorLines: AdvisorLines;
  /** sha256(canonical JSON(上述四件套)),同输入同哈希。 */
  packHash: string;
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

/**
 * 内容哈希 = sha256(canonical JSON(4 件套)),**不含** `packHash` 字段本身。
 *
 * canonical 规则:JSON.stringify,key 按字母序排;数组保留次序(added/removed 已排序;
 * advisorLines 两行次序有语义,不重排)。Node 的 `crypto.createHash('sha256')` 输出 hex。
 */
function hashPackPayload(payload: {
  failSig: string;
  sameCount: number | undefined;
  criteriaDiff: CriteriaDiff;
  watchdogFinding: string;
  advisorLines: AdvisorLines;
}): string {
  // 递归稳定序列化:对象按 key 排序,数组保留次序。
  const serialize = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
  };
  return createHash('sha256').update(serialize(payload)).digest('hex');
}

/**
 * 构档 1 证据包。纯函数,零 LLM 零 IO;四件套缺槽如实标注;`packHash` 确定性。
 *
 * 判据 diff 槽:
 * - `failSetBefore !== null && failSetNow !== null` → diff(added/removed 各自排序去重);
 * - 否则 → `no-history` 字面(I-7)。
 */
export function buildSpinEvidencePack(input: SpinEvidenceInput): SpinEvidencePack {
  const criteriaDiff: CriteriaDiff =
    input.failSetBefore !== null && input.failSetNow !== null
      ? {
          kind: 'diff',
          ...compareCriteriaFailures(input.failSetBefore, input.failSetNow),
        }
      : { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' };

  const payload = {
    failSig: input.failSig,
    sameCount: input.sameCount,
    criteriaDiff,
    watchdogFinding: input.watchdogFinding,
    advisorLines: input.advisorLines,
  };
  return {
    failSig: input.failSig,
    sameCount: input.sameCount,
    criteriaDiff,
    watchdogFinding: input.watchdogFinding,
    advisorLines: input.advisorLines,
    packHash: hashPackPayload(payload),
  };
}

/**
 * 重复包判定:两个包的 `packHash` 相同 → true。调用方据此拒注(I-2)。
 * 接收 `{ packHash }` 结构形状而非 `SpinEvidencePack` 是为了 caller 不必先构包
 * 才能对比(传两个字符串 hash 也行,但结构化更不易传错)。
 */
export function samePack(
  prev: { packHash: string },
  next: { packHash: string },
): boolean {
  return prev.packHash === next.packHash;
}

/**
 * 档 1 注入后的成/败判定(具名判据,I-7)。
 *
 * - `success` = touched 增长 **或** failSet 严格缩小;
 * - `fail`    = 两者皆无(再次命中空转口径 → 记 `exhausted-s1`, 后续由 S2 档 2 或
 *              现状熔断处理,本函数不裁决下游)。
 *
 * 当 failSet 一侧缺席(`null`)时,failSet 比较不参与,只看 touched。
 * `touchedNow < touchedBefore` 视为 `fail`(理论上不该发生,但不假设调用方守序)。
 */
export function judgeRungOutcome(input: {
  touchedBefore: number;
  touchedNow: number;
  failSetBefore: readonly string[] | null;
  failSetNow: readonly string[] | null;
}): SpinJudgeOutcome {
  if (input.touchedNow > input.touchedBefore) return 'success';
  // touched 未增长 → 看 failSet 严格缩小
  // S3 (D-3): 集合比对提成 self-repair-round.compareCriteriaFailures, 本片不复刻第二份。
  // 严格缩小:now 是 before 的真子集 —— 既要 removed 非空,又要 added 空(否则没缩小,反而新增了)。
  if (input.failSetBefore !== null && input.failSetNow !== null) {
    const { added, removed } = compareCriteriaFailures(input.failSetBefore, input.failSetNow);
    if (removed.length > 0 && added.length === 0) return 'success';
  }
  return 'fail';
}

/** 路由事件的入账形状(D-5 observation `spin-route` 字段契约)。 */
export interface SpinRouteEvent {
  /** 档位(本切片恒为 1)。 */
  rung: typeof RUNG_1;
  /** 四态 outcome。 */
  outcome: SpinRouteEventOutcome;
  /** 节点 id。 */
  nodeId: string;
  /** 注入包的哈希(旁路时 = '';注入面未构包,见 SDK 旁路用例)。 */
  packHash: string;
}