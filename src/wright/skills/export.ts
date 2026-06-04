/**
 * src/wright/skills/export — 把 13 core bundle 物化进开源 repo 结构 (Phase 1 收尾)。
 *
 * 按 BUNDLE_LAYOUT 产出一棵可直接 `git init && publish` 的目录:
 *   <out>/skills/<name>/        ← .claude/skills/<name>/ 整目录递归拷 (SKILL.md + scripts/assets/evals)
 *   <out>/substrate/schema.sql  ← registry.ts 实际建的表 DDL (从 :memory: dump = 真理源, 不手抄)
 *   <out>/substrate/gene-library.json ← 复利 substrate 的初始基因 (若存在)
 *   <out>/umbrella.md           ← prompt-level 长尾路由伞 (buildUmbrella)
 *   <out>/manifest.json         ← 机读清单 (scanner 影子元数据快照)
 *   <out>/README.md             ← 人读 bundle 介绍 + 安装说明
 *
 * **真理源不重复**: schema 从 registry 实例 dump (改 registry.ts → 导出自动跟随); skill 清单从
 * scanner 扫盘 (改 bundle.ts/SKILL.md → 自动跟随)。导出器零硬编码 schema/清单。
 *
 * dryRun: 只算不写盘 (报告文件数/字节), 给 the owner 预览导出规模。
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SkillRegistry, type SkillRow } from './registry';
import { syncSkillsToRegistry } from './scanner';
import { CORE_BUNDLE, BUNDLE_LAYOUT, type BundleLayout } from './bundle';
import { buildUmbrella } from './umbrella';

/** 永不导出的目录名 (即使 skill 目录里出现也跳过)。含 dev-research 物料 (runs/outputs) + 编译缓存。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.DS_Store', 'runs', 'outputs', '__pycache__']);

/**
 * 段名级排除判定 (walkStats + copyFilter 共用同一 predicate, 防两处过滤漂移)。
 * 除 EXCLUDE_DIRS 外, 排 `autoresearch-*` 前缀 (dev-research 物料, 含真实事故 inputs/runs) +
 * `.baseline` 后缀 (skill 调优基线快照) —— 这些是 dev 内部物料, 绝不进开源 bundle。
 */
function isExcludedSeg(seg: string): boolean {
  return EXCLUDE_DIRS.has(seg) || seg.startsWith('autoresearch-') || seg.endsWith('.baseline');
}

/** 开源泄漏模式: 个人/内部值, 命中即不该进开源 bundle (pre-export lint 门扫这些)。 */
const LEAK_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'Nick (real name)', re: /\bNick\b/ },
  { label: 'talous (private project)', re: /talous|taloussk/i },
  { label: 'vercel preview URL', re: /vercel\.app/i },
  { label: 'Windows talous path', re: /c--Talous|c:[\\/]worktrees/i },
  { label: '$USERPROFILE', re: /\$USERPROFILE/ },
];

/** 递归扫 dir 下 *.md 正文找泄漏 (跳排除段)。返 "相对路径: 命中标签" 列表。 */
function scanLeaks(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (isExcludedSeg(entry)) continue;
    const p = join(dir, entry);
    const r = rel ? `${rel}/${entry}` : entry;
    if (statSync(p).isDirectory()) {
      out.push(...scanLeaks(p, r));
    } else if (entry.endsWith('.md')) {
      const hits = LEAK_PATTERNS.filter((lp) => lp.re.test(readFileSync(p, 'utf8'))).map((lp) => lp.label);
      if (hits.length) out.push(`${r}: ${hits.join(', ')}`);
    }
  }
  return out;
}

export interface ExportOptions {
  /** skill 源目录 (默认 repo `.claude/skills`)。 */
  skillsRoot: string;
  /** 输出 repo 根目录。 */
  outDir: string;
  /** 布局契约 (默认 BUNDLE_LAYOUT)。 */
  layout?: BundleLayout;
  /** gene-library.json 源路径 (默认 repo `.claude/knowledge/genes/gene-library.json`)。 */
  geneLibraryPath?: string;
  /** 只算不写。 */
  dryRun?: boolean;
  /** 跳过 pre-export 泄漏 lint 门 (dev 调试用; 默认 false = 命中个人/内部值硬阻断)。 */
  allowLeaks?: boolean;
}

export interface SkillExportStat {
  name: string;
  files: number;
  bytes: number;
}

