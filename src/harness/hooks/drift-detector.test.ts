/**
 * drift-detector 的**空转累计**契约 (2026-08-03, G5)。
 *
 * 本文件只盯 `summary()` 那一格 —— 检出逻辑 (环/阈值/注入/恢复) 的行为不在这里断言。
 *
 * ## 为什么需要它
 *
 * 检测器一直在工作 (单次 live 命中 16 个回合、最高同签名重复 39 次), 但它的出口是
 * `onSpinning`/`onRecovered` 两个**函数回调**, 而隔离档的 leaf 跑在 bwrap 子进程里,
 * 只有 JSON 安全的东西过得了那道边界 —— 回调在那条路上**结构性接不了**。
 * 于是这个信号至今零消费者: **不是忘了接, 是接不了**。`summary()` 把它变成数据,
 * 随 leaf 结果过河, 在 executor-dag 转成 `leaf-spin` 观察进留痕库。
 *
 * ## 判据的诚实边界
 *
 * `summary()` 是**频率读数**。停机语义在 `fuseTripped()` (2026-08-14 起): 读数收够了
 * (2026-08-13 夜 26 回合/9× + 2026-08-03 live 16 回合/39× 该拦; 1–6 回合/4–5× 的 TDD
 * 迭代不该拦), 阈值取两组之间的空档 —— 见本文件「熔断闸」一节与 DriftDetectorConfig.fuse 的注。
 */
import { describe, expect, test } from 'bun:test';
import { computeSig, createDriftTracker } from './drift-detector';

describe('空转累计 (G5 频率读数, 2026-08-03)', () => {
  const spin = (t: ReturnType<typeof createDriftTracker>, sig: string, n: number): void => {
    for (let i = 0; i < n; i++) t.note('bash', { command: sig });
  };

  test('没卡过 → 全 0 (缺席 ≠ 0 的口径靠调用方: agent-leaf 只在 >0 时带出去)', () => {
    const t = createDriftTracker();
    t.note('bash', { command: 'a' });
    t.note('bash', { command: 'b' });
    expect(t.summary()).toEqual({ spinEvents: 0, maxSameCount: 0, stuckSigs: [] });
  });

  test('卡一次 → 回合数 1, 记下卡在什么上, maxSameCount ≥ 阈值', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'same', 4);
    const s = t.summary();
    expect(s.spinEvents).toBe(1);
    expect(s.maxSameCount).toBeGreaterThanOrEqual(4);
    expect(s.stuckSigs.length).toBe(1);
  });

  /**
   * **这条是本组的要害。** `reset()` 是每轮 agent 开始时清环用的, 而累计量的是
   * "这个 leaf **整场**卡了多少" —— 跟着 reset 清就只剩最后一轮, 那不是要问的问题,
   * 而且症状是沉默的 (数字看着正常, 只是小了)。
   * 后人很容易"顺手"把它加进 reset 里当漏清的 bug 修掉, 这条闸就是拦那一手。
   */
  test('reset 不清累计 —— 它量的是整场, 不是最后一轮', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'x', 4);
    expect(t.summary().spinEvents).toBe(1);
    t.reset();
    spin(t, 'y', 4);
    expect(t.summary().spinEvents).toBe(2); // 跨轮累加, 不是 1
    expect(t.summary().stuckSigs.length).toBe(2);
  });

  test('反向自检: reset 确实清了环 (否则上一条是恒真式)', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'z', 3); // 差一次就到阈值
    t.reset();
    t.note('bash', { command: 'z' }); // 环清了 → 这一次不该凑成 4
    expect(t.summary().spinEvents).toBe(0);
  });

  test('stuckSigs 去重且有上界 (排障用, 不许把一整场的签名灌进留痕库)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 30; i++) {
      spin(t, `sig-${i}`, 4);
      t.reset();
    }
    expect(t.summary().spinEvents).toBe(30);
    expect(t.summary().stuckSigs.length).toBeLessThanOrEqual(12);
  });
});

describe('computeSig 的 hashline 目标锚 (2026-08-10 尺子修)', () => {
  const patchFor = (path: string): string => `¶${path}#a1b2\nreplace 3..3:\n+new line`;

  // 反向自检: 把 computeSig 的 patch 分支删掉 → 本条当场红 (回到全并成 `hashline_edit:patch` 的旧尺子,
  // S2/S3 实测连改 4 刀即误报 spinning, 单 run 20 次)。
  test('★ 不同目标文件的 patch → 不同签名, 连打 4 个不同文件不触发 spinning', () => {
    expect(computeSig('hashline_edit', { patch: patchFor('src/a.ts') })).not.toBe(
      computeSig('hashline_edit', { patch: patchFor('src/b.ts') }),
    );
    const t = createDriftTracker({ threshold: 4 });
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) t.note('hashline_edit', { patch: patchFor(f) });
    expect(t.summary().spinEvents).toBe(0);
  });

  test('同一文件连打 4 刀 → 仍触发 (尺子变细, 没有钝掉)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 4; i++) t.note('hashline_edit', { patch: patchFor('src/same.ts') });
    expect(t.summary().spinEvents).toBe(1);
  });

  test('无 ¶ 头的 patch (格式坏/非 hashline) → 键名兜底 (既有行为不变)', () => {
    expect(computeSig('hashline_edit', { patch: 'not a hashline patch' })).toBe('hashline_edit:patch');
  });
});

