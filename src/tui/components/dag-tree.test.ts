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

describe('C-1 未知事件不破消费者 (SDD 2026-08-11)', () => {
  // 反向自检 (本组三条): 老 apply 的兜底分支把任何未知事件当 settle 处理,
  // 用 `e.id` 造节点 —— 对老实现跑, size/render 断言当场红 (幽灵节点上屏, D-7 grill F1)。
  test('词表外 type → 不 throw、不造节点、渲染不变', () => {
    const t = fanout();
    const before = t.render(40).join('\n');
    expect(() => t.apply({ type: 'blorp', id: 'ghost' } as never)).not.toThrow();
    expect(t.size).toBe(4); // fanout: plan/extract/shard-1/shard-2 —— 没有 ghost
    expect(t.render(40).join('\n')).toBe(before);
  });

  test('replan (无 id) → 不造幽灵节点 —— 老实现 put(undefined) 会让 size 涨', () => {
    const t = fanout();
    expect(() => t.apply({ type: 'replan', parent: 'extract', round: 1, poisoned: ['shard-2'] })).not.toThrow();
    expect(t.size).toBe(4);
    expect(t.snapshot().nodes.some((n) => n.id === 'undefined' || n.id === undefined)).toBe(false);
  });

  test('缺 type 的畸形对象 → 不 throw、不造节点、渲染不变', () => {
    const t = fanout();
    const before = t.render(40).join('\n');
    expect(() => t.apply({ id: 'ghost' } as never)).not.toThrow();
    expect(t.size).toBe(4);
    expect(t.render(40).join('\n')).toBe(before);
  });
});

describe('C-6 画法 (SDD 2026-08-11)', () => {
  test('① running 节点行带活秒数, 随 render tick 递增 (D-5: 现算 now()-startAt, 不烘进事件)', () => {
    let clock = 1_000;
    const t = new DagTree(theme, () => clock);
    t.beginRun('r');
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }] });
    t.apply({ type: 'start', id: 'a', kind: 'agent' });
    const line = t.render(40)[1]; // [0] 是头行
    expect(line).toContain('0.0s');
    clock = 3_000; // 同一个事件, 只过了墙钟 → 秒数必须变
    const line2 = t.render(40)[1];
    expect(line2).toContain('2s');
    expect(line2).not.toBe(line);
    // 反向自检: 把秒数在事件到达时算死存进节点 → 两次 render 同一串, 断言红。
  });

  test('① settle 耗时真源 = durationMs (引擎墙钟); 缺席回落到达间隔 (D-5)', () => {
    let clock = 100;
    const t = new DagTree(theme, () => clock);
    t.beginRun('r');
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }] });
    t.apply({ type: 'start', id: 'a', kind: 'agent' });
    clock = 200;
    t.apply({ type: 'settle', id: 'a', status: 'done', kind: 'agent', durationMs: 5_000 });
    clock = 700;
    t.apply({ type: 'start', id: 'b', kind: 'agent' });
    clock = 1_200; // 到达间隔 500ms —— 与 a 的引擎墙钟 5s 对比
    t.apply({ type: 'settle', id: 'b', status: 'done', kind: 'agent' });
    const lines = t.render(40).join('\n');
    expect(lines).toContain('✓ a agent 5s'); // 引擎墙钟优先 —— 到达间隔只有 100ms
    expect(lines).toContain('✓ b agent 0.5s'); // 老发射点 → 回落到达间隔 500ms
    // 反向自检: 渲染只用到达间隔 → a 行画 0.1s, 断言红。
  });

  test('② failed 节点下一行缩进画 failReason', () => {
    const t = fanout();
    t.apply({ type: 'settle', id: 'shard-2', status: 'failed', kind: 'agent', failReason: 'assertion failed: nope' });
    const lines = t.render(40);
    const row = lines.findIndex((l) => l.includes('shard-2 agent'));
    expect(row).toBeGreaterThanOrEqual(0);
    const rowLine = lines[row]!; // row 由 findIndex 保证存在
    expect(lines[row + 1]).toContain('assertion failed: nope'); // 紧挨着下一行 = "下一行"
    // 缩进: 原因文本与节点行里的 **id 同列** (子行对齐内容列, 即"这一行的注解")。
    expect(lines[row + 1]!.indexOf('assertion failed: nope')).toBe(rowLine.indexOf('shard-2'));
    // 反向自检: 去掉 failReason 子行 → lines[row+1] 是 shard-3 的行, 断言红。
  });

  test('③ 审核判决画子行 ✗/✓ <gate> r<N>: <reason> (pass 用 ✓, D-9)', () => {
    const t = fanout();
    t.apply({ type: 'verdict', id: 'shard-1', gate: 'judge', verdict: 'pass', round: 1 });
    t.apply({ type: 'verdict', id: 'shard-2', gate: 'verifier', verdict: 'fail', round: 1, reason: 'contradicts source' });
    const lines = t.render(40).join('\n');
    expect(lines).toContain('✓ judge r1');
    expect(lines).toContain('✗ verifier r1: contradicts source');
    // 反向自检: 去掉 verdict 子行 → 两条断言红。
  });

  test('④ progress 的 tool/note 出现在节点行尾', () => {
    const t = fanout();
    t.apply({ type: 'start', id: 'shard-3', kind: 'agent' });
    t.apply({ type: 'progress', id: 'shard-3', tool: 'bash', note: 'edit engine.ts', calls: 2, elapsedMs: 900 });
    // 宽行才看得到 progress 尾巴 (侧栏 34 列会截掉, 那是"少看半句"不是画法错)。
    const line = t.render(80).find((l) => l.includes('shard-3 agent'));
    expect(line).toContain('[bash edit engine.ts]');
    // 反向自检: 去掉行尾 progress 段 → 断言红。
  });
});
