#!/usr/bin/env bun
/**
 * scripts/dag-map —— 代码理解 (codegraph 确定性取上下文 → fanout 合成 map)。
 *
 * 吸收自 fusang scripts/xihe-map.ts (2026-07-26, 承 xihe 三段链吸收计划: web/research/distill 已入,
 * map 是第四件)。镜像 dag-research, 检索器换成 codegraph: 给问题/子系统 → `codegraph context`
 * 确定性产出真实代码切片 (零 LLM, 带 file:line) → 作 groundTruth → 合成结构化 map。
 * **调用方不再读 N 个文件烧 context**。
 *
 * 架构判断 (同 web 栈 doctrine): fanout/synth leaf 是纯模型调用无工具 → codegraph **由脚本确定性查**
 * 喂 groundTruth, 不是 leaf 自己调。索引是 per-machine (.codegraph/ gitignored): 首次 init+index, 之后 sync。
 *
 *   bun run scripts/dag-map.ts "<问题/子系统>" [--symbols a,b,c] [--path dir] [--breadth] [--council] [--model p:m] [--reindex] [--out path]
 *   默认: codegraph context (聚焦 top-N) → 1 次合成 (快/省)。
 *   --council: conductor 分解 lens → **按每 lens 子问题各取一次 codegraph context union** → researchFanout 深析。
 *   --symbols: 额外对这些符号取 callers/callees。--reindex: 强制全量重建索引。
 *
 * 普查/广度检索 (承 xihe-map 2026-06-10 欠采样根因修): `codegraph context` 是 **bounded top-N**
 *   (按相关度坍缩到最高分簇), 普查型问题喂巨型三合一问题 → 输出截断 → 误判"不存在"。
 *   广度模式 (完整性 > 单查相关度):
 *     --path <dir>: 先 `codegraph files --filter <dir>` 拉**完整子树清单**作完整性底座 + 抬高 context top-N。
 *     --breadth:    多段/编号/分号问题拆子查询, 各跑 context (抬高 top-N) 去重 union。
 *     --council:    检索广度随 lens 分解 scale (每 lens 各查一次 union)。
 *     --exhaustive: **分片 map-reduce** — 确定性枚举 --path 子树 (缺省 src) → 每文件恰属一片
 *                   (≤18文件/48KB 每片, 每文件截 12KB) → 并发局部 map (--map-model, 8 并发, 失败重试1)
 *                   → reduce 用既有合成路径。召回 = **确定性账** (分片清单 diff 归零, 机器可验), 非语义 top-N;
 *                   失败片列文件名 = "未覆盖"非"不存在" (无静默丢失)。全仓正文级普查/合规普查用这个。
 */
import '../src/harness/script-bootstrap';
import { send } from '../src/model/gateway';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { resolveRoleModelConfigured } from '../src/model/role-models';
import { authorFanoutSpec } from '../src/harness/research/author-spec';
import { researchFanout } from '../src/harness/research/fanout';
import { parallel } from '../src/harness/primitives';
import { $ } from 'bun';

// ---- arg parse: 三类 flag。取值时**只在下一 token 不是 --flag 时才消费** (承 xihe-map arg-parse 修) ----
//   BOOL           —— 无值开关。
//   OPTIONAL_VALUE —— 值可选, 缺值=空 (`--symbols --council` 合法)。
//   其余 (model/out/path/…) —— 必带值, 下一 token 是 --flag 或行尾 → 报错。
const BOOL = new Set(['council', 'reindex', 'breadth', 'exhaustive']);
const OPTIONAL_VALUE = new Set(['symbols']);
const flags: Record<string, string> = {};
const positionals: string[] = [];
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (BOOL.has(key)) {
      flags[key] = 'true';
      continue;
    }
    const next = av[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    if (!hasValue && !OPTIONAL_VALUE.has(key)) {
      console.error(
        `[dag-map] flag --${key} 需要一个值, 但后面是 ${next === undefined ? '行尾' : `"${next}" (另一个 flag)`}。` +
          ` 若 --${key} 应是 boolean flag, 把它加进脚本 BOOL 集。`,
      );
      process.exit(1);
    }
    flags[key] = hasValue ? next! : '';
    if (hasValue) i++;
  } else positionals.push(a);
}
const question = positionals.join(' ').trim();
if (!question) {
  console.error(
    'usage: bun run scripts/dag-map.ts "<问题/子系统>" [--symbols a,b,c] [--path dir] [--breadth] [--exhaustive] [--council] [--model p:m] [--map-model p:m] [--lens-count N] [--reindex] [--out path]',
  );
  process.exit(1);
}