describe('computeSig 的 bash cd 前缀 (2026-08-11 run 7d50fda2 尺子修)', () => {
  // 真样本形状: 隔离 worktree 的 run root, 光 cd 段就 76 字符 > 50 字符签名窗口。
  const jail = '/home/dev/repos/oh-my-dag/.omd/runs/7d50fda2-c9b0-4a33-afb7-37207e724e90';
  const inJail = (cmd: string): string => `cd ${jail} && ${cmd}`;

  // 反向自检: 把 computeSig 里的 stripCdPrefix 调用去掉 → 本条当场红 (三条命令签名全等,
  // 正是 run 7d50fda2 把 12 条不同命令报成"空转 ×12"的那把尺子)。
  test('★ 同一 jail 下三条不同命令 → 三个不同签名, 不触发 spinning', () => {
    const sigs = ['bun test src/a.test.ts', 'git status', 'ls src'].map((c) => computeSig('bash', { command: inJail(c) }));
    expect(new Set(sigs).size).toBe(3);
    const t = createDriftTracker({ threshold: 4 });
    for (const c of ['bun test src/a.test.ts', 'git status', 'ls src', 'cat package.json']) t.note('bash', { command: inJail(c) });
    expect(t.summary().spinEvents).toBe(0);
  });

  test('剥掉 cd 后同一条命令仍并成一个签名 (尺子变细, 没有钝掉)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 4; i++) t.note('bash', { command: inJail('bun test src/a.test.ts') });
    expect(t.summary().spinEvents).toBe(1);
    // 在不在 jail 里跑同一条命令 = 同一件事, 签名应相同 (否则换档就丢历史)。
    expect(computeSig('bash', { command: inJail('git status') })).toBe(computeSig('bash', { command: 'git status' }));
  });

  test('链式 cd 逐段剥; 光秃秃的 cd (无 &&) 原样保留', () => {
    expect(computeSig('bash', { command: `cd ${jail} && cd src && ls` })).toBe('bash:ls');
    expect(computeSig('bash', { command: 'cd /tmp' })).toBe('bash:cd /tmp');
  });
});

describe('熔断闸 fuseTripped (2026-08-14; 阈值依据 2026-08-13 夜 + 2026-08-03 live 读数)', () => {
  const spin = (t: ReturnType<typeof createDriftTracker>, sig: string, n: number): void => {
    for (let i = 0; i < n; i++) t.note('bash', { command: sig });
  };
  /** 模拟软注入被消费 (每轮 LLM 调用前宿主会调一次) —— 让下一次同签名 note 能重新检出、spinEvents 递增。 */
  const consume = (t: ReturnType<typeof createDriftTracker>): void => void t.takeInjection();

  test('★ 正当 TDD 迭代 (edit↔test 交替, 昨夜 impl_api_time 形状: 6 回合 / max 5×) → 不熔断', () => {
    const t = createDriftTracker({ threshold: 4 });
    // edit → test → edit → test … 各 8 次: 软检出会响 (spinEvents 少量), 但远不到硬阈值。
    for (let i = 0; i < 8; i++) {
      t.note('hashline_edit', { patch: '¶src/x.ts#aa\n…' });
      t.note('bash', { command: 'npx vitest run src/x.test.ts' });
      consume(t);
    }
    expect(t.fuseTripped()).toBeNull();
    expect(t.summary().spinEvents).toBeLessThan(10);
  });

  test('★ 深度空转 (昨夜 build_ingestor 形状: 软注入后继续同签名几十轮) → 熔断, 理由带 stuckSig', () => {
    const t = createDriftTracker({ threshold: 4 });
    // 同一签名连打: maxSameCount 会随 note 持续加深 (不只在检出边沿更新) → 撞 maxSameCount 阈值。
    spin(t, 'PYTHONDONTWRITEBYTECODE=1 python ingest.py', 14);
    const trip = t.fuseTripped();
    expect(trip).not.toBeNull();
    expect(trip!).toContain('空转熔断');
    expect(trip!).toContain('PYTHONDONTWRITEBYTECODE=1');
  });

  test('★ 回合数路径: 反复卡住-注入-再卡 (spinEvents 累计 ≥10) → 熔断', () => {
    const t = createDriftTracker({ threshold: 4, maxSlots: 8 });
    // 每轮换一个签名卡 4 次 (环小, 旧签名滚出) → spinEvents 逐轮 +1 而 maxSameCount 停在 4。
    for (let i = 0; i < 10; i++) {
      spin(t, `sig-${i}`, 4);
      consume(t);
    }
    expect(t.summary().maxSameCount).toBeLessThan(12);
    expect(t.fuseTripped()).not.toBeNull();
  });

  test('fuse:false = 只报不拦 (旧行为逃生口)', () => {
    const t = createDriftTracker({ threshold: 4, fuse: false });
    spin(t, 'same', 20);
    expect(t.summary().spinEvents).toBeGreaterThan(0);
    expect(t.fuseTripped()).toBeNull();
  });

  test('阈值可调 (fuse.maxSameCount=6 → 7 连击即熔断)', () => {
    const t = createDriftTracker({ threshold: 4, fuse: { maxSameCount: 6 } });
    spin(t, 'same', 6);
    expect(t.fuseTripped()).not.toBeNull();
  });

  test('跨 reset 累计: reset (每轮 agent 开始) 不清熔断判据 —— 熔断问的是整场', () => {
    const t = createDriftTracker({ threshold: 4, maxSlots: 8 });
    for (let i = 0; i < 10; i++) {
      spin(t, `sig-${i}`, 4);
      consume(t);
      t.reset();
    }
    expect(t.fuseTripped()).not.toBeNull();
  });
});

