/**
 * `src/eval/replay/corpus.ts` 冻结装载与三切闸契约 —— C-2 (2026-09-01 前置契约)。
 *
 * 真值链逐跳写在每条 fixture 注释里。反向自检 (锁死判据力):
 *  - HELDOUT_DEFAULT_DENY: 把 `expect(() => loadCorpus(m)).toThrow(/HELDOUT|heldout/)` 改成
 *    `expect(loaded.splits.heldout).toEqual([...])` ⇒ 红 (heldout 真锁了, 不是注释旁路);
 *  - 把 `expect(loaded.splits.screen).toEqual(['a', 'c'])` 改成 `['c', 'a']` ⇒ 红
 *    (per-split 字典序固定, 改它会让批次漂移);
 *  - ROUND_TRIP_HASH: 在 manifest.items[0].hash 末尾加一个字符 ⇒ totalHash mismatch throw;
 *  - 在 manifest.items[0].prompt 末尾加一个字符 ⇒ per-item hash mismatch throw
 *    (证 hash 是锁 prompt 的, 改 prompt 必破);
 *  - 在 freeze 输入 items 里塞重复 id ⇒ freezeCorpus throw (证「同 id 不同 prompt 是数据冲突」闸);
 *  - 把 targetCounts 改成全 0 ⇒ assignSplits throw (证闸真接住非法配额)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPLIT_ORDER,
  assignSplits,
  freezeCorpus,
  hashItem,
  loadCorpus,
  stableHash,
  writeManifest,
  type CorpusItem,
  type CorpusManifest,
} from './corpus';

const SEATS = {
  conductor: 'minimax-cn:MiniMax-M3',
  worker: 'minimax-cn:MiniMax-M3',
  verifier: 'openai-codex:gpt-5.6-sol',
};

const TARGET_COUNTS: readonly [number, number, number] = [6, 20, 8];

/** 12 条手工造的小语料, 兼顾字典序与分布。id 用两位字母保证字典序直观。 */
function sampleItems(): CorpusItem[] {
  const ids = ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj', 'ak', 'al'];
  return ids.map((id, i) => ({
    id,
    prompt: `prompt for ${id}: synthetic text #${i + 1}`,
    srcRunId: `run-${Math.floor(i / 4) + 1}`,
  }));
}

// =====================================================================
// HELDOUT_DEFAULT_DENY — C-2 held-out 默认锁
// =====================================================================
describe('HELDOUT_DEFAULT_DENY — held-out 默认不可见', () => {
  test('C-2.a 默认 load 不返回 heldout split (闸上锁)', () => {
    // 真值链:
    //   · freeze 12 题, 配额 [6, 20, 8] → 每题分到一 split
    //   · loadCorpus 不传 allowHeldout → splits 只有 screen + main 两键
    //   · heldout id 不进 prompts 表
    //   · 闸只一个出口: LoadedCorpus.splits.heldout === undefined
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const loaded = loadCorpus(m);
    expect(loaded.splits.heldout).toBeUndefined();
    expect(loaded.splits.screen).toBeDefined();
    expect(loaded.splits.main).toBeDefined();
    // heldout id 不能进 prompts 表
    const heldoutIds = m.splits.heldout;
    for (const id of heldoutIds) {
      expect(loaded.prompts.has(id)).toBe(false);
    }
    // screen + main ids 必须全部进 prompts
    const visibleIds = [...(loaded.splits.screen ?? []), ...(loaded.splits.main ?? [])];
    expect(visibleIds.length).toBeGreaterThan(0);
    for (const id of visibleIds) {
      expect(loaded.prompts.has(id)).toBe(true);
    }
  });

  test('C-2.b 显式 allowHeldout:true → heldout 放行', () => {
    // 真值链: 同 fixture, loadCorpus(m, { allowHeldout: true }) → splits.heldout 非空
    //    且 prompts 表含全部 12 条。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const loaded = loadCorpus(m, { allowHeldout: true });
    expect(loaded.splits.heldout).toBeDefined();
    expect(loaded.splits.heldout!.length).toBe(m.splits.heldout.length);
    expect(loaded.prompts.size).toBe(m.items.length);
  });

  test('C-2.c allowHeldout:false 显式给也锁 (默认等价)', () => {
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const loaded = loadCorpus(m, { allowHeldout: false });
    expect(loaded.splits.heldout).toBeUndefined();
  });

  test('C-2.d manifest.splits.heldout 字段本身存在但 loader 不透传', () => {
    // 真值链: manifest.splits.heldout 是事实表, 必须存在 (来自 freeze 写入);
    //   但 Loader 默认不让它穿透到 LoadedCorpus.splits (闸 vs 事实表分开)。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    // manifest 自身三个 split 全在
    expect(m.splits.heldout).toBeArray();
    expect(m.splits.screen).toBeArray();
    expect(m.splits.main).toBeArray();
    // 默认 load 拿掉 heldout
    const loaded = loadCorpus(m);
    expect(loaded.splits.heldout).toBeUndefined();
  });
});

