/**
 * plan/static-lint —— **跑之前**就能确定性判死的坏 plan (A4, 2026-07-31)。
 *
 * ## 它填的是 2×2 里最空的那格
 *
 * Martin Fowler 把 harness 的控制分成两轴:
 *
 * ```
 *                Computational (确定性/毫秒)   Inferential (推断/贵/不确定)
 *   Feedforward  ← **本模块住这里, 此前几乎是空的**   conductor prompt / persona / 图式
 *   Feedback     产物闸 · accept · lint · 预算轴      judge / verifier / detector
 * ```
 *
 * 审计下来我们的 feedback 两侧都很厚, **computational feedforward 只有"schema 不合法"一条**。
 * 而下面这些全是**跑之前就能算出来**的,今天却要烧一整轮 agent 调用才发现:
 *
 * - 两个**能并行**的节点声明写同一个文件 → 写竞争。谁最后写谁赢, 而赢家是调度顺序决定的,
 *   也就是**每次跑结果可能不同**。这是最坏的一种: 它不报错, 只是有时候产物不对。
 * - 节点依赖的输入文件**不存在**且图里没有任何节点产出它 → 那一步注定失败。
 * - `depends_on` 指向图里不存在的节点 → 编译期已有闸, 这里不重复。
 * - command 节点引用的 cwd 内脚本**不存在**, 或 package script **未定义** → 那一步同样注定失败。
 *
 * ## 纪律: 只报能**确定性判死**的, 不猜
 *
 * 静态检查一旦开始猜, 它就变成了第三个 judge (而且是个没有证据的)。所以:
 * - 写竞争只在**两个节点互不可达**时才算 (有依赖关系 = 有序 = 不是竞争);
 * - 缺输入只在"路径看起来是仓内相对路径 **且** 图里没有任何节点声明产出它"时才算;
 * - 拿不准一律**不报**。
 *
 * ## 出口: 报告, 不拦截
 *
 * 与制品 lint 同一条纪律 —— 存量 plan 会红一片, 而 fail-closed 的代价是把本来能跑的活拒掉。
 * 发现进**下一轮重展开的 prompt**(环唯一的信息通道), 让 conductor 自己改。
 * ⚠ 而且措辞要**为 LLM 消费优化**(Fowler: "instructions for the self-correction"):
 * 说清是哪两个节点、哪个文件、以及**该怎么改**,而不是只报一个"冲突"。
 */
import type { ConductorPlan } from '../conductor-plan';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

type PlanNodeLike = ConductorPlan['nodes'][string];

export interface StaticFinding {
  kind: 'write-race' | 'missing-input' | 'missing-command-target';
  /** 涉及的节点 (规划期可读名 —— 下一轮 conductor 认得出的那个名字体系)。 */
  nodes: string[];
  /** 已经是人话, 且带**怎么改**。 */
  message: string;
}

/** 节点的可达闭包 (沿 depends_on 向上)。 */
function ancestors(plan: ConductorPlan, id: string, memo = new Map<string, Set<string>>()): Set<string> {
  const hit = memo.get(id);
  if (hit) return hit;
  const out = new Set<string>();
  memo.set(id, out); // 先放进去防环 (编译期已查环, 这里只是不挂死)
  for (const d of plan.nodes[id]?.depends_on ?? []) {
    out.add(d);
    for (const a of ancestors(plan, d, memo)) out.add(a);
  }
  return out;
}

/** 两个节点是否**可能并行** = 互不在对方的祖先闭包里。 */
function canRunConcurrently(plan: ConductorPlan, a: string, b: string, memo: Map<string, Set<string>>): boolean {
  return !ancestors(plan, a, memo).has(b) && !ancestors(plan, b, memo).has(a);
}