/**
 * computeSig 的**路径前缀** (2026-08-18, run dbfe0c66 / 14b49f79 的假熔断)。
 *
 * 与上面 `bash cd 前缀` 那一组**是同一种病, 补在了隔壁那一支**: 签名窗口落在了对所有调用
 * 都相同的那一段上。bash 支 2026-08-11 修过 (stripCdPrefix), 而 read/edit/hashline 这一支
 * 直接 `path.slice(0, 60)` —— 隔离档的 worktree 根就有 **73 字符**, 于是窗口全被前缀吃掉,
 * **jail 里任意两个文件的签名逐字节相同**。
 *
 * 代价 (2026-08-18 实盘): run dbfe0c66 的 s1 (509s / 63 工具 / 4.11M) 与 s2 (440s / 60 工具 /
 * 3.16M)、run 14b49f79 的 impl (508s / 61 工具 / 3.97M) 三片全被判 spin-fused —— 而它们在改
 * **不同的文件**。判词写的是"卡在 hashline_edit", 于是差点被归因成"模型在原地打转"。
 */
describe('computeSig 的路径前缀 (2026-08-18 run dbfe0c66 尺子修)', () => {
  // 真样本: 隔离 worktree 的 run root 本身就 73 字符 > 60 字符签名窗口。
  const jail = '/home/dev/repos/oh-my-dag/.omd/runs/dbfe0c66-681c-42cb-89f7-a67e3f569b99';
  const files = ['/src/harness/chat/history-recall.ts', '/src/mcp/tools/history.ts', '/src/serve/chat-tools.ts'];

  // 反向自检: 把 computeSig 里的 pathSig 换回 `path.slice(0, 60)` → 本条当场红 (三个签名全等),
  // 读到的正是实盘那个错值 `hashline_edit:/home/dev/repos/oh-my-dag/.omd/runs/dbfe0c66-681c-42cb-89f7`。
  test('★ 同一 jail 下三个不同文件 → 三个不同签名, 不触发 spinning', () => {
    const sigs = files.map((f) => computeSig('read', { file_path: jail + f }));
    expect(new Set(sigs).size).toBe(3);
    const t = createDriftTracker({ threshold: 4 });
    for (const f of [...files, '/src/harness/chat/session-store.ts']) t.note('edit', { file_path: jail + f });
    expect(t.summary().spinEvents).toBe(0);
  });

  // 反向自检同上: hashline 那条走的是 patch 头提取, 提出来的同样是绝对路径, 一样会被前缀吃掉。
  test('★ hashline_edit 的 patch 头路径同样不许被 jail 前缀吃掉', () => {
    const patchFor = (p: string): string => `¶${p}#abc\n+ x`;
    const sigs = files.map((f) => computeSig('hashline_edit', { patch: patchFor(jail + f) }));
    expect(new Set(sigs).size).toBe(3);
  });

  test('短路径的签名逐字不变 (只动长路径那一格, 不外溢)', () => {
    expect(computeSig('read', { file_path: 'src/a.ts' })).toBe('read:src/a.ts');
  });

  test('grep pattern 仍取**头** (路径看尾, 模式看头 —— 两种参数的区分度在两端)', () => {
    const long = `${'a'.repeat(70)}XYZ`;
    expect(computeSig('grep', { pattern: long })).toBe(`grep:${long.slice(0, 60)}`);
  });
});
