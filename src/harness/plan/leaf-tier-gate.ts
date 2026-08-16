/**
 * plan/leaf-tier-gate —— g1 判据的可执行层(图「引擎墙钟与 leaf 档位」#9,owner 已裁 2026-08-04)。
 *
 * ## 判据(为什么存在)
 *
 * **大内容进 prompt(单次计费),不进工具环(每轮重放)。**
 * r2 实测算术:f2 语料 10 篇 1.2MB ≈ 35 万 token,agent 档 extract 实耗 208 万 input token
 * = **6 倍重放** —— 工具环每一轮都要重发累积对话,内容经工具调用进入就按轮数计费;
 * 经 prompt 注入进入只计一次。同一算术解释了 B 臂(也是工具环)为何 87.6 万 token。
 *
 * ## 三态(化解"判据太硬会杀掉探索")
 *
 * 1. `command` 确定性读 + `leaf` 合成 —— 内容边界已知且总量塞得下;
 * 2. `agent` —— 需按内容决定下一步读什么 / 改文件 / 跑验证;
 * 3. `agent` 探索 → 交棒 `command`+`leaf` 重读 —— 定位与重读分开。
 *
 * ## 为什么是闸不是 prompt 规则
 *
 * prompt 规则不可证伪(模型不听你无从得知);闸红/绿可证伪 —— 与「可靠性来自模型之外」一致。
 * 出口:**拒并给改写建议**,建议文本为下一轮 conductor 消费优化(说清哪个节点、为什么、怎么改)。
 * 有界重问后 fail-open(顽固违规不挂死生产,但证据必须响亮留下)——接线在 executor-dag。
 *
 * ## 判定信号(全部确定性,拿不准一律不报 —— 同 static-lint 纪律)
 *
 * 静态节点:`executor:'agent'` ∧ `output_type:'structured'` ∧ 无 `output_path`(无声明写意图)
 * ∧ goal 里 ≥1 个能 stat 到的真实路径(确定性读边界)→ 这活是"读定死的文件、交结构化产出",
 * command+leaf 严格占优。map 模板同判(模板引用 {{item.*}} = 路径由 lister 确定性给出)。
 *
 * 反向自检:leaf-tier-gate.test.ts 用 f2-a-1 真实生产 plan 的 map 模板做红样本
 * (那张图正是 6 倍重放的案发现场),并证明写意图/探索/command 三类不误伤。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';

type PlanNodeLike = ConductorPlan['nodes'][string] & {
  output_type?: string;
  output_path?: string;
  content_bytes?: number;
  map?: {
    itemVar?: string;
    template?: Record<string, unknown>;
  };
};

export interface LeafTierFinding {
  kind: 'agent-deterministic-read' | 'map-agent-deterministic-read';
  /** 规划期节点名(说给下一轮 conductor 听的名字体系)。 */
  nodes: string[];
  /** 已是人话,带**为什么**与**怎么改**(LLM 消费优化)。 */
  message: string;
  /** stat 到的路径与总字节(map 模板拿不到 → 空/0)。 */
  paths: string[];
  totalBytes: number;
  /**
   * 这条**能不能由引擎自己改**(见 {@link autoRewriteLeafTier})。
   *
   * 只有「静态节点 ∧ 总量塞得下单个 leaf prompt」那一格为真 —— 那一格的改写是确定性的:
   * 节点名、路径、字节数闸全都有,`REWRITE_SMALL` 那三步逐字可执行。map 模板与超阈那两格
   * **真的需要模型判断**(要不要保持逐份扇出、清单从哪来),不假装能改。
   */
  autoRewritable: boolean;
}

/** 一次程序化改写的留证(给日志/观察渲染;静默改图与静默违规一样坏)。 */
export interface LeafTierRewrite {
  /** 被降档的原节点 id(仍在图上,只是不再是 agent)。 */
  node: string;
  /** 新插入的确定性读盘节点 id。 */
  readNode: string;
  command: string;
  paths: string[];
  totalBytes: number;
}

export interface LeafTierRewriteResult {
  plan: ConductorPlan;
  rewritten: LeafTierRewrite[];
  /** 改不动的那些 —— 仍要拒回问模型。 */
  residual: LeafTierFinding[];
}

/** 注入式 stat:文件 → {size, dir:false};目录 → {size: 直属常规文件字节和, dir:true};不存在/读不到 → null。 */
export type StatPathFn = (absPath: string) => { size: number; dir: boolean } | null;

