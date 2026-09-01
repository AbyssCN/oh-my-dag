/**
 * src/tui/dag-hud-attach.ts —— **外部 run 的读侧装配**(SDD 2026-09-01 t-tui-attach 片 2 IMPL)。
 *
 * ## 为什么单有这个模块
 *
 * 本进程的 `DagHud` + `DagTree` 是 **engine bus 消费者** —— 等引擎推 `DagNodeEvent` 过来。
 * 外部 run(其他 CLI / sibling 会话 / detached run) **不在** 本进程 bus 上, 它在盘上
 * `<cwd>/.omd/hud/dag-<runId>.json` 写分片。本模块做的事只有一件:**把盘上的持久态翻译回
 * Hud/Tree 认的事件序列**,让外部 run 在本屏上与本地 run 等形。
 *
 * 不写盘(`hud/load.ts` + `harness/board/run-board.ts` 都是只读);不修改 engine bus 形状;
 * 不动 `KIND_ROLE` / `loadSnapshot` 写侧 / `DagNodeEvent` 词表 (全在冻结名单上)。
 *
 * ## 双通路 (INV-HUD-6 对偶)
 *
 * - `DagHud` 没有 `loadSnapshot` —— 把 snapshot **拆** 成 `planned` / `settle` / `start`
 *   三段 `DagNodeEvent`,逐条 `apply()`。先后顺序与引擎事件到达序同形,渲染等价。
 * - `DagTree.loadSnapshot` 直接吃整张 `HudDagSnapshot` (三相位: planned → settled →
 *   started),不动,与冻结契约逐字一致。
 *
 * ## attach 必须做的副作用
 *
 * 1. **`hud.beginRun(label)` 必调** —— 不调,两个 run 的节点混成一张表(本地 attach 路径
 *    `tui.ts:1648` 同款守则;已知坑 #7)。`tree.loadSnapshot` 内部已经清,这里不另起 `beginRun`。
 * 2. **`tui.requestRender()` 由 caller 调** —— apply/loadSnapshot 本身不触发 diff(详见
 *    `src/tui/AGENTS.md §5`)。
 *
 * ## 终态保留
 *
 * `done|failed|cancelled` 在 reader 侧 `DONE_GRACE_MS=15_000` 内仍可见 —— 由
 * `readDagShards` / `readDagShard` 自动把关(见 `hud/load.ts:25`);attach 层**不另设**
 * 保留窗口,直接复用 reader 的判定结果。过期视图不会进 `runList`,自然不会到 attach。
 *
 * ## Selection 切换 / Watcher 清理
 *
 * 当前实现不持有 per-run watcher(成本高于收益;外部 run 数量不可知,起 N 个 fs.watch 与
 * 全屏时本地 1s ticker 重读是两条并行路径,后者已经够)。attach 由 caller(tui.ts 的 Enter
 * handler)显式调用,**自带 dispose 副作用**:`hud.beginRun()` 清旧;下一拍 ticker 读到的
 * 是新 view,attach 再清一次。**没有需要单独清理的句柄**,因此不暴露 `dispose`。
 *
 * ## 容错
 *
 * 单条 view 半截 / 坏 JSON / 未知 schema 由 reader (`hud/load.ts:readFreshest`) 已经吞掉,
 * 不到 attach 这一层;attach 拿到的 `view` 形状必然合法。本模块 fail-open:不抛、不留副作用。
 *
 * ## 通道 (2026-09-01)
 *
 * `createExternalRunChannel` 给 caller 一个**单 runId** 的尾随通道,1s 由 caller 顺拍驱动;
 * 内部按状态机判 APPLY / SKIP / NO-OP / DETACH,坏输入零抛出(fail-open 留一行日志)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HudDagSnapshot } from '../hud/types';
import { logger } from '../logger';
import { readDagShard, type DagView } from '../hud/load';
import type { DagHud } from './components/dag-hud';
import type { DagTree } from './components/dag-tree';

/**
 * 把一份磁盘视图(外部 run 的快照)接进本地 `DagHud` + `DagTree`。
 *
 * 与本地事件路径(tui.ts:1648)的契约完全同形:
 *   - `hud.beginRun(label)` 必调,清空旧 run 节点
 *   - `hud.apply(synthetic events)` 把 planned / settled / started 转成 `DagNodeEvent`
 *   - `tree.loadSnapshot(snap)` 直接吃整张
 *
 * 副作用:仅两个组件的 in-memory state;不读盘、不写盘、不发请求。
 *
 * @param hud   DagHud (tui.ts:574 装配)
 * @param tree  DagTree (tui.ts:575 装配)
 * @param view  `readDagShards` / `readDagShard` 的输出 —— 必然经过 reader 的容错闸
 */