export interface ExportReport {
  outDir: string;
  skills: SkillExportStat[];
  missing: string[];           // CORE_BUNDLE 里源盘缺失的
  totalBytes: number;
  wrote: string[];             // 实际写出的 (非 dryRun)
  dryRun: boolean;
  leaks: string[];             // pre-export lint 命中的个人/内部值 ("skill/file: 标签")
}

/** 递归数文件 + 字节 (跳 EXCLUDE_DIRS), 不读内容。 */
function walkStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir)) {
    if (isExcludedSeg(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      const sub = walkStats(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files++;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

/** cpSync 的 filter: 命中排除段 (EXCLUDE_DIRS / autoresearch-* / .baseline) 则不拷。与 walkStats 共用 predicate。 */
function copyFilter(src: string): boolean {
  return !src.split(sep).some(isExcludedSeg);
}

/** schema 真理源: 实例化 :memory: registry, dump 实际建出的 DDL。 */
export function dumpSchema(): string {
  const reg = new SkillRegistry();
  // 排除 sqlite 内部对象 (sqlite_sequence) + FTS5 影子表 (genes_fts_data/idx/content/...);
  // 后者由 `CREATE VIRTUAL TABLE genes_fts` replay 时自动重建, 手抄进 schema.sql 会冲突。
  const rows = reg.db
    .query(
      `SELECT sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts_*'
         ORDER BY (type='table') DESC, name`,
    )
    .all() as { sql: string }[];
  reg.close();
  const header =
    '-- wright-skills substrate schema (从 SkillRegistry 实例 dump, 真理源)\n' +
    '-- 改 src/wright/skills/registry.ts 的 CREATE TABLE → 重跑导出自动同步。\n\n';
  return header + rows.map((r) => r.sql.trim() + ';').join('\n\n') + '\n';
}

function buildManifest(rows: SkillRow[], layout: BundleLayout): string {
  const skills = rows
    .filter((r) => r.tier === 'core')
    .map((r) => ({
      name: r.name,
      id: r.id,
      version: r.version,
      tier: r.tier,
      description: r.description,
      has_eval: r.has_eval === 1,
      dir: layout.perSkillDir(r.name),
      // provenance: upstream_repo null = 第一方 wright skill; 非 null = vendored (如 anthropic/skills)。
      origin: r.upstream_repo ?? layout.repo,
      license: r.license,
      upstream_commit: r.upstream_commit,
    }));
  return JSON.stringify(
    {
      repo: layout.repo,
      note: 'machine-readable bundle manifest — 由 src/wright/skills/export.ts 生成, 勿手改',
      skillsRoot: layout.skillsRoot,
      substrateDir: layout.substrateDir,
      umbrella: layout.umbrellaPath,
      count: skills.length,
      skills,
    },
    null,
    2,
  ) + '\n';
}

function buildReadme(rows: SkillRow[], layout: BundleLayout): string {
  const core = rows.filter((r) => r.tier === 'core');
  const lines = core.map((r) => `| \`${r.name}\` | ${(r.description || '').split('.')[0]!.slice(0, 90)} |`);
  return [
    `# ${layout.repo}`,
    '',
    `wright 开源 curated skill bundle —— 一套经机械排除法选出的 **${core.length} 个通用核心技能**,`,
    '配一层 sqlite 复利 substrate。装进任意 Claude Code / pi harness 即用。',
    '',
    '## 内容',
    '',
    `- \`${layout.skillsRoot}/\` — ${core.length} core skill (每个一目录, 含 \`SKILL.md\` + 可选 scripts/evals)`,
    `- \`${layout.substrateDir}/schema.sql\` — 复利 substrate 表结构 (skills/genes/evolution_events + 桥)`,
    `- \`${layout.substrateDir}/gene-library.json\` — 初始修复/优化基因模板`,
    `- \`${layout.umbrellaPath}\` — prompt-level 长尾路由伞 (DMI 隐藏技能的重发现入口)`,
    `- \`manifest.json\` — 机读清单`,
    '',
    '## Core skills',
    '',
    '| skill | 用途 |',
    '|---|---|',
    ...lines,
    '',
    '## 安装',
    '',
    '```bash',
    `# 把 skills/ 下各目录拷进你的 ~/.claude/skills/ 或项目 .claude/skills/`,
    `cp -r ${layout.skillsRoot}/* ~/.claude/skills/`,
    '```',
    '',
    'substrate (`schema.sql` + `gene-library.json`) 供 wright 风格的 skill 进化/复用飞轮使用,',
    '非必需即可用 —— 纯当 skill 包也成立。',
    '',
    '> 生成自 `src/wright/skills/export.ts`。勿手改导出物,改源后重跑导出。',
    '',
  ].join('\n');
}

/**
 * 物化 bundle。幂等 (重跑覆盖同名输出)。返回报告。
 */
export function exportBundle(opts: ExportOptions): ExportReport {
  const layout = opts.layout ?? BUNDLE_LAYOUT;
  const skillsRoot = resolve(opts.skillsRoot);
  const outDir = resolve(opts.outDir);
  const dryRun = opts.dryRun ?? false;
  const geneSrc = opts.geneLibraryPath ?? join(skillsRoot, '..', 'knowledge', 'genes', 'gene-library.json');

  const stats: SkillExportStat[] = [];
  const missing: string[] = [];
  const wrote: string[] = [];
  let totalBytes = 0;

  // 影子表快照 (manifest/umbrella 用) — 扫源盘
  const reg = new SkillRegistry();
  syncSkillsToRegistry(skillsRoot, { registry: reg });

  // pre-export 泄漏 lint 门 (P0): 扫将拷的 *.md, 命中个人/内部值 → 非 allowLeaks 时硬阻断 (绝不静默进开源 repo)。
  // 先扫全量再决定, 让报告完整; dryRun 只报不阻断 (预览)。
  const leaks: string[] = [];
  for (const name of CORE_BUNDLE) {
    const src = join(skillsRoot, name);
    if (!existsSync(join(src, 'SKILL.md'))) continue;
    for (const hit of scanLeaks(src)) leaks.push(`${name}/${hit}`);
  }
  if (leaks.length > 0 && !dryRun && !opts.allowLeaks) {
    reg.close();
    const head = leaks.slice(0, 25).join('\n');
    throw new Error(
      `[export] 拒绝导出: ${leaks.length} 处个人/内部值泄漏 (开源 bundle 不可含)。\n${head}` +
        `${leaks.length > 25 ? `\n…+${leaks.length - 25}` : ''}\n清理源 *.md, 或传 allowLeaks:true 跳过 (仅 dev 调试)。`,
    );
  }

  for (const name of CORE_BUNDLE) {
    const src = join(skillsRoot, name);
    if (!existsSync(join(src, 'SKILL.md'))) {
      missing.push(name);
      continue;
    }
    const s = walkStats(src);
    stats.push({ name, files: s.files, bytes: s.bytes });
    totalBytes += s.bytes;
    if (!dryRun) {
      const dest = join(outDir, layout.perSkillDir(name));
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true, filter: copyFilter });
      // i18n (OSS default = English): the source SKILL.md stays Chinese (the owner's daily harness);
      // a committed SKILL.en.md (English body + bilingual trigger frontmatter) becomes the
      // exported SKILL.md. Collapse to one file so the OSS bundle ships a single SKILL.md.
      const enBody = join(src, 'SKILL.en.md');
      if (existsSync(enBody)) {
        copyFileSync(enBody, join(dest, 'SKILL.md'));
        rmSync(join(dest, 'SKILL.en.md'), { force: true });
      }
      wrote.push(layout.perSkillDir(name) + '/');
    }
  }

  if (!dryRun) {
    // substrate
    const subDir = join(outDir, layout.substrateDir);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'schema.sql'), dumpSchema(), 'utf8');
    wrote.push(`${layout.substrateDir}/schema.sql`);
    if (existsSync(geneSrc)) {
      copyFileSync(geneSrc, join(subDir, 'gene-library.json'));
      wrote.push(`${layout.substrateDir}/gene-library.json`);
    }
    // umbrella (prompt-level) + manifest + README
    writeFileSync(join(outDir, layout.umbrellaPath), buildUmbrella(reg), 'utf8');
    const rows = reg.listSkills();
    writeFileSync(join(outDir, 'manifest.json'), buildManifest(rows, layout), 'utf8');
    // bundle 文档落 skills/README.md (非 outDir 根 README.md) — 不覆盖 repo 项目 README。
    writeFileSync(join(outDir, layout.skillsRoot, 'README.md'), buildReadme(rows, layout), 'utf8');
    wrote.push(layout.umbrellaPath, 'manifest.json', `${layout.skillsRoot}/README.md`);
  }

  reg.close();
  return { outDir, skills: stats, missing, totalBytes, wrote, dryRun, leaks };
}
