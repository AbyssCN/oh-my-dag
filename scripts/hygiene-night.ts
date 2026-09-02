#!/usr/bin/env bun
/**
 * scripts/hygiene-night —— 治理链的**链构造 + 装饰 + 证伪 driver** (契约 §链形状 / D-4..D-6 / D-10)。
 *
 *   bun scripts/hygiene-night.ts --dry-run [--out <plan.json>]   # 零 LLM: 构链 + 编译 + 打印节点
 *   bun scripts/hygiene-night.ts --refute <hy> --out <hy>/worklist.json
 *
 * ## 拓扑由脚本产, 模型只填文本槽
 *
 * 「教 conductor 自由画图」在盘上实测塌了 (dynamic-workflow-design §6 R1)。所以这条链的
 * 6 个节点 id 与边**写死在 `buildHygieneChain` 里**, 经 `compileChain` 确定性编译成
 * ConductorPlan; M3 只往 `perItem` / `goal` 这些文本槽里写话。节点集合变了 = 代码改了,
 * 不会是模型当晚"想了个别的图"。
 *
 * ## D-10 越界红线
 *
 * 本文件不改 `stage-chain.ts` 的冻结接口、不改 `conductor-plan.ts` 的 zod 值域、不改
 * `dag/engine.ts`。装饰的做法是**编译后往 plan 上加字段, 再过一次 `parsePlan`** ——
 * 加错了当场被 schema 拒, 而不是运行到一半才发现。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parsePlan, type ConductorPlan } from '../src/harness/conductor-plan';
import { compileChain, type StageChain } from '../src/harness/goal/stage-chain';
import { buildWorkList, refuteDelete, type RefuteVerdict } from '../src/harness/hygiene/refute';
import { parseTriageBatch, type TriageEntry } from '../src/harness/hygiene/triage';
import { MAX_ITEMS_PER_LEAF, type HygieneItem, type HygieneScan } from '../src/harness/hygiene/types';

/** 链上 6 个节点的 id (顺序 = 线性链的顺序; 测试引用这个常量不写字面)。 */
export const HYGIENE_NODE_IDS = ['scan', 'triage', 'refute', 'apply', 'verify', 'report'] as const;

/** 施工分支名前缀 (D-5: 分支 `hygiene/<date>`, 不 merge)。 */
export const BRANCH_PREFIX = 'hygiene/';

export interface HygieneChainOpts {
  date: string;
  cwd: string;
  maxItemsPerLeaf: number;
}

/**
 * 固定 6 段链。`<hy>` = `runs/hygiene/<date>/`。
 *
 * `triage` 是 map 段: `listFrom.extractor` 跑一条 jq 把 `scan.json` 按 source 分组、
 * 每组截到 `maxItemsPerLeaf` 项 —— **截断在 extractor 里做, 不在 goal 里请求模型自己少写**
 * (M3 输出 32K 截断是量级事实, 靠嘱咐拦不住)。输出形状 `{items:[...]}` 是 `compileChain`
 * 的 `over:'items'` 约定。
 */
