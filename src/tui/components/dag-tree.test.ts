/**
 * L2:左栏 DAG 树(切片③)。
 *
 * 反向自检:
 * - 「start/settle 不覆盖父」那条 —— 把 put 的 keepParent 逻辑去掉,树当场变平,
 *   `├─` 断言红(这就是注释里警告的那个静默症状)。
 * - 「换 run 清空」那条 —— 注释掉 beginRun 里的 clear,两个 run 混图,节点数断言红。
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DagTree } from './dag-tree';
import { createTheme } from '../theme';

const theme = createTheme({ color: false });

function fanout(now: () => number = () => 0): DagTree {
  const t = new DagTree(theme, now);
  t.beginRun('run-1');
  t.apply({ type: 'planned', nodes: [{ id: 'plan', kind: 'conductor' }, { id: 'extract', kind: 'map' }] });
  t.apply({
    type: 'expanded',
    parent: 'extract',
    nodes: [
      { id: 'shard-1', kind: 'agent', deps: [] },
      { id: 'shard-2', kind: 'agent', deps: ['shard-1'] },
    ],
  });
  t.apply({ type: 'start', id: 'shard-1', kind: 'agent' });
  t.apply({ type: 'settle', id: 'shard-1', status: 'done', kind: 'agent' });
  return t;
}

describe('DagTree', () => {
  test('没有 run 时什么都不画(无源恒缺席)', () => {
    expect(new DagTree(theme).render(40)).toEqual([]);
  });

  test('★ 分裂画成树: 分片挂在 map 下, 末子 └─ 其余 ├─', () => {
    const lines = fanout().render(40);
    expect(lines[0]).toContain('DAG run-1');
    const body = lines.join('\n');
    expect(body).toContain('├─✓ shard-1');
    expect(body).toContain('└─○ shard-2');
    // 根节点不带分支符 (plan 没 start 过 → ○ pending)
    expect(body).toMatch(/\n○ plan conductor/);
  });

  test('★ start/settle 的 null parent 不许把子节点打回根(树不变平)', () => {
    const t = fanout();
    // start/settle 都发过了 —— shard-1 仍在 extract 下
    const body = t.render(40).join('\n');
    expect(body).toContain('├─✓ shard-1');
  });

  test('换 run 清空 —— 两个 run 的节点不混图', () => {
    const t = fanout();
    t.beginRun('run-2');
    t.apply({ type: 'planned', nodes: [{ id: 'solo', kind: 'agent' }] });
    const body = t.render(40).join('\n');
    expect(body).toContain('DAG run-2');
    expect(body).not.toContain('shard-1');
    expect(t.size).toBe(1);
  });

  test('时间记事件到达时刻; settle 先于 start 到 (乱序) 画零长, 不编时长', () => {
    let clock = 100;
    const t = new DagTree(theme, () => clock);
    t.beginRun('r');
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }] });
    clock = 200;
    t.apply({ type: 'start', id: 'a', kind: 'agent' });
    clock = 500;
    t.apply({ type: 'settle', id: 'a', status: 'done', kind: 'agent' });
    const [a] = t.snapshot().nodes;
    expect(a!.startAt).toBe(200);
    expect(a!.endAt).toBe(500);
    // 乱序: 只有 settle
    t.apply({ type: 'settle', id: 'b', status: 'failed', kind: 'agent' });
    const b = t.snapshot().nodes.find((n) => n.id === 'b')!;
    expect(b.startAt).toBe(b.endAt); // 零长, 不是编出来的时长
  });

  test('每行过宽度闸(窄侧栏也不超宽)', () => {
    const t = fanout();
    for (const w of [20, 34, 80]) {
      for (const line of t.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
    }
  });
});
