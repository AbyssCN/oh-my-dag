/**
 * src/mcp/run-registry.ts — run 注册表 (SDD run-registry, D-3/D-9).
 *
 * 职责:
 *   - runId → 状态/元数据/结果, 纯内存 (单测零磁盘)
 *   - 持久面: 复用 continuity CheckpointManager (crash resume, D-3/D-9)
 *   - 未知 runId 查询 → 明确 MCP error (isError + message), 非 crash
 *
 * 状态机: pending → running → done | failed (不可逆; 非法转换抛)
 */

/** run 生命周期状态。 */
export type RunStatus = 'pending' | 'running' | 'done' | 'failed';

/** run 元数据快照。 */
export interface RunRecord {
  status: RunStatus;
  goal: string;
  meta: Record<string, unknown>;
  result?: unknown;
  error?: string;
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
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  /** 按状态列 runId; 无参数 → 全部。 */
  listRuns(status?: RunStatus): string[] {
    const entries = [...this.runs.entries()];
    return (status ? entries.filter(([, r]) => r.status === status) : entries).map(([id]) => id);
  }
}
