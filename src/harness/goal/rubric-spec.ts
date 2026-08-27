/**
 * goal/rubric-spec —— rubric 验收分型的**形状与整体裁决**(F2 片 1)。
 *
 * 契约:`docs/plan/2026-08-27-F2-rubric验收分型-执行契约.md` §INV-1 · §INV-2 · §INV-3。
 *
 * ## 它在阶梯的哪一格
 *
 * 无 oracle 验收阶梯:①客观壳硬闸 → ②比较级替代达标级(best-of-N + 跨族 judge)→
 * **③本条(rubric 逐条判)** → ④抽检校准 → ⑤外部 bench 对表。
 * 本模块只管第 ③ 格的**形状**与**整体裁决**;「谁来判每一条」在别处(跨族模型),
 * 「这份 rubric 虚不虚」在 `acceptance-gate` 那一侧的判别力探针(片 2)。
 *
 * ## 三条不许妥协的
 *
 * 1. **逐条痕迹不许被压成总分。** 「3 条里挂了哪一条」正是重规划要用的定位信息;
 *    压成 `2/3` 之后它就没了,事后再也分不回来(仓规坑 ①)。所以 {@link settleRubric}
 *    的返回值里 `traces` 永远是完整的一份,`pass` 只是它的派生量。
 * 2. **checklist 先于产物冻结。** rubric 唯一的可信来源就是「写它的时候还不知道产物长什么样」。
 *    {@link verifyFrozen} 判漂时是**当场拒且调用方不得进入逐条判定** —— 不是记一条警告然后照判。
 * 3. **「几条不过算不过」是注入值。** SDD 未决第 1 条仍开,本文件里不出现任何 owner 未裁的数;
 *    `maxFailures` 必填,连缺省都不给 —— 给了缺省就等于替 owner 裁了。
 *
 * ## 零 IO
 *
 * 全模块不读盘、不发网、不打日志。`createHash` 是纯计算不是 IO。
 * 这条由契约 §INV-2 的第一条 GWT 机械盯着。
 *
 * @module
 */
import { createHash } from 'node:crypto';

/** checklist 的一条 —— 一个稳定 id + 一句可判 yes/no 的要求。 */
export interface RubricItem {
  /** 稳定 id:逐条痕迹靠它回指,所以它必须跨轮不变、且在一份 rubric 内唯一。 */
  readonly id: string;
  /** 一句可判 yes/no 的要求。判不了 yes/no 的句子属于写 rubric 那一步的问题,本模块不管。 */
  readonly requirement: string;
}

/** 冻结后的 rubric —— 条目 + 内容哈希。哈希是「先于产物」这条纪律的机械落点。 */
export interface RubricSpec {
  readonly items: readonly RubricItem[];
  readonly contentHash: string;
}

/** 逐条判词 —— id、yes/no、理由三格。**理由不许空**:没理由的 yes/no 是投票不是判词。 */
export interface RubricItemTrace {
  readonly itemId: string;
  readonly pass: boolean;
  readonly reason: string;
}

/** 冻结校验的结果。判别联合而非 `ok + reason?` —— 后者会长成又一个空旋钮。 */
export type FrozenCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** 今天只有一格;留成联合是为了以后加「条目数变了」这类细分时不改调用方签名。 */
      readonly reason: 'content-drifted';
      /** 点名漂在哪 —— 给人读的,也给重规划定位用。 */
      readonly detail: string;
    };

/** 整体裁决。`traces` 恒为完整一份(INV-2);`pass` 与 `failedIds` 都是它的派生量。 */
export interface RubricVerdict {
  readonly pass: boolean;
  readonly traces: readonly RubricItemTrace[];
  /** 没过的条目 id,按 `traces` 原序。全过时为空数组 —— 空数组不是「没判」,那一格由抛错拦住。 */
  readonly failedIds: readonly string[];
}

/** 整体裁决的注入参数。`maxFailures` **必填无缺省** —— 缺省即替 owner 裁(未决第 1 条)。 */
export interface SettleOptions {
  /** 允许几条不过仍算整体通过。0 = 全过才算过。 */
  readonly maxFailures: number;
}

