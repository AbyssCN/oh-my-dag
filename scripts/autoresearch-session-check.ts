/**
 * scripts/autoresearch-session-check —— P2b 切片 3 的验收 checker(尺子件,人工先立)。
 *
 * 为什么单立脚本而不是内联 jq:① 32d16141 实测内联 jq 的引号内管道曾被表解析截断
 * (根因已修 35a7dc21, 但验收命令零引号内结构仍是更稳的形状);② #251 点火判据自证要求
 * verify 可执行 —— checker 必须先于契约存在, 所以它不在任何切片写集里, 由人立、人改。
 *
 * 用法: bun scripts/autoresearch-session-check.ts <sessionsDir>
 * 退出码 0 = 至少一个 session 的 session.json 含 generations ≥ 2, 且逐代含 fitnessByChild。
 * 其余情况(目录缺席 / 无 session.json / 代数不足 / 代缺 fitness)→ 1, stderr 一行说清缺什么。
 *
 * 证伪(实装前天然红): sessions 目录当前不存在 → exit 1。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function fail(msg: string): never {
  process.stderr.write(`session-check: ${msg}\n`);
  process.exit(1);
}

const dir = process.argv[2];
if (!dir) fail('用法: bun scripts/autoresearch-session-check.ts <sessionsDir>');
if (!existsSync(dir)) fail(`目录不存在: ${dir}(session 还没跑出来)`);

const sessionFiles: string[] = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const p = join(dir, entry.name, 'session.json');
  if (existsSync(p)) sessionFiles.push(p);
}
if (sessionFiles.length === 0) fail(`目录下没有任何 <id>/session.json: ${dir}`);

let ok = 0;
const reasons: string[] = [];
for (const p of sessionFiles) {
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as {
      generations?: Array<{ fitnessByChild?: Record<string, unknown> }>;
    };
    const gens = s.generations;
    if (!Array.isArray(gens) || gens.length < 2) {
      reasons.push(`${p}: generations=${Array.isArray(gens) ? gens.length : '缺席'} (< 2)`);
      continue;
    }
    const bad = gens.findIndex((g) => !g || typeof g.fitnessByChild !== 'object' || g.fitnessByChild === null);
    if (bad >= 0) {
      reasons.push(`${p}: 第 ${bad} 代缺 fitnessByChild`);
      continue;
    }
    ok++;
  } catch (err) {
    reasons.push(`${p}: JSON 读不出 (${(err as Error).message})`);
  }
}
if (ok === 0) fail(`没有合格 session:\n  ${reasons.join('\n  ')}`);
process.stdout.write(`session-check: ${ok}/${sessionFiles.length} session 合格 (generations ≥ 2 且逐代含 fitness)\n`);
