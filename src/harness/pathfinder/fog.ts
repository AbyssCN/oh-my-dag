/**
 * src/harness/pathfinder/fog —— 战争迷雾档位的**纯函数判据**
 * (契约 `docs/plan/2026-08-06-omd-gui-sdd.md` §4)。
 *
 * ## 它治的是什么
 *
 * 雾必须是**真数据的视觉编码**,不是特效。所以判据落在这里一处,前端只渲染不判断 ——
 * 两处各算一份必漂,本仓已经为这条付过账 (S-15 / 「⑧.5 只有一处算」)。
 *
 * ⚠ **雾绑的是 `frontier` 不是 `proximity`**。写 SDD 初稿时绑错过一次:
 * `proximity.ts` 是新颖性坍塌的语义聚类 (co-scientist 谱系), 与图上的距离无关。
 * 正确的接缝是 {@link deriveStatus} —— 它的头注本来就写着「给 UI/store 贴标」。
 *
 * ## 跳数怎么定义
 *
 * `hops` = **这张票还要等几层前置裁完才能动**:
 *
 *   · 已经能动的 (open / suggested / escalated) → 0
 *     —— suggested 与 escalated 也算 0: 它们离"能动"只差 owner 的一个动作, 不差别的票。
 *   · blocked → 1 + max(未裁前置的 hops)
 *
 * 于是 `near` (浅雾) ≡ hops===1, `deep` (深雾) ≡ hops≥2 —— **档由数推出, 不另定义一遍**。
 *
 * ## 三条容错 (承 frontier.ts 的同名纪律, 但这里必须给出**不同的答案**)
 *
 * `computeFrontier` 是单遍 filter, 悬空前置与环都被它一视同仁地归成「不在前沿」。
 * 雾图不能这么糊: 「等前面裁完就会浮出来」与「结构上永远浮不出来」在界面上长得一样,
 * 就会有人对着一张永远不动的票干等。所以这里单开 {@link FogBand} 的 `unreachable` 一档。
 *
 * 合并 `dangling-prereq` 与 `cycle` 成同一档, 是因为**两者的下一步是同一句**
 * (人去改图);但成因不并掉, 留在 {@link FogCell.unreachableReason} 里 ——
 * 补一张票和打断一个环, 手上的动作不同。
 *
 * 纯: 只吃 PathMap 吐 FogView。零 IO / 零 LLM / 零 UI。
 */
import { deriveStatus } from './frontier';
import type { PathMap, Ticket } from './types';

/** 雾档 —— UI 用的粗标签。`near`/`deep` 由 {@link FogCell.hops} 推出, 不是独立判据。 */
export type FogBand =
  /** 已散雾: 裁过了。全亮。 */
  | 'clear'
  /** 待 owner 决断 (`escalated`): 点它就能回。**这一档是雾图存在的理由。** */
  | 'awaiting-owner'
  /** 前沿: 现在就能派。高亮脉冲。 */
  | 'frontier'
  /** 机器建议待确认: 虚线轮廓 —— 它没有执行力 (INV-S1-1), 但离能动只差一次确认。 */
  | 'suggested'
  /** 浅雾: 还差一层 (hops===1)。半透明, 标题可读。 */
  | 'near'
  /** 深雾: 还差两层以上 (hops≥2)。只剩轮廓。 */
  | 'deep'
  /**
   * **结构上永远浮不出来**: 前置 id 在图上不存在, 或它在一个环里。
   *
   * ⚠ 与 `deep` 分开的全部理由是**下一步相反**: 深雾等前面裁完就自然浮出,
   * 这一档等多久都不会动 —— 要人去改图。糊成一档 = 让人对着一张死票干等。
   */
  | 'unreachable';

/** 一张票的雾档读数。 */
export interface FogCell {
  ticketId: string;
  band: FogBand;
  /**
   * 还要等几层前置。**`null` = 不适用**(`clear` / `unreachable`), 不是 0 ——
   * 0 是「现在就能动」, 与「这个数对这一档没有意义」是两件事 (仓规第一条)。
   */
  hops: number | null;
  /** `unreachable` 的直接成因; 其余档 `null`。合并成一档不等于把成因也并掉。 */
  unreachableReason: 'dangling-prereq' | 'cycle' | null;
}

export interface FogView {
  /** 与 `map.tickets` **同序** (稳定; 前端按它渲染不用再排一遍)。 */
  cells: FogCell[];
  /**
   * `children` 里声明了、但图上**没有对应票**的 id —— 自展开还没跑到那一步。
   * 渲染成全黑占位: 它是"已知存在但还没长出来"的东西, 与"不存在"不一样。
   */
  phantoms: string[];
}

