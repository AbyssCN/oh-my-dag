// L6 读数探针: 近期 run 里 tsc / bun test 类 command 节点占节点墙钟的份额与重复次数。
// 数据源 = .omd/continuity/<runId>/ 的 _dag.json (plan: executor/command) + *.json checkpoint (durationMs, 含 __r 重试片)。
// 用法: bun scripts/probes/l6-tsc-test-share.ts <runId-prefix> [...]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/dev/repos/oh-my-dag/.omd/continuity';

function classify(cmd: string): string | null {
  if (/\btsc\b/.test(cmd) && /bun test|\bvitest\b/.test(cmd)) return 'tsc+test';
  if (/\btsc\b/.test(cmd)) return 'tsc';
  if (/bun test(?:\s|$)/.test(cmd)) {
    // 全量 = bun test . / bun test 无目标 / bun test src/;定向 = 指到具体文件
    const m = cmd.match(/bun test\s*([^\s&|;]*)/);
    const target = m?.[1] ?? '';
    return target === '' || target === '.' || target === 'src/' ? 'test-full' : 'test-targeted';
  }
  return null;
}

const prefixes = process.argv.slice(2);
const dirs = readdirSync(ROOT).filter((d) => prefixes.some((p) => d.startsWith(p)));

for (const dir of dirs) {
  const base = join(ROOT, dir);
  const dag = await Bun.file(join(base, '_dag.json')).json();
  const nodes: Record<string, { executor?: string; command?: string }> = dag.plan?.nodes ?? dag.nodes ?? {};
  const files = readdirSync(base).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.endsWith('-deps.json'));
  let total = 0;
  const byClass: Record<string, { ms: number; runs: number }> = {};
  const rows: Array<[string, string, number]> = [];
  for (const f of files) {
    const cp = await Bun.file(join(base, f)).json();
    const ms: number = cp.durationMs ?? 0;
    total += ms;
    // checkpoint 文件名形如 execute::<nodeId>[.__rN].json 或 accept[.__rN].json
    const nodeId = f.replace(/\.json$/, '').replace(/\.__r\d+$/, '');
    const short = nodeId.includes('::') ? (nodeId.split('::')[1] ?? nodeId) : nodeId;
    const node = nodes[short] ?? nodes[nodeId];
    const cmd: string | undefined = node?.command;
    const cls = cmd ? classify(cmd) : null;
    if (cls) {
      byClass[cls] = byClass[cls] ?? { ms: 0, runs: 0 };
      byClass[cls].ms += ms;
      byClass[cls].runs += 1;
      rows.push([f, cls, ms]);
    }
  }
  console.log(`\n=== ${dir.slice(0, 8)} · 节点墙钟合计 ${(total / 60000).toFixed(1)}min · 检查片 ${files.length}`);
  for (const [cls, v] of Object.entries(byClass).sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${cls.padEnd(14)} ${String(v.runs).padStart(2)} 发  ${(v.ms / 1000).toFixed(0).padStart(5)}s  (${((v.ms / total) * 100).toFixed(1)}% 节点墙钟)`);
  }
  for (const [f, cls, ms] of rows.sort((a, b) => b[2] - a[2]).slice(0, 8)) {
    console.log(`    ${(ms / 1000).toFixed(0).padStart(5)}s  ${cls.padEnd(14)} ${f}`);
  }
}
