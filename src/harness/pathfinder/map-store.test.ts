import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderMapMarkdown,
  parseMapMarkdown,
  saveMapDb,
  loadMapDb,
  rebuildDbFromMarkdown,
  mapMarkdownPath,
  defaultDbPath,
} from './map-store';
import { declaredTicketClass, isRulingTicket } from './types';
import type { PathMap, Ticket } from './types';

/** 归一化: 排序票/边/children/decisionsLog, 抹平顺序 (roundtrip 属性只要求集合等价)。 */
function norm(m: PathMap): PathMap {
  return {
    destination: m.destination,
    slug: m.slug,
    tickets: [...m.tickets]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({
        ...t,
        blockedBy: [...t.blockedBy].sort(),
        ...(t.children ? { children: [...t.children].sort() } : {}),
      })),
    decisionsLog: [...m.decisionsLog].sort((a, b) => a.ticketId.localeCompare(b.ticketId)),
  };
}

function t(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'grill', title: partial.id, blockedBy: [], status: 'open', ...partial };
}

/** 带类的票工厂 (`ticketClass` 不在 `Ticket` 上 —— D-3 故意的, 见 types.ts)。 */
function tc(partial: Partial<Ticket> & Pick<Ticket, 'id'> & { ticketClass?: string }): Ticket & { ticketClass?: string } {
  return { type: 'grill', title: partial.id, blockedBy: [], status: 'open', ...partial };
}

const SHAPES: Record<string, PathMap> = {
  empty: { destination: 'Nothing yet', slug: 'nothing', tickets: [], decisionsLog: [] },
  minimal: {
    destination: 'Ship X',
    slug: 'ship-x',
    tickets: [t({ id: 'a' })],
    decisionsLog: [],
  },
  rich: {
    destination: 'Build pathfinder 模式 (跨 session)',
    slug: 'pathfinder',
    tickets: [
      t({ id: 'root', type: 'grill', title: '要不要合并 plan mode?', status: 'ruled', ruling: '合并, 见 D-1', dNumber: 'D-1' }),
      t({ id: 'store', type: 'research', title: '存储用什么?', status: 'blocked', blockedBy: ['root'], children: ['store-md', 'store-db'] }),
      t({ id: 'store-md', type: 'task', title: 'md renderer', status: 'ruled', ruling: 'render markdown, 分组 by status', executorKind: 'agent', blockedBy: ['store'] }),
      t({ id: 'esc', type: 'grill', title: '边界谁定?', status: 'escalated' }),
    ],
    decisionsLog: [
      { ticketId: 'root', gist: '合并 plan mode 进 pathfinder' },
      { ticketId: 'store-md', gist: 'markdown = 真相源' },
    ],
  },
  special: {
    destination: 'Edge: commas, colons: and 中文 · symbols',
    slug: 'edge-case',
    tickets: [
      t({ id: 'x', title: 'title with, comma: and 冒号', status: 'ruled', ruling: 'ruling with # hash and - dash and [brackets]', blockedBy: [] }),
      t({ id: 'y', title: '', status: 'open', blockedBy: ['x'], children: [] }),
    ],
    decisionsLog: [{ ticketId: 'x', gist: 'gist with, comma and 中文标点。' }],
  },
  // 切片2 欠账 (ticketClass) + D-5 三戳 + 等人台账 —— 挂进 SHAPES 即自动过 md 往返 /
  // 字节幂等 / db 往返三套既有属性测试。
  stamped: {
    destination: '控制面统一: 类与戳',
    slug: 'stamped',
    tickets: [
      tc({ id: 'r1', type: 'grill', title: '边界谁定?', status: 'escalated', ticketClass: 'ruling', waitingSince: '2026-08-08T00:00:00.000Z', staleAt: '2026-08-11T00:00:00.000Z' }),
      tc({ id: 'q1', type: 'research', title: '存储用什么?', status: 'suggested', ticketClass: 'question', suggestedBy: 'run-9', waitingSince: '2026-08-09T00:00:00.000Z' }),
      tc({ id: 'k1', type: 'task', title: '接线', status: 'ruled', ticketClass: 'task', ruling: '接上', ruledAt: '2026-08-10T00:00:00.000Z' }),
      t({ id: 'legacy', title: '存量票, 一个新字段都没有' }),
    ],
    decisionsLog: [],
    waitingLog: [{ ticketId: 'r1', waitingSince: '2026-08-08T00:00:00.000Z', waitedMs: 259200000, at: '2026-08-11T00:00:00.000Z' }],
  },
};