/** 已裁票 id 集合 (口径与 frontier.ruledSetOf 一致: delivered 也算裁过)。 */
function ruledSetOf(map: PathMap): Set<string> {
  return new Set(map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
}

/** 深度解算的中间结果。`hops === null` 表示不可达。 */
type Depth = { hops: number; reason: null } | { hops: null; reason: 'dangling-prereq' | 'cycle' };

/**
 * 算一张票的雾档。**判据的唯一定义处** —— 加新档先问「它的下一步跟现有哪一档都不一样吗」。
 */
export function computeFog(map: PathMap): FogView {
  const ruled = ruledSetOf(map);
  const byId = new Map<string, Ticket>(map.tickets.map((t) => [t.id, t]));
  const memo = new Map<string, Depth>();

  /**
   * 递归求深度。`stack` 是当前 DFS 路径 —— 环靠它认, 不靠深度上限
   * (深度上限会把一张合法的长链误判成环, 而长链正是这张图该有的样子)。
   */
  function depthOf(id: string, stack: Set<string>): Depth {
    const cached = memo.get(id);
    if (cached) return cached;

    const t = byId.get(id);
    if (!t) return { hops: null, reason: 'dangling-prereq' };
    if (stack.has(id)) return { hops: null, reason: 'cycle' };

    const derived = deriveStatus(t, ruled);
    // 离"能动"只差 owner 一个动作(或已经能动)→ 0 层。三种状态在这条轴上等价:
    // 它们都不需要**别的票**先裁完。
    if (derived === 'open' || derived === 'suggested' || derived === 'escalated') {
      const d: Depth = { hops: 0, reason: null };
      memo.set(id, d);
      return d;
    }
    if (derived === 'ruled' || derived === 'delivered') {
      const d: Depth = { hops: 0, reason: null };
      memo.set(id, d);
      return d;
    }

    // derived === 'blocked': 1 + max(未裁前置)
    stack.add(id);
    let max = -1;
    let bad: 'dangling-prereq' | 'cycle' | null = null;
    for (const pid of t.blockedBy) {
      if (ruled.has(pid)) continue; // 已裁的前置不再计入等待
      const pd = depthOf(pid, stack);
      if (pd.hops === null) {
        // 一条不可达的前置就足以让它不可达 —— 环/悬空是**结构**问题, 不会被别的分支救回来。
        // 先记 cycle 后记 dangling 都可以, 但两者同时出现时报 cycle: 环是更结构性的那个,
        // 打断环之后悬空前置才有讨论的意义。
        bad = bad === 'cycle' ? 'cycle' : pd.reason;
        continue;
      }
      if (pd.hops > max) max = pd.hops;
    }
    stack.delete(id);

    const d: Depth = bad ? { hops: null, reason: bad } : { hops: max < 0 ? 0 : max + 1, reason: null };
    memo.set(id, d);
    return d;
  }

  const cells: FogCell[] = map.tickets.map((t) => {
    const derived = deriveStatus(t, ruled);
    if (derived === 'ruled' || derived === 'delivered') {
      return { ticketId: t.id, band: 'clear', hops: null, unreachableReason: null };
    }
    if (derived === 'escalated') {
      return { ticketId: t.id, band: 'awaiting-owner', hops: 0, unreachableReason: null };
    }
    if (derived === 'suggested') {
      return { ticketId: t.id, band: 'suggested', hops: 0, unreachableReason: null };
    }
    if (derived === 'open') {
      return { ticketId: t.id, band: 'frontier', hops: 0, unreachableReason: null };
    }
    // blocked
    const d = depthOf(t.id, new Set());
    if (d.hops === null) {
      return { ticketId: t.id, band: 'unreachable', hops: null, unreachableReason: d.reason };
    }
    return { ticketId: t.id, band: d.hops === 1 ? 'near' : 'deep', hops: d.hops, unreachableReason: null };
  });

  // phantom: children 声明过、但图上没有票。去重并保持首次出现序 (渲染要稳定)。
  const seen = new Set<string>();
  const phantoms: string[] = [];
  for (const t of map.tickets) {
    for (const cid of t.children ?? []) {
      if (byId.has(cid) || seen.has(cid)) continue;
      seen.add(cid);
      phantoms.push(cid);
    }
  }

  return { cells, phantoms };
}
