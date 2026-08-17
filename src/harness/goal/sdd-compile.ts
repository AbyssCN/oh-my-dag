/**
 * src/harness/goal/sdd-compile —— SDD 分解表 → **平铺 ConductorPlan** 的编译器
 * (内环 v2 切片 2 · SDD docs/plan/2026-08-11-inner-loop-v2-control-inversion.md)。
 *
 * D-1 直通 v2 = 机械编译, 零 LLM: 已结晶 SDD 的分解表 (切片/写集/依赖/verify + 波形) 本身
 * 就是一张图的全部信息, 让 conductor 再"规划"一遍 = 付 contract 段那 69.7% token 去转录
 * 一份已经写好的东西。所以这里**没有任何模型调用**: 输入是 parseBreakdown 的结构,
 * 输出是可直接进引擎的 plan。
 *
 * D-4 定向 TDD: 每片编译成 RED → 实装 → GREEN 三节点, RED/GREEN 跑**同一条**切片级命令
 * (只差期望退出码)。全量回归留给终局 accept 一次 —— 全量 `bun test` 是分钟级, 铺进
 * 每片每轮就是墙钟的乘法项 (D-4 的原话: 把乘法降为加法)。
 *
 * fail-loud 同 ./sdd-direct 的性格 (G-6): 乱序波形 / 写集相交 / verify 不可跑 / 依赖悬空 /
 * 依赖成环 / 全量回归下沉到切片 —— 逐条 throw 且判词指名切片与问题所在。每条闸在
 * sdd-compile.test.ts 里配了已知违规样本 (证伪方式写在各 test 注释)。
 */
import { DEFAULT_COMMAND_ALLOWLIST } from '../command-leaf';
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import type { SddBreakdown, SddSlice } from './sdd-direct';

/**
 * RED 节点的期望退出码。TDD 第一拍的成功判据恰是「测试失败」, 而 shell 取反整族元字符
 * 被命令闸拒 —— conductor-plan 的 `expect_exit` 就是为这一步存在的 (D-K)。取 1 = bun test
 * 失败的退出码; 引擎按「实际码 === expect_exit」判 done。
 */
export const RED_EXPECT_EXIT = 1;

export interface SddCompileOptions {
  /** 终局全量回归命令 (G-2: 整张图里只出现在 accept 节点, 恰一次)。 */
  readonly acceptCommand: string;
  /** accept 的期望退出码 (缺省 0; 承调用方 acceptance.expectExit)。 */
  readonly acceptExpectExit?: number;
  /** plan 名 (缺省 'sdd-flat')。 */
  readonly name?: string;
}

const nodeId = (id: number): string => `s${id}`;
const redId = (id: number): string => `s${id}-red`;
const greenId = (id: number): string => `s${id}-green`;

/** 命令首词须在引擎白名单里 —— 不在 = 起跑即被命令闸拒(退出码 -1), 读数上是**假红**。 */
function assertRunnable(command: string, where: string): void {
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (!DEFAULT_COMMAND_ALLOWLIST.includes(first))
    throw new Error(
      `${where} 不是可跑命令: "${command}" — 首词 "${first}" 不在命令白名单里。` +
        'verify 列要给切片级测试命令 (如 `bun test src/x.test.ts`), 不是验收点引用 (G-1/G-6 这种)。',
    );
}

/**
 * 写集两两不相交 (/omd-contract:「写集两两不相交 = 可并行的机器判据」)。
 * 刻意**不**因"两片之间有依赖边所以不会并发"而放行: 写集是切片划分的声明, 交集说明这两片
 * 没划干净 (那个文件归谁说不清), 而 D-2 的写集对账下游要按它归属产物。
 */
function assertDisjointWriteSets(slices: readonly SddSlice[]): void {
  const owner = new Map<string, number>();
  for (const s of slices) {
    for (const f of s.writeSet) {
      const prev = owner.get(f);
      if (prev !== undefined)
        throw new Error(
          `切片 ${prev} 与切片 ${s.id} 写集相交: ${f} — 并发跑会互相覆盖 (后写抹掉先写), ` +
            '而两片在台账上都记 done。拆开写集或把它们并成一片。',
        );
      owner.set(f, s.id);
    }
  }
}

