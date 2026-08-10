#!/usr/bin/env bun
/**
 * scripts/probes/g2-survive-kill — 真机验 SDD §3 G2: kill server 后 run 不死 (run 不陪葬)。
 *
 * 流程 (全部真进程, 无单测模拟):
 *   1. 盲检 (观察通道不瞎): 组信号确实能杀同组非-detached 子进程; detached 子进程免疫。
 *   2. RUN 1 (反向敏感路): 真 server (detached, 自有 pgid) → dag_run → dag-exec 子进程 →
 *      `kill -9 -<server_pgid>` **组信号** → 断言子进程存活至落账。
 *      反向自检 (证伪方式, 写死): dag-tools.defaultSpawnDagExec 去掉 `detached: true` →
 *      子进程留在 server 进程组 → 组信号必红 (SDD §5 点名的失败模式: server 收到进程组
 *      信号时子进程陪葬)。改成 in-proc (不 spawn) → 无子进程, 断言 1 红。
 *   3. RUN 2 (SDD 原文): 真 server → dag_run → `kill -9 <server_pid>` 只杀进程 →
 *      断言子进程存活 + PPID 重挂 → 终态写穿 runs.db (落账) → **新** server 起
 *      dag_status 读到终态 (SDD §3 G2 逐字)。
 *   反向: 子进程终态不写穿 (registry 写侧坏) → 断言 2 红; dag_status 只查内存 → 断言 3 红。
 *
 * 两个实测过的坑 (写死, 别再踩):
 *   - 控制进程必须用非阻塞 Bun.spawn 持有: spawnSync 等到子进程退出才返回, 拿到 pid 时
 *     进程早没了, pgrep 必空 (实测假红 + 白等 6 分钟)。
 *   - 组信号必须用 Node `process.kill(-pgid, 'SIGKILL')`: 本机 coreutils 的
 *     `/usr/bin/kill -9 -<pgid>` exit 0 但静默不生效 (负号 operand 被当信号解析; 加 `--` 才灵),
 *     bash 内建 kill 无此坑 —— shell 层解析不可信。
 *
 * 日志: /tmp/omd-g2-probe.log (每行 ISO 时间戳 + 命令原文 + ps 证据)。
 * 退出码: 0=全过(PASS), 1=任一断言红(FAIL), 2=环境不可用。
 */
import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';

const REPO = process.cwd();
const LOG = '/tmp/omd-g2-probe.log';
const log = (m: string): void => appendFileSync(LOG, `[g2 ${new Date().toISOString()}] ${m}\n`);
const fail = (m: string): never => {
  log(`❌ FAIL: ${m}`);
  console.error(`G2 FAIL: ${m}`);
  process.exit(1);
};
const pass = (m: string): void => log(`✅ PASS: ${m}`);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function cmd(c: string[], timeoutMs = 30_000): { ok: boolean; out: string } {
  log(`cmd: ${c.join(' ')}`);
  const r = spawnSync(c[0]!, c.slice(1), { encoding: 'utf-8', timeout: timeoutMs });
  const out = (r.stdout ?? '').trim() + ((r.stderr ?? '').trim() ? `\nERR: ${(r.stderr ?? '').trim()}` : '');
  log(`cmd exit=${r.status} out=${out.slice(0, 1500)}`);
  return { ok: r.status === 0, out };
}

/** ps 证据 (原始列: pid ppid pgid sid stat etime cmd), 逐行进日志。 */
function psEv(tag: string, pids: number[]): void {
  const r = spawnSync('ps', ['-o', 'pid,ppid,pgid,sid,stat,etime,cmd', '-p', ...pids.map(String)], { encoding: 'utf-8' });
  log(`-- ps 证据 [${tag}]:\n${(r.stdout ?? '').trim() || '(无输出 — 进程已不存在)'}`);
}

/**
 * 组信号 (SIGKILL → 整个 pgid)。**必须用 process.kill(-pgid)**: 实测本机 coreutils 的
 * `/usr/bin/kill -9 -<pgid>` exit 0 但静默不生效 (负号 operand 被当信号解析; 加 `--` 才灵),
 * bash 内建 kill 无此坑 —— shell 层解析不可信, 直接用 Node 的负 pid 语义, 无歧义。
 */
