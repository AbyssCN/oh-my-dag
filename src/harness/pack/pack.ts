/**
 * src/harness/pack —— omd 数据插件包 (A3, dsh/cordis 吸收计划线 A)。
 *
 * ## 是什么
 *
 * pack = 可分发的**数据插件**集合: agent 模板卡 / playbook / skills (Agent Skills 规范原样,
 * 反向兼容 Claude Code)。分发格式学 dsh bundle 的自描述方式 (`package.json` 里的 `dsh` 字段):
 *
 * ```json
 * { "name": "my-pack", "version": "1.0.0",
 *   "omd": { "pack": { "agents": "./agents", "playbooks": "./playbooks", "skills": "./skills" } } }
 * ```
 *
 * 三键均可选, 值 = 包内相对目录。`omd pack add <本地目录|git URL>` 展开进 `.omd/` 对应层
 * (现有三层叠加机制原样复用 —— 项目层仍最高优先, 本命令只是替你把文件放进项目层并记账)。
 *
 * ⚠ 格式 v0 (experimental): 未经 grill 的对外契约不视为冻结, 破坏性变更前查 `.omd/packs.json`
 * 的 version 字段可迁移。
 *
 * ## 质量闸 (装不进坏包 —— 这是 omd pack 相对 dsh 的差异化)
 *
 * 安装先进 **staging 临时世界** (mkdtemp) 整体校验, 全过才原子拷入:
 *   - playbook: 走真 loadPlaybooks (A-1 有界 / A-2 路径不逃逸 / A-3 判据自证三道闸,
 *     任一不过整包拒) —— **列出来的 playbook 都被证明过判据有判别力**;
 *   - agent 卡: 每个 .md 必须真的装出一张新卡或覆盖一张内置卡 (fail-open 的 loadAgentTemplates
 *     在安装场景升为 fail-loud: 文件数与生效卡数对不上 = 有坏卡 = 拒);
 *   - skills: 每个条目必须是含 SKILL.md 的目录 (Agent Skills 规范)。
 *
 * ## 账本与可逆性
 *
 * `.omd/packs.json` 记录每包的 source/version/文件清单/内容哈希。
 *   - remove: 哈希与安装时一致的文件删除 (byte 级回到装前); 用户改过的保留 + warn (不吞用户的活);
 *   - 重复 add 同内容: no-op (幂等); 内容变了: 视为升级 (旧文件未被用户改过才许替换);
 *   - 冲突: 目标文件存在且不属于本包 → 整包拒, 一个文件都不拷 (原子性)。
 *
 * staging/克隆临时目录的清理走 effect scope (C1 首个生产消费方): 失败路径逆序清干净,
 * "坏包被拒 → .omd/ 无残留" 是测试钉住的判据。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { createEffectScope } from '../../effect';
import { logger } from '../../logger';
import { loadAgentTemplates } from '../agent-templates';
import { loadPlaybooks } from '../playbook/load';

const PACK_SECTIONS = ['agents', 'playbooks', 'skills'] as const;
type PackSection = (typeof PACK_SECTIONS)[number];

const packManifestSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().optional(),
  omd: z.looseObject({
    pack: z.looseObject({
      agents: z.string().optional(),
      playbooks: z.string().optional(),
      skills: z.string().optional(),
    }),
  }),
});

/** `.omd/packs.json` 的账本形状。files 键 = 相对 .omd/ 的路径, 值 = 安装时内容 sha256。 */
interface PackLedger {
  version: 0;
  packs: Record<string, { source: string; version?: string; installedAt: string; files: Record<string, string> }>;
}

export interface PackResult {
  ok: boolean;
  /** 人读回执 (CLI 原样打印)。 */
  message: string;
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

function ledgerPath(cwd: string): string {
  return join(cwd, '.omd', 'packs.json');
}

function readLedger(cwd: string): PackLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8')) as PackLedger;
    if (parsed && typeof parsed === 'object' && parsed.packs) return parsed;
  } catch {
    /* 不存在/坏 = 空账本; 写入时整文件重写 */
  }
  return { version: 0, packs: {} };
}