describe('map-store markdown roundtrip', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`roundtrip 等价: ${name}`, () => {
      const md = renderMapMarkdown(shape);
      const back = parseMapMarkdown(md);
      expect(norm(back)).toEqual(norm(shape));
    });

    test(`byte-stable: ${name} (render∘parse∘render 幂等)`, () => {
      const md1 = renderMapMarkdown(shape);
      const md2 = renderMapMarkdown(parseMapMarkdown(md1));
      expect(md2).toBe(md1);
    });
  }

  test('renderMapMarkdown 含目的地表头 + 决策日志', () => {
    const md = renderMapMarkdown(SHAPES.rich!);
    expect(md).toContain('Build pathfinder');
    expect(md).toContain('合并 plan mode 进 pathfinder');
  });
});

describe('map-store sqlite', () => {
  test(':memory: saveDb → loadDb 等价 (共享 Database 句柄)', () => {
    const db = new Database(':memory:');
    saveMapDb(SHAPES.rich!, db);
    expect(norm(loadMapDb(db))).toEqual(norm(SHAPES.rich!));
    db.close();
  });

  test('各形状 saveDb → loadDb 等价', () => {
    for (const shape of Object.values(SHAPES)) {
      const db = new Database(':memory:');
      saveMapDb(shape, db);
      expect(norm(loadMapDb(db, shape.slug))).toEqual(norm(shape));
      db.close();
    }
  });

  test('磁盘 db: save → load 等价, 且 re-save 幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-db-'));
    try {
      const dbPath = join(dir, 'sub', 'pathfinder.db'); // sub/ 不存在, 测 mkdirSync
      saveMapDb(SHAPES.rich!, dbPath);
      saveMapDb(SHAPES.rich!, dbPath); // 幂等, 不该重复
      expect(norm(loadMapDb(dbPath))).toEqual(norm(SHAPES.rich!));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('一 db 多图: 按 slug 取', () => {
    const db = new Database(':memory:');
    saveMapDb(SHAPES.minimal!, db);
    saveMapDb(SHAPES.rich!, db);
    expect(norm(loadMapDb(db, 'ship-x'))).toEqual(norm(SHAPES.minimal!));
    expect(norm(loadMapDb(db, 'pathfinder'))).toEqual(norm(SHAPES.rich!));
    db.close();
  });

  test('rebuildDbFromMarkdown == parseMapMarkdown == loadMapDb (md 真相可重建)', () => {
    const db = new Database(':memory:');
    const md = renderMapMarkdown(SHAPES.rich!);
    rebuildDbFromMarkdown(md, db);
    expect(norm(loadMapDb(db))).toEqual(norm(parseMapMarkdown(md)));
    db.close();
  });
});

// ── 切片2 留账: ticketClass 的序列化往返 (没有它, 类型闸只在内存生效) ──────────
describe('map-store × ticketClass (INV-2 的持久化那一半)', () => {
  const ruling = tc({ id: 'r1', type: 'grill', title: '边界谁定?', status: 'escalated', ticketClass: 'ruling' });
  const mapWith = (t0: Ticket): PathMap => ({ destination: 'D', slug: 'd', tickets: [t0], decisionsLog: [] });

  test('标 ruling 的票落盘 (md) 再读回, isRulingTicket 仍真', () => {
    // 实跑证伪: 注掉 renderTicket 的 ticketClass 行 (或 parse 的那支) → 本例转红。
    const back = parseMapMarkdown(renderMapMarkdown(mapWith(ruling))).tickets[0]!;
    expect(isRulingTicket(back)).toBe(true);
  });

  test('标 ruling 的票经 db 往返, isRulingTicket 仍真', () => {
    const db = new Database(':memory:');
    saveMapDb(mapWith(ruling), db);
    expect(isRulingTicket(loadMapDb(db, 'd').tickets[0]!)).toBe(true);
    db.close();
  });

  test('未标类的旧图读入 ticketClass 仍 undefined (NULL≠0: 缺省 ≠ task)', () => {
    const back = parseMapMarkdown(renderMapMarkdown(SHAPES.rich!));
    for (const t0 of back.tickets) expect(declaredTicketClass(t0)).toBeUndefined();
    const db = new Database(':memory:');
    saveMapDb(SHAPES.rich!, db);
    for (const t0 of loadMapDb(db, 'pathfinder').tickets) expect(declaredTicketClass(t0)).toBeUndefined();
    db.close();
  });

  test('存量逐字节兼容: 无类无戳的票渲染输出一个字节都没变', () => {
    const md = renderMapMarkdown(mapWith(t({ id: 'legacy', title: '存量票' })));
    // 改动前的既有形状 (末尾 blockedBy 行带一个尾空格 —— 原样保留)。
    expect(md).toContain(['### legacy', '- type: grill', '- title: 存量票', '- status: open', '- blockedBy: '].join('\n'));
    for (const key of ['ticketClass', 'waitingSince', 'ruledAt', 'staleAt', 'Waiting-human log']) expect(md).not.toContain(key);
  });

  test('人手改的词表外类值原样往返 (fail-closed 的前提: 不静默抹掉, 也不升格)', () => {
    const typo = tc({ id: 'r1', ticketClass: 'rulingg' }); // 手滑
    const back = parseMapMarkdown(renderMapMarkdown(mapWith(typo))).tickets[0]!;
    expect(declaredTicketClass(back)).toBe('rulingg');
    expect(isRulingTicket(back)).toBe(false); // 手滑不升格成裁决票, 也不静默变成可派发的"无类"票
  });
});