// ---- codegraph 索引 (per-machine, .codegraph/ gitignored): 只增量 sync; --reindex 全量重建 ----
$.cwd(process.cwd());
if (flags.reindex) {
  process.stderr.write('[dag-map] --reindex: 全量重建索引...\n');
  await $`codegraph index`.nothrow();
} else {
  await $`codegraph sync`.nothrow().quiet(); // 增量, 快
}

// ---- 检索 helper: 广度模式抬高 bounded top-N (默认 nodes 50 / code 10 → 普查抬到 80 / 20) ----
const RAISED_NODES = 80;
const RAISED_CODE = 20;
async function cgContext(task: string, raised: boolean): Promise<string> {
  const out = raised
    ? await $`codegraph context ${task} --max-nodes ${RAISED_NODES} --max-code ${RAISED_CODE}`.nothrow().text()
    : await $`codegraph context ${task}`.nothrow().text();
  return out.trim();
}

/** 把多份 codegraph context 输出按 block (空行分隔段) 去重 union。普查型: 完整性 > 单查相关度。 */
function unionDedup(parts: { label: string; text: string }[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { label, text } of parts) {
    if (!text) continue;
    const kept: string[] = [];
    for (const block of text.split(/\n\s*\n/)) {
      const b = block.trim();
      if (b.length < 4) continue;
      const key = b.slice(0, 200); // block 前缀作去重键 (codegraph 每簇 #### Symbol(file:line) 唯一)
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(b);
    }
    if (kept.length) out.push(`<!-- 子查询: ${label} -->\n${kept.join('\n\n')}`);
  }
  return out.join('\n\n');
}

/** 把多段/编号/分号问题拆成子查询 (广度检索); <2 段则回退整问题。 */
function splitSubqueries(q: string): string[] {
  const raw = q
    .split(/\n+|[;；]|(?:^|[\s,，])\d+[.)、．]\s+/g)
    .map((s) => s.replace(/^[\s,，:：、。\-*]+|[\s,，]+$/g, '').trim())
    .filter((s) => s.length >= 6);
  const seen = new Set<string>();
  const uniq = raw.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return uniq.length >= 2 ? uniq : [q];
}

// ---- 普查型问题自动广度 (机制非 advisory: stderr 提示会被 2>/dev/null 消费纪律吞掉, 靠检测自动启用) ----
const CENSUS_RE =
  /全盘点|盘点|普查|清单|列出|列清单|有哪些|哪些环节|成熟度|现状|全量|全模块|逐(模块|文件|端点|环节|屏)|所有.*(引擎|模块|文件|端点)|全部.*(引擎|模块|文件|端点)|inventory|list all|enumerate|map out|overview of all/i;
const isCensus = CENSUS_RE.test(question);

