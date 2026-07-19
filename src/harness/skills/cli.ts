/**
 * src/harness/skills/cli — `omd skill` 子命令 (Phase 1 step 3)。
 *
 *   bun src/harness/skills/cli.ts status              扫 root → 影子表 → 打印技能态
 *   bun src/harness/skills/cli.ts set-dmi <name> on    外科设 disable-model-invocation
 *   bun src/harness/skills/cli.ts tidy [--apply]       守护报告 (core 误藏 / 长尾可藏候选)
 *   bun src/harness/skills/cli.ts umbrella [--write p]  生成 prompt-level 路由伞
 *
 * **root 解析** (R6 ③ 防误伤全局): `--root <dir>` > env OMD_SKILLS_ROOT > 默认 repo `.claude/skills`。
 * 要动全局必须显式 `--root ~/.claude/skills` 或 set env, 默认永远是 repo-local 安全目录。
 */
import { resolve, join, dirname } from 'node:path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { SkillRegistry, type EvolutionEventType } from './registry';
import { scanSkillsDir, syncSkillsToRegistry } from './scanner';
import { isResidentSkill } from './bundle';
import { setDmiInFile, skillMdPath, readDmi } from './dmi';
import { buildUmbrella } from './umbrella';
import { exportBundle } from './export';
import { suggestActions } from './action-driver';
import { buildTriggerEvalSet } from './eval-set';
import { splitFrontmatter } from './scanner';
import { curateSkills } from './skill-curator-adapter';

/** 持久 substrate 路径: --db > env OMD_SKILL_DB > 默认 .omd/skills.db。 */
function resolveDbPath(args: string[]): string {
  return resolve(getFlag(args, '--db') ?? process.env.OMD_SKILL_DB ?? '.omd/skills.db');
}

