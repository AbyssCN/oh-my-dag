/**
 * src/mcp/run-registry.ts — run 注册表 (SDD run-registry, D-3/D-9).
 *
 * 职责:
 *   - runId → 状态/元数据/结果, 纯内存 (单测零磁盘)
 *   - 持久面: 复用 continuity CheckpointManager (crash resume, D-3/D-9)
 *   - 未知 runId 查询 → 明确 MCP error (isError + message), 非 crash
 *   - 活体进度: applyNodeEvent 累积引擎 DagNodeEvent → planned/started/settled
 *
 * 状态机: pending → running → done | failed (不可逆; 非法转换抛)
 */

import type { DagNodeEvent } from '../harness/executor-dag-types';

/** run 生命周期状态。 */
export type RunStatus = 'pending' | 'running' | 'done' | 'failed';


/** 单节点执行明细。 */
export interface NodeDetail {
  status: string;
  output: string;
  error?: string;
}

/** 活体进度快照 (applyNodeEvent 累积; planned 每轮重规划整体覆盖)。 */
export interface RunProgress {
  planned: Array<{ id: string; kind: string }>;
  started: string[];
  /** start 事件时刻 (ISO, settle 时清理) — running 行耗时由 now - startedAt 算出。 */
  startedAt: Record<string, string>;
  settled: Array<{ id: string; status: 'done' | 'failed'; kind: string; model?: string }>;
}

/** 毫秒 → 人读耗时 (0s / 45s / 3m12s / 1h2m3s)。 */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
}

/** run 元数据快照。 */
export interface RunRecord {
  status: RunStatus;
  goal: string;
  meta: Record<string, unknown>;
  result?: unknown;
  error?: string;
  nodeDetails?: Record<string, NodeDetail>;
  progress?: RunProgress;
  createdAt: string;
  updatedAt: string;
}

/** MCP 工具结果格式 (兼容 CallToolResult)。 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** 状态机合法转换表。 */
const LEGAL_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ['running'],
  running: ['done', 'failed'],
  done: [],
  failed: [],
};

export class RunRegistry {
  private runs = new Map<string, RunRecord>();