export function attachExternalRun(hud: DagHud, tree: DagTree, view: DagView): void {
  const snap = view.snap;
  // label 选用:goal 优先,空则退到 runId 前 8 —— 与 `dag-<runId8>.json` 文件名同源,
  // 屏上读起来与文件一一对得上(与本地路径 `tui.ts:1648` 用 runId 同款守则)。
  // ⚠ runId < 8 时整段退 (slice 自动越界截短),不补零也不抛 —— 与 `hud/load.ts` 短名解析
  // 同款"截短就截短"守则;UUID 形态的 runId 永远 ≥ 36 字符,这条只在非 UUID 的测试 fixture 上触得到。
  const label = snap.goal || snap.runId.slice(0, 8);

  // (1) HUD: beginRun 清旧 → 喂合成事件。合成顺序 = 引擎事件到达序(planned 先于 settled
  //     / started),与 INV-HUD-6 双通路等价闸对偶(`dag-tree-snapshot.test.ts`)。
  hud.beginRun(label);
  hydrateHudFromSnapshot(hud, snap);

  // (2) Tree: loadSnapshot 内部已清 + 设 runLabel + 重置 seq,不再单独 beginRun。
  tree.loadSnapshot(snap);
}

/**
 * 把 `HudDagSnapshot` 转成 `DagNodeEvent[]` 并喂给 `DagHud.apply`。
 *
 * - `planned` 节点:发一条 `{type:'planned'}` —— 与本地事件桥(tui.ts:1652)同款形状。
 * - `settled` 节点:逐条 `{type:'settle'}`。kind 取 `snap.settled[i].kind`(
 *   settled 的 kind 是写侧权威,允许与 planned 的 kind 不同 —— 老 mirror 没记 planned
 *   时,settled 是唯一真源)。
 * - `started` 节点:逐条 `{type:'start'}`,但**已在 settled 里的跳过**(INV-HUD-6:
 *   settled 赢过 started)。kind 回查 planned → settled,最后才退 `''`(`DagTree.loadSnapshot`
 *   同款做法,tree.ts:234)。
 *
 * 不发 `progress` / `verdict` / `replan`:持久态里没有(C-1 frozen,本地 attach 也不发)。
 */
function hydrateHudFromSnapshot(hud: DagHud, snap: HudDagSnapshot): void {
  if (snap.planned.length > 0) {
    hud.apply({
      type: 'planned',
      nodes: snap.planned.map((p) => ({ id: p.id, kind: p.kind })),
    });
  }
  for (const s of snap.settled) {
    hud.apply({
      type: 'settle',
      id: s.id,
      kind: s.kind,
      status: s.status,
      ...(s.model !== undefined ? { model: s.model } : {}),
    });
  }
  const kindOf = (id: string): string =>
    snap.planned.find((p) => p.id === id)?.kind
      ?? snap.settled.find((s) => s.id === id)?.kind
      ?? '';
  for (const id of snap.started) {
    if (snap.settled.some((s) => s.id === id)) continue; // settled 赢
    hud.apply({ type: 'start', id, kind: kindOf(id) });
  }
}

/**
 * 清空两个组件的当前 attach —— 留给 caller 显式调(如 fullOn 关→开之间换 run)。
 *
 * ⚠ 不调用任何 "attach 才该调" 的副作用(如本地路径的 `beginRun(runId)`):这层是 detach,
 *   调 `beginRun('')` 让 `render` 走 INV-DAG-8 无源恒缺席分支返回 `[]`。
 */
export function detachExternalRun(hud: DagHud, tree: DagTree): void {
  hud.beginRun('');
  tree.beginRun('');
}

/* ─────────────────────────────────────────────────────────────────────────
 * 2026-09-01 · t-tui-attach 外部 run 附身通道 (SDD 片 2 IMPL)
 *
 * 纯读侧:把盘上 `.omd/hud/dag-<runId>.json` + `.omd/continuity/<runId>/` 翻译回 hud/tree
 * 的事件序列。状态机 / 内容键 / 排序键全部按 SDD §状态机 + §契约钉死,实装错就实装错,
 * 不能为绿测试放宽判据。
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * 活图列表选择器(SDD §接口冻结 #2,纯函数)。
 *
 * - `index` 越界/负/非整数 → `null`(0 也合法)
 * - `views` 空数组 → `null`
 * - 否则返 `views[index].snap.runId`
 */
export function selectExternalRun(views: DagView[], index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= views.length) return null;
  return views[index]!.snap.runId;
}