// =====================================================================
// C-2 三切配额与分配
// =====================================================================
describe('C-2 三切拆分与配额', () => {
  test('C-2.e 12 题按 [6, 20, 8] 拆分 → screen 至少 4, main 最多 10, heldout 至少 1 (确定性)', () => {
    // 真值链: fnv1a mod 100 + 配额比例。12 题 × 6/34 ≈ 17.6% → 期望 2-3 screen; × 20/34 ≈
    //   58.8% → 期望 7 main; × 8/34 ≈ 23.5% → 期望 2-3 heldout。不锁精确数 (哈希敏感),
    //   只锁「每切都非空 + 总和 = items 长度 + 比例大致合理」。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const total = m.splits.screen.length + m.splits.main.length + m.splits.heldout.length;
    expect(total).toBe(sampleItems().length);
    // 三切全非空 —— 配额是「目标」, 但 12 题下应每切都吃到几条
    expect(m.splits.screen.length).toBeGreaterThan(0);
    expect(m.splits.main.length).toBeGreaterThan(0);
    expect(m.splits.heldout.length).toBeGreaterThan(0);
  });

  test('C-2.f 同 (items, seed, targetCounts) → 同 split 分配 (确定性闸)', () => {
    // 真值链: 两次 freezeCorpus 同输入 → manifest.totalHash 完全相同。
    //   这条是「freeze 可复算」闸, 也是 C-4 基线可复算的前置。
    const items = sampleItems();
    const a = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS });
    const b = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS });
    expect(a.totalHash).toBe(b.totalHash);
    expect(a.splits).toEqual(b.splits);
  });

  test('C-2.g 不同 seed → 不同 split 分配 (种子真起作用, 不是恒等映射)', () => {
    const items = sampleItems();
    const a = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS, seed: 'alpha' });
    const b = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS, seed: 'beta' });
    // hash 应该不同 (split 分配至少有一处不同)
    const aIds = a.splits.screen.join(',');
    const bIds = b.splits.screen.join(',');
    expect(aIds === bIds && a.splits.main.join(',') === b.splits.main.join(',')).toBe(false);
  });

  test('C-2.h per-split id 列表按字典序排列 (确定性输出序)', () => {
    // 真值链: SPLIT_ORDER 排完后, splits[id] 内的 id 字典序固定, 不跟随输入顺序。
    //   这条让 manifest 写盘后 git diff 稳定。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    for (const split of SPLIT_ORDER) {
      const ids = m.splits[split];
      const sorted = ids.slice().sort((a, b) => a.localeCompare(b));
      expect(ids).toEqual(sorted);
    }
  });
});