/** 依赖必须指向表里真有的切片 (悬空依赖 = 图上永远没有那个前驱, 节点永不就绪)。 */
function assertDepsExist(slices: readonly SddSlice[], ids: ReadonlySet<number>): void {
  for (const s of slices)
    for (const d of s.deps)
      if (!ids.has(d)) throw new Error(`切片 ${s.id} 依赖不存在的切片 ${d}`);
}

/**
 * 波形与依赖列必须互相说得通 (G-6 乱序闸): 每条依赖边必须**跨层向前** ——
 * 依赖在同层或后层 = 那一行波形是骗人的文档 (引擎按依赖调度, 声明的并行根本不成立)。
 * 顺带: 波形覆盖全部切片、不引用不存在的切片。层序成立即蕴含无环, 故此路不再单独查环。
 */
function assertWaveOrder(slices: readonly SddSlice[], waves: readonly (readonly number[])[]): void {
  const layer = new Map<number, number>();
  waves.forEach((wave, i) => {
    for (const id of wave) {
      if (layer.has(id)) throw new Error(`波形里切片 ${id} 出现在多个层 (第 ${layer.get(id)} 层与第 ${i} 层)`);
      layer.set(id, i);
    }
  });
  for (const id of layer.keys())
    if (!slices.some((s) => s.id === id)) throw new Error(`波形引用不存在的切片 ${id}`);
  for (const s of slices) {
    const own = layer.get(s.id);
    if (own === undefined)
      throw new Error(`波形没有覆盖切片 ${s.id} — 漏掉的那片会被静默排除在层序校验之外`);
    for (const d of s.deps) {
      const dep = layer.get(d)!;
      if (dep >= own)
        throw new Error(
          `波形乱序: 切片 ${s.id} (第 ${own} 层) 依赖切片 ${d} (第 ${dep} 层) — ` +
            '依赖必须跨层向前; 同层 = 声明可并行却又互相等, 后层 = 等一个还没跑的产物。',
        );
    }
  }
}

/** 没有波形时依赖列是唯一的顺序来源 —— 环在这里必须自己查 (波形缺席不等于免检)。 */
function assertAcyclic(slices: readonly SddSlice[]): void {
  const pending = new Map(slices.map((s) => [s.id, new Set(s.deps)]));
  let progressed = true;
  while (progressed && pending.size) {
    progressed = false;
    for (const [id, deps] of pending) {
      if ([...deps].every((d) => !pending.has(d))) {
        pending.delete(id);
        progressed = true;
      }
    }
  }
  if (pending.size) throw new Error(`切片依赖成环: ${[...pending.keys()].join('、')} — 图跑起来永远没有就绪节点`);
}

// ── 并行性 advisory 读数 (owner 2026-08-11: 「调度器」放结晶期当审问, 声明期只出读数) ────────
//
// 为什么是读数不是闸: 并行上限由**真依赖关系**决定, 而依赖边真不真是语义判断 (真数据依赖 /
// 可冻结进契约的接口依赖 / 叙事假边), 算法辨不出 —— 30–40% 的任务本来就是线性链 (agentic-graph
// 调研 C1), 把「宽度不够」做成硬闸会拒掉诚实的串行分解, 逼人捏造假独立 (那比串行更贵,
// 并发三跑的 debris 验收就是这笔学费)。所以两个方向各归各: 假并行有乱序/写集闸 (硬),
// 假串行只点名 (advisory), 消解假边的动作留给结晶期的人审。

