/**
 * src/harness/skills/skill-miner — 真 LLM episodic miner (Phase 2, 接 skill-proposer 的 proposer 注入点)。
 *
 * 闭合"复利产新能力"环最后一段: 从**已沉淀的程序性记忆**挖掘候选 skill。
 *
 * ── 关键架构决策: 挖 CONSOLIDATED 层, 不再扫 raw runtime_events (compound, 不是 re-scan) ──
 * dream-pump 已把 raw runtime 信号 consolidate 成 `omd.pattern {situation, approach, outcome}`;
 * ConfidenceAdjuster 已把跨 session 复现的 pattern 升 tentative→confident (≥3 source events, ≥2 sessions)。
 * 所以 **outcome='worked' 的 agent_confident omd.pattern = 复现≥3 次且可靠管用的 workflow** —— 正是
 * backlog 要的"重复 workflow"信号, 且复现门槛由已有 confidence 机器免费提供。miner 吃这一层的产物
 * (每环喂下一环), 不重跑聚类/LLM 抽取 raw 事件 (那是 dream-pump 的活, 重做 = 叠加非堆, 违 compound)。
 *
 * ── 不变量 (SKM-INV) ──────────────────────────────────────────────────────────
 *  - SKM-INV-1 (compound source): 只读 consolidated `omd.pattern` fact; 复现由 confidence ladder 门控,
 *    miner 不自己数 raw 事件。
 *  - SKM-INV-2 (recurrence gate): 仅 outcome==='worked' 且 confidence ≥ agent_confident 的 pattern 入选。
 *  - SKM-INV-3 (propose-only / SK-INV D67): miner **永不** 创建/启用 skill。它只 buffer SkillCandidate[];
 *    创建→quarantine 与 quarantine→on-demand 两道**人工确认**不动 (skill-proposer)。LLM 只**起草文案**,
 *    无升级权 (T4 永不作主 — 升级仍要 T2 description_trigger_delta 机械证据)。
 *  - SKM-INV-4 (mined-once): 每个 pattern identity 至多起草一次, 持久 ledger (落 registry.db) 记账,
 *    无论人最终 accept/reject/dismiss。防确认刷屏 + 抗 LLM 跨 session 起名不确定 (名变了 ledger 仍按
 *    pattern identity 去重)。
 *  - SKM-INV-5 (anti-slop cap): 每轮 mine() 至多起草 maxPerRun (默认 1) 个; LLM 还能否决
 *    (verdict 'covered'/'too-thin') —— 否决也记账 (我们看过了, 别再看)。
 *  - SKM-INV-6 (fail-soft / 类 LRN-4): LLM throw 向上传播 (scheduler 兜)。ledger.mark 只在拿到 verdict
 *    后调 → throw 时该 pattern 未记账, 下轮重试 (幂等, 不静默吞掉一个 pattern)。
 *  - SKM-INV-7 (no coverage dup): 起草 prompt 喂现存 skill name+description, LLM 判已覆盖则 'covered';
 *    proposeSkillCandidate 的同名 guard 作 backstop。
 */
import { z } from 'zod';
import { callModel as defaultCallModel, type ModelRequest } from '../../model';
import { resolveRoleModel } from '../../model/role-models';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';
import type { SkillRegistry } from './registry';
import type { SkillCandidate } from './skill-proposer';

/** miner 读的 memory 切面 (只需按 namespace 列 live fact)。 */
export interface MinerMemory {
  liveFactsByNamespace(namespace: string): { id: string; identityKey: string; fact: ValidatedFact }[];
}

/** 一轮 mine() 的审计结果。 */
export interface MineResult {
  /** 资格内 (worked + confident) 的 pattern 总数。 */
  eligible: number;
  /** 资格内且 ledger 未记账 (本轮可考虑) 的数。 */
  fresh: number;
  /** 本轮起草成 candidate 入 buffer 的数。 */
  authored: number;
  /** 本轮 LLM 否决 (covered/too-thin) 的数。 */
  vetoed: number;
}

export type AuthorVerdict = 'propose' | 'covered' | 'too-thin';

/** LLM 起草输出 (structured)。verdict='propose' 时 name+description 必填 (否则降级 too-thin)。 */
const AuthorSchema = z.object({
  verdict: z.enum(['propose', 'covered', 'too-thin']),
  name: z.string().optional(),
  description: z.string().optional(),
  reason: z.string().optional(),
});

