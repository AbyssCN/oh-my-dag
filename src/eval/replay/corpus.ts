/**
 * src/eval/replay/corpus —— 冻结语料装载与三切闸 (P1 前置件, 2026-09-01 契约)。
 *
 * 冻结语料 = autoresearch 回放评估器的输入。P1 之前, 各次回放都是临时拼题, 不可复算。
 * P1 起, 语料一旦 freeze 即冻结, 任何 evaluation 必须从 manifest 读, 不许现场拼题
 * (防对语料过拟合的隐性注入)。契约 C-2: heldout 默认不可见, 显式 allowHeldout 才放行。
 *
 * 三切:
 *   - screen  (~6): 内环粗筛段, successive halving 第一棒
 *   - main    (~20): 内环主段, 幸存者细跑
 *   - heldout (~8): 内环不可见, 晋升终审唯一接触点 (P3)。**默认锁, 显式闸才开**。
 *
 * 哈希口径: SHA-256(canonical(item)) —— canonical = `id + "\n" + prompt` UTF-8。
 * round-trip 一致 = freeze 写入 manifest.hash, load 读 manifest 验 hash 与 items 段
 * 推出来的 hash 一致, 不一致 throw。
 *
 * 拆分口径: 确定性 —— 同 (items, seed, targetCounts) 永远产同 split 分配。
 * 桶映射 = fnv1a(`${seed}:${id}`, 0xc0ffee) mod 100, 按 targetCounts 比例切。
 *
 * 反向自检 (锁死判据力): §8.3 互证契约 (write 时用 read 的真值做断言)。
 */
import { createHash } from 'node:crypto';

/** 三切名。SPLIT_ORDER 是 manifest.splits 的固定字段顺序。 */
export type SplitName = 'screen' | 'main' | 'heldout';
export const SPLIT_ORDER: readonly SplitName[] = ['screen', 'main', 'heldout'];

/** 一题语料的最小形状。id 唯一 + 不可变; prompt 是冻结内容; srcRunId 是溯源 (来自哪张跑批)。 */
export interface CorpusItem {
  id: string;
  prompt: string;
  /** 来源 run id (任意字符串, 不规定格式), 用于 manifest 逐条目溯源。 */
  srcRunId: string;
}

/** 冻结后 manifest 里的逐条目记录: 原 CorpusItem + 计算出的 hash + 分配的 split。 */
export interface ManifestItem {
  id: string;
  prompt: string;
  /** SHA-256(canonical(id + "\n" + prompt)) 16 进制。round-trip 不变。 */
  hash: string;
  srcRunId: string;
  split: SplitName;
}

/** 冻结后的语料清单。items 是事实表, splits 是 per-split 的 id 列表 (id 字典序)。 */
export interface CorpusManifest {
  version: 1;
  /** 冻结时刻 ISO 戳, 不进 hash (可观测元数据, 不参与 round-trip 一致性)。 */
  frozenAt: string;
  /** 座位签名: 本语料对应哪条座位套, 基线复算要带上 (C-4 互证)。 */
  seats: Record<string, string>;
  /** 逐条目记录。顺序 = freeze 入参顺序。 */
  items: ManifestItem[];
  /** per-split 的 id 列表, 顺序 = id 字典序 (确定)。 */
  splits: Record<SplitName, string[]>;
  /**
   * 总哈希: items 段 canonical JSON 的 SHA-256。round-trip 校验用。
   * canonical = items 按 id 字典序排序后, JSON 序列化 `{id,hash,srcRunId,split}` 列表。
   * 不含 prompt, 避免大字段拖累 (per-item hash 已锁 prompt)。
   */
  totalHash: string;
}

/** freeze 选项。 */
export interface FreezeOptions {
  /** 座位签名, 写进 manifest.seats。回放基线复算时校验一致 (C-4)。 */
  seats: Record<string, string>;
  /** 三切目标配额 [screen, main, heldout]。非负整数, 总和 > 0。 */
  targetCounts: readonly [number, number, number];
  /** 拆分种子; 同 (items + seed + targetCounts) 必须产相同 split 分配。缺省 ''。 */
  seed?: string;
}

