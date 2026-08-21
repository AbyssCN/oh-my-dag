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
import { DagTree, runUsage } from './dag-tree';
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

/**
 * run 级词元合计(2026-08-21)。
 *
 * 它要杀死的失效形态:`settle` 事件**一直带着** `usage:{in,out}`(`dag/types.ts:493-494`),
 * 而 TUI **收下就扔** —— 于是「这一次 run 花了多少」在 TUI 上一处都没有。
 * 底栏那行答的是另一个问题(**进程级** 5h 窗口,切 `/session` 都不清零)。
 *
 * 证伪方式:删掉 `apply` 里 `if (e.usage !== undefined) n.usage = e.usage;` → 第一条红;
 * 把 `runUsage` 的 `withUsage.length === 0 → null` 改成返回 0 → 「无源恒缺席」那条红;
 * 把 `partial` 恒设 false → 「下界」那条红。
 */
describe('runUsage — 这一次 run 花了多少', () => {
  const mk = (): DagTree => new DagTree(createTheme({ color: false }), () => 1000);
  const settle = (t: DagTree, id: string, usage?: { in: number; out: number }): void =>
    t.apply({ type: 'settle', id, status: 'done', kind: 'agent', ...(usage ? { usage } : {}) });

  test('★ settle 带的 usage 真的被收下并合计 (此前收下就扔)', () => {
    const t = mk();
    settle(t, 'a', { in: 1200, out: 300 });
    settle(t, 'b', { in: 800, out: 200 });
    const u = runUsage(t.snapshot().nodes);
    expect(u).toEqual({ in: 2000, out: 500, partial: false });
    expect(t.render(80)[0]).toContain('2.5k tok');
  });

  test('★ 无源恒缺席: 一个都没报 → null, 头行整段不画 (不许画 0 tok 冒充没花钱)', () => {
    const t = mk();
    settle(t, 'a');
    settle(t, 'b');
    expect(runUsage(t.snapshot().nodes)).toBeNull();
    expect(t.render(80)[0]).not.toContain('tok');
  });

  test('★ 下界要标出来: 有定局节点没报 → partial, 渲染带 `+` (同 statusbar 的 $0.00+)', () => {
    const t = mk();
    settle(t, 'a', { in: 1000, out: 0 });
    settle(t, 'b'); // 老发射点, 没报
    const u = runUsage(t.snapshot().nodes)!;
    expect(u.partial).toBe(true);
    expect(t.render(80)[0]).toContain('1.0k+ tok');
  });

  test('还在跑的不算进「谁没报」—— 它本来就还没有 usage', () => {
    const t = mk();
    settle(t, 'a', { in: 1000, out: 0 });
    t.apply({ type: 'start', id: 'b', kind: 'agent' });
    expect(runUsage(t.snapshot().nodes)!.partial).toBe(false);
  });
});

/**
 * 「是哪个闸拦的」(2026-08-21)。
 *
 * 它要杀死的失效形态:七个闸里只有三类发 `verdict`(judge / gate 谎报完成 / verifier);
 * **心跳闸 `stall`、空转熔断 `spin-fused`、产物闸、`expect_exit` oracle、轮数耗尽全部只以
 * `settle{failed}` 露面**,而 `failureKind` 此前**不在事件字段里** —— 它只进 checkpoint。
 * 于是观测面只画得出一句被截断的错误原文,画不出闸名。
 *
 * 证伪方式:删掉 `engine.ts` settleEvent 里那行 `...(r.failureKind ? ...)` → 引擎侧不再带,
 * 本组第一条红;删掉 `dag-tree.ts` 渲染里的 `why` 前缀 → 同样红。
 */
describe('failureKind — 是哪个闸拦的', () => {
  const mk = (): DagTree => new DagTree(createTheme({ color: false }), () => 1000);

  test('★ 成因作为前缀画在失败子行上 (心跳闸这类不发 verdict 的, 全靠它)', () => {
    const t = mk();
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }] });
    t.apply({ type: 'settle', id: 'a', status: 'failed', kind: 'agent', failReason: 'provider 30s 无字节', failureKind: 'stall' });
    const body = t.render(100).join('\n');
    expect(body).toContain('[stall] provider 30s 无字节');
  });

  test('★ 缺席 ≠ unclassified: 老发射点没带成因 → 只画原文, 不编一个出来充数', () => {
    const t = mk();
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }] });
    t.apply({ type: 'settle', id: 'a', status: 'failed', kind: 'agent', failReason: '某个老失败' });
    const body = t.render(100).join('\n');
    expect(body).toContain('某个老失败');
    expect(body).not.toContain('[');
  });

  test('空转熔断与心跳闸分得开 —— 两者的下一步正好相反', () => {
    const t = mk();
    t.apply({ type: 'planned', nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }] });
    t.apply({ type: 'settle', id: 'a', status: 'failed', kind: 'agent', failReason: 'x', failureKind: 'stall' });
    t.apply({ type: 'settle', id: 'b', status: 'failed', kind: 'agent', failReason: 'y', failureKind: 'spin-fused' });
    const body = t.render(100).join('\n');
    expect(body).toContain('[stall]');
    expect(body).toContain('[spin-fused]');
  });
});