function killGroup(pgid: number, note = ''): void {
  log(`组信号 SIGKILL → pgid ${pgid}${note ? ` (${note})` : ''} @ ${new Date().toISOString()}`);
  try {
    process.kill(-pgid, 'SIGKILL');
    log(`组信号已发 (process.kill(-${pgid}))`);
  } catch (e) {
    log(`组信号 pgid ${pgid}: ${(e as Error).message} (组已空属正常)`);
  }
}

function dbGet(runId: string, col: string): string | undefined {
  // 每读新开只读连接: 不跟写者 (子进程) 抢锁, 且读到的必是盘上最新值。
  const db = new Database(join(REPO, '.omd', 'runs.db'), { readonly: true });
  try {
    const r = db.query(`SELECT ${col} FROM omd_runs WHERE run_id=?`).get(runId) as Record<string, unknown> | null;
    const v = r?.[col];
    return v === null || v === undefined ? undefined : String(v);
  } finally {
    db.close();
  }
}

// ── 最小 MCP stdio client (同 g1-probe 模式) ────────────────────────────────
interface McpServer {
  pid: number;
  pgid: number;
  kill: () => void;
  stdin: { write: (s: string) => void };
  close: () => void;
  rpc: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
}
function spawnServer(tag: string): McpServer {
  log(`启动 ${tag}: bun run src/harness/cli.ts mcp @ cwd=${REPO} (detached: true → server 自有 pgid, 供组信号验)`);
  const p = Bun.spawn(['bun', 'run', 'src/harness/cli.ts', 'mcp'], {
    cwd: REPO,
    env: process.env,
    detached: true, // server 自身也要有独立进程组, 组信号才不波及其他进程
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pid = p.pid;
  // 排空 stderr: 不读的话 pipe 缓冲 (64KB) 写满会把 server 卡死, dag_run 响应永不到 (探针假红)。
  (async () => {
    const dec = new TextDecoder();
    const es = p.stderr.getReader();
    for (;;) {
      const { done, value } = await es.read();
      if (done) break;
      void dec.decode(value);
    }
  })();
  let buf = '';
  const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  let msgId = 0;
  const reader = (async () => {
    const dec = new TextDecoder();
    const rs = p.stdout.getReader();
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
          continue; // 非 JSON stdout 行 (banner 等) 跳过
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
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    pid,
    pgid: pid, // Bun.spawn detached:true → 子进程成为会话组长, pgid = pid
    kill: () => {
      try {
        p.kill();
      } catch { /* 已退 */ }
    },
    stdin: { write: (s) => p.stdin.write(s) },
    close: () => {
      try {
        p.stdin.end();
      } catch { /* 已退 */ }
    },
    rpc,
    notify: (method: string, params: unknown) => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

async function handshake(s: McpServer): Promise<void> {
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g2-probe', version: '0' } });
  s.notify('notifications/initialized', {});
  log(`MCP 握手完成 (server pid=${s.pid})`);
}

async function toolCall(s: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }> {
  return (await s.rpc('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
}

/** dag_run → {runId, childPid, logPath}; 响应文本原文进日志。 */
async function dagRun(s: McpServer, task: string): Promise<{ runId: string; childPid: number; logPath: string }> {
  const r = await toolCall(s, 'dag_run', { task });
  const text = r.content.map((c) => c.text).join('\n');
  log(`dag_run 完整响应: ${JSON.stringify(r)}`);
  if (r.isError) fail(`dag_run 起跑被拒: ${text.slice(0, 300)}`);
  const rm = /runId: ([0-9a-f-]{36})/.exec(text);
  const pm = /子进程 pid (\d+)/.exec(text);
  const lm = /日志 ([^\n)]+)/.exec(text);
  if (!rm) fail(`dag_run 响应无 runId: ${text.slice(0, 300)}`);
  const childPid = pm ? Number(pm[1]) : 0;
  if (!childPid) fail(`dag_run 响应无子进程 pid: ${text.slice(0, 300)}`);
  // fail() 是 never, 但 CFA 对这个 if-表达式形没收窄 —— 非空断言与上一行的 fail 语义一致。
  return { runId: rm![1]!, childPid, logPath: lm ? lm[1]! : '' };
}

/** 轮询 runs.db 至终态 (≤10min); 终态那拍把 status 原文落日志。 */
async function waitTerminalDb(runId: string, what: string): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const st = dbGet(runId, 'status');
    if (st && ['done', 'failed', 'cancelled'].includes(st)) {
      const updated = dbGet(runId, 'updated_at');
      log(`${what} ${runId} 终态 status=${st} updated_at=${updated} (盘上 runs.db 原文)`);
      return st;
    }
    if (Date.now() > deadline) fail(`${what} 超时 (10min) 盘上仍未终态: status=${st ?? '(无记录)'}`);
    await Bun.sleep(2000);
  }
}

/** 等子进程完成登记 (owner_pid 写进 runs.db, ≤30s); 与响应 pid 对账。 */
async function waitOwnerPid(runId: string, expectPid: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const p = dbGet(runId, 'owner_pid');
    if (p && p !== 'null' && p !== '0') {
      const owner = Number(p);
      log(`runs.db owner_pid=${owner} (响应子进程 pid=${expectPid}) — ${owner === expectPid ? '一致 ✓' : `不一致 ⚠ (以 db 为准)`}`);
      return owner;
    }
    if (Date.now() > deadline) fail(`30s 内 runs.db 未见属主 pid (子进程没登记?) runId=${runId}`);
    await Bun.sleep(500);
  }
}

function execLogStats(runId: string): { size: number; mode: string; exists: boolean } {
  const p = join(REPO, '.omd', 'continuity', runId, 'exec.log');
  if (!existsSync(p)) return { size: 0, mode: '-', exists: false };
  return { size: statSync(p).size, mode: (statSync(p).mode & 0o777).toString(8), exists: true };
}

/** spec.json 权限位 (SDD §2: 参数经临时文件, argv 不携带 goal 原文; mode 0600 = 不给同机他人读)。 */
function specMode(runId: string): string {
  const p = join(REPO, '.omd', 'continuity', runId, 'spec.json');
  return existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : '-';
}

/** 终态后核验子进程是否自然退出 (dag-exec 在 verifyTerminalPersisted 后 process.exit)。
 *  3s 等待盖过 2s 轮询竞态; 仍活 → 记入待清列表, 探针收尾强清。 */
const pendingCleanup: number[] = [];
async function postTerminalCheck(owner: number, runId: string, tag: string): Promise<void> {
  await Bun.sleep(3000);
  const exited = !alive(owner);
  psEv(`${tag} 终态后 (+3s)`, [owner]);
  if (exited) {
    log(`${tag} 子进程 ${owner} 随终态自然退出 ✓`);
  } else {
    log(`⚠ ${tag} 子进程 ${owner} 终态后仍活 — 记入收尾强清`);
    pendingCleanup.push(owner);
  }
}

// ════════════════════════════════════════════════════════════════════════════
log('== G2 探针起跑 ===================================================');
log(`repo=${REPO} HEAD=${cmd(['git', 'rev-parse', 'HEAD']).out}`);
log(`clone 带入的实现文件 sha256 见 /tmp/g2-sha.txt (与主工作区逐字节一致)`);
log(`预存 server 进程 (环境既有生产, 不触碰): ${cmd(['ps', '-eo', 'pid,cmd'], 10_000).out.split('\n').filter((l) => l.includes('cli.ts mcp')).join(' | ')}`);

// ── 盲检: 观察通道不瞎 ─────────────────────────────────────────────────────
// ① 组信号 (kill -9 -<pgid>) 能杀同组非-detached 子进程 (陪葬可察, 探针不瞎);
// ② detached 子进程 (自有 pgid) 免疫组信号 (存活可察)。
// 注意: 控制进程必须用非阻塞 Bun.spawn 持有 —— spawnSync 会等到子进程退出才返回,
// 拿到 pid 时进程早没了, pgrep 必空 (上一版实测假红 + 白等 6 分钟, 见 /tmp/omd-g2-probe.log 20:20-20:27)。
{
  // ① 同组对: setsid bash 当会话组长 (pgid=自身), 内 sleep 同组; 组信号打组长组 → 两个都得死。
  const ctlA = Bun.spawn(['setsid', 'bash', '-c', 'sleep 180 & wait'], { stdio: ['ignore', 'ignore', 'ignore'] });
  await Bun.sleep(600);
  const ctlASleep = spawnSync('pgrep', ['-P', String(ctlA.pid), 'sleep'], { encoding: 'utf-8' }).stdout.trim();
  log(`盲检①: setsid bash(pid=${ctlA.pid}, 组长) 内非-detached sleep(pid=${ctlASleep || '?'}) 同组`);
  killGroup(ctlA.pid, '盲检①');
  await Bun.sleep(600);
  const aAlive = ctlASleep && alive(Number(ctlASleep));
  log(`盲检①: 组信号后 bash 死=${!alive(ctlA.pid)} sleep=${ctlASleep || '?'} 存活=${aAlive} (期望 false)`);
  if (aAlive) fail('盲检① 红: 组信号没杀掉同组 sleep → kill 机制不可信, 后续断言全无意义');

  // ② detached 对: detached sleep 自有 pgid; 组信号打别人的组 → 它免疫。
  const ctlB = Bun.spawn(['sleep', '180'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  await Bun.sleep(600);
  log(`盲检②: detached sleep pid=${ctlB.pid} pgid=${spawnSync('ps', ['-o', 'pgid=', '-p', String(ctlB.pid)], { encoding: 'utf-8' }).stdout.trim()} (期望 = 自身)`);
  killGroup(ctlA.pid, '盲检② 参照组 (① 的组, 已空)');
  await Bun.sleep(600);
  const bAlive = alive(ctlB.pid);
  log(`盲检②: 组信号 (打别的组) 后 detached sleep=${ctlB.pid} 存活=${bAlive} (期望 true)`);
  if (!bAlive) fail('盲检② 红: detached 子进程被组信号带走 → detached 语义与观察通道不符');
  spawnSync('kill', ['-9', String(ctlB.pid)]); // 清理
  pass('盲检: 组信号杀同组 / detached 免疫, 观察通道区分得开 (不瞎)');
}

// ══ RUN 1: 组信号 (反向敏感路, SDD §5 失败模式) ═══════════════════════════
log('== RUN 1: dag_run → kill -9 -<server_pgid> (组信号) → 子进程存活至落账 ==');
{
  const s1 = spawnServer('server #1 (RUN 1)');
  await handshake(s1);
  const task1 = `G2 probe R1 ${Date.now()}: 用一句话回答你正在执行什么`;
  const { runId, childPid, logPath } = await dagRun(s1, task1);
  const owner1 = await waitOwnerPid(runId, childPid);
  await Bun.sleep(1500);
  const logBefore = execLogStats(runId);
  log(`RUN1 runId=${runId} exec.log=${logPath} 存在=${logBefore.exists} 大小=${logBefore.size} spec 相关目录见 continuity`);
  psEv('RUN1 kill 前', [s1.pid, owner1]);

  log(`RUN1: kill -9 -${s1.pgid} (server 进程组信号) @ ${new Date().toISOString()}`);
  killGroup(s1.pgid, 'RUN1 server 组');
  await Bun.sleep(2000);
  const s1Dead = !alive(s1.pid);
  const child1Alive = alive(owner1);
  psEv('RUN1 kill 后', [s1.pid, owner1]);
  const ppid1 = spawnSync('ps', ['-o', 'ppid=', '-p', String(owner1)], { encoding: 'utf-8' }).stdout.trim();
  log(`RUN1 kill 后: server 死=${s1Dead} 子进程存活=${child1Alive} 子进程 PPID=${ppid1} (原=${s1.pid})`);
  if (!s1Dead) fail(`RUN1: server #1 (${s1.pid}) 组信号后仍活 → 组信号没打到真 server`);
  if (!child1Alive) fail('断言 1: 子进程随 server 组信号陪葬 → detached 没生效 (SDD §5 失败模式现形)');
  if (ppid1 === String(s1.pid)) fail('断言 1b: 子进程 PPID 仍指向死掉的 server → 判活逻辑可疑');
  pass(`RUN1 断言 1: 子进程 ${owner1} 在 server 组信号 (kill -9 -${s1.pgid}) 后仍活 (PPID 重挂 ${ppid1})`);

  const st1 = await waitTerminalDb(runId, 'RUN1');
  const logAfter1 = execLogStats(runId);
  log(`RUN1 exec.log kill 时=${logBefore.size}B → 终态后=${logAfter1.size}B (增长=${logAfter1.size - logBefore.size}B — 子进程在 server 死后继续写)`);
  if (!(logAfter1.size > logBefore.size)) log('⚠ RUN1 exec.log 未增长 (可能终态太快, 不作为红判)');
  const sm1 = specMode(runId);
  log(`RUN1 spec.json mode=${sm1} (期望 600 — 参数经临时文件, argv 不携带 goal 原文, SDD §2)`);
  await postTerminalCheck(owner1, runId, 'RUN1');
  pass(`RUN1 断言 2: 终态 ${st1} 已写穿 runs.db (子进程落账完成)`);
}

// ══ RUN 2: SDD 原文 kill server 进程 + 新 server 读终态 ═══════════════════
log('== RUN 2: dag_run → kill -9 <server_pid> (只杀进程) → 存活至落账 → 新 server 读终态 ==');
let st2 = '';
{
  const s2 = spawnServer('server #2 (RUN 2)');
  await handshake(s2);
  const task2 = `G2 probe R2 ${Date.now()}: 用一句话回答你正在执行什么`;
  const { runId, childPid, logPath } = await dagRun(s2, task2);
  const owner2 = await waitOwnerPid(runId, childPid);
  await Bun.sleep(1500);
  const logBefore2 = execLogStats(runId);
  psEv('RUN2 kill 前', [s2.pid, owner2]);

  log(`RUN2: kill -9 ${s2.pid} (SDD 原文: kill server 进程) @ ${new Date().toISOString()}`);
  spawnSync('kill', ['-9', String(s2.pid)]);
  await Bun.sleep(2000);
  const s2Dead = !alive(s2.pid);
  const child2Alive = alive(owner2);
  psEv('RUN2 kill 后', [s2.pid, owner2]);
  const ppid2 = spawnSync('ps', ['-o', 'ppid=', '-p', String(owner2)], { encoding: 'utf-8' }).stdout.trim();
  log(`RUN2 kill 后: server 死=${s2Dead} 子进程存活=${child2Alive} 子进程 PPID=${ppid2} (原=${s2.pid})`);
  if (!s2Dead) fail(`RUN2: server #2 (${s2.pid}) kill -9 后仍活`);
  if (!child2Alive) fail('断言 1: 子进程随 server 死 → run 陪葬 (detached 没生效)');
  if (ppid2 === String(s2.pid)) fail('断言 1b: 子进程 PPID 仍指向死掉的 server');
  pass(`RUN2 断言 1: 子进程 ${owner2} 在 server kill -9 后仍活 (PPID 重挂 ${ppid2})`);

  st2 = await waitTerminalDb(runId, 'RUN2');
  const logAfter2 = execLogStats(runId);
  log(`RUN2 exec.log kill 时=${logBefore2.size}B → 终态后=${logAfter2.size}B (增长=${logAfter2.size - logBefore2.size}B)`);
  const sm2 = specMode(runId);
  log(`RUN2 spec.json mode=${sm2} (期望 600 — SDD §2)`);
  await postTerminalCheck(owner2, runId, 'RUN2');
  pass(`RUN2 断言 2: 终态 ${st2} 已写穿 runs.db (落账完成)`);

  // 新 server (全新进程, 内存无此 run) → dag_status 必须从盘上读到终态
  const s3 = spawnServer('server #3 (新 server, 读终态)');
  await handshake(s3);
  const statusResp = await toolCall(s3, 'dag_status', { runId });
  const stText = statusResp.content.map((c) => c.text).join('\n');
  log(`RUN2 新 server dag_status 完整响应 JSON: ${JSON.stringify(statusResp)}`);
  if (!stText.includes(`status: ${st2}`)) {
    fail(`断言 3: 新 server (pid=${s3.pid}) dag_status 没读到终态 ${st2}: ${stText.slice(0, 300)}`);
  }
  pass(`断言 3: 新 server (pid=${s3.pid}) dag_status 读到终态 ${st2} (盘上可读, 非内存)`);
  s3.kill();
}

// ── 收尾: 清自己拉起的进程 ───────────────────────────────────────────────────
// 子进程正常应在终态后自行退出 (dag-exec 的 process.exit), 已实测无残留; sweep 是兜底。
// server #1/#2 已被探针自身 kill, #3 已 kill; 这里只处理终态后仍活的子进程 (理论不该有)。
for (const pid of pendingCleanup) {
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
      log(`收尾强清子进程 ${pid}`);
    } catch (e) {
      log(`收尾强清 ${pid} 失败: ${(e as Error).message}`);
    }
  }
}
log(`收尾: 探针拉起的进程已清 (待清列表 ${pendingCleanup.length} 项)`);

log('== G2 完成: 两次真机 kill (组信号 + 单进程), 子进程均存活至落账, 新 server 盘上可读终态 ==');
console.log(`G2 PASS: RUN1 组信号 kill -9 -<server_pgid> 与 RUN2 kill -9 <server_pid> 后 dag-exec 子进程均存活并落账 (终态 ${st2}), 新 server dag_status 读到终态; 证据见 ${LOG}`);
process.exit(0);
