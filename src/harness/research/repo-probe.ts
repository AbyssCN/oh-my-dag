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
import { logger } from '../logger';

export interface RepoHit {
  /** 仓相对路径 (含行号锚, 形如 src/x.ts:42)。 */
  path: string;
  /** 命中行原文 (已按 maxCharsPerHit 截断)。 */
  text: string;
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
  /** 单条命中字符上限。默认 400 (一行代码 + 上下文足够)。 */
  maxCharsPerHit?: number;
  /** 注入式 spawn (测试替身)。默认 Bun.spawnSync。 */
  _spawn?: (argv: string[], opts: { cwd: string }) => { stdout: string; exitCode: number };
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
  const maxChars = opts.maxCharsPerHit ?? 400;
  // -F 字面串 (查询串永远不当正则/元字符解释) · -n 行号 · -r 递归 · -m = **每文件**上限 · 跳噪声目录。
  const argv = [
    'ugrep', '-F', '-n', '-r', '--no-heading',
    '-m', String(perFile),
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
  for (const line of out.stdout.split('\n')) {
    if (hits.length >= perQuery) break;
    // ugrep --no-heading 输出: path:line:text
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({ path: `${m[1]!.replace(/^\.\//, '')}:${m[2]}`, text: (m[3] ?? '').trim().slice(0, maxChars) });
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
export function repoProbe(queries: readonly string[], opts: RepoProbeOpts): RepoHit[] {
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
  return hits;
}

/** 命中列表 → 进语料的 markdown 段 (无命中 → '')。 */
export function renderRepoHits(hits: readonly RepoHit[]): string {
  if (hits.length === 0) return '';
  return [
    '<repo-probe>',
    '以下是**本仓**确定性检索的命中 (file:line — 原文)。这是仓内事实, 与外部来源分开对待:',
    ...hits.map((h) => `- ${h.path} — ${h.text}`),
    '</repo-probe>',
  ].join('\n');
}