/** 节点声明的产出路径 (只认显式声明的 —— 猜不算)。 */
/** 导出给 invocation-facts 复用 —— "哪个字段是写目标"抄第二份早晚先漂。 */
export function declaredOutput(n: PlanNodeLike): string | undefined {
  const p = (n as { output_path?: unknown }).output_path;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** 命令掺了任何 shell 语法/变量/引号/glob → 整条跳过, 静态解析不了的不猜。 */
function hasShellSyntax(cmd: string): boolean {
  return /[$`"'\\&|;<>*?[\]{}]|\r|\n/.test(cmd);
}

/** 白名单脚本扩展名。 */
const SCRIPT_EXT = /\.(ts|js|sh|py)$/;

/**
 * 候选引用是否是**词法上安全**的 cwd 内相对脚本路径:
 * 以 .ts/.js/.sh/.py 结尾, 相对 (无 /、\、~、盘符、URL scheme 前缀),
 * 去掉可选 `./` 后每段非空且不是 `.` / `..`。
 */
function isSafeRelativeScript(ref: string | undefined): ref is string {
  if (typeof ref !== 'string' || !SCRIPT_EXT.test(ref)) return false;
  if (ref.startsWith('/') || ref.startsWith('\\') || ref.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(ref)) return false;        // 盘符
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref)) return false; // URL scheme
  const cleaned = ref.startsWith('.') ? ref.slice(2) : ref;
  if (!cleaned) return false;
  for (const seg of cleaned.split('/')) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** 拼接 cwd 并规范化后仍**词法位于 cwd 内** (防 `..` 逃逸, 虽然上面已拦, 这里兜底)。 */
function staysInsideCwd(cwd: string, ref: string): boolean {
  try {
    const base = resolve(cwd);
    const abs = resolve(cwd, ref);
    return abs === base || abs.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** 报告一条 direct-script 缺失 finding (存在 → 不报; 只有 ENOENT 才判死, 读不到 → 跳过)。 */
function checkDirectScript(cwd: string, ref: string, id: string, out: StaticFinding[]): void {
  if (!staysInsideCwd(cwd, ref)) return;
  try {
    statSync(join(cwd, ref)); // 存在 → 不报
    return;
  } catch (e) {
    // existsSync 在 EACCES/EPERM 下吞错返回 false → 会把"读不到"误报成"文件不存在"。改用 statSync:
    // 只有 ENOENT 是确定性判死; 权限/其他错误 → 跳过, 不猜。
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  out.push({
    kind: 'missing-command-target',
    nodes: [id],
    message:
      `命令引用缺失: 节点 "${id}" 引用 cwd 内脚本 "${ref}", 但文件不存在。` +
      `改法: **创建该脚本**, 或者**把 command 改成 cwd 内真实存在的相对脚本路径**。`,
  });
}

/** 读 package.json 的 scripts 表 (缺失/不可读/JSON 非法/scripts 非对象 → undefined, 不猜)。 */
function packageScripts(cwd: string): Record<string, unknown> | undefined {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts;
  } catch {
    return undefined; // 缺失/不可读/JSON 非法 → 不猜
  }
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return undefined;
  return scripts as Record<string, unknown>;
}

/** 报告一条 package script 缺失 finding (读不到/scripts 非对象 → 跳过)。 */
function checkPackageScript(cwd: string, name: string, id: string, out: StaticFinding[]): void {
  const scripts = packageScripts(cwd);
  if (!scripts) return;
  if (typeof scripts[name] === 'string') return; // 已定义
  out.push({
    kind: 'missing-command-target',
    nodes: [id],
    message:
      `命令引用缺失: 节点 "${id}" 引用 package script "${name}" ` +
      `(${join(cwd, 'package.json')}#scripts.${name}), 但该脚本未定义。` +
      `改法: **在 package.json 的 scripts 中定义 "${name}"**, 或者**把 command 改成已有 script 名**。`,
  });
}

/**
 * 跑前静态检查。**只报确定性判死的**, 拿不准一律不报。
 *
 * @param fileExists 注入式存在性探测 (相对仓根)。省略 = 不做 missing-input 检查
 *   (拿不到文件系统时**不猜**, 而不是假设文件不存在 —— 后者会把所有 plan 报红)。
 */
export function staticLintPlan(
  plan: ConductorPlan,
  opts: { fileExists?: (relPath: string) => boolean } = {},
): StaticFinding[] {
  const out: StaticFinding[] = [];
  const ids = Object.keys(plan.nodes);
  const memo = new Map<string, Set<string>>();

  // ── ① 并行写竞争 ────────────────────────────────────────────────────────────
  // 谁最后写谁赢, 而赢家由调度顺序决定 = **同一张图每次跑结果可能不同**。它不报错, 只是
  // 有时候产物不对 —— 这类静默不确定性是最贵的一种。
  const byPath = new Map<string, string[]>();
  for (const id of ids) {
    const p = declaredOutput(plan.nodes[id]!);
    if (p) byPath.set(p, [...(byPath.get(p) ?? []), id]);
  }
  for (const [path, writers] of byPath) {
    if (writers.length < 2) continue;
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i]!, b = writers[j]!;
        if (!canRunConcurrently(plan, a, b, memo)) continue; // 有依赖 = 有序 = 不是竞争
        out.push({
          kind: 'write-race',
          nodes: [a, b],
          message:
            `写竞争: 节点 "${a}" 与 "${b}" 都声明写 ${path}, 而它们之间没有依赖边 —— ` +
            `谁最后写谁赢, 结果由调度顺序决定, 同一张图每次跑可能不一样。` +
            `改法二选一: **让它们写不同的文件**, 或者**给后写的那个加 depends_on 让顺序确定**。`,
        });
      }
    }
  }

  // ── ② 缺输入 ────────────────────────────────────────────────────────────────
  // 节点声明要读某个仓内文件, 而它既不在盘上、图里也没有任何节点产出它 → 那一步注定失败,
  // 却要烧一次 agent 调用才发现。
  if (opts.fileExists) {
    const produced = new Set([...byPath.keys()]);
    for (const id of ids) {
      const n = plan.nodes[id]!;
      const inputs = (n as { input_paths?: unknown }).input_paths;
      if (!Array.isArray(inputs)) continue;
      for (const raw of inputs) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const p = raw.trim();
        // 绝对路径 / URL 一律不判 —— 我们对仓外一无所知, 猜了就是误报。
        if (p.startsWith('/') || p.includes('://')) continue;
        if (produced.has(p)) continue;          // 图里有人产出它
        // ⚠ **在这里兜住**, 不指望调用方恰好包了 try: 不变量是"探不到就当它在"(漏报好过把所有
        // plan 报红), 它该在模块边界成立。第一版只在引擎的包装里兜, 测试当场抓出来。
        let onDisk = true;
        try { onDisk = opts.fileExists(p); } catch { onDisk = true; }
        if (onDisk) continue;                   // 盘上有 (或探不到)
        out.push({
          kind: 'missing-input',
          nodes: [id],
          message:
            `缺输入: 节点 "${id}" 要读 ${p}, 但它既不在仓里、图里也没有任何节点产出它 —— ` +
            `这一步注定失败。改法: **加一个先产出它的节点并 depends_on 它**, 或者改用一个真实存在的路径。`,
        });
      }
    }
  }

  // ── ③ 缺命令目标 ────────────────────────────────────────────────────────────
  // command 节点引用 cwd 内不存在的脚本、或未定义的 package script → 同样跑之前就能判死。
  // 只碰**简单命令** (`<相对脚本> [args]`、`node/bun/python/bash/sh <相对脚本>`、`bun run <name>`、
  // `npm run <name>`); 掺变量/引号/管道/重定向/glob 的整条跳过, 不递归分析 script 内容。
  for (const id of ids) {
    const n = plan.nodes[id]!;
    if (n.executor !== 'command') continue;                   // 唯一真实判定 = executor (schema 无 type; 非 command 节点带 command 字段也忽略)
    const command = (n as { command?: unknown }).command;
    if (typeof command !== 'string' || command.trim() === '') continue;
    if (hasShellSyntax(command)) continue;
    const tokens = command.trim().split(/\s+/);
    const rawCwd = (n as { cwd?: unknown }).cwd;
    const cwd = typeof rawCwd === 'string' && rawCwd !== '' ? rawCwd : '.';

    const [t0, t1, t2] = tokens;
    let directRef: string | undefined;
    let pkgName: string | undefined;
    if (t0 === 'bun' && t1 === 'run' && tokens.length === 3) {
      // 三词 `bun run X`: 长得像相对脚本 → 先查同名 package script (bun 优先解析它; 已定义就不查
      // 文件, 否则 `bun run lint.js` 会误报"文件不存在"); 没有才按文件查; 否则按 script 名查。
      if (isSafeRelativeScript(t2)) {
        if (typeof packageScripts(cwd)?.[t2] === 'string') continue;
        directRef = t2;
      } else if (t2 !== undefined && /^[A-Za-z0-9:_-]+$/.test(t2)) pkgName = t2;
    } else if (t0 === 'npm' && t1 === 'run' && tokens.length === 3 && t2 !== undefined && /^[A-Za-z0-9:_-]+$/.test(t2)) {
      pkgName = t2;
    } else if (t0 === 'bun' && t1 === 'run' && tokens.length > 3) {
      directRef = t2;                                         // `bun run <脚本> [args...]`
    } else if (t0 === 'bun') {
      directRef = t1;                                         // `bun <脚本> [args...]`
    } else if (t0 === 'node' || t0 === 'python' || t0 === 'python3' || t0 === 'bash' || t0 === 'sh') {
      directRef = t1;
    } else {
      directRef = t0;                                         // 裸 `<相对脚本> [args...]`
    }

    if (directRef !== undefined) {
      if (!isSafeRelativeScript(directRef)) continue;         // 绝对路径/裸 bin/../x.ts/不确定 → 不猜
      checkDirectScript(cwd, directRef, id, out);
    } else if (pkgName !== undefined) {
      checkPackageScript(cwd, pkgName, id, out);
    }
  }

  return out;
}

