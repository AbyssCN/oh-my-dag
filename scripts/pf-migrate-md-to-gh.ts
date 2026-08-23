/**
 * scripts/pf-migrate-md-to-gh —— 把一张 md 决策地图搬上 GitHub Issues 后端 (一次性迁移件)。
 *
 * ## 为什么需要它 (owner 2026-08-12 裁「先写迁移再切」)
 *
 * `resolveBackend` 是**仓级全局**的 (env > config.backend > 'md'): config 一改 gh, md 上的活图
 * 当场从 `map_open` 消失。而两侧 id 形状不兼容 —— md 用语义 id (`task-ticket-writeset`),
 * gh 用 issue number (`#42`, D-D 无内部映射表)。所以"切后端"必须先"搬图", 且搬完得留下
 * **旧 id → 新 id 的映射**, 否则 docs 里那些按语义 id 写的引用全部指空。
 *
 * ## 编排 (全部经 PathBackend 端口, 不自造第二条 gh 路径 —— D-B 单口)
 *
 *  1. `createMap`   → 新 map issue, 新 slug = issue number
 *  2. `addTicket` ×N (拓扑序, blockedBy 用已建票的新 id) —— 拓扑序是硬前提:
 *     nativeDeps=true 时 addTicket 要对每个前置票查 databaseId, 前置没建出来就炸。
 *  3. `rule`        → **带判词的**票 (含 escalated —— 裁过又升人的那种, 见 ticketsNeedingRuling)
 *  4. `markDelivered` → delivered 票补 label (gh 侧 ruled/delivered 靠 label 区分)
 *  5. `escalate`    → escalated 票 (reopen + label + 进入戳)
 *  6. `syncFromMap` → 只剩 suggested 票的 label 没对上, 顺带**当独立校验**用
 *     (它的 `missing` 非空 = 有票没建出来, 那是硬错不是漂移)
 *  7. 回读 `readMap` 逐票比对源图 → 不一致就非零退出 (迁移不自证成功)
 *
 * ## 已知损耗 (**迁移前量过, 不是事后发现** —— 两张活图的真实读数见 `--dry-run` 输出)
 *
 *  - `dNumber` / `ticketClass` / `dispatch`: gh readMap 不解析 → 写进正文存根供人读, 但读不回来。
 *  - `ruledAt`: gh 侧取判词评论的 createdAt → 迁移后全变成"迁移当天"。**时间读数失真**,
 *    要查真实裁决时刻去归档的 md 文件。这条改不掉 (gh 没有可写的历史时间)。
 *  - `suggestionsLog`: gh 侧靠每票评论重建。431 条台账不逐条补 (那是 431 次 gh 调用换一份
 *    归档 md 里已有的历史) —— 明写在这里, 不假装无损。
 *  - `executorKind`: **本来会丢, 已补掉** —— 见 backend-gh 的 `Executor-kind` 正文锚。
 *    不补的话 slice-compiler 缺省 `inproc→leaf`, 15 张 `agent` 票会被静默降级成单发调用。
 *
 * 用法: bun run scripts/pf-migrate-md-to-gh.ts <slug> [--execute]
 *       省 --execute = dry-run (零 gh 写, 只出计划 + 损耗表)。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBackend } from '../src/harness/pathfinder/backend';
import { deriveStatus } from '../src/harness/pathfinder/frontier';
import { loadMap } from '../src/harness/pathfinder/map-store';
import type { PathBackend } from '../src/harness/pathfinder/backend';
import type { PathMap, Ticket } from '../src/harness/pathfinder/types';

/** 一张票在迁移计划里的位置 (纯核产物; 新 id 要等真建出来才知道, 故此处只有序与依赖)。 */
export interface PlannedTicket {
  ticket: Ticket;
  /** 拓扑序位次 (0-based)。 */
  order: number;
}

export interface MigrationPlan {
  order: PlannedTicket[];
  /** 已裁但没有判词文本的票 —— gh 侧 ruled 靠 `**ruling**` 评论读回, 没文本就读不回 ruled。 */
  ruledWithoutText: string[];
  /** gh readMap 不解析的字段命中数 (损耗表; 0 = 这张图不吃这条损耗)。 */
  losses: { dNumber: number; ticketClass: number; dispatch: number; ruledAt: number; suggestionsLog: number };
}

/**
 * 纯核: 图 → 迁移计划 (拓扑排序 + 损耗盘点)。零 IO / 零 gh。
 * 成环 / 悬空前置 → throw (fail-loud: 半张图搬上去比不搬更糟)。
 */
