#!/usr/bin/env bun
/**
 * /tmp/ab-snapshot.ts —— DAG-native(headless conductor)vs direct(TUI conductor)A/B 第一把尺子。
 *
 * **只读**:不写仓内任何文件。sqlite 库先 copy 到 mkdtemp 再开(WAL 里有未 checkpoint 的数据,
 * 直接开会动 -shm/-wal;copy 三件套后在副本上读,原库一个字节不动)。
 *
 * 取数口径(每格都能指回来源):
 *   · 会话/轮数/模型调用/token/cacheHit → `.omd/chat/<scope>/*.jsonl` 的 assistant 消息自带 `usage`
 *     (pi Session 条目;换算同 `src/harness/agent-leaf.ts::mapSessionUsage`:in = input + cacheRead)
 *   · 派图数 + runId → 同上文件里 `role=toolResult && toolName∈{omd_run,omd_solve}` 的回执首行
 *   · 图状态 → `.omd/runs.db` 的 `omd_runs.status`
 *   · 图节点/图侧 token → `.omd/dag-runs.db` 的 `omd_dag_runs.{node_count,usage}`(按 run_id 关联)
 *   · 交叉校验 → `.omd/tui-usage.jsonl`(逐笔 provider 调用账本)
 *
 * 臂的判定**只用数据里看得见的东西**,不靠记忆:
 *   A(DAG-first / headless):会话 id 是 v4 UUID(`conductor_chat` 的 randomUUID)且手面 ⊆ {read,ls,grep}
 *   B(direct / TUI 六只手):会话 id == 'tui'(2026-08-09 前写死的 TUI 默认 id)或 `s-<秒>-<pid>`
 *   C(判不了):其余(人手命名的 id —— TUI 的 `/session new X` 与 `omd serve`(零只手)都可能产生)
 *
 * 用法:bun /tmp/ab-snapshot.ts [repoRoot]   (默认 /home/nick/repos/oh-my-dag)
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.argv[2] ?? '/home/nick/repos/oh-my-dag';
const OMD = join(REPO, '.omd');
/** 本仓纪律:算不出来的格子写「无数据」,不编 0(NULL ≠ 0 ≠ 不适用)。 */
const NA = '无数据';

// ── 只读地打开 sqlite:copy db + -wal + -shm 到临时目录 ────────────────────────
function openSnapshot(name: string): Database | null {
  const src = join(OMD, name);
  if (!existsSync(src)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'absnap-'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(src + suffix)) copyFileSync(src + suffix, join(dir, basename(src) + suffix));
  }
  return new Database(join(dir, basename(src)));
}

// ── 会话解析 ──────────────────────────────────────────────────────────────────
type Arm = 'A-headless(DAG-first)' | 'B-tui(direct)' | 'C-未判定';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TUI_DEFAULT_ID = /^(tui|s-\d+-\d+)$/;
const READ_ONLY_HANDS = new Set(['read', 'ls', 'grep']);
const WRITE_HANDS = new Set(['write', 'edit', 'bash']);

interface SessionStat {
  file: string;
  id: string;
  title: string;
  createdAt: number;
  arm: Arm;
  turns: number;              // role=user 的条目数 = owner 说了几句
  modelCalls: number;         // 带 usage 的 assistant 条目数 = 打了几次 provider
  tools: Record<string, number>;
  handsUsed: string[];        // 观察到的手(read/ls/grep/write/edit/bash)
  usedWriteHand: boolean;
  input: number;              // 未命中缓存的输入
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;               // pi 自带价表算的 `usage.cost.total`(与 omd 账本的 costUsd 不同源,见报告 §边界)
  reasoning: number;          // 思考 token(计在 output 之外的一列)
  dispatched: string[];       // 本会话派出的 runId
}

function scopeDirs(): string[] {
  const chat = join(OMD, 'chat');
  if (!existsSync(chat)) return [];
  return readdirSync(chat)
    .map((d) => join(chat, d))
    .filter((p) => statSync(p).isDirectory());
}

