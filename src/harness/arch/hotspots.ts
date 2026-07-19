/**
 * arch/hotspots —— 热点发现 (确定性, 零 LLM)。dag-deepen 管线第 1 步。
 *
 * 输入 = `git log --oneline --name-only -n N` 的原始输出 (注入式, 不自己跑 git → 纯函数可测)。
 * 方法: 数文件触碰频率 → 按目录聚成 module 级热点 (dir cluster) → 按触碰量取 top K。
 * 理据 (Matt Pocock improve-codebase-architecture): 改得最勤的地方 = 摩擦最大 = 加深 (deepen)
 * 回报最高的地方 — hotspot-first 是 YAGNI 的架构版, 不巡游全仓找"理论上可改进"。
 *
 * scope 覆盖: 用户点名方向 (如 "src/harness/plan") → 只在该前缀内聚热点; 近期 commit 完全
 * 没碰过该前缀时仍返回一个空热点 (files=[]) — 扫描叶自己去探目录, 发现不因日志冷而短路。
 */

/** 一个 module 级热点: 目录簇 + 组内文件触碰明细。 */
export interface Hotspot {
  /** 簇 id = 目录路径 (仓库根文件 → '.')。 */
  dir: string;
  /** 组内文件, 按触碰次数降序 (次数同 → 路径字典序, 稳定可测)。 */
  files: { path: string; touches: number }[];
  /** 组内触碰合计 (排名依据)。 */
  touches: number;
}

export interface HotspotOptions {
  /** 取前 K 个热点 (默认 6)。 */
  topK?: number;
  /** 路径前缀限定 (如 'src/harness/plan'); 给则只聚该前缀内的文件。 */
  scope?: string;
  /** 文件纳入谓词 (默认 CODE_FILE_RE: 只数代码文件, lock/资产/文档不算摩擦)。 */
  include?: (path: string) => boolean;
}

/** 默认纳入的代码文件后缀 (架构摩擦长在代码里, md/lock/图片不算)。 */
export const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sql|css|scss|html|vue|svelte)$/;

/** `--oneline` 的 commit 抬头行: 7-40 位 hex hash + 空格 + 标题。 */
const COMMIT_HEADER_RE = /^[0-9a-f]{7,40}\s/;

/**
 * 从 `git log --oneline --name-only` 原始输出数出每个文件的触碰次数。
 * commit 抬头行/空行跳过; 其余行按文件路径计数 (rename 的 `a -> b` 取新名)。
 */
export function countTouches(gitLog: string, include: (p: string) => boolean = (p) => CODE_FILE_RE.test(p)): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of gitLog.split('\n')) {
    const line = raw.trim();
    if (!line || COMMIT_HEADER_RE.test(line)) continue;
    const path = line.includes(' -> ') ? (line.split(' -> ').pop() ?? line) : line;
    if (!include(path)) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/** 文件 → 所属目录簇 key (根文件归 '.')。 */
function moduleDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

/**
 * 热点聚合: countTouches → (可选 scope 过滤) → 按目录聚簇 → 触碰量降序取 top K。
 * scope 给定但零命中 → 返回 [{dir: scope, files: [], touches: 0}] (扫描叶仍去探它)。
 */
export function computeHotspots(gitLog: string, opts: HotspotOptions = {}): Hotspot[] {
  const topK = opts.topK ?? 6;
  const scope = opts.scope?.replace(/\/+$/, '');
  const counts = countTouches(gitLog, opts.include);

  const groups = new Map<string, { path: string; touches: number }[]>();
  for (const [path, touches] of counts) {
    if (scope && path !== scope && !path.startsWith(`${scope}/`)) continue;
    const dir = moduleDir(path);
    const arr = groups.get(dir) ?? [];
    arr.push({ path, touches });
    groups.set(dir, arr);
  }

  const hotspots: Hotspot[] = [...groups.entries()].map(([dir, files]) => ({
    dir,
    files: files.sort((a, b) => b.touches - a.touches || (a.path < b.path ? -1 : 1)),
    touches: files.reduce((s, f) => s + f.touches, 0),
  }));
  hotspots.sort((a, b) => b.touches - a.touches || (a.dir < b.dir ? -1 : 1));

  if (hotspots.length === 0 && scope) return [{ dir: scope, files: [], touches: 0 }];
  return hotspots.slice(0, Math.max(1, topK));
}
