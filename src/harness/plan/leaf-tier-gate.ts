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

const REWRITE_SMALL = (paths: string[], totalBytes: number): string =>
  `总量 ${Math.round(totalBytes / 1024)}KB 塞得下单个 leaf prompt → 改成两个节点: ` +
  `① \`executor:'command'\` 节点 \`cat ${paths.join(' ')}\`(确定性读盘,零 LLM); ` +
  `② 原节点降为**无 executor 的普通 leaf**(inproc),depends_on 指向 ①,内容经 depOutputs ` +
  `注入 prompt(单消费者不触发 fan-in 摘要,全文直达)。`;

const REWRITE_BIG = (totalNote: string): string =>
  `${totalNote}塞不下单个 leaf → 用 \`executor:'conductor'\` 运行期展开: 先用 command(ls/cat 清单)或 ` +
  `agent lister **只做定位**,conductor 子图按清单为每一份内容画一对节点 ` +
  `\`command cat <路径>\` → \`leaf 提炼\`(内容进 prompt 只计费一次)。探索与重读分开: ` +
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
      message:
        `节点 "${id}" 用 \`executor:'agent'\` 读**确定路径**(${hits.join(', ')})且无写意图(无 output_path,产出 structured)。` +
        `agent 工具环每轮重发累积对话 —— 这类节点的内容会被重复计费(r2 实测 6 倍),且慢。` +
        `改法: ${totalBytes <= threshold ? REWRITE_SMALL(hits, totalBytes) : REWRITE_BIG(`总量 ~${Math.round(totalBytes / 1024)}KB `)}`,
    });
  }
  return out;
}
