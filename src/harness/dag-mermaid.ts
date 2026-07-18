/**
 * dag-mermaid — ConductorPlan → Mermaid flowchart (DAG 画图, 纯函数零依赖)。
 *
 * 场景: dag-record 里的 run 可回放成图 (README/PR/审计贴图), TUI 后续可挂 /dag 命令。
 * 形状约定: command 节点 [[双框]] (确定性 CLI), agent 节点 ([圆角]) (工具子代理),
 * 其余 inproc leaf [方框]。带 results 时失败节点标红 (class failed)。
 * 输出为 ```mermaid 代码块内容 (不含围栏), id 统一 sanitize 防 mermaid 语法炸裂。
 */
import type { ConductorPlan } from './conductor-plan';

export interface MermaidOpts {
  /** 每个节点的终态 (dag-record LeafResult.status), 缺省不着色。 */
  status?: Record<string, 'done' | 'failed'>;
  /** 图方向, 默认 TD (上→下)。 */
  direction?: 'TD' | 'LR';
}

/** mermaid 节点 id 只留字母数字下划线; label 转义引号。 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function label(id: string, goal?: string): string {
  const text = goal ? `${id}: ${goal}` : id;
  const trimmed = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return trimmed.replace(/"/g, '#quot;');
}

/**
 * 把 conductor plan 渲染成 mermaid flowchart 源码 (不含 ``` 围栏)。
 * 节点全部先声明再连边; 无依赖节点也保证出现在图里。
 */
export function planToMermaid(plan: ConductorPlan, opts: MermaidOpts = {}): string {
  const dir = opts.direction ?? 'TD';
  const lines: string[] = [`flowchart ${dir}`];
  const nodes = plan.nodes ?? {};

  for (const [id, node] of Object.entries(nodes)) {
    const sid = safeId(id);
    const text = label(id, node.goal);
    if (node.executor === 'command') lines.push(`  ${sid}[["${text}"]]`);
    else if (node.executor === 'agent') lines.push(`  ${sid}(["${text}"])`);
    else lines.push(`  ${sid}["${text}"]`);
  }

  for (const [id, node] of Object.entries(nodes)) {
    for (const dep of node.depends_on ?? []) {
      if (!(dep in nodes)) continue; // 容忍坏引用, 与 topoLevels 的宽容一致
      lines.push(`  ${safeId(dep)} --> ${safeId(id)}`);
    }
  }

  const failed = Object.entries(opts.status ?? {})
    .filter(([, s]) => s === 'failed')
    .map(([id]) => safeId(id));
  if (failed.length > 0) {
    lines.push('  classDef failed fill:#7f1d1d,stroke:#ef4444,color:#fff');
    lines.push(`  class ${failed.join(',')} failed`);
  }
  return lines.join('\n');
}
