/**
 * src/harness/hygiene/refute —— `delete` 提议的**机械双核** (契约 D-4 / INV-4)。
 *
 * ## 为什么要第二核
 *
 * 第一核 = 分诊叶自己给的 `reproCmd`。它是**模型的自证据**, 判别力弱: 一个把死文件判错的
 * 模型, 给出来的 repro 通常也印证它自己那套说法。第二核是**与模型无关**的独立核对
 * (全仓字面引用计数 + package.json 白名单), 它不读模型的任何一句话。
 *
 * 实测能被第二核抓住而第一核抓不住的形态: `await import('./x')` 这类**动态 import** ——
 * knip 看不见这条边, 于是把 `src/x.ts` 判成死文件; 全仓字面计数看得见。
 *
 * ## fail-closed 的方向
 *
 * 任一核不过 → `refuted`, 该条降 ticket。**没有第二核可用的类** (debt / todo / big-file /
 * stale-plan / test-health / failed-runs / forks) 一律 `refuted` —— 它们的处置是"改"或"归档",
 * 不是机械可证的"删", 按契约非目标只成票。宁可多一张票, 不许多删一个文件。
 */
import { reproAllowed } from './repro-allow';
import type { TriageEntry } from './triage';
import type { HygieneItem } from './types';

export interface RefuteInput {
  entry: TriageEntry;
  item: HygieneItem;
  repoRoot: string;
}

export interface RefuteVerdict {
  itemId: string;
  verdict: 'confirmed' | 'refuted';
  checks: { name: string; ok: boolean; detail: string }[];
}

/** 全仓字面引用计数走这个名字 —— GWT-4 逐字读它。 */
export const CHECK_REF_COUNT = 'ugrep 引用计数';
/** package.json 的 `exports` / `files` 白名单核。 */
export const CHECK_PKG_ALLOWLIST = 'package.json 白名单';
/** 第一核: 分诊叶自己给的 repro (判别力弱, 见文件头)。 */
export const CHECK_REPRO = 'reproCmd 自证据';

/** 全仓字面搜索扫的根 (与 hygiene-scan 的矿源根同集合, 加 package.json)。 */
export const REF_SEARCH_ROOTS = ['src', 'scripts', 'package.json'];

/** 只允许标识符 / 包名 / 路径这几种字符进 shell 串 —— 其余当作"核不了"直接 refuted。 */
const SAFE_NEEDLE = /^[A-Za-z0-9_./@-]+$/;

type Runner = (cmd: string) => { code: number; out: string };

/** 死文件的搜索针 = 去掉扩展名的路径末段 (动态 import 写的就是这个)。 */
function fileNeedle(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
}

/** `ugrep -r -l` 的输出行数 (排除项目自身那一行) —— 引用计数。 */
function countRefs(runner: Runner, cmd: string, selfPath: string | undefined): { n: number; out: string } {
  const res = runner(cmd);
  // ugrep 无命中时退出 1 —— 那是"计数 0", 不是工具错。>1 才是真错, 交给调用处判。
  const hits = res.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== selfPath);
  return { n: res.code > 1 ? Number.NaN : hits.length, out: res.out.slice(0, 300) };
}

/** 该类有没有第二核可用 (没有 = 不进施工清单)。 */
const DELETABLE_SOURCES = new Set(['knip-files', 'knip-exports', 'knip-types', 'knip-deps']);

/**
 * 一条 `delete` 提议 → 双核判决。`deps.run` 注入 = 测试零外部进程。
 * `verdict` 为 `confirmed` 当且仅当 **checks 全部 ok**。
 */
