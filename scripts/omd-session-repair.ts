/**
 * scripts/omd-session-repair —— 把被**两个写者**写坏的会话文件修回可读(SDD 片 B 第 ③ 条)。
 *
 * ## 它只治一种病,而那种病有确定的症状
 *
 * 两个 `Session` 实例写同一份 JSONL 会各按自己的 `nextSequence` 追加 ⇒ 出现**重复 seq**,
 * 而 `JsonlSessionStorage.load()` 撞见非连续 seq 直接抛
 * `Invalid JSONL v4 session …: line N has non-consecutive seq M` —— **整份会话读不出来**。
 * (实测在 `scripts/probes/pi-session-probe.ts` 第 7/8 条。)
 *
 * ## 为什么它**不自动跑**
 *
 * 修复 = **丢掉后到的那几行**。自动修就是**静默丢消息** —— 本仓不接受这种出口。
 * 所以:① 手动调用;② 默认 `--dry` 只报不改;③ 真改之前先备份成 `.bak`;
 * ④ 把丢掉的每一行**原文打印出来**,谁丢了什么必须看得见。
 *
 * ## 用法
 *
 *   bun run scripts/omd-session-repair.ts <file.jsonl>            # 只报告(默认)
 *   bun run scripts/omd-session-repair.ts <file.jsonl> --write    # 真改(先写 .bak)
 *
 * 退出码:0 文件本来就好 / dry 跑完 · 1 发现问题但没改(dry)· 2 改过了 · 3 用法或读不出来。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

interface Line {
  no: number;
  raw: string;
  seq?: number;
  kind?: string;
}

/** 解析出每行的 `seq`(header 没有 seq —— 它不是 mutation)。坏行 `seq` 缺席。 */
export function parseLines(text: string): Line[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((raw, i) => {
      try {
        const o = JSON.parse(raw) as { seq?: number; kind?: string };
        return { no: i + 1, raw, ...(typeof o.seq === 'number' ? { seq: o.seq } : {}), ...(o.kind ? { kind: o.kind } : {}) };
      } catch {
        return { no: i + 1, raw };
      }
    });
}

export interface RepairPlan {
  keep: Line[];
  /** 要丢的行 + 丢的理由(**逐行留原文**,不许只报个数)。 */
  drop: { line: Line; why: string }[];
}

/**
 * 修复计划:**先到的留下,重复的丢**。
 *
 * ⚠ 判据是"seq 是否已经出现过",不是"seq 连不连续" —— 后者会把一个正常的
 * `1,2,3` 也判成要修(第一行 header 没 seq)。
 */
export function planRepair(lines: readonly Line[]): RepairPlan {
  const seen = new Set<number>();
  const keep: Line[] = [];
  const drop: { line: Line; why: string }[] = [];
  for (const l of lines) {
    if (l.seq === undefined) {
      // header 或坏行:header 留着;坏行(JSON 解析不出来)丢掉并说明。
      if (l.kind === 'header') keep.push(l);
      else drop.push({ line: l, why: 'JSON 解析不出来(半截写入)' });
      continue;
    }
    if (seen.has(l.seq)) {
      drop.push({ line: l, why: `seq ${l.seq} 已经出现过(另一个写者写的)` });
      continue;
    }
    seen.add(l.seq);
    keep.push(l);
  }
  return { keep, drop };
}

function main(): void {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const write = argv.includes('--write');
  if (!file || !existsSync(file)) {
    console.error('用法:bun run scripts/omd-session-repair.ts <file.jsonl> [--write]');
    process.exit(3);
  }
  const text = readFileSync(file, 'utf-8');
  const plan = planRepair(parseLines(text));

  if (plan.drop.length === 0) {
    console.log(`✓ ${file}:没有重复 seq、没有半截行 —— 不用修`);
    process.exit(0);
  }

  console.log(`⚠ ${file}:要丢 ${plan.drop.length} 行,留 ${plan.keep.length} 行`);
  for (const d of plan.drop) {
    // **逐行原文** —— 丢了什么必须看得见, 否则这就是一次静默丢消息。
    console.log(`  行 ${d.line.no} · ${d.why}`);
    console.log(`    ${d.line.raw.slice(0, 200)}`);
  }
  if (!write) {
    console.log('\n(dry)没有改动任何文件。真要修:加 --write');
    process.exit(1);
  }
  copyFileSync(file, `${file}.bak`);
  writeFileSync(file, plan.keep.map((l) => l.raw).join('\n') + '\n', 'utf-8');
  console.log(`\n已修:原文备份在 ${file}.bak`);
  process.exit(2);
}

if (import.meta.main) main();
