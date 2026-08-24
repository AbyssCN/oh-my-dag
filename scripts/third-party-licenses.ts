#!/usr/bin/env bun
/**
 * scripts/third-party-licenses —— 生成 / 校验 THIRD_PARTY_LICENSES.md。**零 LLM, 确定性**。
 *
 *   bun run scripts/third-party-licenses.ts            # 重新生成, 写盘
 *   bun run scripts/third-party-licenses.ts --check    # 只比对, 不一致 exit 1 (可进 CI)
 *
 * ## 为什么需要它
 *
 * 我们**不 vendor** 任何依赖 —— npm/bun 从 registry 拉, 每个包自带 LICENSE。走 npm 这条
 * 分发路径时, 分发者是 registry 不是我们, 保留声明的义务不落在这儿。
 *
 * **但 Dockerfile 那条路不一样**: `bun install` + `COPY . .` 之后, 镜像里带着全部
 * node_modules 的代码。一旦分发镜像 (云端部署就会), 我们就是二进制分发者, 而
 * BSD-3-Clause 第二条、Apache-2.0 第四条这类"分发时须复现声明"的义务当场触发。
 * 独立二进制同理。
 *
 * 所以这份清单不是形式主义 —— 它是那一刻唯一能拿出来的东西。
 *
 * ## 口径: 覆盖**整棵 node_modules**, 不只直接依赖
 *
 * 镜像里装的是整棵树, 声明就得覆盖整棵树。直接依赖额外标注出来, 因为它们是我们主动
 * 选进来的、需要有人对其协议负责的那些。
 *
 * ## 已知局限 (写出来, 免得它被当成法务背书)
 *
 * - 只读 `package.json` 的 `license` 字段与包内 LICENSE 文件。字段写错的包, 这里跟着错。
 * - `SEE LICENSE IN <file>` 这类非 SPDX 值原样透传, 并单独列进「需人工确认」区 ——
 *   它们恰恰是最需要人看一眼的那些 (如 @anthropic-ai/claude-agent-sdk 走 Anthropic 商用条款)。
 * - 双协议 (`(MIT OR Apache-2.0)`) 不替你选, 原样列出。
 * - **这不是法律意见。** 上线前该由律师过一遍的是「需人工确认」那一区。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'THIRD_PARTY_LICENSES.md');

/** 包内可能承载协议正文的文件名, 按优先级。 */
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license', 'License'];

export interface Pkg {
  name: string;
  version: string;
  /** package.json 的 license 字段原样; 缺席写 UNKNOWN。 */
  license: string;
  /** 包内 LICENSE 文件的相对文件名; 没有则 undefined。 */
  licenseFile?: string;
  repository?: string;
  direct: boolean;
}

/** SPDX 之外的值 —— 机器判不了, 必须人看。 */
export function needsHumanReview(license: string): boolean {
  return license === 'UNKNOWN' || /^SEE LICENSE/i.test(license) || license.includes('UNLICENSED');
}

function repoUrlOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'url' in raw) return String((raw as { url: unknown }).url);
  return undefined;
}