export function buildHygieneChain(opts: HygieneChainOpts): StageChain {
  const hy = `runs/hygiene/${opts.date}`;
  const n = opts.maxItemsPerLeaf;
  return {
    stages: [
      {
        id: 'scan',
        word: 'command',
        command: `bun scripts/hygiene-scan.ts --out ${hy}/scan.json`,
        goal: `零 LLM 扫描九个矿源 → ${hy}/scan.json`,
      },
      {
        id: 'triage',
        word: 'map',
        listFrom: {
          stage: 'scan',
          extractor: `jq -c '{items: [.items | group_by(.source)[] | {source: .[0].source, ids: [.[].id][:${n}]}]}' ${hy}/scan.json`,
        },
        perItem: [
          '## 硬约束',
          `- 只读 ${hy}/scan.json 里 source = \${item.source} 的项, 只判 \${item.ids} 这批 id, 至多 ${n} 条。`,
          '- 输出**只有**一个 JSON 数组, 每个元素四个字段全必填:',
          '  `{"itemId": string, "disposition": "delete"|"keep"|"ticket", "reason": string, "reproCmd": string}`。',
          '  少一个字段整条作废, 不是"留空"。',
          '- `reproCmd` 必须是只读命令, 前缀取自: ugrep / grep / rg / bfs / bun test / git log / git show /',
          '  git grep / git diff / wc / cat / head / tail / sed -n / ls / bunx tsc --noEmit。',
          '  **禁重定向 `>`、管道 `|`、串接 `;` `&`、命令替换 `$(...)`** —— 带任何一个整条作废。',
          '- 不许改任何文件。这一步只出判断。',
          '',
          '## 提示',
          '- `delete` 只给"机械可证的死件"(死文件 / 死导出 / 死类型 / 死依赖); 拿不准写 `ticket`。',
          '- 判不了就 `ticket`, 不要猜 —— 下游有机械双核, 猜错只是多一轮。',
          `- 写到 ${hy}/triage-\${item.source}.json。`,
        ].join('\n'),
      },
      {
        id: 'refute',
        word: 'command',
        command: `bun scripts/hygiene-night.ts --refute ${hy} --out ${hy}/worklist.json`,
        goal: `合并各类 triage, 对每条 delete 跑机械双核 → ${hy}/worklist.json`,
      },
      {
        id: 'apply',
        word: 'agent',
        goal: [
          '## 硬约束',
          `- 只删 ${hy}/worklist.json 的 \`files\` 与 \`confirmed\` 列出的项, **一项都不许多**。`,
          '- 允许的改动只有三种: 整文件删除 / 删掉一条导出声明 / 从 package.json 删一条 devDependency。',
          '- 不许改任何其他行 —— 包括"顺手"的格式、注释、import 排序。',
          `- 在分支 \`${BRANCH_PREFIX}${opts.date}\` 上做, 不 merge 回 main。`,
          '- verify: `bunx tsc --noEmit` 必须 0; 被删项的姊妹测试必须绿。',
          '',
          '## 提示',
          '- 删导出时若发现同文件里还有别的用处, 停手并在输出里说明 —— 那条会被降成票。',
        ].join('\n'),
      },
      {
        id: 'verify',
        word: 'verify',
        goal: [
          `分支 ${BRANCH_PREFIX}${opts.date} 的 diff 只含 ${hy}/worklist.json 施工清单里那些项的删除;`,
          '无任何新增行; `bunx tsc --noEmit` 退出 0。',
          '逐条核对 diff 与清单, 对不上就判 fail —— 你的职责是攻击这份结果, 不是盖章。',
        ].join('\n'),
      },
      {
        id: 'report',
        word: 'synthesize',
        goal: [
          `读 ${hy}/scan.json 的 counts、${hy}/worklist.json 的 confirmed/refuted、以及上游 verify 判词,`,
          `写 ${hy}/report.md: ① 逐类计数表 ② 双核通过率 (通过/提议) ③ 施工清单与 verify 判词`,
          '④ 需要人裁的残余。**只报事实与下一步, 不建议怎么改架构** (架构候选走 deepen, 不进本链)。',
        ].join('\n'),
      },
    ],
  };
}

/**
 * 编译后的 plan → 装上 `apply` 节点的写集 (D-5「write_set = 施工清单里的文件精确列表」)。
 *
 * 装饰后**再过一次 `parsePlan`**: 装错了 (写集不是字符串数组 / 节点 id 拼错) 当场被 schema 拒。
 * 空清单也照装 `[]` —— 「这次没有可删的」与「忘了声明写集」是两件事 (§静默坑 1),
 * 写集对账那一层靠字段在不在场分辨。
 */
export function decorateHygienePlan(plan: ConductorPlan, workList: string[]): ConductorPlan {
  const decorated = {
    ...plan,
    nodes: { ...plan.nodes, apply: { ...plan.nodes.apply, write_set: [...workList] } },
  };
  const res = parsePlan(JSON.stringify(decorated), { knownServers: new Set<string>() });
  if (!res.ok) throw new Error(`装饰后的 plan 过不了 parsePlan: ${res.error}`);
  return res.plan;
}

// ── 证伪 driver (链上 `refute` 节点跑的就是这个) ────────────────────────────

export interface RefuteRunResult {
  generatedAt: string;
  verdicts: RefuteVerdict[];
  fallbackIds: string[];
  files: string[];
  confirmed: number;
  refuted: number;
}

/** 只读命令执行器 (证伪的第二核用它; 与 hygiene-scan 的 runCapture 同形)。 */
function shellRun(cmd: string, cwd: string): { code: number; out: string } {
  const proc = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  return { code: proc.exitCode ?? 1, out: `${dec.decode(proc.stdout)}${dec.decode(proc.stderr)}` };
}

/**
 * `<hy>/scan.json` + `<hy>/triage-*.json` → 施工清单。
 * `deps.run` 注入 = 测试零外部进程 (真跑时是 `sh -c`, 命令已过 reproCmd 白名单)。
 */
