/**
 * L1:DAG 屏 v2(片 4 切片 1)—— 纯函数渲染器,时钟全注入。
 *
 * GWT 直引 SDD §契约,每条 INV 一条用例 + 反向自检写在注释里。临时改实现 → 该条当场红。
 *
 * ## 闸的覆盖
 *   - ★ INV-DAG-1: fan-in 节点只画一次,deps[0] 之外的依赖标行尾 `╋ +<id>,<id>`
 *   - ★ INV-DAG-2-1: pending 不画 `0s`,画 `—`;整个输出不含 `0s`
 *   - ★ INV-DAG-2-2: failureKind 缺席 → 不编 `[unclassified]`,只画失败原文
 *   - ★ INV-DAG-3: 无 startAt → 整条时间条不画(没有 `█`)
 *   - ★ INV-DAG-4: 120/84/70/60 四个宽度,每行 visibleWidth <= width;60 列不含 `█` 也不含 model 串
 *   - ★ INV-DAG-5-1: done 节点选中 → 不含 `重跑`
 *   - ★ INV-DAG-5-2: 同一张图里 failed 节点选中 → 含 `r` 与 `重跑`
 *   - ★ INV-DAG-6: 判词展开含 `判词的 pass/fail 指的是被审对象`
 *   - ★ INV-DAG-8: 空快照 → `[]`(无源恒缺席)
 *   - ★ INV-DAG-9: 加 paint 与不加 paint 逐字节相等(结构信息不靠色)
 */
import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DagSnapshot, TreeNode, VerdictLine } from '../components/dag-tree';
import { renderDagScreen } from './dag-screen';

const node = (over: Partial<TreeNode> & { id: string; model?: string }): TreeNode => ({
  kind: 'agent',
  status: 'pending',
  parent: null,
  deps: [],
  seq: 0,
  startAt: null,
  endAt: null,
  verdicts: [],
  ...over,
});

const snap = (nodes: TreeNode[], label: string | null = 'r1'): DagSnapshot => ({
  runLabel: label,
  nodes,
});

const verdict = (over: Partial<VerdictLine>): VerdictLine => ({
  gate: 'verifier',
  verdict: 'fail',
  round: 1,
  ...over,
});

const NOW = 12_000;

/** 钉死的渲染选项: 大宽度(时间条 + model 都画得下),选中 = 0。 */
const opts = (
  over: Partial<{ width: number; height: number; selected: number; now: number; paint: import('./dag-screen').DagPaint }> = {},
) => ({
  width: 120,
  height: 40,
  selected: 0,
  now: NOW,
  ...over,
});

describe('★ INV-DAG-8 无源恒缺席', () => {
  // 反向自检: 把 `if (snap.nodes.length === 0) return [];` 去掉 → 红(有节点才画)。
  test('空快照 → []', () => {
    expect(renderDagScreen(snap([]), opts())).toEqual([]);
  });

  test('空快照,宽度=0 也返回 []', () => {
    expect(renderDagScreen(snap([]), opts({ width: 0 }))).toEqual([]);
  });
});

describe('★ INV-DAG-1 fan-in 节点只画一次,deps[1..] 标行尾', () => {
  // 反向自检: 把 `n.deps.length > 1` 那段注释掉 → 整段输出不含 `╋ +`,红;
  //          把 `kids = n.deps[0] === parent` 改成遍历所有 deps → fan-in 节点画两遍,红。
  test('merge 节点 deps=[shard-1, shard-2],画一次,行尾带 ╋ +shard-2', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'plan', status: 'done', seq: 0 }),
        node({ id: 'shard-1', deps: ['plan'], status: 'done', seq: 1, startAt: 0, endAt: 4000 }),
        node({ id: 'shard-2', deps: ['plan'], status: 'done', seq: 2, startAt: 0, endAt: 4000 }),
        node({ id: 'merge', deps: ['shard-1', 'shard-2'], status: 'done', seq: 3, startAt: 4000, endAt: 5000 }),
      ]),
      opts(),
    );
    const body = out.join('\n');
    // 节点 id merge 只出现一次
    expect(body.split('merge').length - 1).toBe(1);
    // 那一行带 ╋ + 与另一个上游 shard-2
    const mergeLine = out.find((l) => /merge\b/.test(l));
    expect(mergeLine).toBeDefined();
    expect(mergeLine!).toContain('╋ +');
    expect(mergeLine!).toContain('shard-2');
    // fan-in 行**不**含两个 ├─ 父链 (子树画一次而不是两次)
    expect(body).not.toMatch(/└─.*merge.*└─/);
  });

  test('deps 长度 1 → 不画 ╋ + (INV-DAG-1 的反面对照)', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'a', seq: 0 }),
        node({ id: 'b', deps: ['a'], seq: 1 }),
      ]),
      opts(),
    );
    const body = out.join('\n');
    expect(body).not.toContain('╋ +');
  });
});

