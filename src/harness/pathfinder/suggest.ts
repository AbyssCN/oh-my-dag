/**
 * src/harness/pathfinder/suggest —— S-1 建议票纯核(契约 docs/plan/2026-08-04-s1-suggested-tickets.md)。
 *
 * 两个入口,全部**纯函数就地改 map**(mutateMap 的 fn 位),零 IO 零 LLM:
 *  - applySuggestions: 机器建议入图 → suggested 态(INV-S1-2 溯源必填 · GWT-6 指纹去重 ·
 *    INV-S1-5 双上限带 No-silent-caps 摘要)。
 *  - confirmSuggestion: 人确认(accept/±改题/reject),suggestionsLog append-only(INV-S1-3)。
 *
 * 时间戳由调用方给(可重放,引擎纯核不自取时钟)。
 */
import { createHash } from 'node:crypto';
import type { PathMap, SuggestionLogEntry, Ticket, TicketType } from './types';
import { markWaitingHuman } from './frontier';
import { semanticHit } from './proximity';

/** D-S1.5: 指纹 = sha256(type + NFC(title))。t3 扩 body 级前,先堵「同题重开」。 */
export function computeFingerprint(type: TicketType, title: string): string {
  return createHash('sha256').update(`${type}\n${title.normalize('NFC')}`).digest('hex');
}

/** 一条机器建议草稿(片 c 的 solve 钩子与测试共用形状)。 */
export interface SuggestionDraft {
  type: TicketType;
  title: string;
  /** INV-S1-2: 建议来源 runId,必填 — 没有来源的建议不收(整批拒)。 */
  suggestedBy: string;
  blockedBy?: string[];
}

export interface ApplySuggestionsOpts {
  /** ISO 时间戳(进 suggestionsLog 的 deduped 行)。 */
  at: string;
  /** INV-S1-5: 单次 run 上限(默认 5 = OMD_SUGGEST_PER_RUN 的解析结果,由调用方传)。 */
  perRunCap?: number;
  /** INV-S1-5: 图上 pending suggested 总上限(默认 20)。 */
  pendingCap?: number;
  /**
   * r1 C1 语义档: 草稿与任一既有票 title 的 cosine ≥ 此值 → 按 deduped-semantic 留痕不入图。
   * 默认 0.6 (与 proximity 同档); 0 = 关 (只留指纹档)。数字上限仍保底 (智能档不替兜底)。
   */
  semanticThreshold?: number;
}

export interface ApplySuggestionsResult {
  /** 真入图的票(status='suggested')。 */
  added: Ticket[];
  /** 指纹撞已有票 → 未入图,记了 deduped 行(ticketId=撞上的既有票)。 */
  deduped: { draftTitle: string; hitTicketId: string }[];
  /** 因两个上限丢弃的条数(No silent caps:摘要必须念出来)。 */
  dropped: number;
  /** 人读摘要一行(GWT-7 的 oracle 面:含「丢弃 N」当 N>0)。 */
  summary: string;
}

