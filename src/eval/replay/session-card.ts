/**
 * src/eval/replay/session-card —— 夜链「研究卡」的形状 + 校卡闸 (契约切片 1)。
 *
 * 承 `docs/plan/2026-09-02-夜间自迭代链-执行契约.md`:
 *  - D-2 提案节点 (LLM) 写 `cards.raw.json`, **它是不可信输入**;
 *  - D-3 校卡机械 = zod schema + 六道语义闸; 全剔 → 空 accepted 并退 0 (**无可跑卡不是失败**);
 *  - D-9 S3 写集与排除表无交, 排除表取 `night-excluded.ts` 单一真源。
 *
 * ## 为什么闸写在这里而不是提示里
 *
 * 提案席是 M3。「每夜最多 3 卡」「主目标只能是 fitness 五维」这类约束写进 prompt 拦不住 ——
 * 本仓实测结论。于是它们全部是这里的 if: 违规卡进 `rejected[]` 带 reason, 不进 `accepted[]`。
 *
 * ## 闸的顺序是判据不是风格
 *
 * 先判**这张卡自己**说错了什么 (基质 / 主目标 / schema / 预算 / 写集 / 证据), 最后才判
 * **它排第几** (maxCards)。反过来的话, 一批坏卡会全被 maxCards 吃掉, 而真正的毛病看不见。
 * maxCards 数的是 `accepted.length` 而不是入参下标 —— 前面的卡被剔掉时, 后面的卡应当补位。
 *
 * ## 反向自检 (session-card.test.ts)
 *
 * 六道闸各配一份「已知违规样本」, 摘掉任一道 → 对应用例当场由绿转红。证伪方式写在 test 注释里。
 */
import { z } from 'zod';
import { touchesExcluded } from './night-excluded';

export const SESSION_CARD_VERSION = 1;

/** 研究基质: 只剩 S3 = 代码改动走 solve。S1/S2 (提示面 / 图式进化 session) 随 v1 规划式 conductor 于 2026-09-04 退役 —— 它们变异的是已删的 prompt。 */
export type Substrate = 'S3';

/** 主目标只能落在 AggregatedFitness 的这五维上 (objective.md §目标 的可机械读那部分)。 */
export type FitnessField =
  | 'planValidityRate'
  | 'fakeSerialPairsTotal'
  | 'speedupTheoreticalMedian'
  | 'shapeDeclarationRate'
  | 'planningTokensTotal';

/** 五维词表的运行时副本 (类型层管不到不可信 JSON, 闸要拿它逐字比)。 */
export const FITNESS_FIELDS: readonly FitnessField[] = [
  'planValidityRate',
  'fakeSerialPairsTotal',
  'speedupTheoreticalMedian',
  'shapeDeclarationRate',
  'planningTokensTotal',
];

/** objective.md 的目标行编号 (晨报按行归位, 不靠猜)。 */
export type ObjectiveRow = 'O1' | 'O2' | 'O3a' | 'O3b' | 'O3c';

interface SessionCardBase {
  version: 1;
  id: string;
  substrate: Substrate;
  mainObjective: FitnessField;
  objectiveRow: ObjectiveRow;
  hypothesis: string;
  /** 必须解析到 candidates.items[].id —— 没有矿源的假设是凭空编的。 */
  evidenceRefs: string[];
  /** 预声明的成败信号 (四要素之二); 晨报原样回显, **事后不许改**。 */
  successSignal: string;
  /** 预声明的作废条件; 同上。 */
  voidConditions: string[];
  budgetMinutes: number;
}

export interface CodeCard extends SessionCardBase {
  substrate: 'S3';
  goal: string;
  writeSet: string[];
  verify: string;
}

export type SessionCard = CodeCard;

// ── schema (结构兜底; 语义判在下面的显式闸, 不靠 zod 的错误文本) ──────────────

const baseShape = {
  version: z.literal(1),
  id: z.string().min(1),
  mainObjective: z.enum([
    'planValidityRate',
    'fakeSerialPairsTotal',
    'speedupTheoreticalMedian',
    'shapeDeclarationRate',
    'planningTokensTotal',
  ]),
  objectiveRow: z.enum(['O1', 'O2', 'O3a', 'O3b', 'O3c']),
  hypothesis: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  successSignal: z.string().min(1),
  voidConditions: z.array(z.string().min(1)),
  budgetMinutes: z.number().int().positive(),
};

const S3Schema = z.object({
  ...baseShape,
  substrate: z.literal('S3'),
  goal: z.string().min(1),
  writeSet: z.array(z.string().min(1)).min(1),
  verify: z.string().min(1),
});

/** 只剩 S3 一支 (2026-09-04)。 */
export const SessionCardSchema: z.ZodType<SessionCard> = S3Schema as unknown as z.ZodType<SessionCard>;

// ── 校卡闸 ────────────────────────────────────────────────────────────────

export interface CardGateCaps {
  maxCards: number;
  nightBudgetMinutes: number;
  sessionBudgetMinutes: number;
}

export interface CardGateResult {
  accepted: SessionCard[];
  rejected: { card: unknown; reason: string }[];
}