export function runRefutePass(
  hyDir: string,
  deps: { run: (cmd: string) => { code: number; out: string }; nowIso: string },
): RefuteRunResult {
  const scan = JSON.parse(readFileSync(join(hyDir, 'scan.json'), 'utf-8')) as HygieneScan;
  const byId = new Map<string, HygieneItem>(scan.items.map((i) => [i.id, i]));

  const entries: TriageEntry[] = [];
  const fallbackIds: string[] = [];
  const triageFiles = existsSync(hyDir)
    ? readdirSync(hyDir).filter((f) => f.startsWith('triage-') && f.endsWith('.json'))
    : [];
  for (const f of triageFiles) {
    const raw = readFileSync(join(hyDir, f), 'utf-8');
    // 该类的期望 id 集 = scan 里同 source 的全部 id (文件名带 source)。
    const source = f.slice('triage-'.length, -'.json'.length);
    const expected = scan.items.filter((i) => i.source === source).map((i) => i.id);
    const parsed = parseTriageBatch(raw, expected);
    if (parsed.parseError) {
      // 整批塌 → 全类降 ticket。判词原文留在这里, 否则明早只看得到"这一类全是票"。
      console.error(`[hygiene-night] ${f} 整批解析失败 (该类 ${expected.length} 项全降 ticket): ${parsed.parseError}`);
    }
    entries.push(...parsed.entries);
    fallbackIds.push(...parsed.fallback);
  }

  const verdicts = entries
    .filter((e) => e.disposition === 'delete')
    .map((entry) => {
      const item = byId.get(entry.itemId);
      if (!item) {
        // scan 里没有这个 id —— parseTriageBatch 本该拦住, 拦不住也不能放行。
        return { itemId: entry.itemId, verdict: 'refuted' as const, checks: [{ name: 'scan 里存在该 id', ok: false, detail: '分诊给的 itemId 不在 scan.json 里' }] };
      }
      return refuteDelete({ entry, item, repoRoot: hyDir }, { run: deps.run });
    });

  const wl = buildWorkList(verdicts, byId);
  return {
    generatedAt: deps.nowIso,
    verdicts,
    fallbackIds,
    files: wl.files,
    confirmed: wl.confirmed.length,
    refuted: wl.refuted.length,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = val('cwd') ?? process.cwd();
  const date = val('date') ?? new Date().toISOString().slice(0, 10);

  const hy = val('refute');
  if (hy) {
    const res = runRefutePass(hy, { run: (cmd) => shellRun(cmd, cwd), nowIso: new Date().toISOString() });
    const out = val('out') ?? join(hy, 'worklist.json');
    writeJson(out, res);
    console.log(`双核: 提议 ${res.verdicts.length} 条 → confirmed ${res.confirmed} / refuted ${res.refuted}; 分诊回退 ${res.fallbackIds.length} 条`);
    console.log(`施工清单 ${res.files.length} 个文件 → ${out}`);
    process.exit(0);
  }

  if (argv.includes('--dry-run')) {
    // 零 LLM 的形状自检: 构链 → 编译 → 装饰 → 打印。任何一步不合 schema 当场抛。
    const chain = buildHygieneChain({ date, cwd, maxItemsPerLeaf: MAX_ITEMS_PER_LEAF });
    const plan = decorateHygienePlan(compileChain(chain), []);
    // 写出 plan.json 供 dag_run_plan 点火 —— 拓扑是脚本产的, 点火那一刻不再经 conductor。
    const planOut = val('out');
    if (planOut) writeJson(planOut, plan);
    console.log(`链: ${chain.stages.map((s) => `${s.id}(${s.word})`).join(' → ')}`);
    console.log(`分支: ${BRANCH_PREFIX}${date} · 每叶上限 ${MAX_ITEMS_PER_LEAF} 项`);
    for (const [id, node] of Object.entries(plan.nodes)) {
      const n = node as Record<string, unknown>;
      const kind = (n.executor as string) ?? (n.primitive ? `primitive:${n.primitive as string}` : '?');
      console.log(`  ${id.padEnd(8)} ${kind.padEnd(16)} depends_on=[${(n.depends_on as string[]).join(', ')}]`);
    }
    process.exit(0);
  }

  console.error('usage: bun scripts/hygiene-night.ts --dry-run | --refute <hy> [--out <worklist.json>]');
  process.exit(1);
}
