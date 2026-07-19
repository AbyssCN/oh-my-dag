/**
 * pathfinder 漏洞回归测试 (2026-07-19 code-review 修复批):
 *  1. 手改未知 status 的票**永不**在 render 往返中丢失 (真相文件人可编)。
 *  2. distill 取 `## 终稿` 内容, 不再把成本统计 blockquote 当裁决。
 *  3. writeResultAtomic: 落盘后无 .tmp 残留, 内容完整。
 *  4. watcher 每 tick reloadMap: 不把 tick 间落盘的 /rule 裁决回滚。
 *  5. watcher 不碰 escalated 票 (人工升级不被迟到结果覆写)。
 *  6. dispatch 去重: 结果已在 / 在途进程活着 → 不重复 spawn; 进程死了 → 重派。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { watchAfkResults } from './afk-hook';
import { dispatchTicket, researchDispatchedPath, researchResultPath } from './dispatch';
import { parseMapMarkdown, renderMapMarkdown } from './map-store';
import { distill, writeResultAtomic } from './result-format';
import type { PathMap, Ticket } from './types';

function tk(p: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'task', title: p.id, blockedBy: [], status: 'open', ...p };
}
function map(tickets: Ticket[]): PathMap {
  return { destination: 'Ship X', slug: 'ship-x', tickets, decisionsLog: [] };
}

describe('regression 1 — 未知 status 永不丢票', () => {
  test('手改 status 的票在 parse→render→parse 往返中保留', () => {
    const md = renderMapMarkdown(map([tk({ id: 't1', status: 'ruled', ruling: 'ok' }), tk({ id: 't2' })]));
    // 模拟手改: t2 的 status 被写成非法词
    const edited = md.replace('- status: open', '- status: donee');
    const round1 = parseMapMarkdown(edited);
    expect(round1.tickets).toHaveLength(2);
    const round2 = parseMapMarkdown(renderMapMarkdown(round1));
    expect(round2.tickets.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(round2.tickets.find((t) => t.id === 't2')?.status).toBe('donee' as Ticket['status']);
    // 幂等: 再往返一次不变
    expect(renderMapMarkdown(round2)).toBe(renderMapMarkdown(parseMapMarkdown(renderMapMarkdown(round2))));
  });
});

describe('regression 2 — distill 契约对齐 dag-research 真实输出', () => {
  test('取 终稿 内容, 跳过成本统计 blockquote', () => {
    const doc = [
      '# 研究: 选哪个存储',
      '',
      '> 12 leaves · $0.0132 · 检索命中 18 · 抓取 5',
      '',
      '## 终稿 (综合判优)',
      '',
      '用 markdown-in-git 作真相源, SQLite 只做本地索引。',
      '',
      '## Lens 冠军 (各视角最优)',
      '',
      '### evidence',
      '别的内容',
    ].join('\n');
    expect(distill(doc)).toBe('用 markdown-in-git 作真相源, SQLite 只做本地索引。');
    expect(distill(doc)).not.toContain('leaves');
  });
});

describe('regression 3 — writeResultAtomic', () => {
  test('落盘完整且无 .tmp 残留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-rf-'));
    try {
      const p = join(dir, 'deep', 'r1.md');
      writeResultAtomic(p, 'hello\nworld');
      expect(existsSync(p)).toBe(true);
      expect(existsSync(`${p}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('regression 4 — watcher 不回滚 tick 间落盘的裁决', () => {
  test('reloadMap 注入后, 结果回流保留磁盘真相里的新裁决', () => {
    const stale = map([
      tk({ id: 'r1', type: 'research', title: 'research it' }),
      tk({ id: 't2', title: 'other', status: 'open' }),
    ]);
    // 磁盘真相: watcher 启动后用户 /rule 了 t2
    const disk = map([
      tk({ id: 'r1', type: 'research', title: 'research it' }),
      tk({ id: 't2', title: 'other', status: 'ruled', ruling: 'user ruled this' }),
    ]);
    let savedMap: PathMap | null = null;
    watchAfkResults(
      stale,
      { cwd: '/nowhere', mode: 'once' },
      {
        reloadMap: () => disk,
        readIfReady: (p) => (p.includes('r1') ? '## 终稿\n\nresearch answer' : null),
        saveMap: (m) => {
          savedMap = m;
        },
      },
    );
    expect(savedMap).not.toBeNull();
    const t2 = (savedMap as unknown as PathMap).tickets.find((t) => t.id === 't2');
    expect(t2?.status).toBe('ruled');
    expect(t2?.ruling).toBe('user ruled this'); // 不被 stale 快照回滚
    expect((savedMap as unknown as PathMap).tickets.find((t) => t.id === 'r1')?.status).toBe('ruled');
  });
});

describe('regression 5 — escalated 票不被迟到结果覆写', () => {
  test('escalated research 票: 结果就绪也不回流', () => {
    const m = map([tk({ id: 'r1', type: 'research', title: 'research it', status: 'escalated' })]);
    let saved = false;
    const h = watchAfkResults(
      m,
      { cwd: '/nowhere', mode: 'once' },
      {
        readIfReady: () => '## 终稿\n\nlate answer',
        saveMap: () => {
          saved = true;
        },
      },
    );
    expect(h.tick()).toEqual([]);
    expect(saved).toBe(false);
  });
});

describe('D-10 自展开 — 契约兜底与自续', () => {
  test('单票子票超上限截断 (契约兜底), droppedChildren 上报; 深度不设限', async () => {
    const { applyAfkResult } = await import('./afk-hook');
    // 深母票 id (r1-c2-c1-c3 = 已展开三层) 仍可继续展开 — 深度是知识结构, 不设限。
    const deepParent = tk({ id: 'r1-c2-c1-c3', type: 'research', title: 'deep q' });
    const doc = ['## 终稿', '', 'answer', '', '## children', '- a', '- b', '- c', '- d', '- e', '- f'].join('\n');
    const applied = applyAfkResult(map([deepParent]), 'r1-c2-c1-c3', doc);
    expect(applied.newChildren).toHaveLength(4); // MAX_CHILDREN_PER_TICKET
    expect(applied.droppedChildren).toBe(2);
    expect(applied.newChildren[0]!.blockedBy).toEqual(['r1-c2-c1-c3']);
  });

  test('dispatch cmd 带 --children (生产端 opt-in 接通)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dsp-'));
    try {
      const spawns: string[][] = [];
      dispatchTicket(
        tk({ id: 'r1', type: 'research', title: 'q?' }),
        { cwd: dir, slug: 'ship-x' },
        { spawnDetached: (cmd) => (spawns.push(cmd), 1) },
      );
      expect(spawns[0]).toContain('--children');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('regression 6 — dispatch 去重', () => {
  const rt = (id: string): Ticket => tk({ id, type: 'research', title: 'q?' });

  test('结果已落地 → 不 spawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dsp-'));
    try {
      const resultPath = researchResultPath(dir, 'ship-x', 'r1');
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, 'done', 'utf8');
      let spawns = 0;
      const r = dispatchTicket(rt('r1'), { cwd: dir, slug: 'ship-x' }, { spawnDetached: () => (spawns++, 1) });
      expect(r.kind).toBe('afk');
      expect(spawns).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('在途进程活着 → 不重复 spawn; 死了 → 重派', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-dsp-'));
    try {
      let spawns = 0;
      const deps = { spawnDetached: () => (spawns++, 4242) };
      dispatchTicket(rt('r1'), { cwd: dir, slug: 'ship-x' }, deps);
      expect(spawns).toBe(1);
      expect(existsSync(researchDispatchedPath(dir, 'ship-x', 'r1'))).toBe(true);
      // 第二次派发: 标记在 + 进程活 → 跳过
      const r2 = dispatchTicket(rt('r1'), { cwd: dir, slug: 'ship-x' }, { ...deps, isAlive: () => true });
      expect(spawns).toBe(1);
      expect(r2.kind).toBe('afk');
      // 进程死了 (无结果) → stale 标记, 重派
      dispatchTicket(rt('r1'), { cwd: dir, slug: 'ship-x' }, { ...deps, isAlive: () => false });
      expect(spawns).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
