/**
 * src/harness/dream/promote —— dream SDD §S3 晋升 + prune 阶梯(零 LLM)。
 *
 * 判据(SDD §S3 行 279-300,冻结):
 *
 *   1. **晋升判据两条同时**:
 *      ① `collectIdentityEvidence(ns, identityKey).length >= N_repro`(store.ts:314,
 *         零新表,按证据 id 去重;N_repro=3 是 **schema 强制** 不是拍的 ——
 *         namespace-kernel.ts:34 `agent_confident.source_event_ids.min(3)`,§1.9);
 *      ② 证据来自 ≥ `N_sessions` 个**不同 source**(tentative,§1.9 拍的)—— 防
 *         「同一次会话里被反复说三遍」冒充跨会话复现。
 *      source 判别用 S2 冻结的 anchor 格式(validate.ts dreamFactInput 行 175-178 的反解):
 *      `session:<id>:seq:<n>` 取 `session:<id>`;`run:<id>[:node:<x>]` 取 `run:<id>` ——
 *      解析规则是**具名纯函数** `sourceGroupOf`(本文件),配测试,不散在调用点。
 *
 *   2. **晋升动作**:构造同 identity 的 `agent_confident` fact(`confidence.source_event_ids`
 *      = collectIdentityEvidence 输出,天然 ≥3 满足 schema),经 `writeFact` →
 *      `checkEvolve(existing=tentative)` 判 replace(旧行 tombstone,新行 live,全走既有路)。
 *      写入口 `confidence.level` 类型 = **字面量 `'agent_confident'`**(裁决 10 编译期闸,
 *      照 S2 DreamCandidate 同款模式;human_verified 对 dream 无路可写 —— 判据 1)。
 *
 *   3. **prune**:`OmdMemory.prune()`(store.ts:279)原样调用,计数进报告。
 *      run 大 blob TTL 清理**不做**(归 S6 report 三态列时一起,见 prune 处 TODO)。
 */
import { join } from 'node:path';
import { createOmdMemory, type OmdMemory } from '../memory';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';

// ---------------------------------------------------------------------------
// 阈值(§1.9 总表;N_repro schema 强制,N_sessions tentative)
// ---------------------------------------------------------------------------

/** 晋升所需证据数。**schema 强制**(namespace-kernel.ts:34),不是拍的。 */
export const N_repro = 3;

/** 证据须来自的不同 source(session/run)数下限。tentative(§1.9:拍的)。 */
export const N_sessions = 2;

// ---------------------------------------------------------------------------
// source 判别(具名纯函数,配测试 —— 不散在调用点)
// ---------------------------------------------------------------------------

/**
 * S2 冻结的 anchor 格式(validate.ts `dreamFactInput` 行 175-178)反解回「组」:
 *   `session:<id>:seq:<n>` → `session:<id>`
 *   `run:<id>[:node:<x>]`  → `run:<id>`
 * 解析不出(非 anchor 格式 / 缺段)返回 null —— 无法归属到 session/run,不计入跨
 * source 判据(宁可不晋升,不可拿「同会话反复说」冒充跨会话复现)。
 */
export function sourceGroupOf(eventId: string): string | null {
  const session = /^session:([^:]+):seq:\d+$/.exec(eventId);
  if (session) return `session:${session[1]!}`;
  const run = /^run:([^:]+)(?::node:.+)?$/.exec(eventId);
  if (run) return `run:${run[1]!}`;
  return null;
}

/**
 * 晋升判据(两条同时,SDD §S3 行 279-282):① evidence ≥ N_repro;② 可归属 source
 * 数 ≥ N_sessions。纯函数,零 IO —— 决策与写分离,测试直接喂数组。
 */
export function shouldPromote(evidence: string[]): boolean {
  if (evidence.length < N_repro) return false;
  const sources = new Set<string>();
  for (const id of evidence) {
    const group = sourceGroupOf(id);
    if (group !== null) sources.add(group);
  }
  return sources.size >= N_sessions;
}

// ---------------------------------------------------------------------------
// 晋升写入口(D-1 同款:唯一构造点,校验与写入同一个 fact)
// ---------------------------------------------------------------------------

