/**
 * src/mcp/run-registry.ts — run 注册表 (SDD run-registry, D-3/D-9).
 *
 * 职责:
 *   - runId → 状态/元数据/结果, 内存热路径 (不给 store 则单测零磁盘)
 *   - **身份持久面** (S2, 2026-08-03): 给了 `store` 则 runId/状态写穿 `.omd/runs.db`, 构造时 hydrate ——
 *     MCP server 是 stdio + 客户端消失即自杀, "重启"是每次会话结束都会发生的事; 此前一重启就
 *     **没人记得那个 runId 存在过**, 而 checkpoint 一直在盘上。见 run-store.ts
 *   - 产物持久面: continuity CheckpointManager (crash resume, D-3/D-9)
 *   - 未知 runId 查询 → 明确 MCP error (isError + message), 非 crash
 *   - 活体进度: applyNodeEvent 累积引擎 DagNodeEvent → planned/started/settled
 *
 * 状态机: pending → running → done | failed (不可逆; 非法转换抛)
 */

import type { DagNodeEvent } from '../harness/executor-dag-types';
import { defaultIsAlive, type RunStore } from './run-store';
import { logger } from '../logger';

/**
 * run 生命周期状态。
 *
 * `cancelled` (D-P, 2026-07-30) 刻意与 `failed` 分开: 被叫停的 run **没有失败** —— 已跑完的节点
 * 全绿、产物全在盘上, 它只是没跑完。混进 failed 会让两个不同的事后动作 (查为什么挂了 / 直接续跑)
 * 读同一个词, 而它们该走的路不一样。与 failed 同为可 resume 的终态 (见 reopenForResume)。
 */