/** load 选项。 */
export interface LoadOptions {
  /** heldout split 是否放行 (默认 false → 闸上锁)。C-2 闸。 */
  allowHeldout?: boolean;
  /** 是否校验 totalHash 与 items 段一致 (默认 true)。 */
  verifyHash?: boolean;
}

/** 装载结果。prompts 仅含放行 split 的 id→prompt。 */
export interface LoadedCorpus {
  manifest: CorpusManifest;
  /** per-split 的 id 列表。heldout 仅当 allowHeldout=true 才存在。 */
  splits: Partial<Record<SplitName, string[]>>;
  /** id → prompt 查找表。不含 heldout, 除非 allowHeldout=true。 */
  prompts: Map<string, string>;
  /** 全部 id 顺序 (freeze 入参顺序); 不区分 split, 用于「所有题」的迭代。 */
  allIds: string[];
  /** 全部条目数 (= manifest.items.length)。 */
  total: number;
}

// ─── 哈希 ────────────────────────────────────────────────────────────────

/** 单条目内容哈希: SHA-256(`${id}\n${prompt}`) 16 进制。 */
export function hashItem(item: Pick<CorpusItem, 'id' | 'prompt'>): string {
  return createHash('sha256').update(`${item.id}\n${item.prompt}`, 'utf8').digest('hex');
}