/**
 * 把 `_dag.json` 的 `deps` / `runtimeNodes[].deps` 合并到 `snap.planned[i].deps` 上。
 *
 * 规则 (SDD D-10 ①):
 *  - 仅当 `planned[i].deps === undefined` 才填;已带 deps 原样保留(快照写的 deps 优先于 continuity)
 *  - `meta === null` → 返**原对象引用**(不改、不抛)
 *  - 命中补齐 → 返**新对象**,不动入参
 *  - 没命中补齐(`mutated === false`)→ 也返原对象(零开销同引用)
 *
 * 用 `_dag.json` + `runtimeNodes` 双重源(后者补运行期挂出来的子节点),但
 * `runtimeNodes` 不可覆盖 `_dag.json` 已有的 deps —— 后者是 resume 锚(参见
 * `DagMetadata.runtimeNodes` 注释)。
 */
export function mergePlannedDeps(
  snap: HudDagSnapshot,
  meta: { deps?: Record<string, string[]>; runtimeNodes?: Array<{ id: string; deps: string[] }> } | null,
): HudDagSnapshot {
  if (meta === null) return snap;
  // 优先 _dag.json.deps;runtimeNodes 作为补充源(运行期挂出的子节点)
  const ids = new Map<string, string[]>();
  if (meta.deps) {
    for (const [id, ds] of Object.entries(meta.deps)) {
      if (Array.isArray(ds)) ids.set(id, ds);
    }
  }
  if (meta.runtimeNodes) {
    for (const n of meta.runtimeNodes) {
      if (!ids.has(n.id) && Array.isArray(n.deps)) ids.set(n.id, n.deps);
    }
  }
  if (ids.size === 0) return snap;
  let mutated = false;
  const planned = snap.planned.map((p) => {
    if (p.deps !== undefined) return p;
    const d = ids.get(p.id);
    if (!d) return p;
    mutated = true;
    return { ...p, deps: d };
  });
  if (!mutated) return snap;
  return { ...snap, planned };
}

/** 通道构造入参(SDD §接口冻结 #3):全部可注入;缺省走生产真源。 */
export interface ExternalRunChannelOpts {
  cwd: string;
  runId: string;
  hud: DagHud;
  tree: DagTree;
  now: () => number;
  requestRender: () => void;
  /** 缺省 = `readDagShard`(生产 reader 真源);单测可替身。 */
  readShard?: (cwd: string, runId: string, nowMs: number) => DagView | null;
  /** 缺省 = D-10 双 home 纪律(repo 本地 → ~/.omd/projects/<slug>)。 */
  continuityHomes?: (cwd: string) => string[];
}

/** 通道返回值:`tick` 由 caller 顺拍;`bound` 报告存活;`dispose` 幂等清理。 */
export interface ExternalRunChannel {
  tick(): void;
  bound(): boolean;
  dispose(): void;
}

/** `cwd` basename → 简化 slug(与 `hud/load.ts:slugOf` 同款兜底近似,仅二级 home 用)。 */
function slugOf(cwd: string): string {
  return basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

/** 双 home 候选(repo 本地 + ~/.omd/projects/<slug>);谁先存在谁赢。 */
function defaultContinuityHomes(cwd: string): string[] {
  const homes = [join(cwd, '.omd', 'continuity')];
  const slug = slugOf(cwd);
  if (slug) homes.push(join(homedir(), '.omd', 'projects', slug, 'continuity'));
  return homes;
}

interface ContinuityMeta {
  deps?: Record<string, string[]>;
  runtimeNodes?: Array<{ id: string; deps: string[] }>;
}

/** 读 `_dag.json`,坏/不存在/未知 schema → null(不抛,每家 home 独立尝试)。 */
function readContinuityMeta(homes: readonly string[], runId: string): ContinuityMeta | null {
  for (const home of homes) {
    const p = join(home, runId, '_dag.json');
    if (!existsSync(p)) continue;
    try {
      const obj = JSON.parse(readFileSync(p, 'utf-8')) as ContinuityMeta;
      return obj;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId, home },
        '[dag-hud-attach] _dag.json read failed (skipping home)',
      );
      // 继续尝试下一 home —— 一家坏不该把所有 home 都毙了
    }
  }
  return null;
}

interface CheckpointShape {
  status?: string;
  summary?: string;
  durationMs?: number;
}

/** 读单个 `<nodeId>.json` checkpoint(只读未归档名,tmp / __r<K> 自然跳过)。 */
function readCheckpoint(homes: readonly string[], runId: string, nodeId: string): CheckpointShape | null {
  for (const home of homes) {
    const p = join(home, runId, `${nodeId}.json`);
    if (!existsSync(p)) continue;
    try {
      const obj = JSON.parse(readFileSync(p, 'utf-8')) as CheckpointShape;
      return obj;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId, nodeId, home },
        '[dag-hud-attach] checkpoint read failed (skipping home)',
      );
    }
  }
  return null;
}