export interface ParallelismReadout {
  /** 依赖列允许的 ASAP 分层 (每片排进最早可跑层)。注意这是 ASAP 宽度, 不是最大反链 —— 够用且线性。 */
  readonly asapWaves: readonly (readonly number[])[];
  /** ASAP 最大宽度 (依赖列允许的最大并行度)。 */
  readonly maxWidth: number;
  /** 关键路径 (最长依赖链上的切片 id, 墙钟下界: 无论多少并发, 这条链只能串着走)。 */
  readonly criticalPath: readonly number[];
  /** 串行率 = 关键路径长 / 切片数。1 = 纯线性链 (要么诚实串行, 要么该去审问依赖边)。 */
  readonly serialRatio: number;
  /** 声明的波形比依赖列保守时点名: 这些切片按依赖本可提早到 ASAP 层, 作者却排在了后面。 */
  readonly conservativeSlices: readonly { id: number; declaredWave: number; asapWave: number }[];
}

/**
 * 并行性读数 (advisory, 只报不拒; 前提: 依赖列已过编译闸, 无环无悬空)。
 * 消费者: 结晶期审问 (/omd-contract 收尾看一眼「串行率 1 的链, 哪条边是真的?」) 与
 * run 摘要行 (读数入账, 声明宽度 vs 依赖宽度的差距可跨 run 累计)。
 */
export function parallelismReadout(breakdown: SddBreakdown): ParallelismReadout {
  const { slices, waves } = breakdown;
  const byId = new Map(slices.map((s) => [s.id, s]));
  // ASAP 层 = 1 + max(依赖的层); 无依赖 = 0 层。同时得到最长链 (关键路径) 的回溯前驱。
  const asapLayer = new Map<number, number>();
  const cpPrev = new Map<number, number | undefined>();
  const layerOf = (id: number): number => {
    const hit = asapLayer.get(id);
    if (hit !== undefined) return hit;
    const s = byId.get(id)!;
    let layer = 0;
    let prev: number | undefined;
    for (const d of s.deps) {
      const dl = layerOf(d) + 1;
      if (dl > layer) {
        layer = dl;
        prev = d;
      }
    }
    asapLayer.set(id, layer);
    cpPrev.set(id, prev);
    return layer;
  };
  for (const s of slices) layerOf(s.id);
  const layerCount = Math.max(...[...asapLayer.values()]) + 1;
  const asapWaves: number[][] = Array.from({ length: layerCount }, () => []);
  for (const s of slices) asapWaves[asapLayer.get(s.id)!]!.push(s.id);
  // 关键路径: 从最深层的任一片回溯前驱链。
  const deepest = slices.reduce((a, b) => (asapLayer.get(a.id)! >= asapLayer.get(b.id)! ? a : b));
  const criticalPath: number[] = [];
  for (let at: number | undefined = deepest.id; at !== undefined; at = cpPrev.get(at)) criticalPath.unshift(at);
  // 声明保守点名: 作者把切片排在比 ASAP 更晚的层 (提早不可能 —— 乱序闸已保证声明不早于依赖)。
  const conservativeSlices: { id: number; declaredWave: number; asapWave: number }[] = [];
  if (waves) {
    const declared = new Map<number, number>();
    waves.forEach((wave, i) => wave.forEach((id) => declared.set(id, i)));
    for (const s of slices) {
      const dw = declared.get(s.id);
      const aw = asapLayer.get(s.id)!;
      if (dw !== undefined && dw > aw) conservativeSlices.push({ id: s.id, declaredWave: dw, asapWave: aw });
    }
  }
  return {
    asapWaves,
    maxWidth: Math.max(...asapWaves.map((w) => w.length)),
    criticalPath,
    serialRatio: criticalPath.length / slices.length,
    conservativeSlices,
  };
}

/** 摘要一行 (进 run-goal 平铺路径的 execute 摘要, 读数入账)。 */
export function describeParallelism(r: ParallelismReadout): string {
  const conservative = r.conservativeSlices.length
    ? ` · 声明保守: ${r.conservativeSlices.map((c) => `片${c.id}(声明层${c.declaredWave}→可提至${c.asapWave})`).join(' ')}`
    : '';
  return `宽度 ${r.maxWidth} · 关键路径 ${r.criticalPath.join('→')} (串行率 ${r.serialRatio.toFixed(2)})${conservative}`;
}