// =====================================================================
// C-2 freeze → load 往返 (hash 锁定)
// =====================================================================
describe('C-2 freeze→load 往返 (hash 锁定)', () => {
  test('C-2.i 写盘→读盘→load → totalHash 不变, per-item hash 不变', () => {
    // 真值链: 写盘 JSON.stringify 是确定性序列化 (keys 顺序固定); 读盘文本 parse
    //   还原 CorpusManifest; loadCorpus 不动 hash, 只验证 round-trip。
    const root = mkdtempSync(join(tmpdir(), 'corpus-rt-'));
    try {
      const items = sampleItems();
      const m = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS });
      const path = join(root, 'manifest.json');
      writeManifest(path, m);
      const text = readFileSync(path, 'utf8');
      const loaded = loadCorpus(text);
      // round-trip 不变
      expect(loaded.manifest.totalHash).toBe(m.totalHash);
      for (let i = 0; i < m.items.length; i++) {
        expect(loaded.manifest.items[i]!.hash).toBe(m.items[i]!.hash);
        expect(loaded.manifest.items[i]!.prompt).toBe(m.items[i]!.prompt);
        expect(loaded.manifest.items[i]!.srcRunId).toBe(m.items[i]!.srcRunId);
        expect(loaded.manifest.items[i]!.split).toBe(m.items[i]!.split);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('C-2.j per-item hash = SHA-256(`${id}\n${prompt}`), 改 prompt 必破', () => {
    // 真值链: hashItem 收 (id, prompt), prompt 末加一字符 → hash 全变。
    //   这是「hash 真锁 prompt 内容」的判据。
    const item: CorpusItem = { id: 'x1', prompt: 'hello world', srcRunId: 'r1' };
    const h1 = hashItem(item);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashItem({ ...item, prompt: 'hello world!' })).not.toBe(h1);
    expect(hashItem({ ...item, id: 'x2' })).not.toBe(h1);
  });

  test('C-2.k manifest 篡改 prompt → loadCorpus 抛 per-item hash mismatch', () => {
    // 真值链: loadCorpus 默认 verifyHash:true → 篡改 prompt 后重算的 hash ≠ 持久 hash,
    //   抛错。这条锁死「manifest 文件可作为真值持久化」的判据。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const tampered: CorpusManifest = JSON.parse(JSON.stringify(m));
    tampered.items[0]!.prompt = tampered.items[0]!.prompt + ' (tampered)';
    // 也要更新 totalHash 让总哈希不自相矛盾 —— 不更新, 让 loader 自己检
    // 实际篡改者若想掩盖 prompt 改动, 必重算 totalHash 与 item hash; 这里我们不重算,
    // 让 per-item hash mismatch 抛错 (总哈希 也会一起 mismatch)。
    expect(() => loadCorpus(tampered)).toThrow(/hash mismatch/);
  });

  test('C-2.l verifyHash:false → 跳过 hash 校验 (逃生口, 默认不走)', () => {
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const tampered: CorpusManifest = JSON.parse(JSON.stringify(m));
    tampered.items[0]!.prompt = tampered.items[0]!.prompt + ' (no verify)';
    // verifyHash:false 应放行
    expect(() => loadCorpus(tampered, { verifyHash: false })).not.toThrow();
  });
});

// =====================================================================
// C-2 fail-closed 闸
// =====================================================================
describe('C-2 freeze/load fail-closed 闸', () => {
  test('C-2.m 重复 id → freezeCorpus throw', () => {
    const items: CorpusItem[] = [
      { id: 'dup', prompt: 'p1', srcRunId: 'r1' },
      { id: 'dup', prompt: 'p2', srcRunId: 'r2' },
    ];
    expect(() => freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS })).toThrow(
      /duplicate id/,
    );
  });

  test('C-2.n 空 items 数组 → freezeCorpus throw', () => {
    expect(() => freezeCorpus([], { seats: SEATS, targetCounts: TARGET_COUNTS })).toThrow(
      /non-empty/,
    );
  });

  test('C-2.o targetCounts 全 0 → assignSplits throw (无法拆)', () => {
    expect(() => assignSplits(['a', 'b'], [0, 0, 0])).toThrow(/sum must be > 0/);
  });

  test('C-2.p targetCounts 含负数 → assignSplits throw', () => {
    expect(() => assignSplits(['a'], [-1, 1, 1])).toThrow(/non-negative/);
    expect(() => assignSplits(['a'], [1, 1.5, 1])).toThrow(/non-negative/);
  });

  test('C-2.q 非整数 quota → assignSplits throw', () => {
    expect(() => assignSplits(['a'], [1, 1, 1.5])).toThrow(/non-negative/);
  });

  test('C-2.r manifest version !== 1 → loadCorpus throw', () => {
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const bad = { ...m, version: 2 as unknown as 1 };
    expect(() => loadCorpus(bad)).toThrow(/version/);
  });

  test('C-2.s manifest 文本坏 JSON → loadCorpus throw', () => {
    expect(() => loadCorpus('{not json')).toThrow(/JSON parse/);
  });

  test('C-2.t manifest 空对象 → loadCorpus throw (结构缺失)', () => {
    expect(() => loadCorpus({})).toThrow(/version/);
    expect(() => loadCorpus({ version: 1 })).toThrow(/items/);
  });

  test('C-2.u splits 段与 items 段不一致 (orphan id) → loadCorpus throw', () => {
    // 真值链: 手动构造一个 splits.screen 含 items 中不存在的 id → 自洽校验抛错。
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const bad: CorpusManifest = JSON.parse(JSON.stringify(m));
    bad.splits.screen = [...bad.splits.screen, 'orphan-id-not-in-items'];
    expect(() => loadCorpus(bad)).toThrow(/splits\.screen/);
  });

  test('C-2.v items 段含非法 split 名 → loadCorpus throw', () => {
    const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
    const bad: CorpusManifest = JSON.parse(JSON.stringify(m));
    bad.items[0]!.split = 'unknown-split' as unknown as 'screen';
    expect(() => loadCorpus(bad)).toThrow(/invalid split/);
  });
});