/** 显式字段表的 contentKey(SDD D-8):免未知字段扰动。 */
function contentKeyOf(snap: HudDagSnapshot): string {
  return JSON.stringify({
    u: snap.updatedAt,
    st: snap.status,
    g: snap.goal,
    lv: snap.levels,
    p: snap.planned,
    r: snap.started,
    sa: snap.startedAt,
    se: snap.settled,
  });
}

/**
 * 创建一个外部 run 附身通道(SDD §状态机 + §接口冻结 #3)。
 *
 * 状态机逐条按 SDD 钉死:`tick` 不抛(内部 catch 留一行日志, fail-open 不吞证据)。
 * 排序键 = `(Date.parse(snap.updatedAt), contentKeyOf(snap))`;单调不回退。
 *
 * `bound()` = 通道仍与 runId 关联(caller 已选 run,通道尚未 DETACH);DETACH / dispose 后
 * 才返 false。
 */
export function createExternalRunChannel(opts: ExternalRunChannelOpts): ExternalRunChannel {
  const readShard = opts.readShard ?? ((cwd: string, runId: string, nowMs: number) => readDagShard(cwd, runId, nowMs));
  const continuityHomes = opts.continuityHomes ?? defaultContinuityHomes;
  let lastT = Number.NEGATIVE_INFINITY;
  let lastK = '';
  // bound = 通道已建立(runId 已选,尚在等盘面);DETACH / dispose 后才 false
  let isBound = true;
  let disposed = false;

  const detach = (): void => {
    if (!isBound) return;
    detachExternalRun(opts.hud, opts.tree);
    isBound = false;
    opts.requestRender();
  };

  const tick = (): void => {
    if (disposed) return;
    let view: DagView | null;
    try {
      view = readShard(opts.cwd, opts.runId, opts.now());
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId: opts.runId },
        '[dag-hud-attach] readShard threw -> DETACH',
      );
      detach();
      return;
    }
    if (view === null) {
      // null 唯一出口 = DETACH(SDD §状态机)。坏 JSON / 分片被 GC / 超龄 / 顶名 全归 null;
      // 区分要改 src/hud/**, 不在写集, 不猜。
      detach();
      return;
    }
    const snap = view.snap;
    const t = Date.parse(snap.updatedAt);
    const k = contentKeyOf(snap);
    // ⚠ 哨兵行(SDD 反向自检锚):单调守卫关掉 → AC-5 乱序用例必红(屏态回退)。
    if (!Number.isFinite(t) || t < lastT) {
      logger.warn(
        { runId: opts.runId, t, lastT, updatedAt: snap.updatedAt },
        '[dag-hud-attach] skipping out-of-order or invalid timestamp',
      );
      return;
    }
    if (t === lastT && k === lastK) {
      // 重放去重:同毫秒同内容 → 幂等 no-op, 不重绘。
      return;
    }

    // ① continuity 树结构补齐(D-10 ①)。mergePlannedDeps 在 meta === null 时返原对象。
    const homes = continuityHomes(opts.cwd);
    const meta = readContinuityMeta(homes, opts.runId);
    const enrichedSnap = mergePlannedDeps(snap, meta);

    // ② attach(同款守则, beginRun 清旧)
    attachExternalRun(opts.hud, opts.tree, { ...view, snap: enrichedSnap });

    // ③ failed 节点补 failReason(D-10 ②)。只在有 checkpoint + status='failed' +
    //    summary 在场时合成 settle;其余原样(public 面走 hud.apply / tree.apply,
    //    词表不外露新事件类型)。逐 settle 走;失败的(坏 JSON / 不存在)由 readCheckpoint
    //    fail-open 留痕。
    for (const s of enrichedSnap.settled) {
      if (s.status !== 'failed') continue;
      const cp = readCheckpoint(homes, opts.runId, s.id);
      if (!cp || cp.status !== 'failed' || typeof cp.summary !== 'string' || cp.summary.length === 0) continue;
      const settleEv = {
        type: 'settle' as const,
        id: s.id,
        kind: s.kind,
        status: 'failed' as const,
        ...(typeof cp.durationMs === 'number' ? { durationMs: cp.durationMs } : {}),
        failReason: cp.summary,
      };
      opts.hud.apply(settleEv);
      opts.tree.apply(settleEv);
    }

    lastT = t;
    lastK = k;
    opts.requestRender();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    detach();
  };

  return {
    tick,
    bound: () => isBound,
    dispose,
  };
}