// ── 终局验收命令: 从 verify 列**推**, 不让分类器再编一遍 (2026-08-11 run 7d50fda2) ────────
//
// 事故形状: SDD verify 列写的是 `bun test src/harness/board/run-board.test.ts`, 而验收分类器
// (classify-acceptance, 只看 goal 文本、看不到 SDD) 自己编了一条 `bun test
// src/harness/dag/run-board.test.ts` —— 目录是幻觉。那条命令同时是**冻结判据**与 accept 节点,
// 于是 s5 叶顺势把冻结判卷造在了幻觉路径上。这次结果无害 (它真去建了那个文件), 但机制是错的:
// 已结晶 SDD 里明明写着这个 run 要跑哪些测试, 判据轴却去问一个看不见 SDD 的模型。
//
// 推法 = **各片 verify 去重串联, 末尾接一环去掉路径限定的全量版**:
//   `bun test A && bun test B && bun test`
// 两截各有各的职责, 缺一条这条命令就不合格:
//   · 前半 (各片 verify) 给**判别力** —— 活干之前那些测试文件还不存在, 这条必红;
//     只留全量版 (`bun test`) 会得到一条**开跑就绿**的冻结判据, 那正是 D-I 要杀的空判据。
//   · 后半 (去路径限定) 给**全量回归** —— accept 节点的本职 (D-4: 全量只在终局跑一次);
//     只留前半就只测了新写的那几个文件, 打烂别处没人看见。
// 顺带两个性质: 命令里出现的路径全部来自 SDD (幻觉路径无处可生); 串起来必然长于任何单片
// verify, 于是 G-2 (accept ≠ 切片 verify) 由构造成立。跨生态通用 (`pytest tests/x.py` →
// 末环 `pytest`), 不写死 bun。

/** 一段命令 (`&&` 分隔的一环) 的"去路径限定"版: 取到第一个含 `/` 的参数为止。 */
function dropPathArgs(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const cut = tokens.findIndex((t) => t.includes('/'));
  return (cut === -1 ? tokens : tokens.slice(0, cut)).join(' ');
}

/**
 * 分解表 verify 列 → 终局验收命令 (见上方注释的两截推法)。
 * 推不出 (verify 列全空) → undefined, 调用方回落既有来源 (fail-open: 这是"判据从哪来"的升级,
 * 不该顺手把分解段无表的存量 SDD 挡在门外 —— 同 run-goal 那条"编译不过则响亮回落"的纪律)。
 */