const defaultStatPath: StatPathFn = (absPath) => {
  try {
    const st = statSync(absPath);
    if (st.isFile()) return { size: st.size, dir: false };
    if (!st.isDirectory()) return null;
    let size = 0;
    for (const f of readdirSync(absPath)) {
      try {
        const s = statSync(join(absPath, f));
        if (s.isFile()) size += s.size;
      } catch {
        /* 单个条目读不到 → 不计, 不猜 */
      }
    }
    return { size, dir: true };
  } catch {
    return null; // 不存在/权限 → 不算确定路径, 不猜 (拿不准不报)
  }
};

/**
 * goal 文本 → 候选路径 token。词法保守:含 `/` 的段,或带扩展名的独立文件名;
 * 剥引号/反引号/括号/中英标点尾巴。真正的过滤靠 stat(存在才算确定路径)。
 */
export function extractPathTokens(goal: string): string[] {
  const out = new Set<string>();
  for (const raw of goal.split(/[\s,;:()【】()「」《》'"`,、;:!?]+/)) {
    const tok = raw.replace(/^[('"`[{<]+|[)'"`\]}>.。]+$/g, '');
    if (!tok || tok.includes('{{')) continue; // 模板变量另判 (map 分支)
    if (!tok.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(tok)) continue;
    const normalized = tok.replace(/\/+$/, ''); // 目录尾斜杠归一 ('raw/' → 'raw')
    if (normalized) out.add(normalized);
  }
  return [...out];
}

export interface LeafTierGateOpts {
  /** 相对路径的根(缺省 process.cwd())。 */
  root?: string;
  /** 注入式 stat(测试用;缺省真盘)。 */
  statPath?: StatPathFn;
  /**
   * 「塞得下单个 leaf prompt」的字节阈值。**按座位 context window 实测定**(r2b 同批探针),
   * 不拍脑袋 —— 接线层从 config/env 给;纯函数层缺省 Infinity = 不做体量分支,建议文案给两条路。
   */
  thresholdBytes?: number;
}

/**
 * 多文件读盘命令。**单文件用 `cat`,多文件必须用 `tail -v -n +1`** —— 后者每份前面打
 * `==> 路径 <==` 头,`cat` 不打。
 *
 * 这条是 2026-08-04 实测买来的:本闸第一版的建议逐字写着 `cat <路径1> <路径2> …`,
 * conductor 照做,于是 10 篇论文被拼成一个**无分隔的字节流**;下游 leaf 关键词答对 5/8,
 * 而「出处」8/8 全错 —— 它只能按内容猜论文标题(答成 `Accelerating…Co-Scientist.pdf`,
 * 语料里根本没这个文件)。老的「每篇一个分片」形状出处全对,因为分片自己知道它读的是谁。
 * **省钱的读法不许把逐源身份一起省掉**:两条命令都过闸、都零 LLM,差别只在那一行头。
 */
export const bundleReadCommand = (paths: string[]): string =>
  paths.length <= 1 ? `cat ${paths.join(' ')}` : `tail -v -n +1 ${paths.join(' ')}`;

const REWRITE_SMALL = (paths: string[], totalBytes: number): string =>
  `总量 ${Math.round(totalBytes / 1024)}KB 塞得下单个 leaf prompt → 改成两个节点: ` +
  `① \`executor:'command'\` 节点 \`${bundleReadCommand(paths)}\`(确定性读盘,零 LLM` +
  `${paths.length > 1 ? ';`tail -v -n +1` 会给每份打 `==> 路径 <==` 头 —— 多文件**不许**用裸 `cat`,' +
  '那样拼出来的字节流没有逐源身份,下游只能猜出处' : ''}); ` +
  `② 原节点降为**无 executor 的普通 leaf**(inproc),depends_on 指向 ①,内容经 depOutputs ` +
  `注入 prompt(单消费者不触发 fan-in 摘要,全文直达)。` +
  `③ 若下游要按来源归因(引用/出处/逐源核对),**保持逐份扇出**(map 模板 ` +
  `\`command: "cat {{item.path}}"\`,每个子节点自带路径),别把 N 份合并成一个装料节点。`;

const REWRITE_BIG = (totalNote: string): string =>
  `${totalNote}塞不下单个 leaf → 用 \`executor:'conductor'\` 运行期展开: 先用 command(ls/cat 清单)或 ` +
  `agent lister **只做定位**,conductor 子图按清单为每一份内容画一对节点 ` +
  `\`command cat <单个路径>\` → \`leaf 提炼\`(内容进 prompt 只计费一次)。` +
  `**一份内容一个节点**,不要合并成一条多文件命令 —— 合并会洗掉逐源身份(裸 \`cat\` 不打文件名), ` +
  `真要一次读多份就用 \`tail -v -n +1\`。探索与重读分开: ` +
  `agent 只在"需要按内容决定下一步/改文件/跑验证"时保留。`;

/**
 * 纯判定:plan → findings。零 IO 依赖注入化(statPath),不改 plan,不打日志(调用方打)。
 */
export function leafTierGateFindings(plan: ConductorPlan, opts: LeafTierGateOpts = {}): LeafTierFinding[] {
  const root = opts.root ?? process.cwd();
  const stat = opts.statPath ?? defaultStatPath;
  const threshold = opts.thresholdBytes ?? Number.POSITIVE_INFINITY;
  const out: LeafTierFinding[] = [];

  for (const [id, rawNode] of Object.entries(plan.nodes)) {
    const node = rawNode as PlanNodeLike;

    // ── map 模板分支:模板 executor:'agent' + 引用 lister 元素 + 无写意图 + 结构化产出 ──
    if (node.executor === 'map' && node.map?.template) {
      const tpl = node.map.template as { executor?: string; goal?: string; output_path?: string; output_type?: string };
      const itemVar = node.map.itemVar ?? 'item';
      const refsItem = typeof tpl.goal === 'string' && tpl.goal.includes(`{{${itemVar}.`);
      // 不要求 output_type==='structured' (静态分支才要): 写文件的模板按 schema 硬规则必须声明
      // output_path, 所以 !output_path 已守住写意图; 多要一个 output_type 合取 = 白送一条
      // 「丢掉该字段即绕过」的路 (2026-08-04 复测时差点被这么绕)。
      if (tpl.executor === 'agent' && refsItem && !tpl.output_path) {
        out.push({
          kind: 'map-agent-deterministic-read',
          nodes: [id],
          paths: [],
          totalBytes: node.content_bytes ?? 0,
          // 清单由运行期 lister 给, 闸手上没有路径也没有字节数 —— 改写不了, 只能问模型。
          autoRewritable: false,
          message:
            `节点 "${id}" 的 map 模板用 \`executor:'agent'\` 去读 lister 已确定的路径 ({{${itemVar}.…}}) 并交结构化产出。` +
            `agent 工具环每一轮都重发累积对话 —— 读定死的文件用 agent = 内容按轮数重复计费(r2 实测 6 倍)。` +
            `改法: ${REWRITE_BIG('per-item 内容')}若单项内容确定塞得下也可把 map 模板换成 ` +
            `\`executor:'command'\`(\`command: "cat {{${itemVar}.path}}"\`)+ 下游 leaf 消费 map 输出。` +
            `节点可加 \`content_bytes\`(预估总字节,可由 lister 侧信息给)帮引擎选路。`,
        });
      }
      continue;
    }

    // ── 静态节点分支 ──
    if (node.executor !== 'agent') continue;
    if ((node as { output_type?: string }).output_type !== 'structured') continue; // 产出即文本交付 → 才是纯读-合成形
    if (node.output_path) continue; // 声明了写意图 → 三态②, 合法
    const goal = typeof node.goal === 'string' ? node.goal : '';
    if (!goal) continue;
    const hits: string[] = [];
    let totalBytes = 0;
    for (const tok of extractPathTokens(goal)) {
      const abs = tok.startsWith('/') ? tok : join(root, tok);
      const st = stat(abs);
      if (st) {
        hits.push(tok);
        totalBytes += st.size;
      }
    }
    if (hits.length === 0) continue; // 无确定路径 → 探索形, 合法 (拿不准不报)
    if (node.content_bytes !== undefined) totalBytes = Math.max(totalBytes, node.content_bytes);
    out.push({
      kind: 'agent-deterministic-read',
      nodes: [id],
      paths: hits,
      totalBytes,
      autoRewritable: totalBytes <= threshold,
      message:
        `节点 "${id}" 用 \`executor:'agent'\` 读**确定路径**(${hits.join(', ')})且无写意图(无 output_path,产出 structured)。` +
        `agent 工具环每轮重发累积对话 —— 这类节点的内容会被重复计费(r2 实测 6 倍),且慢。` +
        `改法: ${totalBytes <= threshold ? REWRITE_SMALL(hits, totalBytes) : REWRITE_BIG(`总量 ~${Math.round(totalBytes / 1024)}KB `)}`,
    });
  }
  return out;
}

/** `<id>__read` 撞名时往后找 —— 图里已有同名节点就不许覆盖(覆盖 = 静默吃掉一个节点)。 */
function freeReadId(taken: ReadonlySet<string>, base: string): string {
  const first = `${base}__read`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    const cand = `${base}__read${n}`;
    if (!taken.has(cand)) return cand;
  }
}

/**
 * **闸自己动手**(issue #144 提议 3 / #145 提议 3,2026-08-16)。
 *
 * ## 为什么改
 *
 * 判据是全确定性的,出口却是「拒 + 给改写建议」——**要再花一发最贵的座位让模型照着改**。
 * 一次拒回 = 1 发规划座;叠上 `LEAF_TIER_MAX_REJECTS=2` + escalation 补丁 3 次 + D-21 复用闸,
 * 一张坏图能烧 6+ 发规划(实测 run 386cf35b:契约段 38m26s,产出 0 行代码)。
 *
 * 更关键的是这条规则**早就在 conductor prompt 里**(`conductor-plan.ts:541-546`),而 codex
 * conductor 连违 4 次 —— 「prompt 规则不可证伪,闸才可证伪」又添一个样本,但也说明
 * **光有闸不够:闸应该自己动手,而不是把确定性的改写外包回给最贵的模型**。
 * 同仓已有先例:`static-lint.ts` 的 `serializeWriteRaces` 就是补边而不是拒图,理由逐字相同。
 *
 * ## 改什么(= `REWRITE_SMALL` 的①②两步,逐字可执行)
 *
 * ① 插一个 `executor:'command'` 节点跑 {@link bundleReadCommand}(零 LLM;多文件走
 *    `tail -v -n +1`,每份自带 `==> 路径 <==` 头 —— 逐源身份不许省);
 * ② 原节点**去掉 executor** 降为普通 inproc leaf,`depends_on` 加上①,内容经 depOutputs 进 prompt。
 *
 * 新节点的 `depends_on` **抄原节点的** —— 不是可有可无的谨慎:原节点的上游可能正是写这些
 * 文件的那个节点,读盘抢在它前面就读到旧内容。抄一份则前后关系逐字不变。
 *
 * ## 不改什么(闸改不动的,老老实实拒回问模型)
 *
 * - **map 模板**:清单由运行期 lister 给,闸手上没有路径;
 * - **超阈**(`totalBytes > thresholdBytes`):塞不下单个 leaf,正解是 conductor 运行期展开
 *   per-item 对,那是个**结构决策**不是改写;
 * - `REWRITE_SMALL` 的③(「下游要按来源归因就保持逐份扇出」):**这一条是判断不是改写**,
 *   闸判不了下游要不要逐源归因。所幸①选的 `tail -v -n +1` 本来就保住了逐源身份,
 *   最坏情况是没扇出而不是丢出处。
 *
 * ⚠ 不改输入 plan(同 `serializeWriteRaces`:调用方可能与 prior 共享引用);无可改写命中时原对象直接返回。
 */
export function autoRewriteLeafTier(plan: ConductorPlan, opts: LeafTierGateOpts = {}): LeafTierRewriteResult {
  const findings = leafTierGateFindings(plan, opts);
  const doable = findings.filter((f) => f.autoRewritable && f.kind === 'agent-deterministic-read');
  if (doable.length === 0) return { plan, rewritten: [], residual: findings };

  const nodes: ConductorPlan['nodes'] = { ...plan.nodes };
  const taken = new Set(Object.keys(nodes));
  const rewritten: LeafTierRewrite[] = [];
  for (const f of doable) {
    const id = f.nodes[0]!;
    const orig = nodes[id];
    if (!orig) continue; // 防御: findings 与 plan 不同源时不猜
    const readId = freeReadId(taken, id);
    taken.add(readId);
    const command = bundleReadCommand(f.paths);
    nodes[readId] = {
      ...(orig.depends_on?.length ? { depends_on: [...orig.depends_on] } : {}),
      goal: `确定性读盘(引擎程序化插入, g1 闸): ${f.paths.join(', ')} — 内容交下游 "${id}" 消费`,
      executor: 'command',
      command,
    } as ConductorPlan['nodes'][string];
    // 原节点降档: executor 整个拿掉 (inproc leaf), 而不是改成 'leaf' —— 两者语义同, 但少一个
    // 显式值就少一处将来会漂的重复。**其余字段逐字保留**: 改档位不是重写节点。
    const { executor: _dropped, ...rest } = orig as Record<string, unknown>;
    nodes[id] = {
      ...rest,
      depends_on: [...new Set([...(orig.depends_on ?? []), readId])],
    } as ConductorPlan['nodes'][string];
    rewritten.push({ node: id, readNode: readId, command, paths: f.paths, totalBytes: f.totalBytes });
  }
  const done = new Set(rewritten.map((r) => r.node));
  return {
    plan: { ...plan, nodes },
    rewritten,
    residual: findings.filter((f) => !f.nodes.every((n) => done.has(n))),
  };
}