// 问题里显式提到的路径 → 自动当 --path 用 (普查连败根因: 查询点名了子树却没人传 flag)
const autoPaths = [
  ...new Set(
    [...question.matchAll(/(?:src|test|scripts|docs)\/[\w./-]*/g)]
      .map((m) => m[0].replace(/[.,，。;；)）'"`]+$/, '').replace(/\/+$/, ''))
      .filter((p) => p.includes('/')),
  ),
].slice(0, 4);

const pathFilters: string[] = flags.path ? [flags.path] : autoPaths;
if (!flags.path && pathFilters.length) {
  process.stderr.write(`[dag-map] 自动 --path (问题点名路径): ${pathFilters.join(', ')}\n`);
}
if (!flags.breadth && !flags.council && !flags.exhaustive && isCensus) {
  flags.breadth = 'true';
  process.stderr.write('[dag-map] 普查型问题 → 自动启用 --breadth (top-N 截断会误判"不存在")\n');
}

// ---- 确定性取上下文 (零 LLM; --exhaustive 时跳过, 走分片 map-reduce) ----
const exhaustive = !!flags.exhaustive;
const raised = !!(pathFilters.length || flags.breadth); // 普查模式抬高 top-N
const baseBlocks: string[] = [];

// (b) path filters: 完整子树文件清单作完整性底座 (语义检索会漏域 — files 不漏)
if (!exhaustive)
  for (const pf of pathFilters) {
    process.stderr.write(`[dag-map] codegraph files --filter ${pf} (完整子树清单)...\n`);
    // 保留 metadata (每文件符号数) — 普查判"真引擎 vs stub"的廉价信号; strip ANSI 色码避免污染 corpus
    const inv = (await $`codegraph files --filter ${pf} --format flat`.nothrow().text())
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim();
    if (inv) baseBlocks.push(`## 子树完整文件清单 (codegraph files --filter ${pf})\n${inv}`);

    // 匿名回调盲区 (承 xihe-map 2026-07-06 修): Hono/Express 路由 handler 是匿名函数挂路由对象,
    // 符号图锚不住正文 → 端点类普查空手。确定性 ugrep 路由注册行直补 groundTruth (零 LLM, 带 file:line)。
    const routes = (await $`ugrep -rn -E ${'\\.(get|post|put|delete|patch)\\s*\\(\\s*[\'"`]/'} ${pf}`.nothrow().text()).trim();
    if (routes) {
      process.stderr.write(`[dag-map] 路由注册行 (确定性 ugrep): ${routes.split('\n').length} 行\n`);
      baseBlocks.push(`## 路由注册行 (确定性 ugrep, 匿名 handler 符号图不可见 — 此清单权威)\n${routes}`);
    }
  }
const hasInventory = baseBlocks.length > 0 || exhaustive;

// (d) --exhaustive: 分片 map-reduce — 确定性枚举→每文件恰属一片→并发局部 map→(下游) reduce 合成。
//     召回从"语义检索 bounded top-N"变成**确定性账**: 分片清单 diff 归零 = 100% 正文级覆盖, 可机器验。
let ctxBlock = '';
let exhaustiveCoverage = '';
if (exhaustive) {
  bootstrapModelRuntime();
  const { readdirSync, statSync } = await import('node:fs');
  const roots = pathFilters.length ? pathFilters : ['src'];
  const files: string[] = [];
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) {
        files.push(root);
        continue;
      }
      for (const f of readdirSync(root, { recursive: true }) as string[]) {
        const fp = `${root}/${f}`;
        if (/\.(ts|tsx)$/.test(fp) && !fp.includes('node_modules')) files.push(fp);
      }
    } catch {
      process.stderr.write(`[dag-map] --exhaustive: 路径不可读, 跳过 ${root}\n`);
    }
  }
  files.sort();
  if (!files.length) {
    console.log('[dag-map] ❌ --exhaustive: 0 个 .ts/.tsx (检查 --path)');
    process.exit(2);
  }

  // 分片: 路径序贪心 (目录天然聚在同片); 每文件截 FILE_CAP, 每片 ≤SHARD_FILES 且 ≤SHARD_CHARS。
  const FILE_CAP = 12_000,
    SHARD_CHARS = 48_000,
    SHARD_FILES = 18,
    SHARD_HARD_CAP = 120;
  type Shard = { files: string[]; entries: string[]; chars: number };
  const shards: Shard[] = [];
  let cur: Shard = { files: [], entries: [], chars: 0 };
  for (const f of files) {
    let txt = '';
    try {
      txt = await Bun.file(f).text();
    } catch {
      txt = '(不可读)';
    }
    const clipped = txt.length > FILE_CAP ? txt.slice(0, FILE_CAP) + `\n…(截 ${txt.length - FILE_CAP} chars, 头部含全部 import+头注)` : txt;
    const entry = `### ${f}\n\`\`\`ts\n${clipped}\n\`\`\``;
    if (cur.files.length && (cur.chars + entry.length > SHARD_CHARS || cur.files.length >= SHARD_FILES)) {
      shards.push(cur);
      cur = { files: [], entries: [], chars: 0 };
    }
    cur.files.push(f);
    cur.entries.push(entry);
    cur.chars += entry.length;
  }
  if (cur.files.length) shards.push(cur);
  if (shards.length > SHARD_HARD_CAP) {
    console.log(`[dag-map] ❌ --exhaustive: ${shards.length} 片 > 上限 ${SHARD_HARD_CAP} — 用 --path 收窄或分多次跑`);
    process.exit(2);
  }
  // 召回 oracle: 每文件恰属一片 (确定性账; 不平=本脚本 bug, fail-fast)
  const acct = shards.flatMap((s) => s.files);
  if (acct.length !== files.length || new Set(acct).size !== files.length) {
    console.log('[dag-map] ❌ exhaustive 分片账不平 (脚本 bug, 拒跑)');
    process.exit(2);
  }
  process.stderr.write(`[dag-map] --exhaustive: ${files.length} 文件 → ${shards.length} 片 (账平), 并发局部 map...\n`);

  const mapModel = flags['map-model'] || resolveRoleModelConfigured('lens').model;
  const failedFiles: string[] = [];
  const jobs = shards.map((s, i) => async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await send({
          model: mapModel,
          messages: [
            {
              role: 'system',
              content:
                '你是代码库分片理解器。对本片每个文件产出局部 map, 每文件一节 `### <路径>`: ①职责一句 ②关键 export/类型/不变量 ③与总问题相关的事实 (标 file:行号)。' +
                '忠实源码不臆造; 与总问题无关的文件也必须给 ①② (普查完整性 — 漏文件 = 错)。截断标记后的内容未给出, 别猜。',
            },
            { role: 'user', content: `## 总问题\n${question}\n\n## 本片文件 (${s.files.length})\n${s.entries.join('\n\n')}` },
          ],
          meta: { role: 'map-shard' },
        });
        process.stderr.write(`  [shard ${i + 1}/${shards.length}] ok (${s.files.length} 文件, 尝试${attempt})\n`);
        return `## 分片 ${i + 1}/${shards.length} (${s.files.length} 文件)\n${r.text}`;
      } catch (e) {
        if (attempt === 2) {
          failedFiles.push(...s.files);
          process.stderr.write(`  [shard ${i + 1}] ❌ 两次失败: ${(e as Error).message}\n`);
          return `## 分片 ${i + 1} ❌ map 失败 (文件未覆盖, 非不存在): ${s.files.join(', ')}`;
        }
      }
    }
    return '';
  });
  const localMaps = (await parallel(jobs, { concurrency: 8 })).map((t) => t ?? '');
  exhaustiveCoverage = `exhaustive ${files.length - failedFiles.length}/${files.length} 文件 · ${shards.length} 片${failedFiles.length ? ` · ⚠️ ${failedFiles.length} 文件所在片失败 (已列名, 无静默丢失)` : ''}`;
  baseBlocks.push(
    `## 完整文件账 (--exhaustive, ${exhaustiveCoverage})\n${files.join('\n')}`,
    `## 逐片局部 map (reduce 的唯一依据; 每文件正文级摘要)\n${localMaps.join('\n\n')}`,
  );
} else if (flags.breadth) {
  // (a) --breadth: 多子查询 union; 否则单次 context (原行为, 回归安全)
  const subs = splitSubqueries(question);
  process.stderr.write(`[dag-map] --breadth: ${subs.length} 个子查询 union (抬高 top-N)...\n`);
  const parts: { label: string; text: string }[] = [];
  for (const s of subs) parts.push({ label: s.slice(0, 50), text: await cgContext(s, true) });
  ctxBlock = unionDedup(parts);
} else {
  process.stderr.write(`[dag-map] codegraph context "${question}"${raised ? ' (抬高 top-N)' : ''}...\n`);
  ctxBlock = await cgContext(question, raised);
}
if (!exhaustive) baseBlocks.push(`## context\n${ctxBlock}`);

