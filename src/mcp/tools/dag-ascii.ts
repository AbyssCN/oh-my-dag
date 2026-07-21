/**
 * src/mcp/tools/dag-ascii — DAG 进度的纯 ASCII 渲染器 (零依赖)。
 *
 * 从 dag-tools 抽出: dag_status / 派发简报 / omd-hud statusline 三方复用同一渲染。
 * **纯函数、无 import** —— statusline 侧 (scripts/omd-hud.ts) 能只拉这个模块, 不拖进
 * 引擎/zod/mcp-sdk (statusline 每 1~2s fork, 重 import 会被 300ms debounce cancel)。
 */

/** Max nodes before downsampling to per-level counts only. */
const ASCII_DOWNSAMPLE_THRESHOLD = 20;

/** Node status symbol map. */
const STATUS_SYM: Record<string, string> = { done: '✔', running: '▶', failed: '✘' };

/**
 * ASCII层级图 — 宽 ≤maxCols 列。>20 节点降采样为每层计数。
 * 有 topoLevels → 按层; 无 → planned 顺序平铺一行组 (诚实)。
 * 导出供 dag_status / 外部渲染 (omd-hud) 复用。
 */
export function renderProgressAscii(
  levels: string[][] | undefined,
  progress: {
    planned: Array<{ id: string; kind: string }>;
    started: string[];
    settled: Array<{ id: string; status: 'done' | 'failed'; kind: string }>;
  },
  maxCols = 100,
): string {
  const settledOf = new Map(progress.settled.map((s) => [s.id, s]));
  const startedSet = new Set(progress.started);
  const kindOf = new Map(progress.planned.map((n) => [n.id, n.kind]));
  // flat fallback: 无 topoLevels 时所有 planned 节点归一层
  const effective = levels ?? (progress.planned.length > 0 ? [progress.planned.map((n) => n.id)] : []);
  const total = effective.reduce((s, l) => s + l.length, 0);

  const sym = (id: string): string => {
    const s = settledOf.get(id);
    if (s) return STATUS_SYM[s.status] ?? '○';
    return startedSet.has(id) ? '▶' : '○';
  };

  if (total > ASCII_DOWNSAMPLE_THRESHOLD) {
    return effective.map((ids, i) => {
      const counts: Record<string, number> = {};
      for (const id of ids) {
        const s = sym(id);
        counts[s] = (counts[s] ?? 0) + 1;
      }
      const parts = ['✔', '▶', '✘', '○'].filter((s) => counts[s]).map((s) => `${s}${counts[s]}`);
      return `L${i + 1} ${parts.join(' ')}`;
    }).join('\n');
  }

  return effective.map((ids, i) => {
    const entries = ids.map((id) => `${sym(id)} ${id}(${kindOf.get(id) ?? '?'})`);
    let line = `L${i + 1} ${entries.join(' ')}`;
    if (line.length > maxCols) line = line.slice(0, maxCols - 3) + '...';
    return line;
  }).join('\n');
}
