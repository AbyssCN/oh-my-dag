#!/usr/bin/env bun
/**
 * scripts/omd-shots-verify —— 截图证据的**确定性闸** (2026-07-26 owner 裁决)。
 *
 * 为什么存在: 证据链原本的地板是"派一个多模态模型去看一眼"。实测下来那一环
 * ① 贵 ② 失败是**静默的** —— 全栈 eval 里 6 次跑只有 1 次真产出截图, 而主指标 pass 依然 1.000,
 * 从读数上完全看不出"这一轮没有任何像素被看过"。
 *
 * 所以地板改成零模型可计算的: 截图**真存在、非空、不是一张白板**。看得懂设计好不好, 那是品味,
 * 交给 HITL 或图外 —— 不该由一个便宜模型在图里假装做完。
 *
 * 用法:
 *   omd-shots-verify <dir|file>... [--min-bytes N] [--min-count N]
 * 全过 → 逐行打印通过的图片路径 + 退出 0 (路径仍被 leaf-media 正则拾取, 想接审查随时能接);
 * 任一条不过 → stderr 说明哪张为什么, 退出 1。
 *
 * v1 只做"有没有 + 空不空 + 是不是白板"。**真正的防偏移是对参照图做像素 diff** —— 有蓝图时那才是
 * 精确判据, 待做 (见 docs/eval-findings.md)。别把 v1 当成偏移检测。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

/** 白板判据: PNG 是无损压缩, 纯色/近纯色页面压得极小。1280x800 的真页面通常 ≥30KB。 */
const DEFAULT_MIN_BYTES = 6_000;

interface Args {
  targets: string[];
  minBytes: number;
  minCount: number;
}

export function parseShotsArgs(argv: string[]): Args {
  const targets: string[] = [];
  let minBytes = DEFAULT_MIN_BYTES;
  let minCount = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--min-bytes') minBytes = Number.parseInt(argv[++i] ?? '', 10) || DEFAULT_MIN_BYTES;
    else if (a === '--min-count') minCount = Number.parseInt(argv[++i] ?? '', 10) || 1;
    else if (a.startsWith('--')) throw new Error(`未知 flag: ${a}`);
    else targets.push(a);
  }
  if (targets.length === 0) throw new Error('用法: omd-shots-verify <dir|file>... [--min-bytes N] [--min-count N]');
  return { targets, minBytes, minCount };
}

const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** 目标(文件或目录)→ 图片绝对路径列表。目录只看一层 —— 截图不该藏在深层。 */
export function collectShots(targets: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const abs = isAbsolute(t) ? t : resolve(cwd, t);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs)) {
        if (IMG.has(extname(f).toLowerCase())) out.push(join(abs, f));
      }
    } else if (IMG.has(extname(abs).toLowerCase())) {
      out.push(abs);
    }
  }
  return [...new Set(out)].sort();
}

/** PNG 头里读宽高 (零依赖: IHDR 在固定偏移)。非 PNG / 头不完整 → null。 */
export function pngSize(path: string): { w: number; h: number } | null {
  try {
    const b = readFileSync(path).subarray(0, 33);
    if (b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

export interface ShotVerdict {
  path: string;
  bytes: number;
  size: string;
  ok: boolean;
  why?: string;
}

export function verifyShots(paths: string[], minBytes: number): ShotVerdict[] {
  return paths.map((p) => {
    const bytes = statSync(p).size;
    const d = pngSize(p);
    const size = d ? `${d.w}x${d.h}` : '?';
    if (bytes === 0) return { path: p, bytes, size, ok: false, why: '空文件' };
    if (bytes < minBytes) {
      return { path: p, bytes, size, ok: false, why: `仅 ${bytes}B (< ${minBytes}) — 疑似白板/近纯色页` };
    }
    return { path: p, bytes, size, ok: true };
  });
}

if (import.meta.main) {
  let args: Args;
  try {
    args = parseShotsArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[omd-shots-verify] ${(e as Error).message}`);
    process.exit(1);
  }
  const shots = collectShots(args.targets);
  if (shots.length < args.minCount) {
    console.error(
      `[omd-shots-verify] 截图不足: 找到 ${shots.length} 张, 需要 ≥${args.minCount} — 渲染步没跑成或产物路径不对。\n` +
        `查过: ${args.targets.join(', ')}`,
    );
    process.exit(1);
  }
  const verdicts = verifyShots(shots, args.minBytes);
  const bad = verdicts.filter((v) => !v.ok);
  for (const v of verdicts) {
    console.error(`  ${v.ok ? '✓' : '✗'} ${v.size} ${v.bytes}B ${v.path}${v.why ? ` — ${v.why}` : ''}`);
  }
  if (bad.length) {
    console.error(`[omd-shots-verify] ${bad.length}/${verdicts.length} 张不合格 — 像素证据不成立。`);
    process.exit(1);
  }
  // stdout 只出路径 (leaf-media 正则拾取用; 想在后面接一层审查随时能接)。
  for (const v of verdicts) console.log(v.path);
}