/** serializeWriteRaces 的输出: 修好的 plan + 补了哪些边 (给日志/观察渲染)。 */
export interface WriteRaceSerialization {
  plan: ConductorPlan;
  /** 每条 = 一次程序化补边: `to.depends_on += from`, 因为两者都声明写 `path` 且此前无序。 */
  added: { from: string; to: string; path: string }[];
}

/**
 * **计划期写竞争硬闸 (2026-08-14, plana 夜报回流第 1 条)**: 把 ①「只报」升级成**构造性消灭** ——
 * 同一文件的多个写者若互不可达 (真会竞争), 引擎直接补依赖边把它们串行化。
 *
 * 为什么是补边而不是拒图: 拒图要烧一轮 conductor 重画 (且 max_rounds 默认 1, 拒 = 整节点报废),
 * 而 lint 消息里那句「给后写的那个加 depends_on」本来就是**确定性可执行**的 —— 机器能做的修复
 * 不该让 LLM 重画一遍 (同 applyPlanPatch「程序化 merge」的理由)。
 *
 * 方向的确定性: 写者按**现有图的拓扑序** (声明序 tie-break) 排队, 边永远从队前指向队后 ——
 * 与既有边一致的全序上加边**不可能成环** (声明序 naive 链会: 声明 [a,b,c] + 既有 a←c 时
 * a→b→c→a, 写这段时先想到的正是那个坑)。同一调度序每次跑同一结果, 这就是要买的东西。
 *
 * ⚠ 不改输入 plan (prior.plan 可能与调用方共享引用 —— engine 里 D-4 毒集那条注买过的教训);
 * 无竞争时原对象直接返回 (零拷贝零扰动)。
 */
