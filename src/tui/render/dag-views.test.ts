/**
 * L1:全屏两画法(切片③)—— 泳道甘特 + 分层依赖。纯函数,时钟全注入。
 *
 * 反向自检:
 * - 甘特「在跑的条画到现在」—— 把 renderGantt 里 `n.endAt ?? o.now` 改成 `?? s`,
 *   「shard-3 在跑」那条当场红(条长为 0,'在跑' 标签也没了)。
 * - 分层「循环依赖不死循环」—— 把 layerOf 的 visiting 守卫去掉,那条用例直接挂死。
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DagSnapshot, TreeNode } from '../components/dag-tree';
import { fmtDur, renderGantt } from './dag-gantt';
import { layerOf, renderLayers } from './dag-layers';

const node = (over: Partial<TreeNode> & { id: string }): TreeNode => ({
  kind: 'agent',
  status: 'done',
  parent: null,
  deps: [],
  seq: 0,
  startAt: null,
  endAt: null,
  ...over,
});

const snap = (nodes: TreeNode[]): DagSnapshot => ({ runLabel: 'r1', nodes });

describe('fmtDur', () => {
  test('秒/分的换算', () => {
    expect(fmtDur(400)).toBe('0.4s');
    expect(fmtDur(42_000)).toBe('42s');
    expect(fmtDur(71_000)).toBe('1m11s');
    expect(fmtDur(120_000)).toBe('2m');
  });
});

describe('renderGantt', () => {
  test('没动过的节点不画空条, 收进尾行计数', () => {
    const out = renderGantt(snap([node({ id: 'a' }), node({ id: 'b' })]), { width: 80, height: 20, now: 0 });
    expect(out[1]).toContain('no node has moved yet');
  });

  test('★ 在跑的条画到"现在"并标「在跑」; 完成的标时长', () => {
    const out = renderGantt(
      snap([
        node({ id: 'done-1', status: 'done', startAt: 0, endAt: 42_000, seq: 0 }),
        node({ id: 'live-1', status: 'running', startAt: 10_000, endAt: null, seq: 1 }),
      ]),
      { width: 80, height: 20, now: 60_000 },
    );
    const body = out.join('\n');
    expect(body).toContain('done-1');
    expect(body).toContain('42s');
    expect(body).toContain('running');
    // 头行写明度量来源 —— 事件到达时刻, 不冒充引擎墙钟
    expect(out[0]).toContain('event arrival time');
  });

  test('高度封顶: 剪掉的说清剪了多少', () => {
    const many = Array.from({ length: 30 }, (_, i) => node({ id: `n${i}`, startAt: i, endAt: i + 1, seq: i }));
    const out = renderGantt(snap(many), { width: 80, height: 10, now: 100 });
    expect(out.length).toBe(10);
    expect(out[9]).toContain('more lines');
  });

  test('每行不超宽', () => {
    const out = renderGantt(
      snap([node({ id: 'x'.repeat(50), startAt: 0, endAt: 1000 })]),
      { width: 60, height: 20, now: 2000 },
    );
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });
});

describe('layerOf / renderLayers', () => {
  test('层 = max(父层, 依赖层) + 1; planned 根在 L0', () => {
    const nodes = [
      node({ id: 'plan' }),
      node({ id: 'extract' }),
      node({ id: 'shard-1', parent: 'extract' }),
      node({ id: 'merge', deps: ['shard-1'] }),
    ];
    const layers = layerOf(nodes);
    expect(layers.get('plan')).toBe(0);
    expect(layers.get('shard-1')).toBe(1);
    expect(layers.get('merge')).toBe(2);
  });

  test('★ 循环依赖不死循环(按已算出的值封顶)', () => {
    const nodes = [node({ id: 'a', deps: ['b'] }), node({ id: 'b', deps: ['a'] })];
    const layers = layerOf(nodes);
    expect(layers.size).toBe(2); // 算完了 = 没转圈
  });

  test('fan-in (deps ≥ 2) 标出来; 依赖边画在行尾; 头行写明分层依据', () => {
    const out = renderLayers(
      snap([
        node({ id: 'a' }),
        node({ id: 'b' }),
        node({ id: 'join', deps: ['a', 'b'] }),
      ]),
      { width: 80, height: 20 },
    );
    const body = out.join('\n');
    expect(out[0]).toContain('by split / known deps');
    expect(body).toContain('L0');
    expect(body).toContain('L1');
    expect(body).toContain('join (agent)  <- a, b  [fan-in]');
  });

  test('空快照返回空数组(无源恒缺席); 高度封顶', () => {
    expect(renderLayers({ runLabel: null, nodes: [] }, { width: 80, height: 10 })).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => node({ id: `n${i}` }));
    const out = renderLayers(snap(many), { width: 80, height: 10 });
    expect(out.length).toBe(10);
    expect(out[9]).toContain('more lines');
  });
});
