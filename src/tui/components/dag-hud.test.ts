/**
 * L2 判据:DAG 活体 HUD(TUI SDD §6,切片 S11)。
 *
 * 吃的是引擎的 `DagNodeEvent`(进程内直订阅,owner 已拍板),不是 `.omd/hud/dag.json` ——
 * 那个文件是 statusline 的数据源,**加 TUI 不许把它断掉**(那条闸在 `assemble` 侧)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { DagNodeEvent } from '../../harness/executor-dag-types';
import { createTheme } from '../theme';
import { DagHud, roleOf } from './dag-hud';

const theme = createTheme({ color: false });
const make = (seat: string | null = 'kimi-coding:k3') => new DagHud(theme, () => seat);
const text = (h: DagHud, w = 80) => h.render(w).join('\n');

const planned = (...ids: [string, string][]): DagNodeEvent => ({
  type: 'planned',
  nodes: ids.map(([id, kind]) => ({ id, kind })),
});

describe('★ 无源恒缺席', () => {
  test('没有 run 时什么都不画 —— 画空表或 0% 的条会读成"有个 run 但没动"', () => {
    expect(make().render(80)).toEqual([]);
    expect(make().active).toBe(false);
  });
});

describe('角色映射(owner 裁决 ③:关系 = conductor / leaf / verifier)', () => {
  test('kind → 角色走一张表', () => {
    expect(roleOf('agent')).toBe('leaf');
    expect(roleOf('command')).toBe('leaf');
    expect(roleOf('judge')).toBe('verifier');
    expect(roleOf('gate')).toBe('verifier');
    expect(roleOf('map')).toBe('conductor');
  });

  test('★ 没见过的 kind 报 unknown —— 不猜。猜错了画面上是个看起来很确定的错分类', () => {
    expect(roleOf('某种新节点')).toBe('unknown');
  });

  test('★ 顶部关系行把三档数出来', () => {
    const h = make();
    h.apply(planned(['a', 'agent'], ['b', 'command'], ['j', 'judge']));
    expect(text(h)).toContain('conductor kimi-coding:k3 -> leaf 2 -> verifier 1');
  });

  test('座位未知时说"未知座位", 不编一个', () => {
    const h = make(null);
    h.apply(planned(['a', 'agent']));
    expect(text(h)).toContain('(未知座位)');
  });
});

describe('逐节点变', () => {
  test('★ planned → start → settle 三步各自反映在屏上', () => {
    const h = make();
    h.apply(planned(['n1', 'agent']));
    expect(text(h)).toContain('待跑');
    h.apply({ type: 'start', id: 'n1', kind: 'agent' });
    expect(text(h)).toContain('在跑');
    h.apply({ type: 'settle', id: 'n1', status: 'done', kind: 'agent', model: 'deepseek-v4-flash' });
    const out = text(h);
    expect(out).toContain('ok');
    expect(out).toContain('deepseek-v4-flash');
  });

  test('★ expanded 的子节点也进图 —— 少了它, 一个 map 节点在 HUD 上永远只有一个点', () => {
    const h = make();
    h.apply(planned(['m', 'map']));
    expect(h.size).toBe(1);
    h.apply({ type: 'expanded', parent: 'm', nodes: [{ id: 'c1', kind: 'agent', deps: [] }, { id: 'c2', kind: 'agent', deps: [] }] });
    expect(h.size).toBe(3);
  });

  test('★ settle 之后模型名不许丢 —— 后续事件覆盖时要保住已知的那一格', () => {
    const h = make();
    h.apply({ type: 'settle', id: 'n', status: 'done', kind: 'agent', model: 'm1' });
    h.apply({ type: 'start', id: 'n', kind: 'agent' }); // 重跑
    expect(text(h)).toContain('m1');
  });

  test('★ 换 run 清空上一个 —— 不清的话两个 run 的节点混成一张表', () => {
    const h = make();
    h.apply(planned(['old', 'agent']));
    h.beginRun('run-2');
    h.apply(planned(['new', 'agent']));
    const out = text(h);
    expect(out).toContain('new');
    expect(out).not.toContain('old');
  });

  test('在跑的排在前面 —— HUD 是看"现在怎么样"的, 不是流水账', () => {
    const h = make();
    h.apply(planned(['a', 'agent'], ['b', 'agent']));
    h.apply({ type: 'settle', id: 'a', status: 'done', kind: 'agent' });
    h.apply({ type: 'start', id: 'b', kind: 'agent' });
    const body = text(h);
    expect(body.indexOf('b')).toBeLessThan(body.indexOf('a', body.indexOf('节点')));
  });
});

describe('宽度', () => {
  test('★ 任意宽度下每一行都不超宽(节点名是中文)', () => {
    const h = make();
    h.apply(planned(...(Array.from({ length: 30 }, (_, i) => [`很长的中文节点名字第${i}个`, 'agent'] as [string, string]))));
    h.apply({ type: 'start', id: '很长的中文节点名字第0个', kind: 'agent' });
    for (const w of [20, 40, 80, 120]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line), `w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('★ 节点多到画不下时说"另有 N 个", 不是静默截断', () => {
    const h = make();
    h.apply(planned(...(Array.from({ length: 40 }, (_, i) => [`n${i}`, 'agent'] as [string, string]))));
    expect(text(h)).toContain('另有 28 个节点');
  });
});
