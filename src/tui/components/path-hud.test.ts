/**
 * L2 判据:pathfinder 进 HUD(goal §4 S13,A4)。
 *
 * goal 那条 verify 的全部内容是**三态要分得开**:
 * 一张图都没有(恒缺席)/ 有图但前沿为空(灰常量即真值,且说清为什么)/ 有票(照实画)。
 * 把前两者画成同一个样子,就是 goal §6 第 1 条禁止的那种"看起来对的返回值"。
 *
 * 读侧走**真地图文件**(用真 API 写出来再读回来),不是打桩一个快照 ——
 * 打桩的话 `createPathReader` 那一半就没人测,而它正是会静默出错的一半。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrResumeMap, saveMap } from '../../harness/pathfinder/maps';
import type { Ticket } from '../../harness/pathfinder/types';
import { createTheme } from '../theme';
import { type PathSnapshot, PathHud, createPathReader } from './path-hud';

const theme = createTheme({ color: false });

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket =>
  ({ id, type: 'decision', title: `待决 ${id}`, blockedBy: [], status: 'open', ...over }) as Ticket;

/** 造一个真世界:临时 cwd + 一张真地图(经真 API 写盘)。 */
function world(tickets: Ticket[] | null): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-path-'));
  if (tickets) {
    const { map } = createOrResumeMap(cwd, '把 TUI 做出来');
    map.tickets = tickets;
    saveMap(map, cwd);
  }
  return cwd;
}

const hudFor = (cwd: string) => {
  const h = new PathHud(theme, createPathReader(cwd));
  h.refresh();
  return h;
};

describe('★ 三态分得开', () => {
  test('一张图都没有 → 什么都不画(恒缺席)', () => {
    const h = hudFor(world(null));
    expect(h.render(80)).toEqual([]);
    expect(h.active).toBe(false);
  });

  test('★ 有图有票 → 照实画前沿票(真地图, 经真 API 写盘再读回)', () => {
    const h = hudFor(world([ticket('t1'), ticket('t2')]));
    const out = h.render(100).join('\n');
    expect(out).toContain('把 TUI 做出来');
    expect(out).toContain('t1');
    expect(out).toContain('t2');
  });

  test('★ 有图但前沿为空(全被挡着)→ 画 0 并说清为什么, 不是空白', () => {
    const h = hudFor(world([ticket('a', { status: 'open', blockedBy: ['zzz'] })]));
    const out = h.render(100).join('\n');
    expect(out).toContain('前沿 0');
    expect(out).toContain('被前置票挡着');
  });

  test('★ 有图且全部裁决完 → 也画 0, 但**理由不同**(与被阻塞分得开)', () => {
    const h = hudFor(world([ticket('a', { status: 'ruled', ruling: 'x' })]));
    const out = h.render(100).join('\n');
    expect(out).toContain('前沿 0');
    expect(out).toContain('全部已裁决');
    expect(out).not.toContain('被前置票挡着');
  });
});

describe('读侧', () => {
  test('★ 挑前沿票最多的那张图 —— 按 slug 排第一的很可能是散完雾的老图', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-path-multi-'));
    const a = createOrResumeMap(cwd, 'aaa 老图').map;
    a.tickets = [ticket('old', { status: 'ruled', ruling: 'x' })];
    saveMap(a, cwd);
    const b = createOrResumeMap(cwd, 'zzz 新图').map;
    b.tickets = [ticket('n1'), ticket('n2')];
    saveMap(b, cwd);
    const h = new PathHud(theme, createPathReader(cwd));
    h.refresh();
    expect(h.render(100).join('\n')).toContain('zzz 新图');
  });

  test('★ 读盘抛错 → 画出原因, 不静默变成"没有图"', () => {
    const h = new PathHud(theme, () => {
      throw new Error('盘上那份坏了');
    });
    h.refresh();
    expect(h.render(80).join('\n')).toContain('盘上那份坏了');
    expect(h.active).toBe(true); // 与"没有图"分得开
  });

  test('refresh 之后状态会变(不是只在构造时读一次)', () => {
    let snap: PathSnapshot | null = null;
    const h = new PathHud(theme, () => snap);
    h.refresh();
    expect(h.render(80)).toEqual([]);
    snap = { destination: 'd', slug: 's', frontier: [{ id: 'x', type: 'decision', title: 't' }], blocked: 0, ruled: 0, total: 1 };
    h.refresh();
    expect(h.render(80).join('\n')).toContain('x');
  });
});

describe('宽度', () => {
  test('★ 中文目的地 + 中文票名, 任意宽度不超宽', () => {
    const h = hudFor(world(Array.from({ length: 12 }, (_, i) => ticket(`票${i}`, { title: `一个很长的中文待决问题第${i}号` }))));
    for (const w of [20, 40, 80]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line), `w=${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('票多到画不下时说"另有 N 张", 不静默截断', () => {
    const h = hudFor(world(Array.from({ length: 12 }, (_, i) => ticket(`t${i}`))));
    expect(h.render(100).join('\n')).toContain('另有 7 张前沿票');
  });
});
