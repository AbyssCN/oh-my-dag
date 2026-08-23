#!/usr/bin/env bun
/**
 * vendor-terminal-bench —— 从 Terminal-Bench 2.1 仓抽出**结构探针需要的那一小部分**(2026-08-05)。
 *
 * ## 抽什么、不抽什么
 *
 * 抽:`instruction.md` 全文 + `task.toml` 的元数据(难度/类别/专家与初级估时/标签)。合计 ~150KB。
 *
 * **不抽 `solution/`(参考解)与 `tests/`** —— 这不是为了省空间, 是**污染通道**:
 * 参考解一旦进仓树, 任何有工具的臂都可能读到它, 而本仓已经在这上面栽过一次
 * (交接 21 §四:eval 答案留在仓树里, 实测有跑真的去 cat 了别人的答案)。
 * 判分要跑真 harness 时用官方 Docker, 答案不进我们的仓。
 *
 * ## 许可与署名
 *
 * Terminal-Bench 2.1 = **Apache-2.0**(harbor-framework/terminal-bench-2-1)。
 * 抽出物保持同一许可, 署名写进 README。
 *
 * 跑: git clone --depth 1 https://github.com/harbor-framework/terminal-bench-2-1 /tmp/tb21
 *     bun run scripts/vendor-terminal-bench.ts --src /tmp/tb21
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SRC = opt('src') ?? '/tmp/tb21';
/** 存盘文件名 —— Terminal-Bench 与它的继任 Frontier-Bench 用同一套 Harbor 布局, 同一个抽取器。 */
const OUT_NAME = opt('name') ?? 'tasks.json';
const OUT = join(import.meta.dir, '..', 'src', 'eval', 'tasks', 'terminal-bench', 'data');

/** task.toml 里我们要的那几个字段(手写小解析 —— 为 5 个标量字段拉一个 TOML 依赖不值)。 */
function field(toml: string, key: string): string {
  return toml.match(new RegExp('^' + key + '\\s*=\\s*"([^"]*)"', 'm'))?.[1] ?? '';
}
function num(toml: string, key: string): number {
  return Number(toml.match(new RegExp('^' + key + '\\s*=\\s*([0-9.]+)', 'm'))?.[1] ?? NaN);
}

const tasksDir = join(SRC, 'tasks');
if (!existsSync(tasksDir)) {
  process.stderr.write(`vendor-terminal-bench: 找不到 ${tasksDir} —— 先 git clone(见文件头)\n`);
  process.exit(2);
}

const out: unknown[] = [];
let skipped = 0;
for (const dir of readdirSync(tasksDir).sort()) {
  const toml = join(tasksDir, dir, 'task.toml');
  const inst = join(tasksDir, dir, 'instruction.md');
  if (!existsSync(toml) || !existsSync(inst)) {
    skipped++; // 缺件的照实计数, 不静默跳过 (README.md 这种非任务目录会落这里)
    continue;
  }
  const t = readFileSync(toml, 'utf8');
  // 两代 benchmark 的估时字段**单位不同**: Terminal-Bench 记分钟, Frontier-Bench 记小时。
  // 统一归到分钟再存盘 —— 混着存必然有人某天拿 4(小时) 当 4(分钟) 比。
  const expMin = num(t, 'expert_time_estimate_min');
  const expHr = num(t, 'expert_time_estimate_hours');
  const expert = Number.isFinite(expMin) ? expMin : Number.isFinite(expHr) ? expHr * 60 : null;
  const junMin = num(t, 'junior_time_estimate_min');
  const junHr = num(t, 'junior_time_estimate_hours');
  const junior = Number.isFinite(junMin) ? junMin : Number.isFinite(junHr) ? junHr * 60 : null;
  out.push({
    id: dir,
    name: field(t, 'name'),
    description: field(t, 'description'),
    difficulty: field(t, 'difficulty'),
    category: field(t, 'category'),
    subcategory: field(t, 'subcategory'),
    // ⚠ 估时缺席记 null 不记 0 —— 仓规第一条 (NULL ≠ 0 ≠ 不适用)。
    expertTimeMin: expert,
    juniorTimeMin: junior,
    instruction: readFileSync(inst, 'utf8'),
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, OUT_NAME), JSON.stringify(out, null, 1));
process.stderr.write(`抽出 ${out.length} 个任务 (跳过 ${skipped} 个缺 task.toml/instruction.md 的目录) → ${OUT}/${OUT_NAME}\n`);