/**
 * gateCards 对 candidates 只用到 id 集合。
 *
 * ✎ 契约冻结接口写的是 `candidates: Candidates`, 而 `Candidates` 声明在
 * `scripts/autoresearch-mine.ts` (切片 2)。收那个具体类型会让 `src/` 反向依赖 `scripts/`,
 * 并且把本切片 (契约里依赖列 = 「—」) 拴死在切片 2 上。取结构最小面, `Candidates` 天然可赋。
 */
export interface CandidateIdSource {
  items: readonly { id: string }[];
}

/** 不可信输入归一成数组: 裸数组 / `{cards:[…]}` 两种写法都收; 其余 → null (整份拒)。 */
function normalizeRawCards(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { cards?: unknown }).cards)) {
    return (raw as { cards: unknown[] }).cards;
  }
  return null;
}

/** 读不可信对象的一个字段 (不 throw —— 判定归闸, 不归解构)。 */
function field(card: unknown, key: string): unknown {
  return card && typeof card === 'object' ? (card as Record<string, unknown>)[key] : undefined;
}

/** zod 的 issue 压成一行 (带 path, 让人知道是哪个字段)。 */
function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join(' · ');
}

/**
 * 校卡: 不可信 `cards.raw.json` → 可跑卡 + 逐条拒因。**永不抛**, 永不部分写。
 *
 * 六道闸 (契约 D-3 / INV-2), reason 各含一个稳定关键词供测试与晨报抓:
 *   `substrate` · `mainObjective` · `budget` · `excluded` · `evidenceRefs` · `maxCards`
 */
export function gateCards(
  raw: unknown,
  candidates: CandidateIdSource,
  caps: CardGateCaps,
): CardGateResult {
  const list = normalizeRawCards(raw);
  if (list === null) {
    return {
      accepted: [],
      rejected: [{ card: raw, reason: 'cards.raw.json 不是数组也不是 {cards:[…]} —— 整份拒' }],
    };
  }

  const knownIds = new Set(candidates.items.map((i) => i.id));
  const accepted: SessionCard[] = [];
  const rejected: { card: unknown; reason: string }[] = [];
  let budgetUsed = 0;

  for (const card of list) {
    // ① 单基质: 判别键必须逐字是 'S3' (数组 / 'S1' / 缺席全拒; S1/S2 已随 v1 退役)。
    const substrate = field(card, 'substrate');
    if (substrate !== 'S3') {
      rejected.push({
        card,
        reason: `substrate 非法: ${JSON.stringify(substrate)} —— 一张卡只跑一个基质, 今天只有 S3 (S1/S2 已退役)`,
      });
      continue;
    }

    // ② 主目标 ∈ fitness 五维 (词表外 = 没有尺可量, 这张卡的读数事后无法归位)。
    const main = field(card, 'mainObjective');
    if (typeof main !== 'string' || !FITNESS_FIELDS.includes(main as FitnessField)) {
      rejected.push({
        card,
        reason: `mainObjective 不在 fitness 五维: ${JSON.stringify(main)} —— 合法值 ${FITNESS_FIELDS.join(' | ')}`,
      });
      continue;
    }

    // ③ 结构兜底 (前两道判过判别键与主目标, 剩下的字段值域交给 schema)。
    const parsed = SessionCardSchema.safeParse(card);
    if (!parsed.success) {
      rejected.push({ card, reason: `schema 拒: ${formatIssues(parsed.error)}` });
      continue;
    }
    const c = parsed.data;

    // ④ 预算帽 (单卡帽 + 夜帽; 两条都要判 —— 一张 8h 的卡与三张 3h 的卡是两种超法)。
    if (c.budgetMinutes > caps.sessionBudgetMinutes) {
      rejected.push({
        card,
        reason: `budget 超单卡帽: ${c.budgetMinutes} > ${caps.sessionBudgetMinutes} 分钟`,
      });
      continue;
    }
    if (budgetUsed + c.budgetMinutes > caps.nightBudgetMinutes) {
      rejected.push({
        card,
        reason:
          `budget 超夜帽: 已收 ${budgetUsed} + 本卡 ${c.budgetMinutes} > ${caps.nightBudgetMinutes} 分钟`,
      });
      continue;
    }

    // ⑤ S3 写集与排除表无交 (夜链不许改尺子; D-9)。
    if (c.substrate === 'S3') {
      const hits = touchesExcluded(c.writeSet);
      if (hits.length > 0) {
        rejected.push({
          card,
          reason: `writeSet 命中 excluded 排除表: ${hits.join(', ')} —— 尺子不进夜链写集`,
        });
        continue;
      }
    }

    // ⑥ evidenceRefs 可解析到 candidates.items[].id (凭空编的假设没有矿源)。
    const dangling = c.evidenceRefs.filter((r) => !knownIds.has(r));
    if (dangling.length > 0) {
      rejected.push({
        card,
        reason: `evidenceRefs 指向不存在的 candidate id: ${dangling.join(', ')}`,
      });
      continue;
    }

    // ⑦ 每夜 ≤ maxCards —— 数 accepted 不数下标, 前面被剔的卡让后面的补位。
    if (accepted.length >= caps.maxCards) {
      rejected.push({ card, reason: `maxCards 超额: 每夜最多 ${caps.maxCards} 卡` });
      continue;
    }

    accepted.push(c);
    budgetUsed += c.budgetMinutes;
  }

  return { accepted, rejected };
}