function classify(id: string, tools: Record<string, number>): Arm {
  const names = Object.keys(tools);
  const noWrite = names.every((n) => !WRITE_HANDS.has(n));
  if (UUID_V4.test(id) && noWrite && names.every((n) => READ_ONLY_HANDS.has(n) || n.startsWith('omd_')))
    return 'A-headless(DAG-first)';
  if (TUI_DEFAULT_ID.test(id)) return 'B-tui(direct)';
  return 'C-未判定';
}

function parseSession(path: string): SessionStat | null {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const header = JSON.parse(lines[0]!) as { kind?: string; id?: string; createdAt?: number; metadata?: { title?: string } };
  if (header.kind !== 'header') return null;
  const s: SessionStat = {
    file: basename(path),
    id: header.id ?? '(无 id)',
    title: header.metadata?.title ?? '',
    createdAt: header.createdAt ?? 0,
    arm: 'C-未判定',
    turns: 0, modelCalls: 0, tools: {}, handsUsed: [], usedWriteHand: false,
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, reasoning: 0, dispatched: [],
  };
  for (const line of lines.slice(1)) {
    const e = JSON.parse(line) as { type?: string; message?: Record<string, unknown> };
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message as {
      role?: string;
      toolName?: string;
      content?: unknown;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } };
    };
    if (m.role === 'user') s.turns++;
    if (m.role === 'assistant') {
      const u = m.usage;
      if (u) {
        s.modelCalls++;
        s.input += u.input ?? 0;
        s.cacheRead += u.cacheRead ?? 0;
        s.cacheWrite += u.cacheWrite ?? 0;
        s.output += u.output ?? 0;
        s.reasoning += u.reasoning ?? 0;
        s.cost += u.cost?.total ?? 0;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content as { type?: string; name?: string }[]) {
          if (b.type === 'toolCall' && b.name) s.tools[b.name] = (s.tools[b.name] ?? 0) + 1;
        }
      }
    }
    if (m.role === 'toolResult' && (m.toolName === 'omd_run' || m.toolName === 'omd_solve')) {
      const text = Array.isArray(m.content)
        ? (m.content as { text?: string }[]).map((c) => c.text ?? '').join('')
        : '';
      // 回执首行 `runId: <id>` 是钉死的形状(src/mcp/tools/chat.ts::collectRunIds 同一条)
      const hit = text.startsWith('[TOOL ERROR]') ? null : text.match(/^runId:\s*(\S+)/m);
      if (hit) s.dispatched.push(hit[1]!);
    }
  }
  s.handsUsed = Object.keys(s.tools).filter((n) => READ_ONLY_HANDS.has(n) || WRITE_HANDS.has(n)).sort();
  s.usedWriteHand = s.handsUsed.some((n) => WRITE_HANDS.has(n));
  s.arm = classify(s.id, s.tools);
  return s;
}

// ── 账本(交叉校验用)────────────────────────────────────────────────────────
interface UsageRow { ts: number; model: string; source: string; in: number; out: number; cacheHit?: number; costUsd?: number; unpriced?: boolean }
function readLedger(): UsageRow[] {
  const p = join(OMD, 'tui-usage.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as UsageRow);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const sessions: SessionStat[] = [];
for (const dir of scopeDirs()) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const s = parseSession(join(dir, f));
    if (s) sessions.push(s);
  }
}
sessions.sort((a, b) => a.createdAt - b.createdAt);

