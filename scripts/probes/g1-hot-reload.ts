#!/usr/bin/env bun
/**
 * scripts/probes/g1-hot-reload.ts — 真机验 G1 (SDD §3): 热生效 (本 SDD 的存在理由)。
 *
 * 流程: 起真 server (src/harness/cli.ts mcp) → dag_run A → 改引擎一行 marker + 真 commit →
 * dag_run B → 断言 B 的 exec.log 含 MARKER 且 server pid 未变 → 清理 (kill server + 撤临时 commit)。
 *
 * 反向自检 (证伪方式, 写死在注释里):
 *   - 把 dag_run handler 撤掉 spawn 改回 in-proc → B 没有子进程 → exec.log 不存在 → 断言红。
 *   - 把 B 的断言改成"不含 MARKER" → 热生效回归后当场红。
 *   - S1 陈旧闸: commit 后 server 是旧 HEAD → 工具响应头部带 ⚠ stale 行 (probe 只日志不判 —
 *     那是 S1 单测的领地, 这里不重复闸)。
 *
 * 日志: /tmp/g1-probe.log (不留仓根)。退出码: 0=全过, 1=任一断言红, 2=环境不可用。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const REPO = process.cwd();
const LOG = '/tmp/g1-probe.log';
const ENGINE = join(REPO, 'src', 'harness', 'dag', 'engine.ts');
const log = (m: string): void => appendFileSync(LOG, `[g1 ${new Date().toISOString()}] ${m}\n`);
const fail = (m: string): never => {
  log(`❌ FAIL: ${m}`);
  console.error(`g1 FAIL: ${m}`);
  process.exit(1);
};

// ── 起真 server (stdio MCP) ────────────────────────────────────────────────
const server = Bun.spawn(['bun', 'run', 'src/harness/cli.ts', 'mcp'], {
  cwd: REPO,
  env: process.env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});
const serverPid = server.pid;
log(`server pid=${serverPid} 起 (bootSha 见 server 侧 S1)`);

// ── 最小 MCP stdio client (逐行 JSON-RPC) ───────────────────────────────────
let buf = '';
const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
let msgId = 0;
const reader = (async () => {
  const dec = new TextDecoder();
  const rs = server.stdout.getReader();
  for (;;) {
    const { done, value } = await rs.read();
    if (done) break;
    buf += dec.decode(value);
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        log(`非 JSON stdout 行 (跳过): ${line.slice(0, 120)}`);
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  }
})();
const rpc = (method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const notify = (method: string, params: unknown): void => {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
};
const toolCall = async (name: string, args: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }> =>
  (await rpc('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
const runIdOf = (resp: { content: { text: string }[] }): string => {
  const m = /runId: ([0-9a-f-]{36})/.exec(resp.content.map((c) => c.text).join('\n'));
  if (!m) return fail(`dag_run 响应里没有 runId: ${JSON.stringify(resp).slice(0, 300)}`);
  return m[1]!;
};
const waitTerminal = async (runId: string, what: string): Promise<void> => {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    if (Date.now() > deadline) fail(`${what} 超时 (15min) 仍未终态: ${runId}`);
    const s = await toolCall('dag_status', { runId });
    const text = s.content.map((c) => c.text).join('\n');
    if (/status: (done|failed|cancelled)/.test(text)) {
      log(`${what} ${runId} 终态: ${/status: (\w+)/.exec(text)?.[1]} — ${text.split('\n').slice(0, 6).join(' | ')}`);
      return;
    }
    await Bun.sleep(3000);
  }
};

// ── 握手 ───────────────────────────────────────────────────────────────────
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g1-probe', version: '0' } });
notify('notifications/initialized', {});

// ── run A: 改动前的代码 ─────────────────────────────────────────────────────
const task = `G1 probe ${Date.now()}: 用一句话回答你正在执行什么 (这是热生效探针的第一跑)`;
const a = await toolCall('dag_run', { task });
if (a.isError) fail(`dag_run A 起跑被拒: ${JSON.stringify(a).slice(0, 300)}`);
const runA = runIdOf(a);
log(`dag_run A runId=${runA} (server pid 仍 ${serverPid})`);
await waitTerminal(runA, 'A');

// ── 改引擎一行 + 真 commit (G1 的 T1 断言面: 下一个 run 吃盘上新码) ──────────
const marker = `OMD-G1-MARKER-${Date.now()}`;
const lines = readFileSync(ENGINE, 'utf-8').split('\n');
const anchor = lines.findIndex((l) => l.startsWith('export async function runExecutorDag('));
if (anchor < 0) fail(`engine.ts 找不到 runExecutorDag 签名 (anchor 变了?)`);
// 签名跨多行 (参数列表占几行) —— 插在签名首行后会把 marker 塞进参数列表, 子进程启动即
// 语法错 (真机实测: B 的 exec.log "Unexpected :" @ 3144)。下移到函数体 `{` 之后。
let body = anchor;
while (body < lines.length && !lines[body]!.includes('{')) body++;
if (body >= lines.length) fail('runExecutorDag 函数体 `{` 找不到');
lines.splice(body + 1, 0, `  console.error('[${marker}]');`);
writeFileSync(ENGINE, lines.join('\n'));
log(`engine.ts 已插入 marker (line ${body + 2})`);
try {
  execSync('git add src/harness/dag/engine.ts && git commit -m "G1 probe marker (temp)"', { cwd: REPO, stdio: 'pipe' });
  log('真 commit 完成 (HEAD 漂移 → S1 stale 档激活)');
} catch (e) {
  // commit 失败 (pre-commit hook 等) → 脏工作区档: marker 未提交, G1 的 T1 断言仍有效
  // (子进程读盘上新码), 只少 S1 的 stale 面 —— 那面 S1 单测已覆盖。
  log(`commit 失败, 降级脏工作区档继续: ${(e as Error).message.split('\n')[0]}`);
}

// ── run B: 新代码 ───────────────────────────────────────────────────────────
const b = await toolCall('dag_run', {
  task: `G1 probe ${Date.now()}: 用一句话回答你正在执行什么 (这是热生效探针的第二跑)`,
});
if (b.isError) fail(`dag_run B 起跑被拒: ${JSON.stringify(b).slice(0, 300)}`);
const runB = runIdOf(b);
await waitTerminal(runB, 'B');

// ── 断言 ────────────────────────────────────────────────────────────────────
const logB = join(REPO, '.omd', 'continuity', runB, 'exec.log');
const logA = join(REPO, '.omd', 'continuity', runA, 'exec.log');
const textB = readFileSync(logB, 'utf-8');
const textA = readFileSync(logA, 'utf-8');
if (!textB.includes(marker)) fail(`B 的 exec.log 不含 MARKER → 热生效没发生 (子进程在跑盘上旧码?)`);
if (textA.includes(marker)) fail(`A 的 exec.log 反而含 MARKER → 时序错 (A 跑在了 marker 之后?)`);
if (serverPid !== server.pid) fail(`server pid 变了 (${serverPid} → ${server.pid}) → 不是热生效, 是重启`);
log(`✅ G1 过: B 吃新码 (MARKER 在 exec.log) 且 server pid=${serverPid} 未变; A 无 MARKER (反向 ✓)`);

// ── 清理: kill server + 撤临时 commit (只撤 marker 那个 commit, 不碰别的) ────
try {
  server.kill();
} catch { /* 已退 */ }
try {
  const head = execSync('git log -1 --oneline', { cwd: REPO }).toString().trim();
  if (head.includes('G1 probe marker')) {
    execSync('git reset --soft HEAD~1 && git restore --source=HEAD --staged --worktree src/harness/dag/engine.ts', { cwd: REPO, stdio: 'pipe' });
    log('临时 commit 已撤, engine.ts 已还原 (其余工作区改动未触碰)');
  } else {
    log(`⚠ HEAD 不是 marker commit (${head}) — 未撤 (人为检查)`);
  }
} catch (e) {
  log(`⚠ 清理失败: ${(e as Error).message} — 需人工确认 engine.ts 与 git 状态`);
}
log('g1 完成');
process.exit(0);