export function planMigration(map: PathMap): MigrationPlan {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  for (const t of map.tickets) {
    for (const dep of t.blockedBy) {
      if (!byId.has(dep)) throw new Error(`票 "${t.id}" 的前置 "${dep}" 不在图上 (悬空边) — 先修 md 图再迁移`);
    }
  }
  // Kahn: 入度 = 未排进去的前置数。同层按原顺序 (可重放, 两次跑出同一份计划)。
  const remaining = new Map(map.tickets.map((t) => [t.id, new Set(t.blockedBy)]));
  const order: PlannedTicket[] = [];
  while (remaining.size > 0) {
    const ready = map.tickets.filter((t) => remaining.has(t.id) && remaining.get(t.id)!.size === 0);
    if (ready.length === 0) {
      throw new Error(`blockedBy 成环, 排不出拓扑序: ${[...remaining.keys()].join(', ')}`);
    }
    for (const t of ready) {
      order.push({ ticket: t, order: order.length });
      remaining.delete(t.id);
    }
    for (const deps of remaining.values()) for (const t of ready) deps.delete(t.id);
  }
  const n = (f: (t: Ticket) => unknown) => map.tickets.filter((t) => f(t)).length;
  return {
    order,
    ruledWithoutText: map.tickets.filter((t) => (t.status === 'ruled' || t.status === 'delivered') && t.ruling === undefined).map((t) => t.id),
    losses: {
      dNumber: n((t) => t.dNumber),
      ticketClass: n((t) => (t as Ticket & { ticketClass?: string }).ticketClass),
      dispatch: n((t) => t.dispatch),
      ruledAt: n((t) => t.ruledAt),
      suggestionsLog: map.suggestionsLog?.length ?? 0,
    },
  };
}

/**
 * 票 → gh issue 正文。锚行形状对齐 backend-gh 既有锚 (`^Key: value$`, parseAnchor 消费)。
 * `Origin-id` 是迁移的**唯一回溯锚**: 新 id 是 issue number, 旧 id 只活在这一行里。
 * ⚠ `Blocked-by` 不在这里写 —— legacy 策略由 addTicket 自己拼, native 策略压根不写正文 (D-C 单真相)。
 */
export function ticketBody(t: Ticket, originSlug: string): string {
  const lines = [`Origin-id: ${t.id}`, `Origin-map: ${originSlug}`];
  if (t.suggestedBy) lines.push(`Suggested-by: ${t.suggestedBy}`);
  if (t.fingerprint) lines.push(`Fingerprint: ${t.fingerprint}`);
  if (t.waitingSince) lines.push(`Waiting-since: ${t.waitingSince}`);
  // 下面两行 gh 读不回来 (readMap 不解析) —— 落在正文是给人看的存根, 不冒充可往返字段。
  if (t.dNumber) lines.push(`D-number: ${t.dNumber}`);
  if (t.ruledAt) lines.push(`Origin-ruled-at: ${t.ruledAt}`);
  return lines.join('\n');
}

/**
 * open/blocked 归一 —— 比对前必跑, 两侧都跑同一个纯核 (`frontier.deriveStatus`)。
 *
 * ★ 为什么需要这一步 (2026-08-12 首次真机迁移当场抓到, 3 张票):
 * md 盘上的 `status` 是**字面值**, 写进去之后不随前置状态回写; 而前沿一直是 `computeFrontier`
 * 现算的, 于是"存的是 open、算出来是 blocked"这种陈旧从来不露头。gh 侧 readMap 每次都重算
 * (二遍 deriveStatus), 所以拿 md 字面值当真值比对 = **假红**: 报的是 md 的陈旧, 不是迁移搬错了。
 * 归一后仍红 = 真的搬错了。
 */
export function normalizeDerived(map: PathMap): PathMap {
  const ruledSet = new Set(map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
  return {
    ...map,
    tickets: map.tickets.map((t) => (t.status === 'open' || t.status === 'blocked' ? { ...t, status: deriveStatus(t, ruledSet) } : t)),
  };
}

/**
 * 要发判词评论的票 —— 判据是**判词有没有**, 不是状态是不是终态。
 *
 * ★ 2026-08-12 大图迁移当场抓到: `proto-cube-sandbox-leaf` 是 **escalated 且带 1108 字判词**
 * (types.ts:49 明写这形态合法 —— 票裁过又被重新升人, `escalate` 不清 ruling)。按状态挑就漏了它,
 * 而漏掉的症状是**沉默的**: 票在 gh 上齐全, 只是判词凭空少了一张。
 */
export function ticketsNeedingRuling(map: PathMap): Ticket[] {
  return map.tickets.filter((t) => t.ruling !== undefined);
}

/** 回读校验的一条不一致。 */
export interface Mismatch {
  ticketId: string;
  field: string;
  want: string;
  got: string;
}

/** 纯核: 源图 (id 已重映射) vs 回读图 → 不一致清单。空 = 迁移逐票对得上。 */
export function diffMaps(want: PathMap, got: PathMap): Mismatch[] {
  const out: Mismatch[] = [];
  const gotById = new Map(got.tickets.map((t) => [t.id, t]));
  for (const w of want.tickets) {
    const g = gotById.get(w.id);
    if (!g) {
      out.push({ ticketId: w.id, field: '整票', want: '存在', got: '缺失' });
      continue;
    }
    const cmp = (field: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ ticketId: w.id, field, want: String(a), got: String(b) });
    };
    cmp('type', w.type, g.type);
    cmp('title', w.title, g.title);
    cmp('status', w.status, g.status);
    cmp('blockedBy', [...w.blockedBy].sort(), [...g.blockedBy].sort());
    cmp('executorKind', w.executorKind, g.executorKind);
    // ruling 只比"有没有": gh 侧判词经 scrubAttribution 洗过署名, 逐字节比会假红。
    cmp('ruling有无', w.ruling !== undefined, g.ruling !== undefined);
  }
  for (const g of got.tickets) {
    if (!want.tickets.some((w) => w.id === g.id)) out.push({ ticketId: g.id, field: '整票', want: '不存在', got: '多出来了' });
  }
  return out;
}