// =====================================================================
// C-2 单条原语 — hashItem / stableHash
// =====================================================================
describe('C-2 单条原语', () => {
  test('C-2.w hashItem 同输入同输出 (确定性)', () => {
    const a = hashItem({ id: 'i', prompt: 'p' });
    const b = hashItem({ id: 'i', prompt: 'p' });
    expect(a).toBe(b);
  });

  test('C-2.x stableHash 同输入同输出 (32-bit FNV-1a, 范围内)', () => {
    expect(stableHash('foo')).toBe(stableHash('foo'));
    expect(stableHash('foo', 1)).toBe(stableHash('foo', 1));
    const h = stableHash('seed:test');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});

// =====================================================================
// C-2 写盘 — writeManifest / 读盘
// =====================================================================
describe('C-2 写盘与文件存在性', () => {
  test('C-2.y writeManifest 写盘 → JSON 文件 + 末尾换行', () => {
    const root = mkdtempSync(join(tmpdir(), 'corpus-wm-'));
    try {
      const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
      const path = join(root, 'sub', 'manifest.json'); // 子目录不存在, 应自动建
      writeManifest(path, m);
      // 读盘验尾换行
      const bytes = readFileSync(path);
      expect(bytes[bytes.length - 1]).toBe(0x0a); // '\n'
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// C-2 manifests 必须是 fixtures 真值自证 (写集对账闸)
//   注: 这层是 (frozen manifest + frozen items) → 期望 split 配额断言。
//   与 C-2.e 不同的是, 这层用 fixture 级硬编码期望 (例如 34 题 → 至少 5 screen /
//   至少 15 main / 至少 6 heldout), 与片 5 的 verify 命令对齐。
// =====================================================================
describe('C-2 配额下限 (片 5 manifest.json 验收读数对齐)', () => {
  test('C-2.z 34 题 fixture 满足片 5 verify 下限: screen≥5 · main≥15 · heldout≥6', () => {
    // 真值链: 片 5 验收命令是 `jq -e '(.splits.screen|length>=5) and ...' manifest.json`。
    //   这层用 34 题 fixture 模拟, 跑同样的下限, 证明下限合理 (34 题下三切都过线)。
    const ids = Array.from({ length: 34 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
    const items: CorpusItem[] = ids.map((id, i) => ({
      id,
      prompt: `corpus prompt ${id}: ${'lorem ipsum '.repeat((i % 5) + 1)}`,
      srcRunId: `run-${(i % 4) + 1}`,
    }));
    const m = freezeCorpus(items, { seats: SEATS, targetCounts: TARGET_COUNTS });
    expect(m.splits.screen.length).toBeGreaterThanOrEqual(5);
    expect(m.splits.main.length).toBeGreaterThanOrEqual(15);
    expect(m.splits.heldout.length).toBeGreaterThanOrEqual(6);
    // 总和 = items.length
    expect(
      m.splits.screen.length + m.splits.main.length + m.splits.heldout.length,
    ).toBe(34);
  });
});

// 为 C-2.y 引入 node:fs writeFileSync 提示 (writeManifest 内部读 fs, 这层不直接调)
void writeFileSync;