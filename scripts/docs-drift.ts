#!/usr/bin/env bun
/**
 * scripts/docs-drift —— D-5 docs-drift 跑法: `/omd-docs-drift` skill 的三步之二(plan/apply,
 * 见 `client-skills/omd-docs-drift/SKILL.md`; 中间那步 dag_run 派 Sonnet 座在本脚本之外——本
 * 文件不跑 LLM, 只做纯核编排 + I/O)。`docs/plan/2026-08-11-docs-drift.md` 的 D-3/D-4/D-5。
 *
 * 三条子命令:
 *
 *   bun run scripts/docs-drift.ts init                       # 打基线 stamp = 当前 HEAD
 *   bun run scripts/docs-drift.ts plan [--since <ref>]        # 打印待审 DriftAuditTask[] JSON
 *   bun run scripts/docs-drift.ts apply --results <file> --run-id <id> [--slug <slug>]
 *
 * stamp 落在 `.dev/docs-drift-stamp`(git 跟踪, 盘上记的是「上次审计的 commit sha」——D-3 原文
 * 「盘上记 commit」)。init 只在**没有 stamp 时**写基线; plan 只读不写(反复跑 plan 不该悄悄
 * 挪基线); stamp 只在 apply **成功跑完**之后挪到 HEAD —— 挪早了会漏审 plan 与 apply 之间
 * 落地的改动 (谁在这窗口里改了 docs-map 覆盖源, 下一轮就再也照不到)。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDriftAuditPlan, buildSuggestionDrafts, type DriftAuditLeafResult } from '../src/harness/docs/drift-audit';
import { parseDocsMap } from '../src/harness/docs/drift-map';
import { resolveBackend } from '../src/harness/pathfinder/backend';

const ROOT = new URL('..', import.meta.url).pathname;
const STAMP_PATH = join(ROOT, '.dev', 'docs-drift-stamp');
const DOCS_MAP_PATH = join(ROOT, 'docs', 'docs-map.md');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readStamp(): string | null {
  return existsSync(STAMP_PATH) ? readFileSync(STAMP_PATH, 'utf8').trim() : null;
}

function writeStamp(sha: string): void {
  writeFileSync(STAMP_PATH, `${sha}\n`);
}

function readDocsMapRows() {
  return parseDocsMap(readFileSync(DOCS_MAP_PATH, 'utf8'));
}

/** slug 未显式给 → 恰一张开放地图用它, 零/多张报错列 slug (同 `src/mcp/tools/pathfinder.ts` 的 resolveSlug 口径)。 */
function resolveSlug(backend: ReturnType<typeof resolveBackend>, slug: string | undefined): string {
  if (slug) return slug;
  const maps = backend.listMaps(ROOT);
  if (maps.length === 0) throw new Error('没有开放地图 — 先 `path_map <destination>` 建一张');
  if (maps.length > 1) throw new Error(`多张开放地图, 需显式 --slug: ${maps.map((m) => m.slug).join(', ')}`);
  return maps[0]!.slug;
}

function cmdInit(): number {
  if (readStamp()) {
    console.log(`[docs-drift] 已有 stamp (${readStamp()}) —— init 不覆盖既有基线, 想重打先手动删 ${STAMP_PATH}`);
    return 1;
  }
  const head = git(['rev-parse', 'HEAD']);
  writeStamp(head);
  console.log(`[docs-drift] 基线 stamp = ${head}`);
  return 0;
}

function cmdPlan(argv: string[]): number {
  const sinceIdx = argv.indexOf('--since');
  const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : readStamp();
  if (!since) {
    console.log('[docs-drift] 没有 stamp 也没给 --since —— 先 `bun run scripts/docs-drift.ts init` 打基线; 本轮零任务 (NULL≠0: 不是漏审, 是没有可比较的过去)。');
    console.log(JSON.stringify([]));
    return 0;
  }
  const changedFiles = git(['diff', '--name-only', `${since}..HEAD`])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = readDocsMapRows();
  const tasks = buildDriftAuditPlan(rows, changedFiles);
  console.error(`[docs-drift] ${since}..HEAD: ${changedFiles.length} 个变更文件, ${rows.length} 行 docs-map, ${tasks.length} 条待审对`);
  console.log(JSON.stringify(tasks, null, 2));
  return 0;
}

async function cmdApply(argv: string[]): Promise<number> {
  const resultsIdx = argv.indexOf('--results');
  const runIdIdx = argv.indexOf('--run-id');
  const slugIdx = argv.indexOf('--slug');
  const resultsPath = resultsIdx >= 0 ? argv[resultsIdx + 1] : undefined;
  const runId = runIdIdx >= 0 ? argv[runIdIdx + 1] : undefined;
  const slugArg = slugIdx >= 0 ? argv[slugIdx + 1] : undefined;
  if (!resultsPath || !runId) {
    console.error('usage: docs-drift apply --results <file> --run-id <id> [--slug <slug>]');
    return 1;
  }

  const leafResults = JSON.parse(readFileSync(resultsPath, 'utf8')) as DriftAuditLeafResult[];
  const found = leafResults.filter((r) => r.driftFound).length;
  const clean = leafResults.length - found;
  console.error(`[docs-drift] ${leafResults.length} 条叶结果: ${found} 条判出漂移, ${clean} 条明确「未见漂移」`);

  const { drafts, downgraded } = await buildSuggestionDrafts(leafResults, { runId, cwd: ROOT });

  if (downgraded.length > 0) {
    console.error(`[docs-drift] ${downgraded.length} 条 finding 被反幻觉闸降级(幻觉锚/无锚), 不落票 —— 留痕不吞:`);
    for (const d of downgraded) console.error(`  · ${JSON.stringify(d)}`);
  }

  if (drafts.length === 0) {
    console.log('[docs-drift] 零合法漂移 finding —— 零票。');
  } else {
    const backend = resolveBackend(ROOT);
    const slug = resolveSlug(backend, slugArg);
    if (!backend.suggest) throw new Error(`后端 "${backend.kind}" 不支持 suggest — 落不了票`);
    const result = backend.suggest(ROOT, slug, drafts, { at: new Date().toISOString() });
    console.log(`[docs-drift] ${slug}: ${result.summary}`);
  }

  const head = git(['rev-parse', 'HEAD']);
  writeStamp(head);
  console.log(`[docs-drift] stamp 挪到 ${head}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'plan':
      return cmdPlan(rest);
    case 'apply':
      return cmdApply(rest);
    default:
      console.error('usage: docs-drift <init|plan|apply> ...\n  init                                       打基线 stamp\n  plan [--since <ref>]                       打印待审 DriftAuditTask[] JSON\n  apply --results <file> --run-id <id> [--slug <slug>]   落 suggested 票 + 挪 stamp');
      return 1;
  }
}

if (import.meta.main) process.exit(await main());
