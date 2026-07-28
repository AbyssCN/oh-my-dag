/**
 * research/repo-probe —— second-pass 的**仓内腿** (对称 web 腿 buildSecondPassProbe)。
 *
 * 缺口分析常问"这个断言在**我们仓里**是怎么实现的" —— web 腿只会去抓 URL, 接不住; 而研究 leaf
 * 是 inproc 看不见仓库。这一层把那类缺口交给**确定性检索**: 模型只负责点名要查什么
 * (gap.repoQueries), 取什么、取多少、从哪取全由代码定。
 *
 * 刻意不是工具循环: 给 leaf 一个 grep 工具意味着"查几次、查什么"由模型自由裁量, 那正是 D-6
 * 判过的下限流失。这里模型出上限 (缺什么), 代码出下限 (实际取到什么), 与 web 腿同一分工。
 *
 * 安全面: 固定 argv 数组调 ugrep/grep (**不过 shell**, 查询串当字面量 -F 传), cwd 绑定,
 * 命中数/字节数双封顶。查询串再怎么畸形也只是搜不到东西, 不会变成命令。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';

export interface RepoHit {
  /** 仓相对路径 (含行号锚, 形如 src/x.ts:42)。 */
  path: string;
  /** 命中行原文 + 上下文 (换行分隔, 已按 maxCharsPerHit 截断)。 */
  text: string;
}

/** 整读进来的文件 (仓内腿的"一个源" —— 与 web 腿的"一个页面"对位)。 */
export interface RepoFile {
  path: string;
  text: string;
  /** 超 maxCharsPerFile 被截断 (带显式标记进语料, 不静默丢)。 */
  truncated: boolean;
}

export interface RepoProbeResult {
  /** 行级命中 (定位面)。 */
  hits: RepoHit[];
  /** 整读文件 (纵深面) —— 命中最集中的前 N 个。 */
  files: RepoFile[];
}

export interface RepoProbeOpts {
  /** 检索根 (绑定 cwd, 不接受调用方在 query 里逃逸)。 */
  cwd: string;
  /**
   * **同一文件**最多取几条。默认 2 —— 同一个符号在一个文件里重复 8 次基本是噪声, 2 条足够定位,
   * 省下的名额给别的文件 = 更多来源。(直接当 ugrep 的 -m 传, 它就是 per-file 语义。)
   */
  maxHitsPerFile?: number;
  /** 每条 query 收集上限 (进轮转分配前的池子)。默认 16。 */
  maxHitsPerQuery?: number;
  /** 单轮总命中上限 (跨 query)。默认 40 —— 语料增长必须有闸, 同 web 腿的 probeCrawl。 */
  maxHitsTotal?: number;
  /**
   * 每条命中前后各带几行上下文。默认 2。
   *
   * 为什么不是 0: 裸一行 `import { X } from '...'` 只回答了"这里用了 X", 回答不了缺口真正问的
   * "**怎么**用的" —— 而那正是仓内腿存在的理由。反过来也别开太大: 一条 import 周围的 ±5 行
   * 是纯噪声。最优值是 eval 该测的曲线, 不是这里能拍的。
   */
  contextLines?: number;
  /** 单条命中 (含上下文) 字符上限。默认 1200 —— 对齐 web 腿每源 12k 的量级差 (10×, 不是 30×)。 */
  maxCharsPerHit?: number;
  /**
   * 命中最集中的前 N 个文件**整读**进语料。默认 3; 0 = 关。
   *
   * 为什么要这条: web 腿的一个"源"是**一整页**(几 KB~30KB), 仓内腿的一条"命中"只是**一行**
   * (实测均 ~200 字符, 只用到自己上限的 12%)。同样 40 个单位, 一边是 40 页一边是 40 行 ——
   * 差的不是预算数字是**取材粒度**, 调大单条上限没用。整读把仓内腿的单位提到与 web 对位。
   */
  fullFileTop?: number;
  /** 整读单文件字符上限。默认 12000 —— 与 web 腿每源同一个数, 两边"一个源"的量级对齐。 */
  maxCharsPerFile?: number;
  /** 仓内腿语料总闸 (行级 + 整读)。默认 40000。 */
  maxCharsTotal?: number;
  /** 注入式 spawn (测试替身)。默认 Bun.spawnSync。 */
  _spawn?: (argv: string[], opts: { cwd: string }) => { stdout: string; exitCode: number };
  /** 注入式文件读 (测试替身)。默认 readFileSync。 */
  _readFile?: (path: string) => string;
}