export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';


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
  settled: Array<{ id: string; status: 'done' | 'failed' | 'skipped'; kind: string; model?: string }>;
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
  running: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export class RunRegistry {
  private runs = new Map<string, RunRecord>();
  /**
   * D-P: 在飞 run 的取消把手。住在这里而不是各工具的模块变量里 —— registry 已经是这个 server
   * 唯一那份"哪些 run 在飞"的真相, 取消把手是同一件事的另一面; 分两处存早晚对不上
   * (dag_goal 与 dag_run 都要能被取消, 而它们是两个文件)。
   */
  private controllers = new Map<string, AbortController>();

  /**
   * S2 持久面 (给了才存)。**内存仍是热路径**, 这里是写穿的镜像 —— 省略 = 老语义, 零磁盘。
   * 存什么/不存什么, 以及"属主进程"那条为什么是关键而不是记账, 见 `run-store.ts` 模块注。
   */
  private readonly store?: RunStore;
  private readonly isAlive: (pid: number) => boolean;
  private readonly pid: number;

  /**
   * @param now clock 注入 (单测可冻); 默认实时。
   * @param opts.store 持久面; 给了则构造时**先 hydrate** —— server 重启后 runId 还认得出来。
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    opts: { store?: RunStore; isAlive?: (pid: number) => boolean; pid?: number } = {},
  ) {
    this.store = opts.store;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.pid = opts.pid ?? process.pid;
    if (this.store) this.hydrate();
  }

  /**
   * 从持久面恢复 runId → 状态。
   *
   * ⚠ **不许原样恢复 `running`**: 那会让重启后出现一个永远"在跑"、却根本没有进程在跑它的 run ——
   * 比不持久化更坏 (不持久化至少是"不知道", 这是"知道错的")。属主 pid 不存活 = 它跑到一半被打断,
   * 落 `failed` 并把原因写清 —— 打断之后该干的事与 failed/cancelled 完全一样 (resume), 下一步
   * 一样就不该造新词 (D-P 给 cancelled 立新词的理由反过来用)。
   */
  private hydrate(): void {
    for (const r of this.store!.all()) {
      const orphaned = (r.status === 'running' || r.status === 'pending') && (r.ownerPid === null || !this.isAlive(r.ownerPid));
      this.runs.set(r.runId, {
        status: (orphaned ? 'failed' : r.status) as RunStatus,
        goal: r.goal,
        meta: r.meta,
        ...(orphaned
          ? { error: `属主进程已不在 (pid ${r.ownerPid ?? '?'}) — 这次跑没跑完, 直接 resume 接着跑` }
          : r.error
            ? { error: r.error }
            : {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
    }
  }

  /**
   * 把一条记录写穿到持久面 (无 store → no-op)。
   *
   * **这里也 fail-open**, 尽管生产的 store 自己已经吞了异常 —— 不变量是"持久化不该把一次真跑
   * 带走", 它该在**边界**上成立, 而不是靠注进来的 store 恰好有礼貌。
   */
  private persist(runId: string): void {
    if (!this.store) return;
    const rec = this.runs.get(runId);
    if (!rec) return;
    try {
      this.putRecord(runId, rec);
    } catch (e) {
      // fail-open 的判断不变: 把一次在跑的活炸掉要贵得多。**但不许无声** ——
      // 2026-08-02 一次 live 在这条路上丢了终态, 而两层 catch (这里 + run-store.put) 都不出声,
      // 于是唯一的症状是"盘上停在 running 而 worker 说 done", 排查时无从下手。
      // ⚠ 注释原文"最多是重启后少认得一个 runId"**低估了代价**: detached run 的盘上记录
      // 就是它唯一的出口, 丢了等于这次跑的结论没有任何人看得到。
      logger.warn(
        { runId, status: rec.status, err: (e as Error).message },
        '[omd/run-registry] persist 失败 —— 内存已是新状态而盘上没有 (fail-open 继续跑)',
      );
    }
  }

  private putRecord(runId: string, rec: RunRecord): void {
    this.store!.put({
      runId,
      status: rec.status,
      goal: rec.goal,
      meta: rec.meta,
      ...(rec.error ? { error: rec.error } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      // 终态记录的 pid 没有意义 (判活只在 pending/running 上做), 存 null 免得误导。
      ownerPid: rec.status === 'pending' || rec.status === 'running' ? this.pid : null,
    });
  }

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
    this.persist(runId);
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
    // 终态 → 取消把手没有意义了, 清掉 (留着 = 一个永远 abort 不到东西的旋钮 + 内存慢慢涨)。
    if (LEGAL_TRANSITIONS[to].length === 0) this.controllers.delete(runId);
    this.persist(runId);
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
    this.persist(runId); // transition 已写过一次, 但 error 是它之后才落的
  }

  /**
   * D-P 协作式取消的**收尾登记** (引擎那侧已经停了派活, 这里只记状态)。
   *
   * `result` 照记 —— 被叫停的 run 手上有的东西一样值钱 (已跑完的节点、产物、账本), 拿不到它
   * 才是取消最贵的代价。`error` 记原因: 它不是错误, 是"为什么停的", 与 failed 的错误消息占同一格
   * 但由 status 分辨 (查询侧按 status 决定怎么念这句话)。
   */
  cancel(runId: string, reason: string, result?: unknown): void {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error(`unknown run ${runId}`);
    this.transition(runId, 'cancelled');
    rec.error = reason;
    if (result !== undefined) rec.result = result;
    this.persist(runId); // 同 fail: 原因是 transition 之后才落的
  }

  /**
   * D-P: 给这个 run 建一个取消把手, 返回喂给引擎 `cancelSignal` 的 signal。
   * 同一个 runId 重复调 (resume) → 新把手 (上一次的已随终态清掉)。
   */
  attachCancel(runId: string): AbortSignal {
    const ac = new AbortController();
    this.controllers.set(runId, ac);
    return ac.signal;
  }

  /**
   * D-P: 请求取消。**只是打个招呼** —— 引擎在下一个调度接缝上自己停下来 (不杀在飞节点),
   * 终态由引擎跑完后经 {@link cancel} 登记。
   *
   * @returns false = 这个 run 没有取消把手 (未知 / 不在飞 / server 重启后内存态丢了) —— 调用方
   *   该如实告诉用户"没停到", 而不是回一句"已取消"。
   */
  requestCancel(runId: string, reason: string): boolean {
    const ac = this.controllers.get(runId);
    if (!ac || ac.signal.aborted) return false;
    ac.abort(reason);
    return true;
  }

  /** 该 run 是否已被请求取消 (在飞期间查得到; 终态后把手已清 → false)。 */
  isCancelRequested(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted === true;
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
      // 运行时展开 (map/conductor 子节点): **追加**进 planned, 不覆盖 —— 覆盖等于把父节点从图上抹掉。
      // 这是"观察面变窄"那条的活体侧: 此前子节点只有 start/settle 两个事件, 于是进度行的分母
      // (planned 的长度) 里根本没有它们, 一个展开出 5 个子节点的执行段永远显示 "0/1"。
      case 'expanded': {
        const known = new Set(progress.planned.map((n) => n.id));
        for (const n of e.nodes) if (!known.has(n.id)) progress.planned.push({ id: n.id, kind: n.kind });
        break;
      }
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
    // 取消不是失败: 念法不同 (原因 + "怎么接着跑"), 而且手上的结果照样给。
    if (rec.status === 'cancelled') {
      parts.push(`cancelled: ${rec.error ?? '调用方叫停'}`);
      parts.push(`resume: dag_resume runId=${runId} (已跑完的节点会被跳过)`);
      if (rec.result !== undefined) {
        parts.push(`partial: ${typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result)}`);
      }
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
   * failed / **cancelled** → 重开为 running (error/progress 清空, 新一次尝试); 其余态由调用方先行拒绝。
   *
   * cancelled 可续是 D-P 的兑现处 —— "已跑完的节点全保留"这句话, 保留在盘上的 checkpoint 里,
   * 兑现在这一次 resume 上。不让它续, 取消就等于扔掉。
   */
  reopenForResume(runId: string, opts: { goal: string; meta?: Record<string, unknown> }): void {
    const rec = this.runs.get(runId);
    if (!rec) {
      this.register(runId, opts);
      this.start(runId);
      return;
    }
    if (rec.status !== 'failed' && rec.status !== 'cancelled') {
      throw new Error(`run ${runId} is ${rec.status} — resume 仅适用 failed/cancelled/未知 run`);
    }
    rec.status = 'running';
    rec.error = undefined;
    // **result 也得清** (2026-07-30 取消冒烟撞出来的): 重开 = 新一次尝试, 上一次的结论不再作数。
    // 此前只清 error —— 于是一个被叫停的 run (它**带着 result**: 手上已跑完的东西照记) 续跑之后,
    // `dag_result` / `dag_status` 还会把上一次那份摘要端出来, 读的人分不清那是这次还是上次的。
    // failed 那条路上一直有同样的洞, 只是 failed 很少带 result 所以没人撞见。
    rec.result = undefined;
    rec.progress = undefined;
    rec.updatedAt = new Date().toISOString();
    // 写穿: 续跑的属主是**本进程**。漏了这一步, 盘上那条还挂着上一个已死进程的 pid ——
    // 下次 hydrate 会把一个正在跑的 run 判成"被打断", 而它好好地在跑。
    this.persist(runId);
  }

  /** 按状态列 runId; 无参数 → 全部。 */
  listRuns(status?: RunStatus): string[] {
    const entries = [...this.runs.entries()];
    return (status ? entries.filter(([, r]) => r.status === status) : entries).map(([id]) => id);
  }
}
