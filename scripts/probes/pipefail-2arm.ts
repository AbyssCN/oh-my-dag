// #146 表内项② / #145 附录: OMD_BASH_PIPEFAIL 两臂对照 (四要素在 agent-tools.ts:885 注释里冻结)。
// 单一变量 = pipefail 开/关 (包裹用生产同源 withPipefail, 不自己重写)。
// 成败信号 (预先声明): 开臂 0→非0 的翻转里, 真错 (管道掩盖了左侧失败) vs 假红 (SIGPIPE 141 类)。
//   真错 > 假红 → 建议默认开; 反之维持默认关。两侧读数 (翻转与不翻转) 都写。
// 对照基线 = 同一批命令同一棵树两臂各跑一次 (不拿录制时的旧退出码当基线 —— 树状态已变)。
// 命令源 = .omd/continuity/**.json 的 shellRuns (真实生产命令), 只回放只读白名单形。
// 用法: bun scripts/probes/pipefail-2arm.ts [--heavy 6] [--light 200]
import { readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { withPipefail } from '../../src/harness/agent-tools';

const ROOT = '/home/nick/repos/oh-my-dag';
const OUT = `${ROOT}/.omd/eval/pipefail-2arm.jsonl`;
const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const HEAVY_CAP = arg('heavy', 6);
const LIGHT_CAP = arg('light', 200);

// 只读白名单: 每个 && / ; / | 分段的首词都得在表内, 且整串不含写形。宁可漏不可错杀树。
const SAFE_HEADS = new Set([
  'ls', 'grep', 'ugrep', 'rg', 'head', 'tail', 'wc', 'cat', 'echo', 'sort', 'uniq', 'cut', 'tr',
  'jq', 'file', 'stat', 'which', 'sed', 'awk', 'true', 'test',
  // 刻意不收: xargs (二级命令逃逸) · find (-exec/-delete) · sqlite3 (SQL 写形查不住)
]);
const HEAVY_HEADS = new Set(['bun', 'bunx', 'tsc']);
// 先剥安全重定向 (2>&1 等), 剩下任何 > 都按写形拒
const stripSafeRedirects = (c: string) => c.replace(/2>&1|1>&2|>&2|2>\/dev\/null|&>\/dev\/null|>\/dev\/null/g, '');
const WRITE_SHAPE = />|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btee\b|\bsed\s+-i|\bgit\s+(add|commit|push|checkout|stash|restore|reset|clean)\b|--fix|\binstall\b|\bkill\b/;

function heads(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}
function classify(cmd: string): 'light' | 'heavy' | null {
  if (WRITE_SHAPE.test(stripSafeRedirects(cmd))) return null;
  const hs = heads(cmd);
  if (!hs.length) return null;
  if (hs.every((h) => SAFE_HEADS.has(h))) return 'light';
  if (hs.every((h) => SAFE_HEADS.has(h) || HEAVY_HEADS.has(h))) {
    // bun/bunx 只收 test / --check / tsc 形 (只读验证); bun run 之类不回放
    if (/\bbun(x)?\s+(?!test|--check|tsc)/.test(cmd)) return null;
    return 'heavy';
  }
  return null;
}

// 1. 收割 + 去重
const seen = new Set<string>();
const light: string[] = [];
const heavy: string[] = [];
for (const dir of readdirSync(`${ROOT}/.omd/continuity`)) {
  let files: string[];
  try {
    files = readdirSync(`${ROOT}/.omd/continuity/${dir}`).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    continue;
  }
  for (const f of files) {
    let cp: { shellRuns?: Array<{ command?: string }> };
    try {
      cp = await Bun.file(`${ROOT}/.omd/continuity/${dir}/${f}`).json();
    } catch {
      continue;
    }
    for (const r of cp.shellRuns ?? []) {
      const cmd = (r.command ?? '').trim();
      if (!cmd || !cmd.includes('|') || seen.has(cmd)) continue;
      seen.add(cmd);
      const cls = classify(cmd);
      if (cls === 'light') light.push(cmd);
      else if (cls === 'heavy') heavy.push(cmd);
    }
  }
}
const batch = [...light.slice(0, LIGHT_CAP), ...heavy.slice(0, HEAVY_CAP)];
console.log(`收割: 管道命令去重后 light=${light.length} heavy=${heavy.length} → 回放 ${batch.length} 条 (light≤${LIGHT_CAP}, heavy≤${HEAVY_CAP})`);

// 2. 两臂回放
function run(cmd: string, timeoutMs: number): number | 'timeout' {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, timeout: timeoutMs, stdio: 'ignore' });
  if (r.signal || (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')) return 'timeout';
  return r.status ?? -1;
}

mkdirSync(`${ROOT}/.omd/eval`, { recursive: true });
let flips = 0;
let sameCount = 0;
let realErr = 0;
let falseRed = 0;
for (const cmd of batch) {
  const timeoutMs = classify(cmd) === 'heavy' ? 120_000 : 20_000;
  const off = run(cmd, timeoutMs);
  const on = run(withPipefail(cmd, { OMD_BASH_PIPEFAIL: '1' } as NodeJS.ProcessEnv), timeoutMs);
  const rec: Record<string, unknown> = { cmd, off, on };
  if (off === 0 && typeof on === 'number' && on !== 0) {
    flips++;
    // 判别: SIGPIPE 死 (128+13=141) = 假红; 否则单跑管道首段看它是不是真失败
    if (on === 141) {
      falseRed++;
      rec.verdict = 'false-red-sigpipe';
    } else {
      const firstSeg = cmd.split('|')[0]!.trim();
      const segExit = run(firstSeg, timeoutMs);
      rec.firstSegExit = segExit;
      if (typeof segExit === 'number' && segExit !== 0) {
        realErr++;
        rec.verdict = 'real-error-masked';
      } else {
        falseRed++;
        rec.verdict = 'false-red-other'; // 首段独跑绿而 pipefail 红 → 后段/SIGPIPE 变体
      }
    }
    console.log(`FLIP off=0 on=${on} [${rec.verdict}] ${cmd.slice(0, 140).replace(/\n/g, ' ')}`);
  } else {
    sameCount++;
  }
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
}
console.log(`\n两臂读数: 回放 ${batch.length} · 不翻转 ${sameCount} · 翻转(0→非0) ${flips} = 真错 ${realErr} + 假红 ${falseRed}`);
console.log(`裁决判据 (冻结于 agent-tools.ts:903): 真错 > 假红 → 建议默认开; 否则维持默认关。`);
console.log(`逐条读数: ${OUT}`);
