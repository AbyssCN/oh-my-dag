/**
 * harness/writeset/head-baseline —— **head 档的轮基线 = 写集哈希快照**(刀①-2,2026-08-30 闸门三角结)。
 *
 * ## 它补的洞
 *
 * 救援③(engine.ts「写集相对 run 基线有改动 → 判真写入」)此前只在隔离档生效:判据是
 * `git status --porcelain` 对 `continuity.rollbackBaseline` 那个 commit —— 而 head 档没有
 * 轮基线 commit(也**不该有**:在人的工作树上打 commit 会把人的未提交改动一起收进去)。
 * 于是 head 档下「上一轮真干完活、本轮被重跑」的 leaf 理性只读不写 → empty-artifact → 级联 skip,
 * 死循环完整存在(契约 §审计结论 ②)。
 *
 * 本模块给 head 档一个**不打 git commit 的基线**:每轮开跑前把各节点 `write_set` 文件的
 * (内容哈希 + symlink realpath + mode 位)记成 sidecar manifest,救援③在 head 档改比对它。
 *
 * ## 显式不支持(契约钉死,遇到降级现状行为 = 无基线,救援③不启用)
 *
 * submodule / git-LFS / sparse-checkout:这三种形态下「盘上这份文件」与「内容哈希」的对应
 * 关系不再由本模块的 lstat+read 语义单独决定(LFS pointer vs 真身、submodule 的独立 HEAD)。
 * 判错的代价是把别人的改动认成本轮写入 —— 宁可整个不开。检测在 {@link headBaselineUnsupported},
 * 命中时调用方必须留一行证据(fail-open 不吞证据)。
 *
 * 证伪方式(head-baseline.test 反向自检):把 compare 的 hash 判等改成恒 true →
 * 「跑前跑后一字未动」用例必红(no-change 被误判成 changed)。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hashArtifact } from '../continuity/checkpoint-manager';
import { logger } from '../logger';

/** 一条写集路径在轮开跑前的状态。三个 `null` 都表示「量过了且不存在/不适用」,不是没量。 */
export interface HeadBaselineEntry {
  /** 内容 hash(sha256 前 16;symlink 跟随读真身)。文件不存在/读不到 → null。 */
  hash: string | null;
  /** lstat 的权限位(八进制,如 '644')。不存在 → null。 */
  mode: string | null;
  /** symlink 的 realpath;非 symlink / 不存在 → null。哈希抓不到「真身被换了个目标」,这一位抓。 */
  link: string | null;
}

export interface HeadWriteSetBaseline {
  createdAt: string;
  /** 相对 root 的写集路径 → 跑前状态。键 = write_set 里的原样字符串(精确匹配,与救援③隔离档同口径,不展开 glob)。 */
  entries: Record<string, HeadBaselineEntry>;
}

/** 这棵树能不能用本基线。能 → null;不能 → 不支持的原因(调用方留证据行)。 */
export function headBaselineUnsupported(root: string): string | null {
  if (existsSync(join(root, '.gitmodules'))) return 'submodule (.gitmodules 在仓根)';
  if (existsSync(join(root, '.git/info/sparse-checkout'))) return 'sparse-checkout (.git/info/sparse-checkout 存在)';
  try {
    const attrs = join(root, '.gitattributes');
    if (existsSync(attrs) && readFileSync(attrs, 'utf-8').includes('filter=lfs')) return 'git-lfs (.gitattributes 声明 filter=lfs)';
  } catch (err) {
    // .gitattributes 读不了 → 判不了 LFS → 保守当不支持 (fail-closed: 宁可不开基线, 不冒认错改动的险)。
    return `git-lfs 判定失败 (.gitattributes 读不了: ${(err as Error).message})`;
  }
  return null;
}

function statEntry(root: string, rel: string): HeadBaselineEntry {
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  try {
    const st = lstatSync(abs);
    const link = st.isSymbolicLink() ? realpathSync(abs) : null;
    return { hash: hashArtifact(abs), mode: (st.mode & 0o777).toString(8), link };
  } catch (err) {
    // ENOENT = 「量过了且不存在」是本函数的正常一格, 不刷日志; 其余错法 (权限/IO) 必须留痕 ——
    // 静默把它们记成"不存在", 事后与真不存在再也分不开 (NULL≠0≠不适用)。
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      logger.warn({ path: abs, code, err: (err as Error).message }, '[omd/head-baseline] 写集路径 stat 失败 (非 ENOENT) → 记为不存在 (fail-open 留证)');
    }
    return { hash: null, mode: null, link: null };
  }
}

/** 每轮开跑前照一次相。`paths` = 全图节点 write_set 的并集(调用方收)。 */
export function captureHeadBaseline(root: string, paths: Iterable<string>): HeadWriteSetBaseline {
  const entries: Record<string, HeadBaselineEntry> = {};
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p in entries) continue;
    entries[p] = statEntry(root, p);
  }
  return { createdAt: new Date().toISOString(), entries };
}

/**
 * 救援③的 head 档判据:节点写集里,相对轮基线**变过**的路径。
 *
 * INV 与隔离档 `writeSetChangedSinceBaseline` 逐格对齐:
 *   写集空 → reason 'no-write-set';基线里没这一格(运行期长出来的节点)→ 不判那条路
 *   (fail-closed:证不出「跑前长什么样」就不许说「变了」);全部没变 → reason 'no-change'。
 * 变的定义 = hash ∨ mode ∨ link 任一不同(mode/link 是哈希的盲区,契约点名要抓)。
 */
export function changedSinceHeadBaseline(args: {
  root: string;
  writeSet: readonly string[];
  baseline: HeadWriteSetBaseline;
}): { changed: string[]; reason?: string } {
  const ws = (args.writeSet ?? []).filter((p) => typeof p === 'string' && p.length > 0);
  if (ws.length === 0) return { changed: [], reason: 'no-write-set' };
  const changed: string[] = [];
  const unjudged: string[] = [];
  for (const p of ws) {
    const before = args.baseline.entries[p];
    if (!before) {
      unjudged.push(p);
      continue;
    }
    const now = statEntry(args.root, p);
    if (now.hash !== before.hash || now.mode !== before.mode || now.link !== before.link) changed.push(p);
  }
  if (changed.length > 0) return { changed };
  // 「没变」与「有几格判不了」分开说 —— 判不了的路径要进日志, 不许静默当成没变 (NULL≠0≠不适用)。
  return { changed: [], reason: unjudged.length > 0 ? `no-change (未入基线判不了: ${unjudged.join(', ')})` : 'no-change' };
}