/** 编译期闸(裁决 10,照 S2 DreamCandidate 同款模式):promote 写入口的 level 是
 *  字面量 `'agent_confident'` —— 联合类型里根本没有 human_verified,dream 无路可写。 */
export interface PromoteConfidence {
  level: 'agent_confident';
  source_event_ids: string[];
  created_at: Date;
}

export type PromoteFactInput = Omit<ValidatedFact, 'confidence'> & {
  confidence: PromoteConfidence;
};

/**
 * 晋升 fact 构造:**同 identity** —— namespace + payload 原样(identity 字段不动,
 * supersession 键不变),confidence 换成 agent_confident(`source_event_ids` =
 * collectIdentityEvidence 输出,天然 ≥3 满足 schema),anchor(source_event_id /
 * source_doc_id)保留原 fact 的 —— 证据全集已在 source_event_ids 里,不必另挑。
 * created_at 由本构造点补(writeFact 不代填,同 S2 dreamFactInput 行 172)。
 */
export function promoteFactInput(
  existing: ValidatedFact,
  evidence: string[],
  now: Date,
): PromoteFactInput {
  const { confidence: _old, ...rest } = existing;
  return {
    ...rest,
    confidence: {
      level: 'agent_confident',
      source_event_ids: evidence,
      created_at: now,
    },
  };
}

// ---------------------------------------------------------------------------
// promote + prune 跑(图序:merge(S2) → promote(S3) → prune(S3),SDD §S3 行 386-387)
// ---------------------------------------------------------------------------

export interface PromoteDreamOpts {
  /** 工作目录(仓根)—— 一切盘路径的锚(本片不碰盘,与 merge 同款签名保持一致)。 */
  cwd: string;
  /** 注入的记忆库(省略=按 cwd 创建 `.omd/memory.db`)。 */
  memory?: OmdMemory;
  /** 可注入时钟:prune 与自信 fact 的 created_at 共用,测试 TTL 边界用。 */
  now?: Date;
}

export interface PromoteReport {
  ok: boolean;
  /** 晋升条数(tentative → agent_confident,以 replace 落库为准)。 */
  promoted: number;
  /** prune() 计数(TTL 过期 tentative tombstone 数)。 */
  pruned: number;
}

export async function promoteDreamFacts(opts: PromoteDreamOpts): Promise<PromoteReport> {
  const now = opts.now ?? new Date();
  const ownMemory = !opts.memory;
  const memory: OmdMemory =
    opts.memory ?? createOmdMemory({ path: join(opts.cwd, '.omd', 'memory.db') });
  try {
    let promoted = 0;
    // 只扫 live tentative —— 已 confident/human_verified 的不在扫描面(不重复晋升)。
    for (const { namespace, identityKey, fact } of memory.liveTentativeFacts()) {
      const evidence = memory.collectIdentityEvidence(namespace, identityKey);
      if (!shouldPromote(evidence)) continue;
      const result = await memory.writeFact(promoteFactInput(fact, evidence, now), {
        scanSecrets: true, // dream 是自动学习路径,非用户主权(同 merge.ts:102)
      });
      // existing=tentative → checkEvolve 恒 replace(evolution-lock.ts:107-113);
      // insert 不可能(evidence≥3 必有历史行)、evolve/reject 不可能。非 replace 按
      // 「未晋升」计 —— 防漂,不静默吞。
      if (result.status === 'written' && result.action === 'replace') promoted++;
    }

    // ── prune:OmdMemory.prune() 原样调用(store.ts:279),计数进报告 ──
    const pruned = memory.prune(now);
    // TODO(S6):run 大 blob TTL 清理 —— 已被 extract 蒸过且 report 已记的 run 大 blob
    // 按 TTL 清、provenance 指针永久留;report 三态列 extracted-then-pruned /
    // never-extracted / not-applicable **分开**(SDD §S3 行 288-291 + 坑 #1;
    // session-store.ts:60 messageCount:0 = 「没数过」是同族先例)。归 report 三态列时一起做。
    return { ok: true, promoted, pruned };
  } finally {
    if (ownMemory) memory.close();
  }
}