describe('★ INV-DAG-2 缺席 ≠ 0 ≠ 不适用', () => {
  // 反向自检: 把 `n.status === 'pending' ? '—' : fmtDur(durMs)` 改成无条件 fmtDur(0)
  //          → 输出含 `0s`,红; 把 `modelCell` 改成 `modelVal ?? '0'` → 含 `0`, 红(本测试不动 model 这条)。
  test('pending 节点: 用时列是 `—`,整个输出不含 `0s`', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'a', status: 'pending', seq: 0 }),
        node({ id: 'b', status: 'pending', seq: 1 }),
      ]),
      opts(),
    );
    const body = out.join('\n');
    expect(body).toContain('—');
    expect(body).not.toContain('0s');
    // 用时列必须是 `—`(而非空白、问号、placeholder)
    const aLine = out.find((l) => /\ba\b/.test(l));
    expect(aLine).toBeDefined();
    expect(aLine!).toMatch(/—/);
  });

  test('全 pending 节点的图: 不含 `0s`,长度仍 > 0(不是无源)', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'p1', seq: 0 }),
        node({ id: 'p2', seq: 1 }),
        node({ id: 'p3', seq: 2 }),
      ]),
      opts(),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.join('\n')).not.toContain('0s');
  });

  // 反向自检: 把 `if (n.failureKind) `[${n.failureKind}] `` 那种"补一个 unclassified"加回去
  //          → 输出含 `[unclassified]`,红。
  test('失败记录无 failureKind → 输出不含 `[unclassified]`,只画原文', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'shard-3', status: 'failed', startAt: 3000, endAt: 9100, failReason: 'tsc: RunId 不存在' }),
      ]),
      opts(),
    );
    const body = out.join('\n');
    expect(body).not.toContain('[unclassified]');
    expect(body).not.toContain('unclassified');
    // 失败原文还在
    expect(body).toContain('tsc: RunId 不存在');
  });

  test('失败记录带 failureKind → `[kind]` 前缀可以出现', () => {
    const out = renderDagScreen(
      snap([
        node({
          id: 'shard-3',
          status: 'failed',
          startAt: 3000,
          endAt: 9100,
          failReason: 'tsc: RunId 不存在',
          failureKind: 'empty-artifact',
        }),
      ]),
      opts(),
    );
    // 头行里节点行不含 `[empty-artifact]`(前缀是为闸归类,不在节点行加),但允许其它形态
    // 这里钉的是"不要硬塞 unclassified",所以只要不含 unclassified 就行
    expect(out.join('\n')).not.toContain('unclassified');
  });
});

describe('★ INV-DAG-3 甘特不画空条', () => {
  // 反向自检: 把 `if (showBar && n.startAt !== null)` 改成无条件画一条
  //          → 没 startAt 的节点那一行出现 `█`,红。
  test('既无 startAt 也无 endAt 的节点: 那一行无 `█`', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'pending-1', status: 'pending', seq: 0 }),
      ]),
      opts({ width: 120 }),
    );
    const line = out.find((l) => /\bpending-1\b/.test(l));
    expect(line).toBeDefined();
    expect(line!).not.toContain('█');
  });

  test('running 节点无 endAt: 条画到 now(含 `█`)', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'live', status: 'running', startAt: NOW - 4000, endAt: null, seq: 0 }),
      ]),
      opts({ width: 120, now: NOW }),
    );
    const body = out.join('\n');
    expect(body).toContain('█');
  });

  test('done 节点有 startAt+endAt: 条画到 endAt', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'done-1', status: 'done', startAt: 1000, endAt: 5000, seq: 0 }),
      ]),
      opts({ width: 120 }),
    );
    const body = out.join('\n');
    expect(body).toContain('█');
  });
});

