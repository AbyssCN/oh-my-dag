/**
 * src/harness/dag/dag-scheduler —— executor-DAG 的**纯调度器**(从 executor-dag.ts 的 executePlan 里抽出)。
 *
 * 只管三件事, 且**只管这三件**:
 *   ① 拓扑推进   —— indeg 归零即入 ready (取代逐层 barrier);
 *   ② 并发闸     —— 全局 cap × per-kind × per-channel 三层记账;
 *   ③ quorum 判词 —— 依赖没达标的节点从 ready 里摘掉 (判定在此, 日志与 LeafResult 构造在调用方)。
 *
 * 刻意**零 IO / 零 async / 零 config 依赖**: 不打日志、不碰 results、不认识 ExecutorDagConfig。
 * 节点 kind / channel / 依赖状态一律经 opts 的三个纯函数问调用方 (executor-dag 那边持有 config 与
 * results, 由它把 `config.leafModel`/`config.agentLeafModel`/`results[d]?.status` 闭包进去)。
 * 收益: 调度语义从此可以**脱开 LLM 单测** —— 以前这些规则只能连着真跑一张图才验得到。
 *
 * ⚠ 这是搬迁不是重写: 所有判据 (幻象 dep 视为已满足 / cap 缺省 / 非严格 FIFO 让位 / quorum 缺省启发)
 *   与原 executePlan 逐字一致, 任何"顺手改进"都是行为变更。
 */
import type { ConductorPlan } from '../conductor-plan';

/** 调度期 kind 词表。按**声明的 executor** 记账 (运行期 router 的选择不改记账)。 */
export type SchedKind = 'agent' | 'command' | 'inproc';

export interface DagSchedulerOpts {
  /** 节点 → 调度 kind。command → 'command'; agent → 'agent'; 其余 (leaf/map/primitive) → 'inproc'。 */
  kindOf: (id: string) => SchedKind;
  /**
   * 节点 → 渠道键 (provider 前缀), null = 不入渠道闸 (command 节点无模型)。
   * 模型缺省值 (leafModel / agentLeafModel) 由调用方闭包进来 —— 调度器不认识 config。
   */
  channelOf: (id: string) => string | null;
  /** 节点 → 已 settle 的状态 ('done'/'failed'/'skipped'/…); undefined = 还没结果。quorum 判定读它。 */
  statusOf: (id: string) => string | undefined;
  /** 全局并发上限。缺省/非正 = 图宽 (idSet.size || 1), **不是无穷**。 */
  maxFanout?: number;
  /** per-kind 并发闸。三格各自缺省 +∞ (未配即不限, 零回归)。 */
  kindFanout?: Partial<Record<SchedKind, number>>;
  /** per-channel 并发闸 (D-23)。未配任何一格 → 渠道闸整体停用 (channelBlocked 恒 false)。 */
  channelFanout?: Record<string, number>;
}

/** quorum 判词 (不达标才产出)。日志文案与 skipped LeafResult 由调用方拼 —— 调度器零 IO。 */
export interface QuorumVerdict {
  requires: 'all' | 'any' | number;
  done: number;
  /** 真实依赖 (已滤掉幻象 dep)。 */
  deps: string[];
  /** 未 done 的依赖, 已格式化成 `id(status)`。 */
  bad: string[];
}

const EMPTY: readonly string[] = [];

export class DagScheduler {
  private readonly idSet: Set<string>;
  private readonly indeg = new Map<string, number>();
  private readonly dependents = new Map<string, string[]>();
  private readonly ready: string[];
  private readonly cap: number;
  private readonly kindCap: Record<SchedKind, number>;
  private readonly runningByKind: Record<SchedKind, number> = { agent: 0, command: 0, inproc: 0 };
  private readonly channelCap: Record<string, number>;
  private readonly hasChannelCaps: boolean;
  private readonly runningByChannel = new Map<string, number>();
  /** takeRunnable 记的账 (kind + channel), release 按同一笔退 —— 不重算, 保证增减配对。 */
  private readonly charged = new Map<string, { kind: SchedKind; channel: string | null }>();
  private running = 0;