export function acceptCommandFromBreakdown(breakdown: SddBreakdown): string | undefined {
  const links: string[] = [];
  const fullRegression: string[] = [];
  for (const s of breakdown.slices) {
    const verify = s.verify.trim();
    if (!verify) continue;
    // 去重按**段**不按整串: 两条不同 verify 串共享同一段 (`bun test a` 与 `bun test a && bun test b`)
    // 时, 整串去重会让同一测试文件跑两遍 (实测 run 68cfb43f 的 accept 就是这形状, 白烧一发)。
    for (const seg of verify.split('&&').map((x) => x.trim()).filter(Boolean)) {
      if (!links.includes(seg)) links.push(seg);
    }
    for (const seg of verify.split('&&')) {
      const head = dropPathArgs(seg);
      // 裸形仍含引号参数 = 模式参在而文件参没了 (grep 族 `ugrep -qF "x" path` → `ugrep -qF "x"`
      // 读 stdin, 永远非零) —— 蒸出来的是废令不是全量环。实测样本 run 928ff86e: 三条 O-6
      // 标记 grep 被蒸成无文件 ugrep, 实装全对的 run 被判 not-converged (冤案)。
      // 全量环只收"去路径后仍自足"的形 (`bun test src/x.test.ts` → `bun test`; `pytest tests/x.py`
      // → `pytest`), 判据 = 裸形无引号残参 —— 跨生态通用, 仍不写死 bun。
      if (head && !/["']/.test(head) && !fullRegression.includes(head)) fullRegression.push(head);
    }
  }
  if (!links.length) return undefined;
  return [...links, ...fullRegression.filter((h) => !links.includes(h))].join(' && ');
}

/**
 * 分解表结构 → 平铺 plan (G-1: 节点 = 切片×3 + accept, 零 conductor 展开)。
 *
 * 节点形状 (每片):
 *  · `sN-red`   command, expect_exit=1 —— 证明本片的测试**先是红的** (D-4)
 *  · `sN`       agent + write_set (D-2), 依赖自己的 RED
 *  · `sN-green` command, expect_exit=0 —— 同一命令串转绿
 * 表里的依赖边接到**上游片的 GREEN** 上: 「2 依赖 1」的语义是 1 真绿了才轮到 2, 而不是
 * 1 的实装节点跑完就算数 (跑完 ≠ 对, 这个仓的静默失效图鉴专门有一条)。
 */
export function compileBreakdown(
  breakdown: SddBreakdown,
  opts: SddCompileOptions,
): ConductorPlan {
  const { slices, waves } = breakdown;
  if (!slices.length)
    throw new Error('分解表零切片 — 编译不出图 (空图会把"什么都没干"记成"跑完了")');
  assertRunnable(opts.acceptCommand, '全量回归命令 (accept)');
  for (const s of slices) {
    assertRunnable(s.verify, `切片 ${s.id} 的 verify 列`);
    // G-2: 全量回归只属于终局那一次。下沉到切片 = D-4 要消掉的乘法项原样回来,
    // 而节点计数看不出异常 (命令在表里确实只写了一次)。
    if (s.verify.trim() === opts.acceptCommand.trim())
      throw new Error(
        `切片 ${s.id} 的 verify 列就是全量回归命令 (${opts.acceptCommand}) — ` +
          '它只该在终局 accept 节点跑一次 (D-4: 定向 TDD 把乘法降为加法)。',
      );
  }
  assertDepsExist(slices, new Set(slices.map((s) => s.id)));
  assertDisjointWriteSets(slices);
  if (waves) assertWaveOrder(slices, waves);
  else assertAcyclic(slices);

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const s of slices) {
    nodes[redId(s.id)] = {
      executor: 'command',
      command: s.verify,
      expect_exit: RED_EXPECT_EXIT,
      depends_on: s.deps.map(greenId),
      output_type: 'none',
      goal: `RED: 证明切片 ${s.id} 的测试在实装前是红的`,
    };
    nodes[nodeId(s.id)] = {
      executor: 'agent',
      // 切片级契约 (名 + 写集 + verify) 进 goal。**SDD 全文不在这里内联** —— 每节点一份
      // 全文是 N 倍 token, 注不注入由接线方 (切片 5) 按读数裁, 编译器不替它决定。
      goal:
        `实施切片 ${s.id}: ${s.name}\n` +
        `写集 (只许动这些文件): ${s.writeSet.join('、')}\n` +
        `完成判据: \`${s.verify}\` 退出码 0`,
      write_set: [...s.writeSet],
      output_type: 'file',
      depends_on: [redId(s.id)],
    };
    nodes[greenId(s.id)] = {
      executor: 'command',
      command: s.verify,
      expect_exit: 0,
      depends_on: [nodeId(s.id)],
      output_type: 'none',
      goal: `GREEN: 切片 ${s.id} 的切片级判据转绿`,
    };
  }
  nodes['accept'] = {
    executor: 'command',
    command: opts.acceptCommand,
    expect_exit: opts.acceptExpectExit ?? 0,
    depends_on: slices.map((s) => greenId(s.id)),
    output_type: 'none',
    goal: '终局全量回归 (确定性验收 · D-3 唯一停止规则)',
  };
  return PlanSchema.parse({ name: opts.name ?? 'sdd-flat', nodes });
}