function writeLedger(cwd: string, ledger: PackLedger): void {
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(ledgerPath(cwd), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** 递归收文件 (相对 base), 排序保证清单确定性。 */
function collectFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

function isGitSource(src: string): boolean {
  return /^(https?:\/\/|git@)/.test(src) || src.endsWith('.git');
}

/**
 * 校验 staging 世界 (镜像 .omd 布局: staging/.omd/{agents,playbooks,skills})。
 * `reject` 非 null = 第一条拒绝理由; 全过时附**知情安装清单** (grill 决策 1, owner 2026-08-17
 * 裁 "add 即信任 + 知情安装": 卡/playbook 是 prompt 载荷, 装了什么至少过一遍人眼)。
 */
function validateStaging(
  staging: string,
  sections: Partial<Record<PackSection, string[]>>,
): { reject: string | null; listing: string[]; cards: { name: string; description: string }[] } {
  const listing: string[] = [];
  const cards: { name: string; description: string }[] = [];
  // playbook: 真 loadPlaybooks, 三道闸任一不过整包拒 (throw 原文即理由)
  if (sections.playbooks?.length) {
    try {
      const all = loadPlaybooks(staging);
      const packNames = new Set(sections.playbooks.map((f) => f.split('/')[0]!));
      for (const name of packNames) {
        const pb = all.get(name);
        if (pb) listing.push(`  playbook: ${name} (${pb.steps.length} 步, 判据已自证) · acceptance: ${pb.acceptance.command}`);
      }
    } catch (err) {
      return { reject: `playbook 校验不过: ${err instanceof Error ? err.message : String(err)}`, listing, cards };
    }
  }
  // agent 卡: 文件数与生效卡数对得上 (装不出的卡 = 坏卡)
  if (sections.agents?.length) {
    const baselineDir = mkdtempSync(join(tmpdir(), 'omd-pack-baseline-'));
    try {
      const baseline = loadAgentTemplates({ root: baselineDir });
      const withPack = loadAgentTemplates({ root: staging });
      const effective: { name: string; description: string }[] = [];
      for (const [name, tpl] of withPack) {
        const base = baseline.get(name);
        if (!base || base.body !== tpl.body || base.description !== tpl.description) {
          effective.push({ name, description: tpl.description });
        }
      }
      const cardFiles = sections.agents.filter((f) => f.endsWith('.md')).length;
      if (effective.length < cardFiles) {
        return { reject: `agent 卡校验不过: ${cardFiles} 个 .md 只装出 ${effective.length} 张有效卡 (坏卡在加载日志里有 warn)`, listing, cards };
      }
      // 卡的知情清单在 addPack 里拼 (那边才知道谁覆盖内置/谁冲突, grill 决策 3)
      cards.push(...effective);
    } finally {
      rmSync(baselineDir, { recursive: true, force: true });
    }
  }
  // skills: 每个顶层条目 = 含 SKILL.md 的目录 (Agent Skills 规范)
  if (sections.skills?.length) {
    const skillsRoot = join(staging, '.omd', 'skills');
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) return { reject: `skills 校验不过: ${entry.name} 不是目录 (规范 = <skill>/SKILL.md)`, listing, cards };
      if (!existsSync(join(skillsRoot, entry.name, 'SKILL.md'))) {
        return { reject: `skills 校验不过: ${entry.name}/ 缺 SKILL.md`, listing, cards };
      }
      listing.push(`  skill: ${entry.name}`);
    }
  }
  return { reject: null, listing, cards };
}