  /** 图宽 = 节点数 (暖发的 `size > 1` 前置条件读它)。 */
  readonly size: number;

  constructor(
    private readonly plan: ConductorPlan,
    private readonly opts: DagSchedulerOpts,
  ) {
    this.idSet = new Set(Object.keys(plan.nodes));
    for (const id of this.idSet) {
      // 幻象 dep (指向不存在的 id) 视为已满足, 同 topoLevels。
      const deps = (plan.nodes[id]!.depends_on ?? []).filter((d) => this.idSet.has(d));
      this.indeg.set(id, deps.length);
      for (const d of deps) {
        const arr = this.dependents.get(d) ?? [];
        arr.push(id);
        this.dependents.set(d, arr);
      }
    }
    this.ready = [...this.idSet].filter((id) => (this.indeg.get(id) ?? 0) === 0);
    this.size = this.idSet.size;
    this.cap = opts.maxFanout && opts.maxFanout > 0 ? opts.maxFanout : this.idSet.size || 1;
    // per-kind 并发闸 (fanout 最大化, 2026-07-21): inproc 纯 API 等待默认不限;
    // agent/command 有本地足迹 (工具调用/CLI 抢本机 CPU·磁盘) → 独立小闸。
    this.kindCap = {
      agent: opts.kindFanout?.agent ?? Number.POSITIVE_INFINITY,
      command: opts.kindFanout?.command ?? Number.POSITIVE_INFINITY,
      inproc: opts.kindFanout?.inproc ?? Number.POSITIVE_INFINITY,
    };
    this.channelCap = opts.channelFanout ?? {};
    this.hasChannelCaps = Object.keys(this.channelCap).length > 0;
  }

  get runningCount(): number {
    return this.running;
  }

  get readyCount(): number {
    return this.ready.length;
  }

  /** 收敛判据: ready 空且无在跑。 */
  isDrained(): boolean {
    return this.ready.length === 0 && this.running === 0;
  }

  /** 直接下游 (fan-in 定向摘要要数 consumer)。 */
  dependentsOf(id: string): readonly string[] {
    return this.dependents.get(id) ?? EMPTY;
  }

  /**
   * 暖发挑节点: 摘一个**真会打模型**的 ready 节点 (即非 command)。整层都是 command → null (不暖)。
   *
   * **记账** (t-initial-pump, 2026-09-02): 暖发不再是调用方 await 到 settle 的串行一发 ——
   * 它起跑后 pool 只按住一个宽限窗口就放开, 之后暖发与其余节点**真并发**。不记账就会让
   * `isDrained()` 在暖发还在飞时判成收敛 (ready 空 + running 0) → 它的 dependents 永远不派。
   * 与 `takeRunnable` 同一笔账, 由同一个 `release(id)` 退。
   * (仍**不过** kind/channel 闸: 暖发是这张图的第一发, 此刻没有别的在飞, 闸恒不可能挡住它。)
   */
  takeWarmStart(): string | null {
    const idx = this.ready.findIndex((rid) => this.opts.kindOf(rid) !== 'command');
    if (idx < 0) return null;
    const id = this.ready.splice(idx, 1)[0]!;
    this.charge(id);
    return id;
  }

  /**
   * D-7v2 quorum: 从 ready 里摘掉第一个依赖没达标的节点, 返回判词。**不记账** (skip 不运行不占槽,
   * 所以它排在 kind 闸之前消化)。调用方拿判词打日志 + 构造 skipped LeafResult + settle。
   */
  takeSkippable(): { id: string; verdict: QuorumVerdict } | null {
    for (let i = 0; i < this.ready.length; i++) {
      const id = this.ready[i]!;
      const verdict = this.quorumVerdict(id);
      if (verdict) {
        this.ready.splice(i, 1);
        return { id, verdict };
      }
    }
    return null;
  }

