/**
 * src/harness/session/checkpoint-anchors —— 交接的**代码锚**(L3, 2026-08-28)。
 *
 * ## 它替掉的那句话
 *
 * 今天每一段交接开场都带一句「可能已过时;要核实就读全文,别直接当事实用」。那是一句
 * **免责声明** —— 它对每一份交接都成立,所以它不含信息。这一层把它换成读数:
 * 「上一段交接引用的 12 个文件里,3 个在那之后被改过 —— 是这三个」。
 *
 * ## 与 writer 那道验真闸的分工
 *
 * `writer.ts:validate` 是**写时**闸:检查 md 里的路径真实存在、commit 真在 git 里 ——
 * 判的是"这份交接有没有编造"。本模块是**读时**闸:同样几个路径,在交接写完**之后**
 * 有没有被改过 —— 判的是"这份交接还新鲜吗"。两者用同一个路径提取器(见 `extractRepoPaths`),
 * 但回答的是两个不同的问题,任何一个都替代不了另一个。
 *
 * ## 为什么是 sidecar 文件, 不是写进 md / 写进 fact
 *
 * - 写进 md:md 是给人和模型读的真源,往里塞一串 16 位 hex 是污染;而且读回要解析,脆。
 * - 写进 continuity fact:那条 fact 走 sink,**全程 fail-open**,失败只留一行 `{ok:false}`。
 *   把锚挂在一条可能不存在的记录上,等于让读侧的"没有锚"永远分不清是没写还是写失败了。
 * - sidecar `checkpoint.anchors.json` 与 `checkpoint.md` **同目录同生命周期**:
 *   md 在则锚在,md 被删则锚一起没。零 schema 迁移,零解析。
 *
 * ## NULL ≠ 0(仓规坑①)
 *
 * 「没有 sidecar」与「有 sidecar 且 0 个文件变了」是两件事:前者是这份交接写于本机制之前
 * (或写锚时失败了),后者是一条真读数。{@link readCheckpointAnchors} 前者返 `null`、后者返
 * `changed: []`,渲染面据此**一个不说话、一个说"全部未变"**。
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprintFile } from '../memory/staleness';

/** sidecar 文件名 —— 与 `checkpoint.md` 并排。 */
export const ANCHORS_FILENAME = 'checkpoint.anchors.json';

export interface CheckpointAnchor {
  /** 仓相对路径。 */
  path: string;
  /** 写交接那一刻该文件的 sha256 前 16 hex。 */
  sha: string;
}

export interface CheckpointAnchorFile {
  /** 写入时刻(epoch ms)—— 渲染面说"交接之后"时用它。 */
  writtenAt: number;
  anchors: CheckpointAnchor[];
}

/**
 * 从 checkpoint markdown 里提取仓内路径。
 *
 * ⚠ **正则与 `writer.ts:validate` 的 `pathRe` 必须一致** —— 两边提的是同一批路径,
 * 一边认得另一边不认得的话,写时闸放行的路径读时闸看不见(反过来更糟:读时闸告警一个
 * 写时闸从没验过的路径)。这里是那个正则的**唯一定义处**,writer 从这里 import。
 */
export function extractRepoPaths(md: string): string[] {
  const pathRe = /(?:src|docs|scripts|test|frontend|sql|supabase)\/[\w\-./[\]]+/g;
  return [
    ...new Set(
      (md.match(pathRe) ?? []).map((p) => p.replace(/[.,;:)\]]+$/, '').replace(/:\d+.*$/, '')),
    ),
  ];
}

/**
 * 写 sidecar。**只锚真实存在的路径** —— md 里合法地引用了源材料里的外部路径(writer 的
 * 验真闸允许这种),那种路径在本仓读不到,锚它只会在读侧制造一片假的 `missing`。
 *
 * 全程 fail-open 且**返回写了几个**:调用方拿这个数决定要不要在日志里说一句。
 * 抛出去会让交接写入失败,而交接是告知层 —— 它永远不该把正在跑的那一轮弄失败。
 */
export function writeCheckpointAnchors(
  checkpointPath: string,
  md: string,
  projectRoot: string,
  nowMs: number = Date.now(),
): number {
  try {
    const anchors: CheckpointAnchor[] = [];
    for (const p of extractRepoPaths(md)) {
      const { sha } = fingerprintFile(join(projectRoot, p));
      if (sha !== null) anchors.push({ path: p, sha });
    }
    const payload: CheckpointAnchorFile = { writtenAt: nowMs, anchors };
    writeFileSync(join(dirname(checkpointPath), ANCHORS_FILENAME), `${JSON.stringify(payload, null, 2)}\n`);
    return anchors.length;
  } catch {
    return -1; // -1 = 写锚这一步挂了 (0 = 写成功但一个路径都没提到) —— 两者不许折叠
  }
}

export interface AnchorDrift {
  /** 交接写入时刻(epoch ms)。 */
  writtenAt: number;
  /** 锚的总数。 */
  total: number;
  /** 交接之后**内容变了**的路径。 */
  changed: string[];
  /** 交接之后**读不到了**的路径(删了 / 换了 worktree)。与 changed 分开 —— 处置不同。 */
  gone: string[];
}

/**
 * 读 sidecar 并重算。
 *
 * 返回 `null` 的三种情形(调用方一律当"这一格没有读数",**不要**当"没有漂移"):
 * sidecar 不存在(交接写于本机制之前)· 读不动 · 内容不是预期形状。
 */
export function readCheckpointAnchors(checkpointPath: string, projectRoot: string): AnchorDrift | null {
  try {
    const p = join(dirname(checkpointPath), ANCHORS_FILENAME);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<CheckpointAnchorFile>;
    if (!Array.isArray(raw.anchors) || typeof raw.writtenAt !== 'number') return null;

    const changed: string[] = [];
    const gone: string[] = [];
    for (const a of raw.anchors) {
      if (typeof a?.path !== 'string' || typeof a?.sha !== 'string') continue;
      const { sha } = fingerprintFile(join(projectRoot, a.path));
      if (sha === null) gone.push(a.path);
      else if (sha !== a.sha) changed.push(a.path);
    }
    return { writtenAt: raw.writtenAt, total: raw.anchors.length, changed, gone };
  } catch {
    return null;
  }
}

/** 一次漂移读数 → 注进开场的一行。无漂移也说话(「全部未变」是读数,沉默不是)。 */
export function renderAnchorDrift(d: AnchorDrift | null): string {
  if (d === null) return ''; // 没有读数 ⇒ 什么都不说, 而不是说"没变"
  if (d.total === 0) return '交接锚:这份交接没有引用仓内文件 — 无从判新鲜度。';
  if (d.changed.length === 0 && d.gone.length === 0) {
    return `交接锚:引用的 ${d.total} 个文件在交接之后**都没变**。`;
  }
  const parts: string[] = [];
  if (d.changed.length > 0) parts.push(`**${d.changed.length} 个被改过**: ${d.changed.slice(0, 8).join(' · ')}`);
  if (d.gone.length > 0) parts.push(`${d.gone.length} 个读不到: ${d.gone.slice(0, 5).join(' · ')}`);
  return `交接锚:引用的 ${d.total} 个文件里, ${parts.join(';')} — 涉及这些文件的结论先核再用。`;
}