export function refuteDelete(input: RefuteInput, deps: { run: Runner }): RefuteVerdict {
  const { entry, item } = input;
  const checks: RefuteVerdict['checks'] = [];
  const done = (): RefuteVerdict => ({
    itemId: entry.itemId,
    verdict: checks.length > 0 && checks.every((c) => c.ok) ? 'confirmed' : 'refuted',
    checks,
  });

  if (entry.disposition !== 'delete') {
    checks.push({ name: CHECK_REPRO, ok: false, detail: `disposition="${entry.disposition}" 不是 delete, 不进施工清单` });
    return done();
  }
  if (!DELETABLE_SOURCES.has(item.source)) {
    checks.push({
      name: CHECK_REF_COUNT,
      ok: false,
      detail: `source="${item.source}" 没有机械第二核 — 该类的处置是改/归档, 按契约只成票`,
    });
    return done();
  }

  // ── 第一核: 模型自己的 repro (先过白名单, 再真跑) ──────────────────────
  const allow = reproAllowed(entry.reproCmd);
  if (!allow.ok) {
    checks.push({ name: CHECK_REPRO, ok: false, detail: `reproCmd 被白名单拒: ${allow.reason}` });
    return done();
  }
  const repro = deps.run(entry.reproCmd);
  checks.push({
    name: CHECK_REPRO,
    // 只读搜索类命令"无命中"退出 1 是正常读数; >1 才是工具/参数错。
    ok: repro.code <= 1,
    detail: `退出 ${repro.code}: ${repro.out.slice(0, 200)}`,
  });

  // ── 第二核: 与模型无关的全仓字面核 ────────────────────────────────────
  const needle = item.source === 'knip-files' ? fileNeedle(item.path ?? '') : (item.symbol ?? '');
  if (!needle || !SAFE_NEEDLE.test(needle)) {
    checks.push({
      name: CHECK_REF_COUNT,
      ok: false,
      detail: `搜索针 "${needle}" 含不安全字符或为空 — 核不了就不放行`,
    });
    return done();
  }

  if (item.source === 'knip-deps') {
    // 死依赖: 全仓找不到 `from '<pkg>` 的引用才算真死。
    const cmd = `ugrep -r -l -F "from '${needle}" ${REF_SEARCH_ROOTS.join(' ')}`;
    const { n, out } = countRefs(deps.run, cmd, undefined);
    checks.push({
      name: CHECK_REF_COUNT,
      ok: n === 0,
      detail: Number.isNaN(n) ? `ugrep 出错: ${out}` : `依赖 "${needle}" 的 import 边计数 = ${n}\n${out}`,
    });
    return done();
  }

  // 死文件 / 死导出 / 死类型: 全仓字面词计数 (-w 抓 `await import('./x')` 这类动态引用)。
  const refCmd = `ugrep -r -l -w -F "${needle}" ${REF_SEARCH_ROOTS.join(' ')}`;
  const { n, out } = countRefs(deps.run, refCmd, item.path);
  checks.push({
    name: CHECK_REF_COUNT,
    ok: n === 0,
    detail: Number.isNaN(n)
      ? `ugrep 出错: ${out}`
      : `"${needle}" 在 ${REF_SEARCH_ROOTS.join(' ')} 的引用计数 = ${n} (已排除自身)\n${out}`,
  });

  // package.json 白名单核: 死文件看 `files`, 死导出/类型看 `exports`。
  const pkg = deps.run(`ugrep -c -F "${needle}" package.json`);
  const pkgHits = Number.parseInt(pkg.out.trim().split('\n')[0] ?? '0', 10);
  const inPkg = Number.isFinite(pkgHits) && pkgHits > 0;
  checks.push({
    name: CHECK_PKG_ALLOWLIST,
    ok: !inPkg,
    detail: inPkg
      ? `"${needle}" 出现在 package.json (exports / files 白名单) — 对外接口不许当死件删`
      : `"${needle}" 不在 package.json`,
  });
  return done();
}

/** 一批提议 → 只留 confirmed 的施工清单 (D-4「只有过双核的 delete 才进施工清单」)。 */
export function buildWorkList(
  verdicts: RefuteVerdict[],
  items: Map<string, HygieneItem>,
): { confirmed: RefuteVerdict[]; refuted: RefuteVerdict[]; files: string[] } {
  const confirmed = verdicts.filter((v) => v.verdict === 'confirmed');
  const refuted = verdicts.filter((v) => v.verdict === 'refuted');
  const files = [
    ...new Set(confirmed.map((v) => items.get(v.itemId)?.path).filter((p): p is string => Boolean(p))),
  ].sort();
  return { confirmed, refuted, files };
}