/** `omd pack add <本地目录|git URL>`。全程原子: 校验全过才拷入, 拒绝时 .omd/ 零残留。 */
export async function addPack(cwd: string, source: string): Promise<PackResult> {
  const scope = createEffectScope((m) => logger.warn(m));
  try {
    // ── 取源 (git URL → 浅克隆进临时目录; 本地目录原样) ──────────────────────
    let srcDir = source;
    if (isGitSource(source)) {
      const cloneDir = mkdtempSync(join(tmpdir(), 'omd-pack-clone-'));
      scope.defer(() => rmSync(cloneDir, { recursive: true, force: true }), 'pack-clone');
      const r = spawnSync('git', ['clone', '--depth', '1', source, cloneDir], { encoding: 'utf8' });
      if (r.status !== 0) return { ok: false, message: `git clone 失败: ${(r.stderr || '').trim().slice(0, 400)}` };
      srcDir = cloneDir;
    }
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      return { ok: false, message: `pack 源不存在或不是目录: ${srcDir}` };
    }
    // ── 读自描述 manifest ────────────────────────────────────────────────────
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
    } catch (err) {
      return { ok: false, message: `pack 源缺 package.json 或解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const manifest = packManifestSchema.safeParse(manifestRaw);
    if (!manifest.success) {
      return { ok: false, message: `package.json 不是合法 pack 声明 (要 name + omd.pack 段): ${manifest.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const { name, version } = manifest.data;
    const packDecl = manifest.data.omd.pack;

    // ── staging 世界: 镜像 .omd 布局, 全部校验在这里跑 ───────────────────────
    const staging = mkdtempSync(join(tmpdir(), 'omd-pack-staging-'));
    scope.defer(() => rmSync(staging, { recursive: true, force: true }), 'pack-staging');
    const sections: Partial<Record<PackSection, string[]>> = {};
    const incoming = new Map<string, string>(); // 相对 .omd/ 的路径 → sha256
    for (const section of PACK_SECTIONS) {
      const rel = packDecl[section];
      if (!rel) continue;
      const from = join(srcDir, rel);
      if (!existsSync(from)) return { ok: false, message: `声明的 ${section} 目录不存在: ${rel}` };
      const to = join(staging, '.omd', section);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      const files = collectFiles(to);
      if (files.length === 0) continue;
      sections[section] = files;
      for (const f of files) incoming.set(join(section, f), sha256(readFileSync(join(to, f))));
    }
    if (incoming.size === 0) return { ok: false, message: 'pack 声明的目录全为空 —— 没有可安装内容' };
    const { reject, listing, cards } = validateStaging(staging, sections);
    if (reject) return { ok: false, message: `拒绝安装 ${name}: ${reject}` };
    // 知情安装 (grill 决策 1): 内容总哈希 = 文件清单+逐文件哈希的摘要, 与账本可互验。
    const contentDigest = sha256(JSON.stringify([...incoming].sort())).slice(0, 12);

    // ── 幂等 / 升级 / 冲突判定 (全判完才动盘, 原子性) ─────────────────────────
    const ledger = readLedger(cwd);
    const prior = ledger.packs[name];

    // grill 决策 3 (owner 2026-08-17 裁): 卡 name 来自 frontmatter ≠ 文件名 —— 文件冲突闸
    // 盖不住"不同文件名装同名卡"这个洞 (后到会静默覆盖, S-3 族)。判据:
    //   与项目层手写卡 / 其他包的卡同名 → 整包拒并点名;
    //   覆盖内置卡合法 (模板机制"项目卡覆盖内置"的既有设计意图), 回执标 [覆盖内置]。
    // "他人的卡" = 当前 cwd 的 agents 目录**去掉本包已有文件**后装出的非内置增量。
    if (cards.length > 0) {
      const othersDir = mkdtempSync(join(tmpdir(), 'omd-pack-others-'));
      scope.defer(() => rmSync(othersDir, { recursive: true, force: true }), 'pack-others-view');
      const ownedNow = new Set(Object.keys(prior?.files ?? {}));
      const cwdAgents = join(cwd, '.omd', 'agents');
      if (existsSync(cwdAgents)) {
        const dst = join(othersDir, '.omd', 'agents');
        mkdirSync(dst, { recursive: true });
        for (const f of collectFiles(cwdAgents)) {
          if (ownedNow.has(join('agents', f))) continue;
          mkdirSync(dirname(join(dst, f)), { recursive: true });
          cpSync(join(cwdAgents, f), join(dst, f));
        }
      }
      const baseline = loadAgentTemplates({ root: join(othersDir, 'no-such-subdir') }); // 纯内置
      const others = loadAgentTemplates({ root: othersDir });
      const nameConflicts: string[] = [];
      for (const c of cards) {
        const other = others.get(c.name);
        const b = baseline.get(c.name);
        const isForeignCard = other && (!b || other.body !== b.body || other.description !== b.description);
        if (isForeignCard) nameConflicts.push(c.name);
        listing.push(`  agent 卡: ${c.name}${b ? ' [覆盖内置]' : ''} —— ${c.description}`);
      }
      if (nameConflicts.length > 0) {
        return {
          ok: false,
          message: `拒绝安装 ${name}: 卡名与项目层手写卡或其他已装包冲突 (不同文件名装同名卡会静默覆盖, 不许) —— ${nameConflicts.join(', ')}`,
        };
      }
    }
    if (prior) {
      const same =
        Object.keys(prior.files).length === incoming.size &&
        [...incoming].every(([f, h]) => prior.files[f] === h);
      if (same) return { ok: true, message: `${name} 已安装且内容一致 —— no-op (幂等)` };
      // 升级前置: 旧文件在盘上未被用户改过 (改过 = 拒, 不吞用户的活)
      const dirty = Object.entries(prior.files).filter(([f, h]) => {
        const p = join(cwd, '.omd', f);
        return existsSync(p) && sha256(readFileSync(p)) !== h;
      });
      if (dirty.length > 0) {
        return { ok: false, message: `拒绝升级 ${name}: 以下文件安装后被本地修改过, 不覆盖 —— ${dirty.map(([f]) => f).join(', ')}` };
      }
    }
    const owned = new Set(Object.keys(prior?.files ?? {}));
    const conflicts = [...incoming.keys()].filter((f) => {
      const p = join(cwd, '.omd', f);
      return existsSync(p) && !owned.has(f);
    });
    if (conflicts.length > 0) {
      return { ok: false, message: `拒绝安装 ${name}: 目标已存在且不属于本包 (不覆盖项目层文件) —— ${conflicts.join(', ')}` };
    }

    // ── 提交: 先清旧 (升级), 再拷新, 再记账 ──────────────────────────────────
    for (const f of owned) {
      if (!incoming.has(f)) {
        const p = join(cwd, '.omd', f);
        if (existsSync(p)) unlinkSync(p);
      }
    }
    for (const [f] of incoming) {
      const from = join(staging, '.omd', f);
      const to = join(cwd, '.omd', f);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
    ledger.packs[name] = {
      source,
      ...(version ? { version } : {}),
      installedAt: new Date().toISOString(),
      files: Object.fromEntries(incoming),
    };
    writeLedger(cwd, ledger);
    const counts = PACK_SECTIONS.filter((s) => sections[s]?.length).map((s) => `${s} ${sections[s]!.length}`).join(' · ');
    return {
      ok: true,
      message: [
        `${prior ? '升级' : '安装'} ${name}${version ? `@${version}` : ''}: ${counts} → .omd/ (账: .omd/packs.json)`,
        ...listing,
        `  内容哈希: ${contentDigest} (add 即信任 —— 以上载荷会进 prompt, 过一遍眼)`,
      ].join('\n'),
    };
  } finally {
    await scope.dispose();
  }
}

/** `omd pack remove <name>`。哈希一致的文件删除; 用户改过的保留 + warn。 */
export function removePack(cwd: string, name: string): PackResult {
  const ledger = readLedger(cwd);
  const entry = ledger.packs[name];
  if (!entry) return { ok: false, message: `未安装的 pack: ${name} (已装: ${Object.keys(ledger.packs).join(', ') || '无'})` };
  const kept: string[] = [];
  for (const [f, h] of Object.entries(entry.files)) {
    const p = join(cwd, '.omd', f);
    if (!existsSync(p)) continue;
    if (sha256(readFileSync(p)) === h) unlinkSync(p);
    else {
      kept.push(f);
      logger.warn({ pack: name, file: f }, '[omd/pack] 文件安装后被本地修改 → 保留不删 (remove 不吞用户的活)');
    }
  }
  delete ledger.packs[name];
  writeLedger(cwd, ledger);
  return {
    ok: true,
    message: `已卸载 ${name}${kept.length ? ` (保留被本地修改的: ${kept.join(', ')})` : ' (byte 级回到装前)'}`,
  };
}

/** `omd pack list`。 */
export function listPacks(cwd: string): PackResult {
  const ledger = readLedger(cwd);
  const entries = Object.entries(ledger.packs);
  if (entries.length === 0) return { ok: true, message: '无已安装 pack。安装: omd pack add <本地目录|git URL>' };
  return {
    ok: true,
    message: entries
      .map(([n, e]) => `${n}${e.version ? `@${e.version}` : ''} — ${Object.keys(e.files).length} 文件 · ${e.source} · ${e.installedAt}`)
      .join('\n'),
  };
}
