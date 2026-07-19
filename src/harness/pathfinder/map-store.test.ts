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

describe('map-store path helpers', () => {
  test('mapMarkdownPath = docs/plan/pathfinder/<slug>.md', () => {
    expect(mapMarkdownPath('feat-x', '/repo')).toBe('/repo/docs/plan/pathfinder/feat-x.md');
  });
  test('defaultDbPath = .omd/pathfinder.db', () => {
    expect(defaultDbPath('/repo')).toBe('/repo/.omd/pathfinder.db');
  });
});