  /**
   * kind × channel 双闸内选第一个可起跑节点并**记账** (running++)。
   * 非严格 FIFO: 被闸挡住的节点让位给后面能跑的, 保持吞吐。
   * null = 全局 cap 满 ∨ ready 空 ∨ 就绪节点全被闸挡住 (等 settle 释放)。
   */
  takeRunnable(): string | null {
    if (this.running >= this.cap || this.ready.length === 0) return null;
    const idx = this.ready.findIndex(
      (id) => this.runningByKind[this.opts.kindOf(id)] < this.kindCap[this.opts.kindOf(id)] && !this.channelBlocked(id),
    );
    if (idx < 0) return null;
    const id = this.ready.splice(idx, 1)[0]!;
    this.charge(id);
    return id;
  }

  /** 记一笔 (kind + channel), `release` 按同一笔退 —— takeRunnable 与 takeWarmStart 共用。 */
  private charge(id: string): void {
    const kind = this.opts.kindOf(id);
    const channel = this.hasChannelCaps ? this.opts.channelOf(id) : null;
    this.running++;
    this.runningByKind[kind]++;
    if (channel != null) this.runningByChannel.set(channel, (this.runningByChannel.get(channel) ?? 0) + 1);
    this.charged.set(id, { kind, channel });
  }

  /** 与 takeRunnable 配对的记账回退 (节点跑完时调, 在 settle 之前)。 */
  release(id: string): void {
    const c = this.charged.get(id);
    if (!c) return;
    this.charged.delete(id);
    this.running--;
    this.runningByKind[c.kind]--;
    if (c.channel != null) this.runningByChannel.set(c.channel, (this.runningByChannel.get(c.channel) ?? 1) - 1);
  }

  /** settle 后的拓扑推进: 释放 dependents, indeg 减到 0 的入 ready 并作为"新就绪"返回。 */
  advance(id: string): string[] {
    const fresh: string[] = [];
    for (const dep of this.dependents.get(id) ?? []) {
      const n = (this.indeg.get(dep) ?? 1) - 1;
      this.indeg.set(dep, n);
      if (n === 0) {
        this.ready.push(dep);
        fresh.push(dep);
      }
    }
    return fresh;
  }

  // ── 内部判据 ────────────────────────────────────────────────────────────────

  /**
   * quorum 判定: 达标 → null (照跑); 不达标 → 判词。
   * requires 缺省 = 'all' (S3 片 3 / D-6): 合成节点必须看见全部输入, 把「宽扇出」的偏好塞进
   * 缺省会让所有 synth 静默吞失败。宽扇出单叶 429 不陪葬 synth 的诉求由显式 `requires: 'any'`
   * 或整数 K 表达, 不再是缺省。零依赖 → 恒不 skip。
   */
  private quorumVerdict(id: string): QuorumVerdict | null {
    const node = this.plan.nodes[id]!;
    const deps = (node.depends_on ?? []).filter((d) => this.idSet.has(d));
    if (deps.length === 0) return null;
    const doneCount = deps.filter((d) => this.opts.statusOf(d) === 'done').length;
    const req = (node.requires ?? 'all') as 'all' | 'any' | number;
    const ok = req === 'all' ? doneCount === deps.length : req === 'any' ? doneCount >= 1 : doneCount >= req;
    if (ok) return null;
    const bad = deps.filter((d) => this.opts.statusOf(d) !== 'done').map((d) => `${d}(${this.opts.statusOf(d) ?? '?'})`);
    return { requires: req, done: doneCount, deps, bad };
  }

  /** 渠道闸: 没配 channelFanout → 恒 false (零回归)。 */
  private channelBlocked(id: string): boolean {
    if (!this.hasChannelCaps) return false;
    const ch = this.opts.channelOf(id);
    if (ch == null) return false;
    const cap = this.channelCap[ch];
    return cap !== undefined && (this.runningByChannel.get(ch) ?? 0) >= cap;
  }
}