describe('★ INV-DAG-4 列宽随屏宽退让', () => {
  // 反向自检: 把 showBar/showModel 阈值改 → 60 列那次输出含 `█` 或 model 串,红。
  // 反向自检: 拿 fitLine 替成不截断 → visibleWidth 超 width,红。
  const sample = (): DagSnapshot =>
    snap([
      node({ id: 'plan', kind: 'conductor', status: 'done', seq: 0, startAt: 0, endAt: 2100, model: 'kimi:k2' }),
      node({ id: 'shard-1', kind: 'agent', deps: ['plan'], status: 'done', seq: 1, startAt: 3000, endAt: 14200, model: 'deepseek:v3' }),
      node({ id: 'shard-2', kind: 'agent', deps: ['plan'], status: 'done', seq: 2, startAt: 3000, endAt: 21500, model: 'deepseek:v3' }),
      node({ id: 'merge', kind: 'inproc', deps: ['shard-1', 'shard-2'], status: 'done', seq: 3, startAt: 21500, endAt: 22000 }),
    ]);

  test('120 / 84 / 70 / 60 四档宽度,每行 visibleWidth <= width', () => {
    for (const w of [120, 84, 70, 60]) {
      const out = renderDagScreen(sample(), opts({ width: w }));
      for (const line of out) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  test('60 列那次: 不含 `█`(时间条已丢),也不含 model 串', () => {
    const out = renderDagScreen(sample(), opts({ width: 60 }));
    const body = out.join('\n');
    expect(body).not.toContain('█');
    // model 列已丢, 节点里的 model 串(deepseek:v3 / kimi:k2)不应出现在树行
    expect(body).not.toContain('deepseek:v3');
    expect(body).not.toContain('kimi:k2');
  });

  test('120 列那次: bar + model 都在(正向对照,确认大宽度下两列都画)', () => {
    const out = renderDagScreen(sample(), opts({ width: 120 }));
    const body = out.join('\n');
    expect(body).toContain('█');
    expect(body).toContain('deepseek:v3');
  });
});

describe('★ INV-DAG-5 选中就地展开', () => {
  // 反向自检: 把 `if (n.status === 'failed' || n.kind === 'await')` 那段去掉
  //          → done 节点选中那一屏也含 `重跑`,红。
  const withDoneAndFailed = (): DagSnapshot =>
    snap([
      node({ id: 'plan', status: 'done', seq: 0, startAt: 0, endAt: 2100 }),
      node({ id: 'shard-3', status: 'failed', deps: ['plan'], seq: 1, startAt: 3000, endAt: 9100, failReason: 'tsc 错' }),
      node({ id: 'verify', status: 'failed', deps: ['shard-3'], seq: 2, startAt: 10000, endAt: 15000, failReason: 'verifier 没过' }),
    ]);

  test('done 节点被选中: 不含 `重跑`(无下一步提示)', () => {
    const out = renderDagScreen(withDoneAndFailed(), opts({ selected: 0 }));
    expect(out.join('\n')).not.toContain('重跑');
  });

  test('同一张图里 failed 节点被选中: 含 `r` 与 `重跑`', () => {
    // selected=1 → shard-3 (failed)
    const out = renderDagScreen(withDoneAndFailed(), opts({ selected: 1 }));
    const body = out.join('\n');
    expect(body).toContain('重跑');
    // r 键标注存在(键位行也有 ↑↓ ... r/i/s, 所以放宽到行内, 只要"含 r"就行)
    expect(body).toContain('r');
  });

  test('失败原文只在 failed 节点选中时画(其他节点展开无 `✗ tsc 错`)', () => {
    const out = renderDagScreen(withDoneAndFailed(), opts({ selected: 0 }));
    // done 节点展开里**不**带 failReason 那一行(失败原文只画在被选中的 failed 上)
    expect(out.join('\n')).not.toContain('tsc 错');
  });

  test('(按键未接线) 提示必须出现(SDD: 不许画一个点了没反应的入口)', () => {
    const out = renderDagScreen(withDoneAndFailed(), opts({ selected: 1 }));
    expect(out.join('\n')).toContain('按键未接线');
  });

  test('上游失败节点: verify 选中时,展开里指明上游 shard-3 挂了', () => {
    const out = renderDagScreen(withDoneAndFailed(), opts({ selected: 2 }));
    const body = out.join('\n');
    expect(body).toContain('上游');
    expect(body).toContain('shard-3');
  });
});

describe('★ INV-DAG-6 判词的 pass/fail 指的是被审对象', () => {
  // 反向自检: 把 `判词的 pass/fail 指的是被审对象` 那句限定行去掉
  //          → 该段不含此句,红。
  test('verdict: fail 展开 → 含这句限定', () => {
    const out = renderDagScreen(
      snap([
        node({
          id: 'verify',
          status: 'failed',
          startAt: 10000,
          endAt: 15000,
          failReason: 'shard-3 没修',
          verdicts: [verdict({ gate: 'verifier', verdict: 'fail', reason: 'shard-3 没修' })],
          seq: 0,
        }),
      ]),
      opts({ selected: 0 }),
    );
    const body = out.join('\n');
    expect(body).toContain('判词的 pass/fail 指的是被审对象');
    expect(body).toContain('verifier');
    expect(body).toContain('fail');
  });

  test('verdict: pass 展开 → 含这句限定(不只 fail 要)', () => {
    const out = renderDagScreen(
      snap([
        node({
          id: 'gate',
          status: 'done',
          startAt: 10000,
          endAt: 12000,
          verdicts: [verdict({ gate: 'judge', verdict: 'pass' })],
          seq: 0,
        }),
      ]),
      opts({ selected: 0 }),
    );
    expect(out.join('\n')).toContain('判词的 pass/fail 指的是被审对象');
  });

  test('pending / running 节点的 verdict 不画(还没结果)', () => {
    const out = renderDagScreen(
      snap([
        node({
          id: 'live',
          status: 'running',
          startAt: NOW - 1000,
          endAt: null,
          verdicts: [verdict({ gate: 'verifier', verdict: 'fail' })],
          seq: 0,
        }),
      ]),
      opts({ selected: 0 }),
    );
    expect(out.join('\n')).not.toContain('判词的 pass/fail 指的是被审对象');
  });
});

describe('★ INV-DAG-9 结构信息不靠颜色', () => {
  // 反向自检: 给某行加 `\x1b[33m` 之类的色码 → 剥掉 paint 后行不等,红。
  test('plain(无 paint)与带 paint 渲染后,剥色逐字节相等', () => {
    const s: DagSnapshot = snap([
      node({ id: 'a', status: 'done', startAt: 0, endAt: 1000, seq: 0 }),
      node({ id: 'b', deps: ['a'], status: 'failed', startAt: 1000, endAt: 2000, failReason: 'x', seq: 1 }),
    ]);
    // NO_COLOR 等价: 不传 paint
    const a = renderDagScreen(s, opts({ selected: 1 }));
    // 加 paint(用 ANSI SGR 当 dummy): 渲染层只要 paint 钩子不破坏字节顺序, 剥色后应相等
    const fakePaint = {
      accent: (t: string) => `\x1b[34m${t}\x1b[0m`,
      dim: (t: string) => `\x1b[2m${t}\x1b[0m`,
      warn: (t: string) => `\x1b[33m${t}\x1b[0m`,
      sel: (t: string) => `\x1b[1;36m${t}\x1b[0m`,
      ok: (t: string) => `\x1b[32m${t}\x1b[0m`,
      fail: (t: string) => `\x1b[31m${t}\x1b[0m`,
    };
    const b = renderDagScreen(s, opts({ selected: 1, paint: fakePaint }));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      const aLine = a[i]!;
      const bLine = b[i]!;
      // 剥掉 SGR: \x1b\[...m
      const stripped = bLine.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toBe(aLine);
    }
  });

  test('选中用 `▸`(结构信息不靠色)', () => {
    const out = renderDagScreen(
      snap([
        node({ id: 'a', status: 'done', startAt: 0, endAt: 1000, seq: 0 }),
      ]),
      opts({ selected: 0 }),
    );
    // `▸` 必须出现在选中行的行首那一格
    const aLine = out.find((l) => /\ba\b/.test(l));
    expect(aLine).toBeDefined();
    expect(aLine!).toContain('▸');
  });
});

describe('基础格式', () => {
  test('返回 string[]', () => {
    const out = renderDagScreen(
      snap([node({ id: 'a', status: 'done', startAt: 0, endAt: 1000, seq: 0 })]),
      opts(),
    );
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  test('头行带 runLabel', () => {
    const out = renderDagScreen(
      snap([node({ id: 'a', status: 'done', startAt: 0, endAt: 1000, seq: 0 })], 'my-run'),
      opts(),
    );
    expect(out[0]).toContain('my-run');
  });

  test('高度封顶: 剪掉的说清剪了多少', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      node({ id: `n${i}`, status: 'pending', seq: i }),
    );
    const out = renderDagScreen(snap(many), opts({ height: 5 }));
    expect(out.length).toBe(5);
    expect(out[4]).toContain('more lines');
  });
});