  /** @param now clock 注入 (单测可冻); 默认实时。 */
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 注册新 run。重复 runId → throw。 */
  register(runId: string, opts: { goal: string; meta?: Record<string, unknown> }): void {
    if (this.runs.has(runId)) throw new Error(`run ${runId} already registered`);
    const now = new Date().toISOString();
    this.runs.set(runId, {
      status: 'pending',
      goal: opts.goal,
      meta: opts.meta ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 状态转换。非法转换 → throw; 未知 runId → throw。 */
  private transition(runId: string, to: RunStatus): void {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error(`unknown run ${runId}`);
    if (!LEGAL_TRANSITIONS[rec.status].includes(to)) {
      throw new Error(`illegal transition ${rec.status} → ${to} for run ${runId}`);
    }
    rec.status = to;
    rec.updatedAt = new Date().toISOString();
  }

  start(runId: string): void {
    this.transition(runId, 'running');
  }

  succeed(runId: string, result: unknown): void {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error(`unknown run ${runId}`);
    this.transition(runId, 'done');
    rec.result = result;
  }

  fail(runId: string, error: string): void {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error(`unknown run ${runId}`);
    this.transition(runId, 'failed');
    rec.error = error;
  }

  /** 查状态; 未知 → null。 */
  getStatus(runId: string): RunStatus | null {
    return this.runs.get(runId)?.status ?? null;
  }

  /** 查完整记录; 未知 → null。 */
  getRecord(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  /** 写节点明细; 未知 runId → 静默忽略 (不抛, 对齐查询侧 null 语义)。 */
  setNodeDetails(runId: string, details: Record<string, NodeDetail>): void {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.nodeDetails = details;
    rec.updatedAt = new Date().toISOString();
  }

  /** 应用引擎节点事件 → 活体进度; 未知 runId → 静默忽略 (对齐 setNodeDetails)。 */
  applyNodeEvent(runId: string, e: DagNodeEvent): void {
    const rec = this.runs.get(runId);
    if (!rec) return;
    const progress = (rec.progress ??= { planned: [], started: [], startedAt: {}, settled: [] });
    switch (e.type) {
      case 'planned':
        progress.planned = e.nodes;
        break;
      case 'start':
        progress.started.push(e.id);
        progress.startedAt[e.id] = this.now().toISOString();
        break;
      case 'settle':
        progress.settled.push({ id: e.id, status: e.status, kind: e.kind, model: e.model });
        progress.started = progress.started.filter((id) => id !== e.id);
        delete progress.startedAt[e.id];
        break;
    }
    rec.updatedAt = new Date().toISOString();
  }

  /** 查单节点明细; 未知 runId/nodeId → null (不抛)。 */
  getNodeDetail(runId: string, nodeId: string): NodeDetail | null {
    return this.runs.get(runId)?.nodeDetails?.[nodeId] ?? null;
  }

  /**
   * MCP-safe 查询: 未知 runId → isError 结果 (非 crash)。
   * 已知 → 正常摘要。
   */
  getSummary(runId: string): ToolResult {
    const rec = this.runs.get(runId);
    if (!rec) {
      return {
        content: [{ type: 'text', text: `unknown run ${runId}` }],
        isError: true,
      };
    }
    const parts = [
      `runId: ${runId}`,
      `status: ${rec.status}`,
      `goal: ${rec.goal}`,
      `created: ${rec.createdAt}`,
      `updated: ${rec.updatedAt}`,
    ];
    if (rec.status === 'done' && rec.result !== undefined) {
      parts.push(`result: ${typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result)}`);
    }
    if (rec.status === 'failed' && rec.error) {
      parts.push(`error: ${rec.error}`);
    }
    // running 态活体进度 (applyNodeEvent 累积; D-8 宽出: 计数 + 在跑节点名, 不灌输出)。
    if (rec.status === 'running' && rec.progress) {
      const p = rec.progress;
      const total = p.planned.length || p.started.length + p.settled.length;
      const done = p.settled.filter((s) => s.status === 'done').length;
      const failed = p.settled.length - done;
      const pending = Math.max(0, total - p.started.length - p.settled.length);
      parts.push(`progress: ${done}/${total} done${failed ? `, ${failed} failed` : ''}, ${pending} pending`);
      if (p.started.length) {
        const kindOf = new Map(p.planned.map((n) => [n.id, n.kind]));
        const nowMs = this.now().getTime();
        parts.push(`running: ${p.started.map((id) => {
          const at = p.startedAt[id];
          const elapsed = at ? formatDuration(nowMs - Date.parse(at)) : '?';
          return `${id}(${kindOf.get(id) ?? '?'}, ${elapsed})`;
        }).join(', ')}`);
      }
    }
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  /**
   * resume 入口 (D-3 断点续跑): 未知 runId (server 重启, 内存态丢) → register+start;
   * failed → 重开为 running (error/progress 清空, 新一次尝试); 其余态由调用方先行拒绝。
   */
  reopenForResume(runId: string, opts: { goal: string; meta?: Record<string, unknown> }): void {
    const rec = this.runs.get(runId);
    if (!rec) {
      this.register(runId, opts);
      this.start(runId);
      return;
    }
    if (rec.status !== 'failed') throw new Error(`run ${runId} is ${rec.status} — resume 仅适用 failed/未知 run`);
    rec.status = 'running';
    rec.error = undefined;
    rec.progress = undefined;
    rec.updatedAt = new Date().toISOString();
  }

  /** 按状态列 runId; 无参数 → 全部。 */
  listRuns(status?: RunStatus): string[] {
    const entries = [...this.runs.entries()];
    return (status ? entries.filter(([, r]) => r.status === status) : entries).map(([id]) => id);
  }
}