const SYSTEM_PROMPT =
  'You are a skill author for an AI coding agent. The agent has learned a procedural pattern that recurred ' +
  'and reliably WORKED across multiple sessions. Decide whether this pattern deserves to become a named, ' +
  'reusable SKILL the agent would deliberately invoke when it next hits a similar situation.\n\n' +
  'A good candidate is a GENERALIZABLE PROCEDURE — a repeatable way of handling a recurring kind of task. ' +
  'Be conservative (most learned patterns are NOT worth a skill).\n' +
  '- verdict "too-thin": one-off, trivial, too situation-specific to generalize, or just restated good ' +
  'judgement with no reusable procedure.\n' +
  '- verdict "covered": an EXISTING skill (listed below) already does this.\n' +
  '- verdict "propose": author a new skill — provide "name" (short kebab-case, e.g. "rebase-cleanup") and ' +
  '"description" (ONE trigger-oriented sentence: WHEN to use it and WHAT it does — this becomes the skill\'s ' +
  'invocation description).\n\n' +
  'Output format (STRICT): reply with ONLY a JSON object, no prose, no code fences:\n' +
  '{ "verdict": "propose|covered|too-thin", "name": "...", "description": "...", "reason": "..." }';

export interface SkillMinerOptions {
  memory: MinerMemory;
  registry: SkillRegistry;
  /** 注入 (测试/换 transport)。默认真 callModel。 */
  callModel?: typeof defaultCallModel;
  /** 'provider:modelId'。默认 resolveRoleModel('dream') AT CALL TIME (起草是轻量抽取, 复用 dream 档便宜模型)。 */
  model?: string;
  /** 每轮起草上限 (SKM-INV-5)。默认 1 (anti-slop 保守)。 */
  maxPerRun?: number;
  /** 起草推理档。默认 'medium' (文案抽取, 不需 high)。 */
  thinkingLevel?: NonNullable<ModelRequest['thinkingLevel']>;
}

/** fact 的 confidence 级 (所有 branch 都有 confidenceField)。 */
function levelOf(fact: ValidatedFact): string {
  return (fact as { confidence: { level: string } }).confidence.level;
}

/** SKM-INV-2: outcome 'worked' + 级别 ≥ agent_confident。 */
function isEligible(fact: ValidatedFact): boolean {
  const f = fact as unknown as Record<string, unknown>;
  if (f.outcome !== 'worked') return false;
  const lvl = levelOf(fact);
  return lvl === 'agent_confident' || lvl === 'human_verified';
}

/** 复现强度代理 (排序选最该升级的): confident=证据数, human_verified=最高。 */
function evidenceCount(fact: ValidatedFact): number {
  if (levelOf(fact) === 'human_verified') return Number.MAX_SAFE_INTEGER;
  const ids = (fact as { confidence: { source_event_ids?: unknown } }).confidence.source_event_ids;
  return Array.isArray(ids) ? ids.length : 0;
}

/** SkillCandidate.source 人读溯源文案。 */
function sourceLine(fact: ValidatedFact): string {
  const f = fact as unknown as Record<string, unknown>;
  return `confident pattern: "${String(f.situation)}" → "${String(f.approach)}" (worked, ${evidenceCount(fact)}× evidence)`;
}