export function serializeWriteRaces(plan: ConductorPlan): WriteRaceSerialization {
  const ids = Object.keys(plan.nodes);
  const memo = new Map<string, Set<string>>();
  // 现有图的拓扑位置 (Kahn, 声明序 tie-break)。环由编译期闸拒, 这里防御性跳出即可。
  const topoIndex = new Map<string, number>();
  {
    const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const id of ids) for (const d of plan.nodes[id]!.depends_on ?? []) if (indeg.has(id) && plan.nodes[d]) indeg.set(id, (indeg.get(id) ?? 0) + 1);
    const ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
    let n = 0;
    while (ready.length) {
      const id = ready.shift()!;
      topoIndex.set(id, n++);
      for (const other of ids) {
        if ((plan.nodes[other]!.depends_on ?? []).includes(id)) {
          const left = (indeg.get(other) ?? 0) - 1;
          indeg.set(other, left);
          if (left === 0) ready.push(other);
        }
      }
    }
  }
  const byPath = new Map<string, string[]>();
  for (const id of ids) {
    const p = declaredOutput(plan.nodes[id]!);
    if (p) byPath.set(p, [...(byPath.get(p) ?? []), id]);
  }
  const added: WriteRaceSerialization['added'] = [];
  const nodes: ConductorPlan['nodes'] = { ...plan.nodes };
  for (const [path, writers] of byPath) {
    if (writers.length < 2) continue;
    const ordered = [...writers].sort((a, b) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0));
    for (let i = 1; i < ordered.length; i++) {
      const from = ordered[i - 1]!;
      const to = ordered[i]!;
      // 已有序 (任一方向可达) = 不是竞争, 不补。⚠ memo 在补边后失效 → 每次补完清掉重算,
      // 三写者链式补边时第二刀要看见第一刀 (否则 w1→w3 会再补一条冗余边)。
      if (!canRunConcurrently({ ...plan, nodes }, from, to, memo)) continue;
      nodes[to] = { ...nodes[to]!, depends_on: [...new Set([...(nodes[to]!.depends_on ?? []), from])] };
      memo.clear();
      added.push({ from, to, path });
    }
  }
  return added.length ? { plan: { ...plan, nodes }, added } : { plan, added };
}