/** totalHash = items 按 id 排序后, 每条 {id,hash,srcRunId,split} 列表的 SHA-256。 */
function totalHashOf(items: readonly ManifestItem[]): string {
  const canonical = JSON.stringify(
    items
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((it) => ({
        id: it.id,
        hash: it.hash,
        srcRunId: it.srcRunId,
        split: it.split,
      })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─── 拆分 ────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash; 给 split 分配用的稳定 hash。 */
function fnv1a(str: string, seed: number): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 32-bit FNV-1a, 暴露给测试与外部做"同种子同分布"断言。 */
export function stableHash(input: string, seed = 0xc0ffee): number {
  return fnv1a(input, seed);
}

/**
 * 给定 items + seed + targetCounts, 决定每个 item 进哪一 split。确定性。
 *
 * 算法: 按 id 字典序遍历, bucket = fnv1a(`${seed}:${id}`) mod 100。
 *   bucket < screenQuota → screen
 *   bucket < screenQuota + mainQuota → main
 *   else → heldout
 * quota 来自 targetCounts 比例 (× 100 圆整)。
 *
 * ⚠ 边界: targetCounts 任一为负 → throw; 全部为 0 → throw (无法拆分)。
 */
export function assignSplits(
  ids: readonly string[],
  targetCounts: readonly [number, number, number],
  seed = '',
): Map<string, SplitName> {
  const [sN, mN, hN] = targetCounts;
  if (
    !Number.isInteger(sN) ||
    !Number.isInteger(mN) ||
    !Number.isInteger(hN) ||
    sN < 0 ||
    mN < 0 ||
    hN < 0
  ) {
    throw new Error(
      `assignSplits: targetCounts must be non-negative integers, got [${sN}, ${mN}, ${hN}]`,
    );
  }
  const total = sN + mN + hN;
  if (total === 0) {
    throw new Error('assignSplits: targetCounts sum must be > 0');
  }
  const screenQuota = Math.round((sN / total) * 100);
  const mainQuota = Math.round((mN / total) * 100);
  // 不强制 screenQuota + mainQuota + (100 - screenQuota - mainQuota) === 100 ——
  // 末段自然填 heldout, 圆整误差吃掉。
  const sortedIds = ids.slice().sort((a, b) => a.localeCompare(b));
  const result = new Map<string, SplitName>();
  for (const id of sortedIds) {
    const bucket = fnv1a(`${seed}:${id}`, 0xc0ffee) % 100;
    let split: SplitName;
    if (bucket < screenQuota) split = 'screen';
    else if (bucket < screenQuota + mainQuota) split = 'main';
    else split = 'heldout';
    result.set(id, split);
  }
  return result;
}

// ─── freeze ──────────────────────────────────────────────────────────────

/**
 * 冻结一批 items 为 manifest。
 *
 * 失败模式 (fail-closed):
 *   - items 为空 → throw
 *   - 重复 id → throw (同 id 不同 prompt 是数据冲突, 不该被覆盖)
 *   - prompt/srcRunId 非字符串 → throw
 *   - targetCounts 非法 → throw (assignSplits 内)
 *
 * 不做 prompt 内容去重 / 净化: 入参即真值, manifest hash 锁定。
 */
export function freezeCorpus(
  items: readonly CorpusItem[],
  opts: FreezeOptions,
): CorpusManifest {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('freezeCorpus: items must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (typeof it.id !== 'string' || it.id === '') {
      throw new Error(`freezeCorpus: item has empty/non-string id`);
    }
    if (seen.has(it.id)) {
      throw new Error(`freezeCorpus: duplicate id "${it.id}"`);
    }
    seen.add(it.id);
    if (typeof it.prompt !== 'string') {
      throw new Error(`freezeCorpus: item "${it.id}" has non-string prompt`);
    }
    if (typeof it.srcRunId !== 'string') {
      throw new Error(`freezeCorpus: item "${it.id}" has non-string srcRunId`);
    }
  }
  const seed = opts.seed ?? '';
  const splitMap = assignSplits(
    items.map((i) => i.id),
    opts.targetCounts,
    seed,
  );
  const itemRecords: ManifestItem[] = items.map((it) => ({
    id: it.id,
    prompt: it.prompt,
    hash: hashItem(it),
    srcRunId: it.srcRunId,
    split: splitMap.get(it.id) as SplitName,
  }));
  const splits: Record<SplitName, string[]> = {
    screen: [],
    main: [],
    heldout: [],
  };
  for (const it of itemRecords.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    splits[it.split].push(it.id);
  }
  return {
    version: 1,
    frozenAt: new Date().toISOString(),
    seats: { ...opts.seats },
    items: itemRecords,
    splits,
    totalHash: totalHashOf(itemRecords),
  };
}

// ─── load ────────────────────────────────────────────────────────────────

/**
 * 装载 manifest.json 文本或已解析对象。
 *
 * 失败模式 (fail-closed):
 *   - 文本不可解析 → throw
 *   - version !== 1 → throw
 *   - items / splits 段缺失或键不匹配 → throw
 *   - totalHash 与 items 段不一致 (verifyHash 默认 true) → throw
 *   - splits 段 ID 不在 items 段 (orphans) → throw
 *
 * ⚠ heldout 默认锁: allowHeldout=false 时, LoadedCorpus.splits.heldout 缺席,
 *    LoadedCorpus.prompts 不含 heldout id。这是 C-2 闸, 不是 UX 偏好。
 */
export function loadCorpus(
  input: string | unknown,
  opts: LoadOptions = {},
): LoadedCorpus {
  let m: CorpusManifest;
  if (typeof input === 'string') {
    try {
      m = JSON.parse(input) as CorpusManifest;
    } catch (e) {
      throw new Error(
        `loadCorpus: manifest JSON parse failed — ${(e as Error).message}`,
      );
    }
  } else {
    m = input as CorpusManifest;
  }
  if (!m || typeof m !== 'object') {
    throw new Error('loadCorpus: manifest must be an object');
  }
  if (m.version !== 1) {
    throw new Error(
      `loadCorpus: unsupported manifest version ${JSON.stringify(m.version)} (expected 1)`,
    );
  }
  if (!Array.isArray(m.items)) {
    throw new Error('loadCorpus: manifest.items must be an array');
  }
  if (!m.splits || typeof m.splits !== 'object') {
    throw new Error('loadCorpus: manifest.splits must be an object');
  }
  for (const split of SPLIT_ORDER) {
    if (!Array.isArray(m.splits[split])) {
      throw new Error(`loadCorpus: manifest.splits.${split} must be an array`);
    }
  }
  // item 自检: 每条都有合法字段
  for (const it of m.items) {
    if (typeof it.id !== 'string' || it.id === '') {
      throw new Error('loadCorpus: manifest item has empty/non-string id');
    }
    if (typeof it.prompt !== 'string') {
      throw new Error(`loadCorpus: manifest item "${it.id}" has non-string prompt`);
    }
    if (typeof it.hash !== 'string' || it.hash === '') {
      throw new Error(`loadCorpus: manifest item "${it.id}" has empty/non-string hash`);
    }
    if (typeof it.srcRunId !== 'string') {
      throw new Error(`loadCorpus: manifest item "${it.id}" has non-string srcRunId`);
    }
    if (it.split !== 'screen' && it.split !== 'main' && it.split !== 'heldout') {
      throw new Error(
        `loadCorpus: manifest item "${it.id}" has invalid split "${it.split}"`,
      );
    }
  }
  // hash 一致性自检 (verifyHash 默认 true)
  if (opts.verifyHash !== false) {
    const recomputed = totalHashOf(m.items);
    if (recomputed !== m.totalHash) {
      throw new Error(
        `loadCorpus: totalHash mismatch (manifest=${m.totalHash.slice(0, 12)}, recomputed=${recomputed.slice(0, 12)})`,
      );
    }
    // per-item hash 自检 —— 改 prompt 必破这条
    for (const it of m.items) {
      const expected = hashItem({ id: it.id, prompt: it.prompt });
      if (expected !== it.hash) {
        throw new Error(
          `loadCorpus: item "${it.id}" hash mismatch (manifest=${it.hash.slice(0, 12)}, recomputed=${expected.slice(0, 12)})`,
        );
      }
    }
  }
  // splits 与 items 自洽: splits.X ⊆ items[X] 的 id 集合, 无 orphan
  const itemIdBySplit: Record<SplitName, Set<string>> = {
    screen: new Set(),
    main: new Set(),
    heldout: new Set(),
  };
  for (const it of m.items) {
    itemIdBySplit[it.split].add(it.id);
  }
  for (const split of SPLIT_ORDER) {
    for (const id of m.splits[split]) {
      if (!itemIdBySplit[split].has(id)) {
        throw new Error(
          `loadCorpus: splits.${split} contains id "${id}" not present in items.${split}`,
        );
      }
    }
    if (m.splits[split].length !== itemIdBySplit[split].size) {
      // 检查 splits 与 items 在该 split 下数量一致 (有遗漏或多算)
      const inSplits = new Set(m.splits[split]);
      for (const id of itemIdBySplit[split]) {
        if (!inSplits.has(id)) {
          throw new Error(
            `loadCorpus: items.${split} contains id "${id}" missing from splits.${split}`,
          );
        }
      }
    }
  }

  // C-2 闸: heldout 默认锁
  const allowHeldout = opts.allowHeldout === true;
  const splits: Partial<Record<SplitName, string[]>> = {
    screen: m.splits.screen.slice(),
    main: m.splits.main.slice(),
  };
  if (allowHeldout) {
    splits.heldout = m.splits.heldout.slice();
  }
  const prompts = new Map<string, string>();
  for (const it of m.items) {
    if (it.split === 'heldout' && !allowHeldout) continue;
    prompts.set(it.id, it.prompt);
  }
  return {
    manifest: m,
    splits,
    prompts,
    allIds: m.items.map((it) => it.id),
    total: m.items.length,
  };
}

// ─── 便利: 写盘 ──────────────────────────────────────────────────────────

/**
 * 把 manifest 写到 disk (JSON + 末尾换行)。目录不存在自动建。
 * 仅 freeze 出的 manifest 可写; 不可写手造对象 (字段不全会写坏 hash)。
 */
export function writeManifest(path: string, manifest: CorpusManifest): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const path_ = require('node:path') as typeof import('node:path');
  fs.mkdirSync(path_.dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 从 disk 读 manifest 文本。文件不存在 → throw (C-2 fail-closed, 不许静默回落)。 */
export function readManifestText(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  if (!fs.existsSync(path)) {
    throw new Error(`readManifestText: file not found at "${path}"`);
  }
  return fs.readFileSync(path, 'utf8');
}