/** kebab 化 LLM 起的名 (防空格/大小写/符号污染 registry name)。 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class SkillMiner {
  private readonly memory: MinerMemory;
  private readonly registry: SkillRegistry;
  private readonly call: typeof defaultCallModel;
  private readonly model: string | undefined;
  private readonly maxPerRun: number;
  private readonly thinkingLevel: NonNullable<ModelRequest['thinkingLevel']>;
  /** buffer: mine() 异步填, takeCandidates() 同步排空 (flywheel proposer 调)。 */
  private buffer: SkillCandidate[] = [];

  constructor(opts: SkillMinerOptions) {
    this.memory = opts.memory;
    this.registry = opts.registry;
    this.call = opts.callModel ?? defaultCallModel;
    this.model = opts.model;
    this.maxPerRun = opts.maxPerRun ?? 1;
    this.thinkingLevel = opts.thinkingLevel ?? 'medium';
    // SKM-INV-4: mined-once ledger 落 registry.db (复用 skill substrate, 零新 db 文件; registry.db 设计为可共享)。
    this.registry.db.run(`
      CREATE TABLE IF NOT EXISTS skill_mined_patterns (
        pattern_key    TEXT PRIMARY KEY,
        verdict        TEXT NOT NULL,
        candidate_name TEXT,
        created_at     INTEGER NOT NULL
      )`);
  }

  /** ledger: 该 pattern identity 是否已起草过 (无论 accept/reject)。 */
  private alreadyMined(patternKey: string): boolean {
    return this.registry.db.query(`SELECT 1 FROM skill_mined_patterns WHERE pattern_key = ?`).get(patternKey) != null;
  }

  private mark(patternKey: string, verdict: AuthorVerdict, candidateName?: string): void {
    this.registry.db.run(
      `INSERT OR IGNORE INTO skill_mined_patterns (pattern_key, verdict, candidate_name, created_at) VALUES (?,?,?,?)`,
      [patternKey, verdict, candidateName ?? null, Math.floor(Date.now())],
    );
  }

  /** 跑一轮挖掘。无资格/无新 pattern → 不调模型 (省 call)。LLM throw 传播 (SKM-INV-6)。 */
  async mine(): Promise<MineResult> {
    const eligible = this.memory.liveFactsByNamespace('omd.pattern').filter((p) => isEligible(p.fact));
    const fresh = eligible.filter((p) => !this.alreadyMined(p.identityKey));
    if (fresh.length === 0) {
      return { eligible: eligible.length, fresh: 0, authored: 0, vetoed: 0 };
    }

    // 先挖复现最强的 (证据最多 = 最该沉淀成 skill)。
    const chosen = fresh
      .sort((a, b) => evidenceCount(b.fact) - evidenceCount(a.fact))
      .slice(0, this.maxPerRun);

    const existing = this.registry
      .listSkills()
      .map((s) => ({ name: s.name, description: s.description }));

    let authored = 0;
    let vetoed = 0;
    for (const p of chosen) {
      const decision = await this.author(p.fact, existing); // throw → 未 mark, 下轮重试 (SKM-INV-6)
      if (decision.verdict === 'propose' && decision.name && decision.description) {
        const name = slugify(decision.name);
        if (name) {
          this.mark(p.identityKey, 'propose', name);
          this.buffer.push({ name, description: decision.description.trim(), source: sourceLine(p.fact) });
          authored++;
          continue;
        }
      }
      // propose 缺字段/名空 → 当 too-thin 记账 (防御); covered/too-thin 同样记账。
      const verdict: AuthorVerdict = decision.verdict === 'covered' ? 'covered' : 'too-thin';
      this.mark(p.identityKey, verdict, undefined);
      vetoed++;
    }

    return { eligible: eligible.length, fresh: fresh.length, authored, vetoed };
  }

  /** flywheel proposer: 同步排空 buffer (一次取走已起草的 candidate)。 */
  takeCandidates(): SkillCandidate[] {
    if (this.buffer.length === 0) return [];
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /** LLM 起草一条 (structured)。callModel 只在 schema 命中才返 → parsed 已过 AuthorSchema。 */
  private async author(
    fact: ValidatedFact,
    existing: { name: string; description: string }[],
  ): Promise<z.infer<typeof AuthorSchema>> {
    const f = fact as unknown as Record<string, unknown>;
    const skillList =
      existing.length === 0
        ? '(none)'
        : existing.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
    const req: ModelRequest = {
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nExisting skills:\n${skillList}` },
        {
          role: 'user',
          content: `Learned pattern (recurred across sessions, outcome=worked):\n- situation: ${String(f.situation)}\n- approach: ${String(f.approach)}`,
        },
      ],
      model: this.model ?? resolveRoleModel('dream'),
      thinkingLevel: this.thinkingLevel,
      responseSchema: AuthorSchema,
    };
    const res = await this.call(req);
    return AuthorSchema.parse(res.parsed);
  }
}

/** factory (对齐 createDreamPump / createEventStore 约定)。 */
export function createSkillMiner(opts: SkillMinerOptions): SkillMiner {
  return new SkillMiner(opts);
}