// ── D-5: 三戳 + 等人台账的序列化往返 ─────────────────────────────────────────
describe('map-store × waiting_human 戳与台账 (D-5)', () => {
  test('waitingSince / ruledAt / staleAt 三戳 md 往返', () => {
    const back = parseMapMarkdown(renderMapMarkdown(SHAPES.stamped!));
    const byId = Object.fromEntries(back.tickets.map((x) => [x.id, x]));
    expect(byId.r1!.waitingSince).toBe('2026-08-08T00:00:00.000Z');
    expect(byId.r1!.staleAt).toBe('2026-08-11T00:00:00.000Z');
    expect(byId.k1!.ruledAt).toBe('2026-08-10T00:00:00.000Z');
    // NULL≠0: 存量票读回来三戳全 undefined, 不许被补成 0 / now。
    expect(byId.legacy!.waitingSince).toBeUndefined();
    expect(byId.legacy!.ruledAt).toBeUndefined();
    expect(byId.legacy!.staleAt).toBeUndefined();
  });

  test('三戳 db 往返', () => {
    const db = new Database(':memory:');
    saveMapDb(SHAPES.stamped!, db);
    const byId = Object.fromEntries(loadMapDb(db, 'stamped').tickets.map((x) => [x.id, x]));
    expect(byId.r1!.waitingSince).toBe('2026-08-08T00:00:00.000Z');
    expect(byId.r1!.staleAt).toBe('2026-08-11T00:00:00.000Z');
    expect(byId.k1!.ruledAt).toBe('2026-08-10T00:00:00.000Z');
    expect(byId.legacy!.waitingSince).toBeUndefined();
    db.close();
  });

  test('等人台账 (waitingLog) md + db 往返, 且无台账的图读回仍 undefined', () => {
    // 实跑证伪: 注掉 renderMapMarkdown 的 Waiting-human log 段 → 本例转红。
    expect(parseMapMarkdown(renderMapMarkdown(SHAPES.stamped!)).waitingLog).toEqual(SHAPES.stamped!.waitingLog!);
    const db = new Database(':memory:');
    saveMapDb(SHAPES.stamped!, db);
    expect(loadMapDb(db, 'stamped').waitingLog).toEqual(SHAPES.stamped!.waitingLog!);
    saveMapDb(SHAPES.rich!, db);
    expect(loadMapDb(db, 'pathfinder').waitingLog).toBeUndefined(); // 没记过 ≠ 记了个空
    db.close();
    expect(parseMapMarkdown(renderMapMarkdown(SHAPES.rich!)).waitingLog).toBeUndefined();
  });
});

describe('map-store path helpers', () => {
  test('mapMarkdownPath = docs/plan/pathfinder/<slug>.md', () => {
    expect(mapMarkdownPath('feat-x', '/repo')).toBe('/repo/docs/plan/pathfinder/feat-x.md');
  });
  test('defaultDbPath = .omd/pathfinder.db', () => {
    expect(defaultDbPath('/repo')).toBe('/repo/.omd/pathfinder.db');
  });
});
