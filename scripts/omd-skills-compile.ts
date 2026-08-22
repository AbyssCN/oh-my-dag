#!/usr/bin/env bun
/**
 * scripts/omd-skills-compile —— skills → 引擎件编译 CLI (SDD 2026-07-25 S3, /omd-skills 的干活层)。
 *
 * 用法:
 *   bun run scripts/omd-skills-compile.ts --suggest                 # 全池分类列候选 (零 LLM 零写盘)
 *   bun run scripts/omd-skills-compile.ts impeccable dataviz ...    # 显式点名编译 (CMP-4 opt-in)
 *   选项: --root <repoRoot> (缺省 cwd) · --skills-dir <dir> (缺省 $CLAUDE_CONFIG_DIR|~/.claude/skills)
 *         · --model <coord> (缺省 role 'conductor' — plan 是 TUI 审议座舱专属角色, headless 不用)
 *         · --as card|recipe (显式分类覆盖 — 带辅助脚本的 craft skill 被脚本优先规则误收时用)
 */
import '../src/harness/script-bootstrap';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { callModel } from '../src/model';
import { resolveRoleModel } from '../src/model/role-models';
import { DISTILL_SCHEMA, compileSkills, suggestSkills, type Distilled } from '../src/harness/skills/compile';

const flags: Record<string, string> = {};
const names: string[] = [];
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a === '--suggest' || a === '--help') flags[a.slice(2)] = 'true';
  else if (a.startsWith('--')) flags[a.slice(2)] = av[++i] ?? '';
  else names.push(a);
}

const root = flags.root ?? process.cwd();
const skillsRoot = flags['skills-dir'] ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills');

if (flags.help || (!flags.suggest && names.length === 0)) {
  console.log('usage: omd-skills-compile (--suggest | <skill-name>...) [--root dir] [--skills-dir dir] [--model coord]');
  process.exit(flags.help ? 0 : 1);
}

if (flags.suggest) {
  const entries = suggestSkills({ root, skillsRoot });
  const by = (k: string) => entries.filter((e) => e.kind === k);
  console.log(`# skills 编译候选 (${skillsRoot})\n`);
  console.log(`## craft 候选 (${by('craft').length} — 蒸馏成卡)`);
  for (const e of by('craft')) console.log(`  ${e.cached ? '[已编译]' : '        '} ${e.name} — ${e.description}`);
  console.log(`\n## 能力型 (${by('capability').length} — 提配方)`);
  for (const e of by('capability')) console.log(`  ${e.cached ? '[已编译]' : '        '} ${e.name} — ${e.detail}`);
  console.log(`\n## 跳过 (${by('skip').length} — 宿主依赖)`);
  for (const e of by('skip')) console.log(`           ${e.name} — ${e.detail}`);
  process.exit(0);
}

bootstrapModelRuntime();
const model = flags.model ?? resolveRoleModel('conductor');

const distill = async (prompt: string): Promise<Distilled> => {
  const res = await callModel({
    model,
    messages: [{ role: 'user', content: prompt }],
    responseSchema: DISTILL_SCHEMA,
    temperature: 0.2,
  });
  return res.parsed as Distilled;
};

const as = flags.as === 'card' || flags.as === 'recipe' ? flags.as : undefined;
if (flags.as && !as) {
  console.error(`--as 只认 card|recipe, 收到: ${flags.as}`);
  process.exit(1);
}
const results = await compileSkills(names, { root, skillsRoot, distill, ...(as ? { as } : {}) });
let failed = 0;
for (const r of results) {
  if (r.status === 'card' || r.status === 'recipe') console.log(`✓ ${r.name} → ${r.status} ${r.path}`);
  else if (r.status === 'cached') console.log(`= ${r.name} 未变 (source_hash 一致) ${r.path}`);
  else if (r.status === 'skip') console.log(`- ${r.name} 跳过: ${r.reason}`);
  else {
    console.log(`✗ ${r.name} 失败: ${r.reason}`);
    failed++;
  }
}
process.exit(failed > 0 ? 1 : 0);