/**
 * 把一组条目冻成一份 rubric。
 *
 * 哈希口径:按**原序**把 `id` 与 `requirement` 用不可能出现在正文里的分隔符拼起来再取 sha256。
 * 不排序 —— 条目顺序本身是 rubric 的一部分(读的人按这个顺序判),换序就该算另一份。
 */
export function freezeRubric(items: readonly RubricItem[]): RubricSpec {
  if (items.length === 0) throw new Error('freezeRubric: 一份 rubric 至少要有 1 个条目');
  const seen = new Set<string>();
  for (const it of items) {
    if (it.id.length === 0) throw new Error('freezeRubric: 条目 id 不许为空串');
    if (seen.has(it.id)) throw new Error(`freezeRubric: 条目 id 重复 — ${it.id}`);
    seen.add(it.id);
  }
  return { items: Object.freeze([...items]), contentHash: hashItems(items) };
}

/**
 * 验收期比对:呈上来的这份条目与冻结时那份是不是逐字节相同。
 *
 * ⚠ 判漂时调用方**不得**继续逐条判定(INV-3)。这个函数只负责说「漂了」;
 * 「漂了就不判」的责任在调用方,由片 4 的接线测试盯住。
 */
export function verifyFrozen(spec: RubricSpec, presented: readonly RubricItem[]): FrozenCheck {
  if (hashItems(presented) === spec.contentHash) return { ok: true };
  return { ok: false, reason: 'content-drifted', detail: describeDrift(spec.items, presented) };
}

/**
 * 由逐条痕迹取整体裁决。
 *
 * **不做任何压缩** —— `traces` 原样带走。想知道「几条过了」的调用方自己去数,
 * 本函数不提供那个数字,免得它变成默认读法而逐条那一列没人看(INV-2)。
 */
export function settleRubric(
  traces: readonly RubricItemTrace[],
  opts: SettleOptions,
): RubricVerdict {
  if (traces.length === 0) throw new Error('settleRubric: 至少要有 1 条逐条痕迹 — 零痕迹不许判成通过');
  if (!Number.isInteger(opts.maxFailures) || opts.maxFailures < 0) {
    throw new Error(`settleRubric: maxFailures 必须是非负整数, 收到 ${opts.maxFailures}`);
  }
  for (const t of traces) {
    if (t.reason.length === 0) throw new Error(`settleRubric: 条目 ${t.itemId} 的判词没有理由 — 没理由的 yes/no 是投票不是判词`);
  }
  const failedIds = traces.filter((t) => !t.pass).map((t) => t.itemId);
  return {
    pass: failedIds.length <= opts.maxFailures,
    traces: Object.freeze([...traces]),
    failedIds: Object.freeze(failedIds),
  };
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

/**
 * 分隔符用控制字符 —— 正文里不可能出现,免得「a|b」与「a」「b」撞哈希。
 *
 * ⚠ **写成转义序列,不许把裸控制字符打进源码。** 2026-08-28 实测:第一版直接键入 0x00,
 * 被「源码裸 NUL 字节 (0x00) 绊线」当场抓住 —— 裸 NUL 会让一批工具把整个文件当二进制,
 * ugrep 直接报 Binary file … matches、不给行号,而那正是本仓搜代码的主力。
 */
const SEP = '\u0000';

function hashItems(items: readonly RubricItem[]): string {
  const h = createHash('sha256');
  for (const it of items) h.update(`${it.id}${SEP}${it.requirement}${SEP}`);
  return h.digest('hex');
}

/** 点名漂在哪:条目数对不上先报数,否则报第一个内容不同的 id。 */
function describeDrift(frozen: readonly RubricItem[], presented: readonly RubricItem[]): string {
  if (frozen.length !== presented.length) {
    return `条目数变了: 冻结时 ${frozen.length} 条, 呈上 ${presented.length} 条`;
  }
  for (let i = 0; i < frozen.length; i++) {
    const a = frozen[i]!;
    const b = presented[i]!;
    if (a.id !== b.id) return `第 ${i + 1} 条的 id 变了: ${a.id} → ${b.id}`;
    if (a.requirement !== b.requirement) return `条目 ${a.id} 的要求被改过`;
  }
  // 走到这里说明两份逐字相同却哈希不等 —— 不该发生, 但不假装它不会。
  return '哈希不一致但逐条比对没找出差异 (哈希口径可能已改)';
}