const defaultSpawn = (argv: string[], opts: { cwd: string }): { stdout: string; exitCode: number } => {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, stdout: 'pipe', stderr: 'ignore' });
  return { stdout: new TextDecoder().decode(r.stdout), exitCode: r.exitCode ?? 1 };
};

/** 跑一条 query, 返回已按 per-file 收敛的命中 (顺序 = ugrep 遍历序)。 */
function runQuery(query: string, opts: RepoProbeOpts): RepoHit[] {
  const spawn = opts._spawn ?? defaultSpawn;
  const perFile = opts.maxHitsPerFile ?? 2;
  const perQuery = opts.maxHitsPerQuery ?? 16;
  const maxChars = opts.maxCharsPerHit ?? 1200;
  const ctx = Math.max(0, opts.contextLines ?? 2);
  // -F 字面串 (查询串永远不当正则/元字符解释) · -n 行号 · -r 递归 · -m = **每文件**上限 · 跳噪声目录。
  // -A/-B 上下文: ugrep 用 `path:line:text` 标命中行、`path-line-text` 标上下文行, 据此归并。
  const argv = [
    'ugrep', '-F', '-n', '-r', '--no-heading',
    '-m', String(perFile),
    ...(ctx > 0 ? ['-A', String(ctx), '-B', String(ctx)] : []),
    '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
    '--', query, '.',
  ];
  let out: { stdout: string; exitCode: number };
  try {
    out = spawn(argv, { cwd: opts.cwd });
  } catch (e) {
    logger.warn({ query, err: String(e) }, '[omd/repo-probe] 检索失败 → 该 query 跳过 (fail-open)');
    return [];
  }
  if (out.exitCode !== 0 && !out.stdout) return []; // exit 1 = 没搜到, 正常
  const hits: RepoHit[] = [];
  /** 尚未归属的 before 上下文 (path → 行), 等它那条命中出现再合并。 */
  let pending: { path: string; lines: string[] } | null = null;
  for (const line of out.stdout.split('\n')) {
    // **非贪婪**: 正文里出现 `-12-` 这种串很常见, 贪婪会切到最后一处 → 行号与正文全错位
    // (2026-07-28 实测: 一条注释里的 "2026-07-28" 把切点吃到了 "28")。
    const hit = /^(.+?):(\d+):(.*)$/.exec(line);
    if (hit) {
      if (hits.length >= perQuery) break;
      const path = hit[1]!.replace(/^\.\//, '');
      const before = pending && pending.path === path ? pending.lines : [];
      pending = null;
      const body = [...before, (hit[3] ?? '').trim()].filter(Boolean).join('\n');
      hits.push({ path: `${path}:${hit[2]}`, text: body.slice(0, maxChars) });
      continue;
    }
    const ctxLine = /^(.+?)-(\d+)-(.*)$/.exec(line);
    if (!ctxLine) continue; // 块间的 '--' 分隔行等
    const path = ctxLine[1]!.replace(/^\.\//, '');
    const text = (ctxLine[3] ?? '').trim();
    if (!text) continue;
    const last = hits.at(-1);
    // **同文件才归并**: 不加这个判据, B 文件的 before 上下文会挂到 A 文件的命中上
    // (2026-07-28 实测复现: 一条命中的尾巴接着另一个文件的 import 行)。
    if (last && last.path.startsWith(`${path}:`)) {
      if (last.text.length < maxChars) last.text = `${last.text}\n${text}`.slice(0, maxChars);
      continue;
    }
    // 属于下一条命中的 before 上下文 (只留最近 ctx 行)
    if (!pending || pending.path !== path) pending = { path, lines: [] };
    pending.lines.push(text);
    if (pending.lines.length > ctx) pending.lines.shift();
  }
  return hits;
}

/**
 * 跑一批仓内查询 → 命中列表 (已去重、已封顶)。
 *
 * **名额按 query 轮转分配**, 不是先到先得。为什么: 顺序取的写法下, 第一条常见词 (如 "config")
 * 会吃光全部名额, 后面真正想查的符号**零命中** —— 2026-07-28 实测复现
 * (["config", "SeatUnresolvedError", "assertSeatsUsable"] → 后两条各 0 条)。
 * 轮转既公平又不浪费: 某条 query 早早取完, 剩余额度自动流给还有货的。
 *
 * 失败不断链 (与 web 腿同): ugrep 不在 / 非零退出 → 该 query 空手而归, 不抛。
 */
export function repoProbe(queries: readonly string[], opts: RepoProbeOpts): RepoProbeResult {
  const total = opts.maxHitsTotal ?? 40;
  const pools = queries
    .map((q) => q.trim())
    .filter(Boolean)
    .map((q) => runQuery(q, opts));
  const hits: RepoHit[] = [];
  const seen = new Set<string>();
  const cursor = new Array(pools.length).fill(0);
  let progressed = true;
  while (hits.length < total && progressed) {
    progressed = false;
    for (let i = 0; i < pools.length && hits.length < total; i++) {
      const pool = pools[i]!;
      // 跳过本 query 里已被别的 query 命中过的同一 file:line (去重不占轮次)
      while (cursor[i] < pool.length && seen.has(pool[cursor[i]]!.path)) cursor[i]++;
      if (cursor[i] >= pool.length) continue;
      const hit = pool[cursor[i]++]!;
      seen.add(hit.path);
      hits.push(hit);
      progressed = true;
    }
  }
  return { hits, files: promoteFiles(hits, opts) };
}

/**
 * 命中最集中的前 N 个文件整读 —— 仓内腿的"纵深面"。
 *
 * 挑法 = 命中数排序 (命中多 = 这个文件与缺口最相关), 同数按路径稳定序。读失败跳过不抛
 * (second-pass 是增益不是链路)。
 */
function promoteFiles(hits: readonly RepoHit[], opts: RepoProbeOpts): RepoFile[] {
  const topN = opts.fullFileTop ?? 3;
  if (topN <= 0 || hits.length === 0) return [];
  const perFile = opts.maxCharsPerFile ?? 12_000;
  const totalCap = opts.maxCharsTotal ?? 40_000;
  const read = opts._readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const counts = new Map<string, number>();
  for (const h of hits) {
    const f = h.path.slice(0, h.path.lastIndexOf(':'));
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([f]) => f);
  const files: RepoFile[] = [];
  // 行级命中已经占了一部分预算, 整读只能用剩下的 (总闸对两个面一起生效)。
  let budget = totalCap - hits.reduce((a, h) => a + h.text.length, 0);
  for (const f of ranked) {
    if (budget <= 0) break;
    let raw: string;
    try {
      raw = read(join(opts.cwd, f));
    } catch (e) {
      logger.warn({ file: f, err: String(e) }, '[omd/repo-probe] 整读失败 → 跳过 (fail-open)');
      continue;
    }
    const cap = Math.min(perFile, budget);
    const truncated = raw.length > cap;
    files.push({ path: f, text: raw.slice(0, cap), truncated });
    budget -= Math.min(raw.length, cap);
  }
  return files;
}

/** 命中 + 整读文件 → 进语料的 markdown 段 (全空 → '')。 */
export function renderRepoHits(r: RepoProbeResult | readonly RepoHit[]): string {
  // 兼容老签名 (只给 hits 数组)。
  const res: RepoProbeResult = Array.isArray(r) ? { hits: r as RepoHit[], files: [] } : (r as RepoProbeResult);
  if (res.hits.length === 0 && res.files.length === 0) return '';
  const parts = [
    '<repo-probe>',
    '以下是**本仓**确定性检索的结果。这是仓内事实, 与外部来源分开对待:',
  ];
  if (res.hits.length > 0) {
    parts.push('', '### 命中定位 (file:line — 原文 + 上下文)', ...res.hits.map((h) => `- ${h.path}\n${h.text}`));
  }
  for (const f of res.files) {
    parts.push(
      '',
      `### 相关文件全文: ${f.path}${f.truncated ? ' [已截断, 全文见该路径]' : ''}`,
      f.text,
    );
  }
  parts.push('</repo-probe>');
  return parts.join('\n');
}