/** 打开持久 registry 并先把 skills root 同步进去 (record-event/suggest 需要 skill 已在库)。 */
function openSyncedRegistry(args: string[]): SkillRegistry {
  const dbPath = resolveDbPath(args);
  mkdirSync(dirname(dbPath), { recursive: true });
  const reg = new SkillRegistry({ path: dbPath });
  syncSkillsToRegistry(resolveRoot(args), { registry: reg });
  return reg;
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function resolveRoot(args: string[]): string {
  const raw = getFlag(args, '--root') ?? process.env.OMD_SKILLS_ROOT ?? '.claude/skills';
  return resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
}

function parseOnOff(v: string | undefined): boolean | null {
  if (v == null) return null;
  if (['on', '1', 'true', 'yes'].includes(v.toLowerCase())) return true;
  if (['off', '0', 'false', 'no'].includes(v.toLowerCase())) return false;
  return null;
}

function cmdStatus(args: string[]): number {
  const root = resolveRoot(args);
  const reg = new SkillRegistry(); // :memory: — 每次扫盘, 不留 stale
  const rep = syncSkillsToRegistry(root, { registry: reg });
  const rows = reg.listSkills();
  process.stdout.write(`\nskills root: ${root}\n`);
  process.stdout.write(`scanned ${rep.scanned} · core ${rep.core} · hidden ${rows.filter((r) => r.dmi === 1).length}\n\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${pad('NAME', 18)}${pad('TIER', 12)}${pad('DMI', 6)}${pad('BODY', 6)}EVAL\n`);
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.name, 18)}${pad(r.tier, 12)}${pad(r.dmi ? 'hidden' : 'shown', 6)}${pad(r.has_body ? 'y' : '-', 6)}${r.has_eval ? 'y' : '-'}\n`,
    );
  }
  if (rep.errors.length) {
    process.stderr.write(`\n⚠️ ${rep.errors.length} parse error(s):\n`);
    for (const e of rep.errors) process.stderr.write(`  ${e.dir}: ${e.reason}\n`);
  }
  reg.close();
  return 0;
}

function cmdSetDmi(args: string[]): number {
  const name = args[1];
  const value = parseOnOff(args[2]);
  if (!name || value == null) {
    process.stderr.write('usage: set-dmi <name> <on|off>\n');
    return 2;
  }
  if (value === true && isResidentSkill(name)) {
    process.stderr.write(`✗ '${name}' 是 resident 常驻成员, 拒绝 disable (Smart Zone 契约: resident 永远进 prompt)。\n`);
    return 1;
  }
  const root = resolveRoot(args);
  const path = skillMdPath(root, name);
  if (!path) {
    process.stderr.write(`✗ 未找到 ${root}/${name}/SKILL.md\n`);
    return 1;
  }
  const res = setDmiInFile(path, value);
  process.stdout.write(`${name}: disable-model-invocation → ${value} [${res}] (${path})\n`);
  return res === 'no-frontmatter' ? 1 : 0;
}

function cmdTidy(args: string[]): number {
  const root = resolveRoot(args);
  const apply = hasFlag(args, '--apply');
  const { skills, errors } = scanSkillsDir(root);

  // (a) core 被误藏 (磁盘上 disable-model-invocation:true 但属 core) → 违约
  const coreViolations: string[] = [];
  // (b) 长尾可藏候选 (非 core 且当前 shown) → 提示可 set-dmi 省 token
  const hideCandidates: string[] = [];
  for (const s of skills) {
    const path = skillMdPath(root, s.name)!;
    const onDisk = readDmi(path);
    if (isResidentSkill(s.name) && onDisk) coreViolations.push(s.name);
    if (!isResidentSkill(s.name) && !onDisk) hideCandidates.push(s.name);
  }

  process.stdout.write(`\ntidy report (root: ${root})\n`);
  process.stdout.write(`  core violations (误藏, 应 shown): ${coreViolations.length ? coreViolations.join(', ') : '无'}\n`);
  process.stdout.write(`  hide candidates (非 core, 当前 shown): ${hideCandidates.length}\n`);
  if (hideCandidates.length) process.stdout.write(`    ${hideCandidates.join(', ')}\n`);
  if (errors.length) process.stderr.write(`  ⚠️ ${errors.length} parse error(s)\n`);

  if (apply) {
    // 仅修违约 (把误藏的 core 设回 shown) — **不**自动藏长尾 (藏=有损可发现性, 留人决策)
    let fixed = 0;
    for (const name of coreViolations) {
      const path = skillMdPath(root, name)!;
      if (setDmiInFile(path, false) === 'changed') fixed++;
    }
    process.stdout.write(`  --apply: 修复 ${fixed} 个 core 违约 (长尾隐藏不自动改, 用 set-dmi 手动)。\n`);
  } else {
    process.stdout.write(`  (dry-run; --apply 修 core 违约。长尾隐藏请显式 set-dmi <name> on)\n`);
  }
  return 0;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function cmdExport(args: string[]): number {
  const out = getFlag(args, '--out');
  if (!out) {
    process.stderr.write('usage: export --out <dir> [--dry-run] [--root <skills dir>]\n');
    return 2;
  }
  const root = resolveRoot(args);
  const dryRun = hasFlag(args, '--dry-run');
  const rep = exportBundle({ skillsRoot: root, outDir: out, dryRun });
  process.stdout.write(`\n${dryRun ? '[dry-run] ' : ''}export → ${rep.outDir}\n`);
  for (const s of rep.skills) {
    process.stdout.write(`  ${s.name.padEnd(16)} ${String(s.files).padStart(3)} files  ${fmtBytes(s.bytes)}\n`);
  }
  process.stdout.write(`  total: ${rep.skills.length} skills · ${fmtBytes(rep.totalBytes)}\n`);
  if (rep.missing.length) process.stderr.write(`  ⚠️ 缺失 (源盘无): ${rep.missing.join(', ')}\n`);
  if (!dryRun) process.stdout.write(`  wrote ${rep.wrote.length} path(s) (skills/ + substrate/ + umbrella/manifest/README)\n`);
  return rep.missing.length ? 1 : 0;
}

const EVENT_TYPES: EvolutionEventType[] = [
  'route_hit', 'held_out_delta', 'grounded_label', 'dmi_change', 'version_bump',
  'description_trigger_delta', 'eval_fixture_generated',
];

function cmdRecordEvent(args: string[]): number {
  const name = args[1];
  const type = args[2] as EvolutionEventType;
  if (!name || !type || !EVENT_TYPES.includes(type)) {
    process.stderr.write(`usage: record-event <skill> <${EVENT_TYPES.join('|')}> [delta] [--metadata '<json>']\n`);
    return 2;
  }
  const delta = args[3] && !args[3].startsWith('--') ? Number(args[3]) : undefined;
  if (delta !== undefined && Number.isNaN(delta)) {
    process.stderr.write(`✗ delta 非数: ${args[3]}\n`);
    return 2;
  }
  const metaRaw = getFlag(args, '--metadata');
  let metadata: unknown;
  if (metaRaw) {
    try { metadata = JSON.parse(metaRaw); } catch { process.stderr.write(`✗ --metadata 非合法 JSON\n`); return 2; }
  }
  const reg = openSyncedRegistry(args);
  const s = reg.getSkill(name);
  if (!s) { process.stderr.write(`✗ 未知 skill: ${name}\n`); reg.close(); return 1; }
  reg.recordEvent(s.id, type, delta, metadata);
  process.stdout.write(`${name}: +${type}${delta !== undefined ? ` delta=${delta}` : ''} → ${resolveDbPath(args)}\n`);
  reg.close();
  return 0;
}

function cmdSuggestActions(args: string[]): number {
  const reg = openSyncedRegistry(args);
  const actions = suggestActions(reg);
  if (hasFlag(args, '--json')) {
    process.stdout.write(JSON.stringify(actions, null, 2) + '\n');
  } else if (actions.length === 0) {
    process.stdout.write('\n无建议 — 所有 skill 健康 (无退化/无高频缺 eval/无陈旧)。\n');
  } else {
    process.stdout.write(`\n${actions.length} 条建议 (源自 substrate 数据, 非 LLM 猜):\n`);
    for (const a of actions) process.stdout.write(`  [${a.kind}] ${a.skill} — ${a.reason}\n`);
  }
  reg.close();
  return 0;
}

function cmdCheckUpstream(args: string[]): number {
  const name = args[1];
  if (!name) { process.stderr.write('usage: check-upstream <skill> [--root <dir>]\n'); return 2; }
  const provPath = join(resolveRoot(args), name, 'provenance.json');
  if (!existsSync(provPath)) {
    process.stdout.write(`${name}: 无 provenance.json → 视为第一方 omd skill (无上游可比)。\n`);
    return 0;
  }
  let prov: { upstream_repo?: string; upstream_path?: string; upstream_commit?: string | null; upstream_head_seen?: string | null; last_checked?: string };
  try { prov = JSON.parse(readFileSync(provPath, 'utf8')); } catch { process.stderr.write(`✗ provenance.json 非法 JSON\n`); return 1; }
  process.stdout.write(
    `\n${name} provenance:\n` +
    `  upstream: ${prov.upstream_repo ?? '?'}/${prov.upstream_path ?? '?'}\n` +
    `  vendored commit: ${prov.upstream_commit ?? '未知'}\n` +
    `  head seen: ${prov.upstream_head_seen ?? '未记录'}${prov.last_checked ? ` (@ ${prov.last_checked})` : ''}\n`,
  );
  if (!prov.upstream_commit) {
    process.stdout.write(
      `  ⚠ vendored commit 未知 → 无法精确 ahead/behind; 已知落后 (body diff)。\n` +
      `  实时比对: gh api repos/${prov.upstream_repo}/commits?path=${prov.upstream_path}&per_page=1 拿当前 HEAD, 对比上方 head seen。\n`,
    );
  } else {
    process.stdout.write(`  比对: gh api repos/${prov.upstream_repo}/commits?path=${prov.upstream_path} 看 vendored commit 之后是否有 newer。\n`);
  }
  return 0;
}

function cmdEvalGenerate(args: string[]): number {
  const name = args[1];
  if (!name) { process.stderr.write('usage: eval-generate <skill> [--root <dir>] [--db <path>]\n'); return 2; }
  const mdPath = skillMdPath(resolveRoot(args), name);
  if (!mdPath) { process.stderr.write(`✗ 未找到 ${resolveRoot(args)}/${name}/SKILL.md\n`); return 1; }
  const { fm } = splitFrontmatter(readFileSync(mdPath, 'utf8'));
  const desc = typeof fm.description === 'string' ? fm.description : '';
  const evalSet = buildTriggerEvalSet(desc);
  if (evalSet.length === 0) {
    process.stderr.write(`✗ ${name} description 无 Trigger:/Skip: 段 → 无法自动起草 (手写 evals/trigger-eval.json)\n`);
    return 1;
  }
  // 写 eval-set 文件 (run_eval.py 吃) + 落 skill_examples + 留 eval_fixture_generated 痕。
  const evalDir = join(dirname(mdPath), 'evals');
  mkdirSync(evalDir, { recursive: true });
  const evalSetPath = join(evalDir, 'trigger-eval.json');
  writeFileSync(evalSetPath, JSON.stringify(evalSet, null, 2) + '\n', 'utf8');

  const reg = openSyncedRegistry(args);
  const s = reg.getSkill(name);
  if (s) {
    const examples = evalSet.map((e) => ({ query: e.query, label: (e.should_trigger ? 'positive' : 'negative') as 'positive' | 'negative' }));
    const added = reg.upsertSkillExamples(s.id, examples);
    reg.recordEvent(s.id, 'eval_fixture_generated', evalSet.length, { positive: evalSet.filter((e) => e.should_trigger).length, negative: evalSet.filter((e) => !e.should_trigger).length });
    process.stdout.write(`✓ ${name}: ${evalSet.length} 查询 (${evalSet.filter((e) => e.should_trigger).length}+/${evalSet.filter((e) => !e.should_trigger).length}-) → ${evalSetPath}\n  skill_examples +${added}\n`);
  } else {
    process.stdout.write(`✓ ${name}: eval-set → ${evalSetPath} (skill 未在 registry, 跳过 examples 落库)\n`);
  }
  reg.close();
  return 0;
}

function cmdEvalRun(args: string[]): number {
  const name = args[1];
  if (!name) { process.stderr.write('usage: eval-run <skill> [--root <dir>]\n'); return 2; }
  const sink = join(resolveRoot(args), 'skill-creator', 'eval_sink.py');
  if (!existsSync(sink)) {
    process.stderr.write(`✗ 未找到 ${sink} (skill-creator eval_sink.py 缺失)\n`);
    return 1;
  }
  // 薄包装: 把 description trigger eval 委派给官方 run_eval.py, sink 抽 delta 后回调 record-event。
  process.stdout.write(`eval-run ${name}: 委派 eval_sink.py → 官方 run_eval.py (description trigger eval)\n`);
  const proc = Bun.spawnSync(['python3', sink, '--skill', name, '--root', resolveRoot(args), '--db', resolveDbPath(args)], {
    stdout: 'inherit', stderr: 'inherit',
  });
  return proc.exitCode ?? 1;
}

async function cmdCurate(args: string[]): Promise<number> {
  const apply = hasFlag(args, '--apply');
  const reg = openSyncedRegistry(args);
  const res = await curateSkills(reg, { dryRun: !apply });
  const dedup = res.reducers.find((r) => r.kind === 'DEDUP')!;
  const prune = res.reducers.find((r) => r.kind === 'PRUNE')!;
  process.stdout.write(`\n${apply ? '' : '[dry-run] '}curate skills (DEDUP + PRUNE, core/rare 豁免)\n`);
  process.stdout.write(`  DEDUP: ${dedup.skipped ? `skipped (${dedup.reason})` : `${dedup.tombstoned} 近义删`}\n`);
  process.stdout.write(`  PRUNE: ${prune.tombstoned} 陈旧删\n`);
  process.stdout.write(`  shrink: ${res.shrink.count_in}→${res.shrink.count_out} skills · ${res.shrink.bytes_in}→${res.shrink.bytes_out} B (held=${res.shrink.held})\n`);
  if (res.tombstonedIds.length) {
    process.stdout.write(`  tombstoned: ${res.tombstonedIds.join(', ')}\n`);
  }
  process.stdout.write(apply ? `  ✓ 已落 substrate (可 restore 回退)\n` : `  (dry-run; --apply 才真 tombstone)\n`);
  reg.close();
  return 0;
}

function cmdUmbrella(args: string[]): number {
  const root = resolveRoot(args);
  const reg = new SkillRegistry();
  syncSkillsToRegistry(root, { registry: reg });
  const body = buildUmbrella(reg);
  const out = getFlag(args, '--write');
  if (out) {
    writeFileSync(resolve(out), body, 'utf8');
    process.stdout.write(`umbrella written → ${resolve(out)}\n`);
  } else {
    process.stdout.write(body + '\n');
  }
  reg.close();
  return 0;
}

export function runCli(argv: string[]): number | Promise<number> {
  const [cmd, ...rest] = argv;
  const args = [cmd ?? '', ...rest];
  switch (cmd) {
    case 'status': return cmdStatus(args);
    case 'set-dmi': return cmdSetDmi(args);
    case 'tidy': return cmdTidy(args);
    case 'umbrella': return cmdUmbrella(args);
    case 'export': return cmdExport(args);
    case 'record-event': return cmdRecordEvent(args);
    case 'suggest-actions': return cmdSuggestActions(args);
    case 'eval-generate': return cmdEvalGenerate(args);
    case 'eval-run': return cmdEvalRun(args);
    case 'check-upstream': return cmdCheckUpstream(args);
    case 'curate': return cmdCurate(args);
    default:
      process.stderr.write('usage: omd skill <status|set-dmi|tidy|umbrella|export|record-event|suggest-actions|eval-generate|eval-run|check-upstream|curate> [--root <dir>] [--db <path>]\n');
      return 2;
  }
}

if (import.meta.main) {
  Promise.resolve(runCli(process.argv.slice(2))).then((code) => process.exit(code));
}