const runsDb = openSnapshot('runs.db');
const dagDb = openSnapshot('dag-runs.db');
type RunRow = { run_id: string; status: string; goal: string; meta: string; created_at: string; updated_at: string; owner_pid: number | null };
const allRuns: RunRow[] = runsDb ? (runsDb.query('select run_id,status,goal,meta,created_at,updated_at,owner_pid from omd_runs').all() as RunRow[]) : [];
const runById = new Map(allRuns.map((r) => [r.run_id, r]));
/**
 * **db 里的 `status` 不是最终判词**:`src/mcp/run-registry.ts::hydrate` 在装载时把
 * 「running/pending 但属主 pid 已不存活」判为 `failed`(注释原话:不许原样恢复 running)。
 * 这里照抄同一条,否则完成率会把一堆早死的 run 记成"还在跑"。
 */
const alive = (pid: number | null): boolean => {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const derivedStatus = (id: string): string => {
  const r = runById.get(id);
  if (!r) return NA;
  const orphaned = (r.status === 'running' || r.status === 'pending') && !alive(r.owner_pid);
  return orphaned ? `failed(属主 pid ${r.owner_pid ?? '?'} 已不在;db 里仍写 ${r.status})` : r.status;
};
type DagRow = { id: string; run_id: string | null; plan_name: string; node_count: number; entry: string | null; usage: string; created_at: number; nodes: string };
const allDags: DagRow[] = dagDb ? (dagDb.query('select id,run_id,plan_name,node_count,entry,usage,created_at,nodes from omd_dag_runs').all() as DagRow[]) : [];
const dagsByRun = new Map<string, DagRow[]>();
for (const d of allDags) if (d.run_id) dagsByRun.set(d.run_id, [...(dagsByRun.get(d.run_id) ?? []), d]);

const ARMS: Arm[] = ['A-headless(DAG-first)', 'B-tui(direct)', 'C-未判定'];
const pct = (num: number, den: number): string => (den === 0 ? NA : `${((num / den) * 100).toFixed(1)}%`);

console.log(`# A/B 快照 —— DAG-native vs direct   (生成于 ${new Date().toISOString()})`);
console.log(`repo: ${REPO}\n`);

console.log('## 1. 逐会话原始读数(.omd/chat/<scope>/*.jsonl)\n');
console.log('| 会话 id | 臂 | 轮数 | 模型调用 | 用过的手 | 写手? | input | cacheRead | cacheWrite | output | 派图 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of sessions) {
  console.log(
    `| \`${s.id.slice(0, 12)}\` | ${s.arm} | ${s.turns} | ${s.modelCalls} | ${s.handsUsed.join(',') || '—'} | ${s.usedWriteHand ? '是' : '否'} | ${s.input} | ${s.cacheRead} | ${s.cacheWrite} | ${s.output} | ${s.dispatched.length} |`,
  );
}

console.log('\n## 2. 两臂快照表\n');
console.log('| 指标 | ' + ARMS.join(' | ') + ' |');
console.log('|---|' + ARMS.map(() => '---').join('|') + '|');
const cells: [string, (list: SessionStat[]) => string][] = [
  ['会话数 n', (l) => String(l.length)],
  ['轮数(owner 发言)', (l) => (l.length ? String(l.reduce((a, s) => a + s.turns, 0)) : NA)],
  ['模型调用数', (l) => (l.length ? String(l.reduce((a, s) => a + s.modelCalls, 0)) : NA)],
  ['平均每轮调用数', (l) => {
    const t = l.reduce((a, s) => a + s.turns, 0);
    return t === 0 ? NA : (l.reduce((a, s) => a + s.modelCalls, 0) / t).toFixed(1);
  }],
  ['token in (=input+cacheRead)', (l) => (l.length ? String(l.reduce((a, s) => a + s.input + s.cacheRead, 0)) : NA)],
  ['token out', (l) => (l.length ? String(l.reduce((a, s) => a + s.output, 0)) : NA)],
  ['cacheWrite', (l) => (l.length ? String(l.reduce((a, s) => a + s.cacheWrite, 0)) : NA)],
  ['cacheHit 率 (cacheRead/in)', (l) => pct(l.reduce((a, s) => a + s.cacheRead, 0), l.reduce((a, s) => a + s.input + s.cacheRead, 0))],
  ['reasoning token', (l) => (l.length ? String(l.reduce((a, s) => a + s.reasoning, 0)) : NA)],
  ['pi 价表算的 cost', (l) => (l.length ? `$${l.reduce((a, s) => a + s.cost, 0).toFixed(4)}` : NA)],
  ['用过写手的会话数', (l) => (l.length ? String(l.filter((s) => s.usedWriteHand).length) : NA)],
  ['派图数(转录可追)', (l) => (l.length ? String(l.reduce((a, s) => a + s.dispatched.length, 0)) : NA)],
];
for (const [label, fn] of cells) {
  console.log(`| ${label} | ` + ARMS.map((a) => fn(sessions.filter((s) => s.arm === a))).join(' | ') + ' |');
}
// 图完成率单独一行:分母 = 该臂转录里可追的 runId 数
console.log(
  '| 图完成率(done/派图) | ' +
    ARMS.map((a) => {
      const ids = sessions.filter((s) => s.arm === a).flatMap((s) => s.dispatched);
      if (ids.length === 0) return NA;
      const done = ids.filter((id) => derivedStatus(id) === 'done').length;
      return `${done}/${ids.length} = ${pct(done, ids.length)}`;
    }).join(' | ') + ' |',
);
console.log(
  '| 有 dag-runs 记录的图 | ' +
    ARMS.map((a) => {
      const ids = sessions.filter((s) => s.arm === a).flatMap((s) => s.dispatched);
      if (ids.length === 0) return NA;
      return `${ids.filter((id) => dagsByRun.has(id)).length}/${ids.length}`;
    }).join(' | ') + ' |',
);

console.log('\n## 3. 各臂派出的图(.omd/runs.db + .omd/dag-runs.db)\n');
console.log('| runId | 臂 | 来源会话 | 判定 status | dag-runs 行 | node_count | 图侧 usage |');
console.log('|---|---|---|---|---|---|---|');
const claimed = new Set<string>();
for (const s of sessions) {
  for (const id of s.dispatched) {
    claimed.add(id);
    const ds = dagsByRun.get(id) ?? [];
    const u = ds.length ? (JSON.parse(ds[ds.length - 1]!.usage) as Record<string, number>) : null;
    console.log(
      `| \`${id.slice(0, 8)}\` | ${s.arm} | \`${s.id.slice(0, 8)}\` | ${derivedStatus(id)} | ${ds.length} | ${ds.length ? ds.map((d) => d.node_count).join('+') : NA} | ${u ? `conductor ${u.conductorIn}/${u.conductorOut} · leaves ${u.leavesIn}/${u.leavesOut} (cache ${u.leavesCacheHit})` : NA} |`,
    );
  }
}

console.log('\n## 4. 孤儿图(runs.db 里有、任何转录都追不到)\n');
console.log('> 成因已核:`runChatTurn` 的会话文件在**一轮跑成之后**才建/追加(半轮不入库),');
console.log('> 所以「派完图、这一轮随后报错」= 图在账上、转录里没有。派图数因此是**下界**。\n');
console.log('| runId | 判定 status | created_at | meta | goal 首 60 字 |');
console.log('|---|---|---|---|---|');
// 只列与会话同期(最早会话当天之后)的;更早的是本 A/B 之前的历史 run
const earliestDay = sessions.length ? new Date(sessions[0]!.createdAt).toISOString().slice(0, 10) : '';
for (const r of allRuns) {
  if (claimed.has(r.run_id)) continue;
  if (earliestDay && r.created_at.slice(0, 10) < earliestDay) continue;
  console.log(`| \`${r.run_id.slice(0, 8)}\` | ${derivedStatus(r.run_id)} | ${r.created_at.slice(0, 10)} ${r.created_at.slice(11, 19)} | ${r.meta} | ${r.goal.replace(/\n/g, ' ').slice(0, 60)} |`);
}

console.log('\n## 5. 账本交叉校验(.omd/tui-usage.jsonl)\n');
const ledger = readLedger();
const bySource = new Map<string, { rows: number; in: number; out: number; cache: number; cost: number }>();
for (const r of ledger) {
  const k = `${r.source}/${r.model}`;
  const acc = bySource.get(k) ?? { rows: 0, in: 0, out: 0, cache: 0, cost: 0 };
  acc.rows++; acc.in += r.in; acc.out += r.out; acc.cache += r.cacheHit ?? 0; acc.cost += r.costUsd ?? 0;
  bySource.set(k, acc);
}
console.log(`账本共 ${ledger.length} 行,时间跨度 ${ledger.length ? new Date(ledger[0]!.ts).toISOString() : NA} → ${ledger.length ? new Date(ledger[ledger.length - 1]!.ts).toISOString() : NA}\n`);
console.log('| source/model | 行数 | in | out | cacheHit | costUsd |');
console.log('|---|---|---|---|---|---|');
for (const [k, v] of [...bySource.entries()].sort()) {
  console.log(`| ${k} | ${v.rows} | ${v.in} | ${v.out} | ${v.cache} | $${v.cost.toFixed(4)} |`);
}
// 会话文件 vs 账本对账(只对 source='chat' 的那部分 —— 其余 source 无会话归属)
const chatLedger = ledger.filter((r) => r.source === 'chat' && !r.model.startsWith('fixture:'));
const chatIn = chatLedger.reduce((a, r) => a + r.in, 0);
const chatOut = chatLedger.reduce((a, r) => a + r.out, 0);
console.log(`\nsource='chat'(非 fixture)合计: rows=${chatLedger.length} in=${chatIn} out=${chatOut}`);
console.log('对照会话文件同期合计,可核「账本口径 in = input + cacheRead」是否成立。');

console.log('\n## 6. 对账:会话文件 ↔ 账本\n');
console.log('| 对象 | 来源 | 调用数 | in | out | cacheHit |');
console.log('|---|---|---|---|---|---|');
const armB = sessions.filter((s) => s.arm === 'B-tui(direct)');
const armA = sessions.filter((s) => s.arm === 'A-headless(DAG-first)');
const line = (label: string, src: string, calls: number, i: number, o: number, c: number) =>
  console.log(`| ${label} | ${src} | ${calls} | ${i} | ${o} | ${c} |`);
line('B 臂(tui 会话)', '会话文件 usage', armB.reduce((a, s) => a + s.modelCalls, 0), armB.reduce((a, s) => a + s.input + s.cacheRead, 0), armB.reduce((a, s) => a + s.output, 0), armB.reduce((a, s) => a + s.cacheRead, 0));
line("B 臂", "账本 source='chat' 非 fixture", chatLedger.length, chatIn, chatOut, chatLedger.reduce((a, r) => a + (r.cacheHit ?? 0), 0));
line('A 臂(headless 会话)', '会话文件 usage', armA.reduce((a, s) => a + s.modelCalls, 0), armA.reduce((a, s) => a + s.input + s.cacheRead, 0), armA.reduce((a, s) => a + s.output, 0), armA.reduce((a, s) => a + s.cacheRead, 0));
// A 臂在账本上被标 engine(2026-08-09 15:55 前 mcp 分支的已知贴错标),只能按 conductor 座的 model 拢
const conductorModel = 'kimi-coding:k3';
const engConductor = ledger.filter((r) => r.source === 'engine' && r.model === conductorModel);
line(`账本 source='engine' & model=${conductorModel}`, '(含孤儿轮 + escalation 座)', engConductor.length, engConductor.reduce((a, r) => a + r.in, 0), engConductor.reduce((a, r) => a + r.out, 0), engConductor.reduce((a, r) => a + (r.cacheHit ?? 0), 0));
console.log('\n差额 = 账本里有、A 臂转录里没有的 conductor 调用(孤儿轮 + 非对话位的同座调用)。');