/** 把源图按 idMap 重映射成"迁移后应有的样子" (用于 syncFromMap 的真值 + 回读比对)。 */
export function remap(map: PathMap, idMap: Map<string, string>, newSlug: string): PathMap {
  return {
    ...map,
    slug: newSlug,
    tickets: map.tickets.map((t) => ({
      ...t,
      id: idMap.get(t.id) ?? t.id,
      blockedBy: t.blockedBy.map((d) => idMap.get(d) ?? d),
      ...(t.children ? { children: t.children.map((c) => idMap.get(c) ?? c) } : {}),
    })),
  };
}

// ── 副作用编排 (从这里往下才碰 gh) ──────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const execute = args.includes('--execute');
  // --verify=<newSlug>: 只回读比对已迁移的图 (零 gh 写)。迁移中断 / 改了校验判据后重核用。
  const verifyOnly = args.find((a) => a.startsWith('--verify='))?.split('=')[1];
  if (!slug) {
    console.error('用法: bun run scripts/pf-migrate-md-to-gh.ts <slug> [--execute | --verify=<newSlug>]');
    return 2;
  }
  const cwd = process.cwd();
  const map = loadMap(cwd, slug);
  if (!map) {
    console.error(`✗ 找不到 md 图 "${slug}" (docs/plan/pathfinder/${slug}.md)`);
    return 2;
  }
  const plan = planMigration(map);

  console.log(`◈ ${map.destination}\n  slug=${slug} · ${map.tickets.length} 票 · ${map.tickets.reduce((s, t) => s + t.blockedBy.length, 0)} 条边`);
  const byStatus = map.tickets.reduce<Record<string, number>>((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {});
  console.log(`  状态分布: ${JSON.stringify(byStatus)}`);
  console.log(`  已知损耗: dNumber=${plan.losses.dNumber} ticketClass=${plan.losses.ticketClass} dispatch=${plan.losses.dispatch} ruledAt(时间失真)=${plan.losses.ruledAt} suggestionsLog(不搬)=${plan.losses.suggestionsLog}`);
  if (plan.ruledWithoutText.length > 0) {
    console.error(`✗ 已裁但无判词文本 ${plan.ruledWithoutText.length} 张: ${plan.ruledWithoutText.join(', ')}`);
    console.error('  gh 侧 ruled 靠 `**ruling**` 评论读回 —— 没文本搬过去会读成 open。先在 md 图补判词。');
    return 2;
  }
  const writes = map.tickets.length + 1 + map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').length * 2 + map.tickets.filter((t) => t.status === 'delivered').length;
  console.log(`  预计 gh 写调用 ≈ ${writes} 次 (建图1 + 建票${map.tickets.length} + 判词/关闭 + label)`);

  if (verifyOnly) {
    // 旧 id → 新 id 走 issue 正文的 Origin-id 锚倒推 (映射表文件可能不在手边; 锚是随票走的)。
    const backend = resolveBackend(cwd, { env: { ...process.env, OMD_PATH_BACKEND: 'gh' } });
    const got = backend.readMap(cwd, verifyOnly);
    if (!got) {
      console.error(`✗ 回读不到 gh 图 "${verifyOnly}"`);
      return 1;
    }
    // 按拓扑序建票 ⇒ 新 id 的排序与建票顺序一致; 用它对回计划序 (与迁移时同一份 order)。
    const idMap = new Map(plan.order.map((p, i) => [p.ticket.id, [...got.tickets].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[i]?.id ?? '?']));
    const diffs = diffMaps(normalizeDerived(remap(map, idMap, verifyOnly)), got);
    if (diffs.length > 0) {
      console.error(`\n✗ 回读比对 ${diffs.length} 处不一致:`);
      for (const d of diffs.slice(0, 30)) console.error(`  ${d.ticketId} · ${d.field}: 想要 ${d.want} / 实得 ${d.got}`);
      return 1;
    }
    console.log(`\n✓ 回读逐票一致 (${got.tickets.length} 票, gh slug=${verifyOnly})`);
    return 0;
  }

  if (!execute) {
    console.log('\n拓扑序 (前 10):');
    for (const p of plan.order.slice(0, 10)) console.log(`  ${String(p.order).padStart(2)}. [${p.ticket.status}] ${p.ticket.id}${p.ticket.blockedBy.length ? ` ← ${p.ticket.blockedBy.join(',')}` : ''}`);
    console.log(`\n(dry-run, 零 gh 写。真跑加 --execute)`);
    return 0;
  }

  const backend: PathBackend = resolveBackend(cwd, { env: { ...process.env, OMD_PATH_BACKEND: 'gh' } });
  console.log(`\n▶ 执行 (backend=${backend.kind})`);

  const created = backend.createMap(cwd, map.destination, slug);
  const newSlug = created.slug;
  console.log(`  ✓ map issue #${newSlug}`);

  const idMap = new Map<string, string>();
  for (const p of plan.order) {
    const t = p.ticket;
    const nt = {
      type: t.type,
      title: t.title,
      blockedBy: t.blockedBy.map((d) => idMap.get(d)!),
      body: ticketBody(t, slug),
      ...(t.executorKind ? { executorKind: t.executorKind } : {}),
    };
    const made = backend.addTicket(cwd, newSlug, nt);
    idMap.set(t.id, made.id);
    console.log(`  ✓ ${t.id} → ${made.id}`);
  }

  // 判词 + 终态 label。顺序: rule (关票) → markDelivered (补 label) → escalate (reopen 的那张)。
  // 顺序要紧: rule 会 close 票, escalate 随后 reopen + 打 label —— 先发判词再升人, 两者都留得下。
  for (const t of ticketsNeedingRuling(map)) {
    backend.rule(cwd, newSlug, idMap.get(t.id)!, t.ruling!);
  }
  const deliveredIds = map.tickets.filter((t) => t.status === 'delivered').map((t) => idMap.get(t.id)!);
  if (deliveredIds.length > 0) backend.markDelivered(cwd, newSlug, deliveredIds);
  for (const t of map.tickets.filter((x) => x.status === 'escalated')) {
    backend.escalate?.(cwd, newSlug, idMap.get(t.id)!);
  }
  console.log(`  ✓ 判词 ${ticketsNeedingRuling(map).length} 条 · delivered ${deliveredIds.length} 张 · escalated ${map.tickets.filter((t) => t.status === 'escalated').length} 张`);

  // suggested label 由 syncFromMap 补 (它是"以盘为准纠正渲染"的既有口)。
  const truth = remap(map, idMap, newSlug);
  const sync = (backend as PathBackend & { syncFromMap?: Function }).syncFromMap;
  if (typeof sync === 'function') {
    const r = sync.call(backend, cwd, newSlug, truth, { at: new Date().toISOString() });
    console.log(`  ✓ syncFromMap: 纠正 ${r.synced.length} 张 · missing ${r.missing.length}`);
    if (r.missing.length > 0) {
      console.error(`  ✗ 有票没建出来: ${r.missing.join(', ')}`);
      return 1;
    }
  }

  // 映射表存盘: 新 id 是 issue number, 旧语义 id 只活在这份表和 issue 正文的 Origin-id 锚里。
  const mapFile = join(cwd, '.omd', 'pathfinder', `migration-${slug}-${Date.now()}.json`);
  writeFileSync(mapFile, JSON.stringify({ originSlug: slug, newSlug, at: new Date().toISOString(), idMap: Object.fromEntries(idMap) }, null, 2), 'utf8');
  console.log(`  ✓ id 映射表 → ${mapFile}`);

  // 回读校验: 迁移不自证成功。
  const readBack = backend.readMap(cwd, newSlug);
  if (!readBack) {
    console.error('✗ 回读不到新图');
    return 1;
  }
  const diffs = diffMaps(normalizeDerived(truth), readBack);
  if (diffs.length > 0) {
    console.error(`\n✗ 回读比对 ${diffs.length} 处不一致:`);
    for (const d of diffs.slice(0, 30)) console.error(`  ${d.ticketId} · ${d.field}: 想要 ${d.want} / 实得 ${d.got}`);
    return 1;
  }
  console.log(`\n✓ 迁移完成且回读逐票一致 (${readBack.tickets.length} 票)。新 slug = ${newSlug}`);
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