/** 机器建议入图(在 mutateMap 的 fn 位调用;直改 map)。 */
export function applySuggestions(map: PathMap, drafts: SuggestionDraft[], opts: ApplySuggestionsOpts): ApplySuggestionsResult {
  // INV-S1-2 整批前置校验:缺溯源 = 调用方缺陷,响亮拒绝而不是丢那一条。
  for (const d of drafts) {
    if (!d.suggestedBy) throw new Error(`建议草稿「${d.title.slice(0, 40)}」缺 suggestedBy — 没有来源的建议不收 (INV-S1-2)`);
  }
  const perRunCap = opts.perRunCap ?? 5;
  const pendingCap = opts.pendingCap ?? 20;
  const log = (map.suggestionsLog ??= []);
  const byFp = new Map(map.tickets.filter((t) => t.fingerprint).map((t) => [t.fingerprint!, t.id]));
  const ids = new Set(map.tickets.map((t) => t.id));
  let pending = map.tickets.filter((t) => t.status === 'suggested').length;

  const added: Ticket[] = [];
  const deduped: ApplySuggestionsResult['deduped'] = [];
  let dropped = 0;

  for (const d of drafts) {
    const fp = computeFingerprint(d.type, d.title);
    // GWT-6 / INV-S1-4: 撞任何状态的既有票 → 不入图, 但**必须留痕**(沉默去重是缺陷)。
    // 与既有无指纹票撞不判(老票没指纹;t3 补算历史指纹时自然收紧)。
    const hit = byFp.get(fp);
    if (hit !== undefined) {
      deduped.push({ draftTitle: d.title, hitTicketId: hit });
      log.push({ ticketId: hit, outcome: 'deduped', at: opts.at, runId: d.suggestedBy });
      continue;
    }
    // r1 C1 (GWT-R1-3): 语义近邻去重 — 指纹(同题逐字)档之后、预算之前。留痕指向撞上的票。
    if ((opts.semanticThreshold ?? 0.6) > 0) {
      const titles = map.tickets.map((t) => t.title);
      const hitIdx = semanticHit(d.title, titles, { threshold: opts.semanticThreshold ?? 0.6 });
      if (hitIdx !== null) {
        const hitId = map.tickets[hitIdx]!.id;
        deduped.push({ draftTitle: d.title, hitTicketId: hitId });
        log.push({ ticketId: hitId, outcome: 'deduped-semantic', at: opts.at, runId: d.suggestedBy });
        continue;
      }
    }
    // INV-S1-5 双上限(去重后才计数:重复项不占预算)。
    if (added.length >= perRunCap || pending >= pendingCap) {
      dropped++;
      continue;
    }
    // id: s 前缀自增(与 addTicket 的 r/g/p/t 前缀族并列,s=suggested 出生)。
    let n = 1;
    while (ids.has(`s${n}`)) n++;
    const tid = `s${n}`;
    ids.add(tid);
    const ticket: Ticket = {
      id: tid,
      type: d.type,
      title: d.title,
      blockedBy: d.blockedBy ?? [],
      status: 'suggested',
      suggestedBy: d.suggestedBy,
      fingerprint: fp,
    };
    // D-5 三戳之三 (切片 6 接线): suggested = "等人确认" —— 出生即进等人态, 于是**这一刻**就是
    // 进入时刻。不打这个戳的话, 每张建议票的等待读数都是 `waiting-unknown-since`, 超时永不升级
    // (G-5 fail-safe 是对的: 不知道等了多久就不假装知道 —— 所以缺的不是闸, 是这个戳)。
    // 时刻用 opts.at (调用方给的同一个可重放时钟), 不自取 Date.now。
    markWaitingHuman(ticket, opts.at);
    map.tickets.push(ticket);
    byFp.set(fp, tid);
    added.push(ticket);
    pending++;
  }

  const parts = [`建议入图 ${added.length}`];
  if (deduped.length > 0) parts.push(`去重 ${deduped.length}`);
  if (dropped > 0) parts.push(`丢弃 ${dropped} (上限 perRun=${perRunCap}/pending=${pendingCap})`);
  return { added, deduped, dropped, summary: parts.join(' · ') };
}

export type ConfirmAction = 'accept' | 'reject';

/**
 * 人确认一张 suggested 票(在 mutateMap 的 fn 位调用;直改 map)。
 * - accept:status → open(带 title = 改题,outcome='edited');票照常进前沿生命周期。
 * - reject:票从图上移除,台账留 rejected 行(INV-S1-3:拒绝不是删除无痕)。
 * 非 suggested 票 / 不存在 → throw(GWT-3 幂等拒绝:同票二次 confirm 走这条)。
 */
export function confirmSuggestion(
  map: PathMap,
  ticketId: string,
  action: ConfirmAction,
  opts: { at: string; title?: string },
): SuggestionLogEntry {
  const idx = map.tickets.findIndex((t) => t.id === ticketId);
  if (idx < 0) throw new Error(`票 "${ticketId}" 不存在 — 无可 confirm`);
  const tk = map.tickets[idx]!;
  if (tk.status !== 'suggested') throw new Error(`票 "${ticketId}" 状态是 ${tk.status}, 不是 suggested — confirm 只作用于待确认建议 (已处理过的不重复处理)`);
  const runId = tk.suggestedBy ?? '(unknown)';
  const log = (map.suggestionsLog ??= []);
  let entry: SuggestionLogEntry;
  if (action === 'reject') {
    map.tickets.splice(idx, 1);
    entry = { ticketId, outcome: 'rejected', at: opts.at, runId };
  } else {
    const edited = opts.title !== undefined && opts.title !== tk.title;
    if (edited) tk.title = opts.title!;
    tk.status = 'open';
    entry = { ticketId, outcome: edited ? 'edited' : 'accepted', at: opts.at, runId };
  }
  log.push(entry);
  return entry;
}