/** 扫整棵 node_modules (含 @scope 一层)。不递归嵌套 node_modules —— bun 是扁平装的。 */
export function scanPackages(nodeModules: string, direct: Set<string>): Pkg[] {
  const out: Pkg[] = [];
  const push = (dir: string, name: string) => {
    const pjPath = join(dir, 'package.json');
    if (!existsSync(pjPath)) return;
    let pj: Record<string, unknown>;
    try {
      pj = JSON.parse(readFileSync(pjPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return; // 坏 package.json 不该让整份清单生不出来
    }
    const licRaw = pj.license ?? (Array.isArray(pj.licenses) ? undefined : undefined);
    out.push({
      name: String(pj.name ?? name),
      version: String(pj.version ?? '?'),
      license: typeof licRaw === 'string' && licRaw.length > 0 ? licRaw : 'UNKNOWN',
      licenseFile: LICENSE_FILES.find((f) => existsSync(join(dir, f))),
      repository: repoUrlOf(pj.repository),
      direct: direct.has(String(pj.name ?? name)),
    });
  };
  for (const e of readdirSync(nodeModules)) {
    if (e.startsWith('.')) continue;
    const p = join(nodeModules, e);
    if (e.startsWith('@')) {
      for (const s of readdirSync(p)) push(join(p, s), `${e}/${s}`);
    } else {
      push(p, e);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按协议聚合, 出现次数多的在前 —— 读者先看到主流那几种。 */
export function groupByLicense(pkgs: Pkg[]): [string, Pkg[]][] {
  const m = new Map<string, Pkg[]>();
  for (const p of pkgs) (m.get(p.license) ?? m.set(p.license, []).get(p.license)!).push(p);
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

export function render(pkgs: Pkg[]): string {
  const review = pkgs.filter((p) => needsHumanReview(p.license));
  const groups = groupByLicense(pkgs);
  const L: string[] = [];

  L.push('# Third-party licenses');
  L.push('');
  L.push('oh-my-dag depends on the packages below. This file is generated — do not edit by hand:');
  L.push('');
  L.push('```sh');
  L.push('bun run scripts/third-party-licenses.ts          # regenerate');
  L.push('bun run scripts/third-party-licenses.ts --check  # verify it is current (exit 1 if stale)');
  L.push('```');
  L.push('');
  L.push(
    'We do not vendor any of these. Installing from a registry fetches each package with its own ' +
      'licence text attached. This file exists for the paths where we *are* the distributor — a ' +
      'container image or a standalone binary carries these dependencies inside it, and licences ' +
      'such as BSD-3-Clause and Apache-2.0 require the notice to travel with them.',
  );
  L.push('');
  L.push(`**${pkgs.length} packages** · ${pkgs.filter((p) => p.direct).length} direct, ${pkgs.filter((p) => !p.direct).length} transitive.`);
  L.push('');

  if (review.length > 0) {
    L.push('## Needs a human, not a script');
    L.push('');
    L.push(
      'These do not carry a machine-readable SPDX licence. Their terms have to be read before ' +
        'anything is shipped commercially.',
    );
    L.push('');
    L.push('| Package | Version | Declared | Where the terms live |');
    L.push('|---|---|---|---|');
    for (const p of review) {
      L.push(`| \`${p.name}\` | ${p.version} | \`${p.license}\` | ${p.licenseFile ?? p.repository ?? '—'} |`);
    }
    L.push('');
  }

  L.push('## By licence');
  L.push('');
  L.push('| Licence | Packages |');
  L.push('|---|---:|');
  for (const [lic, ps] of groups) L.push(`| ${lic} | ${ps.length} |`);
  L.push('');

  L.push('## Every package');
  L.push('');
  L.push('| Package | Version | Licence | Direct |');
  L.push('|---|---|---|:--:|');
  for (const p of pkgs) {
    L.push(`| \`${p.name}\` | ${p.version} | ${p.license} | ${p.direct ? '✓' : ''} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(
    'Generated from `package.json` and the `package.json` of each installed dependency. ' +
      'A package that declares its licence incorrectly is reported incorrectly here — this is a ' +
      'faithful reading of what is on disk, not a legal opinion.',
  );
  L.push('');
  return L.join('\n');
}

function main(): number {
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const direct = new Set(Object.keys(pj.dependencies ?? {}));
  const pkgs = scanPackages(join(ROOT, 'node_modules'), direct);
  const text = render(pkgs);

  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current === text) {
      console.log(`✅ THIRD_PARTY_LICENSES.md 是最新的 (${pkgs.length} 个包)`);
      return 0;
    }
    console.error('❌ THIRD_PARTY_LICENSES.md 与盘上的依赖不一致 —— 依赖变了但清单没跟。');
    console.error('   跑 `bun run scripts/third-party-licenses.ts` 重新生成后提交。');
    return 1;
  }

  writeFileSync(OUT, text, 'utf8');
  const review = pkgs.filter((p) => needsHumanReview(p.license));
  console.log(`写入 THIRD_PARTY_LICENSES.md —— ${pkgs.length} 个包, ${groupByLicense(pkgs).length} 种协议`);
  if (review.length > 0) {
    console.log(`⚠ ${review.length} 个包没有机读协议, 已单列进「需人工确认」区:`);
    for (const p of review) console.log(`   ${p.name}@${p.version} → ${p.license}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());