// (c) 覆盖度地板: top-N context 没够到的子树文件 → 直接从源码抽 export 签名。
//     零 LLM、不依赖检索排名 — 保证普查"每文件至少签名级可见",
//     把失败模式从"自信地判缺失"压到"签名可见, 深度未覆盖"。成本 ~1 行/符号。
if (!exhaustive && pathFilters.length) {
  const { readdirSync, statSync } = await import('node:fs');
  const treeFiles: string[] = [];
  for (const pf of pathFilters) {
    try {
      if (!statSync(pf).isDirectory()) continue; // files --filter 是子串匹配, 这里只对真目录做地板
      for (const f of readdirSync(pf, { recursive: true }) as string[]) {
        if (/\.(ts|tsx)$/.test(String(f)) && !String(f).includes('node_modules')) treeFiles.push(`${pf}/${f}`);
      }
    } catch {
      /* 非本地目录的 filter → 跳过 (清单仍由 codegraph files 提供) */
    }
  }
  const uncovered = treeFiles.filter((f) => !ctxBlock.includes(f)).slice(0, 40);
  const sigBlocks: string[] = [];
  for (const f of uncovered) {
    try {
      const sigs = (await Bun.file(f).text())
        .split('\n')
        .filter((l) => /^export\s+(?:async\s+)?(?:function|const|interface|class|type|enum)\s/.test(l))
        .map((l) => l.replace(/\s*[{=].*$/, '').trim())
        .slice(0, 12);
      if (sigs.length) sigBlocks.push(`### ${f}\n${sigs.join('\n')}`);
    } catch {
      /* unreadable → 跳过 */
    }
  }
  if (sigBlocks.length) {
    process.stderr.write(`[dag-map] 覆盖度地板: ${sigBlocks.length} 个未够到文件补 export 签名\n`);
    baseBlocks.push(
      `## 覆盖度地板 (top-N 未够到的清单文件 → export 签名, 直接取自源码, 真实存在)\n${sigBlocks.join('\n\n')}`,
    );
  }
}

// --symbols: 额外取 callers/callees (不受广度模式影响)
const symbolBlocks: string[] = [];
const symbols = flags.symbols ? flags.symbols.split(',').map((s) => s.trim()).filter(Boolean) : [];
for (const sym of symbols) {
  const callers = await $`codegraph callers ${sym}`.nothrow().text();
  const callees = await $`codegraph callees ${sym}`.nothrow().text();
  symbolBlocks.push(`### 符号 ${sym}\n#### callers\n${callers.trim()}\n#### callees\n${callees.trim()}`);
}

let corpus = `# codegraph 上下文: ${question}\n\n${baseBlocks.join('\n\n')}${
  symbolBlocks.length ? '\n\n## 符号调用关系\n' + symbolBlocks.join('\n\n') : ''
}`;
if (corpus.replace(/\s/g, '').length < 80) {
  // 致命错误进 stdout (非 stderr): 消费纪律是 2>/dev/null, 走 stderr 的死因对调用方不可见
  const noIndex = !(await Bun.file(`${process.cwd()}/.codegraph/index.db`).exists()) && !(await Bun.file(`${process.cwd()}/.codegraph`).exists());
  console.log(
    noIndex
      ? `[dag-map] ❌ 本目录 (${process.cwd()}) 无 codegraph 索引 (.codegraph/ 是 per-worktree gitignored)。先跑: codegraph init && codegraph index`
      : '[dag-map] ❌ codegraph 上下文为空。换问法 / --reindex / 确认符号名。',
  );
  process.exit(2);
}

if (!exhaustive) bootstrapModelRuntime(); // exhaustive 已在分片 map 前 bootstrap
// synth/终审默认 = reason 角色 (--model 可覆盖)
const model = flags.model || resolveRoleModelConfigured('reason').model;

const GROUNDING =
  '硬纪律: 只用下面 codegraph 上下文里的真实符号/文件/调用关系推理; 引用处标 file:line; ' +
  '上下文未覆盖的部分明说"本次检索未够到"——**禁止**断言"索引未收录/建议补索引"' +
  '(top-N 没够到 ≠ 索引没有; 你无法区分二者, 别替用户诊断索引), 禁用训练记忆编造不存在的函数/路径。' +
  (hasInventory
    ? '注意: "## 子树完整文件清单"/"## 完整文件账" 是该范围全部文件的权威清单 — 清单里列出的文件**确实存在**, 不要因正文未引用就判其"不存在"; 判"缺失"只允许针对清单里也没有的东西。' +
      (exhaustive ? ' map 失败片的文件 = "未覆盖", 不是"不存在"。' : '')
    : '');

let mapText: string;
let meta: string;
if (flags.council) {
  // 深析: conductor 分解代码理解 lens → researchFanout
  process.stderr.write('[dag-map] --council: conductor 分解 lens → researchFanout...\n');
  const lensCount = flags['lens-count'] ? Number.parseInt(flags['lens-count'], 10) || undefined : undefined;
  const cfg = await authorFanoutSpec({ goal: question, groundTruth: corpus, lensCount });

  // 普查根因修 (承 xihe-map): 检索广度随分解 scale — 每 lens 子问题各取一次 codegraph context union 进 corpus。
  // exhaustive 时跳过: corpus 已是全量局部 map (再叠 codegraph 只膨胀 L×V leaf 注入成本)。
  if (!exhaustive) {
    process.stderr.write(`[dag-map] --council: 按 ${cfg.lenses.length} lens 各取一次 codegraph context (检索广度随分解 scale)...\n`);
    const lensParts: { label: string; text: string }[] = [];
    for (const lens of cfg.lenses) {
      const q = [lens.key, ...lens.subAngles].join(' ');
      lensParts.push({ label: lens.key, text: await cgContext(q, true) });
    }
    const lensCtx = unionDedup(lensParts);
    if (lensCtx) corpus = `${corpus}\n\n## lens 检索补充 (检索广度随分解 scale)\n${lensCtx}`;
  }

  const res = await researchFanout({
    ...cfg,
    groundTruth: corpus, // ← 用 lens-enriched corpus 覆盖 (authorFanoutSpec 里那份是分解前的底座)
    stablePrefix: `你是代码库理解合成系统的一员。${GROUNDING}`,
    lensModel: resolveRoleModelConfigured('lens').model,
    reasonModel: model,
    onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
  });
  mapText = res.final;
  meta = `--council · ${res.leafCount} leaves · lens检索union · $${res.costStats.totalUsd.toFixed(4)} · lens: ${cfg.lenses
    .map((l) => l.key)
    .join(',')}`;
} else {
  // 默认: 1 次合成 (快/省) — codegraph 已做完"读代码"的重活, 这里只合成
  process.stderr.write(`[dag-map] 合成 map (${model})...\n`);
  const res = await send({
    model,
    messages: [
      { role: 'system', content: `你是代码理解合成器。把 codegraph 上下文合成成结构化 map: 职责/数据流/调用链/关键契约不变量/边界与失败模式, 每点标 file:line。${GROUNDING}` },
      { role: 'user', content: `${corpus}\n\n## 任务\n${question}` },
    ],
    thinkingLevel: 'high',
    meta: { role: 'map-synth' },
  });
  mapText = res.text;
  meta = `单次合成 · ${model}`;
}

if (exhaustiveCoverage) meta += ` · ${exhaustiveCoverage}`;

// ---- 输出: map 进 stdout (调用方要的); 上下文语料附录存盘 (零丢失) ----
const doc = [`# 代码 map: ${question}`, '', `> ${meta}`, '', '## Map', '', mapText, '', '---', '', '## codegraph 上下文附录 (合成依据)', '', corpus].join('\n');
const slug = question.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'map';
const out = flags.out || `/tmp/dag-map-${slug}-${Date.now()}.md`;
await Bun.write(out, doc);

process.stderr.write(`\n[dag-map] ${meta} → ${out}\n\n`);
console.log(mapText);
