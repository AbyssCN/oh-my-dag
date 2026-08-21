/**
 * **后台 run 到底脱没脱离会话**(2026-08-21,P3 那跑莫名其妙没了之后补)。
 *
 * ## 为什么真起进程
 *
 * 这条判据的全部内容就是**内核给不给这个子进程一个自己的会话**,而那件事在源码字符串上
 * 看不出来:`Bun.spawn(...)` 加不加 `detached` 组出来的调用长得几乎一样,
 * 跑起来一个抗组信号一个不抗。所以判据是 `ps` 上的 **pgid / sid 读数**,
 * 同 `shell-sandbox.test.ts` 那条理由。
 *
 * ## 现场
 *
 * `defaultSpawnDetached` 的注释一直写着 "Bun.spawn detached",而实装**只有 `unref()`**。
 * 两者是两件事:
 *   · `unref()` 只让母进程的事件循环不等它;
 *   · `detached: true` 才让子进程自成会话与进程组。
 * 单变量实测(第三方发信号,两个方向都量):只 unref → 组信号把它连坐杀掉;
 * 加 detached → 存活。
 *
 * ⚠ 本文件**不**断言"P3 那跑就是这么死的" —— 那条我查不出硬证据(进程死亡不留痕,
 * dmesg 无 OOM 记录)。这里只钉住一件独立成立的事:声明面说脱离,实装面就得真脱离。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSpawnDetached } from '../../src/mcp/tools/goal';

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) {
    try {
      process.kill(p, 9);
    } catch {
      /* 已经没了 */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `ps` 读一个 pid 的 pgid / sid。读不到 → null(进程已退)。 */
function psGroups(pid: number): { pgid: number; sid: number } | null {
  const r = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'pgid=,sid=', '--no-headers']);
  const out = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0 || !out) return null;
  const [pgid, sid] = out.split(/\s+/).map(Number);
  return pgid !== undefined && sid !== undefined ? { pgid, sid } : null;
}

describe('defaultSpawnDetached —— 真脱离, 不是只 unref', () => {
  test('★ 起出来的子进程是**自己的会话首领** (pid === pgid === sid)', async () => {
    // 怎么让它红: 把 `detached: true` 从 defaultSpawnDetached 里删掉 →
    // pgid 变成本测试进程的 pid、sid 变成本测试进程的会话, 两条断言同时红。
    // 那正是 2026-08-21 之前的实装。
    const dir = mkdtempSync(join(tmpdir(), 'omd-detached-'));
    dirs.push(dir);
    const pid = defaultSpawnDetached(['bash', '-c', 'sleep 20'], { cwd: dir, logPath: join(dir, 'log', 'out.log') });
    expect(pid).toBeGreaterThan(0);
    pids.push(pid!);
    // spawn 之后内核设置 pgid/sid 有极短窗口, 给一拍。
    await Bun.sleep(200);
    const g = psGroups(pid!);
    expect(g).not.toBeNull();
    expect(g!.pgid).toBe(pid!); // 自己是进程组首领 —— 组信号打不到它头上
    expect(g!.sid).toBe(pid!); // 自己是会话首领 —— 会话拆除的 SIGHUP 也带不走它
  });

  test('★ 反面锚: 本测试进程自己**不是**会话首领 —— 否则上面那条是空断言', async () => {
    // 没有这条, 上面那条在"整个测试进程恰好就是会话首领"的机器上会假绿。
    const g = psGroups(process.pid);
    expect(g).not.toBeNull();
    expect(g!.sid).not.toBe(process.pid);
  });

  test('日志文件目录会被建出来 (logPath 的父目录不存在也不该炸)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-detached-log-'));
    dirs.push(dir);
    const logPath = join(dir, 'a', 'b', 'out.log');
    const pid = defaultSpawnDetached(['bash', '-c', 'echo hello'], { cwd: dir, logPath });
    pids.push(pid!);
    await Bun.sleep(300);
    expect(readFileSync(logPath, 'utf8')).toContain('hello');
  });
});

// ── 防再漏: 全仓「自称 detached 的 spawn」必须真传 detached ─────────────────────────
//
// 这次的实况不是"大家都忘了", 是**三处对、三处漏**: dag-tools.ts / session/final-spawn.ts /
// scripts/session-continuity-hook.ts 一直传着, 而 mcp/tools/goal.ts 与 pathfinder/dispatch.ts
// 的两处没传。一个正确写法在仓里存在三份、仍然漏掉三处 —— 靠 review 看不出来,
// 因为漏的地方**长得和对的地方几乎一样**(差一个字段)。
//
// 所以这条是**源码级**闸而不是行为级: 行为级要真起六个进程, 而这里要防的是"下次又漏一处"。
describe('全仓闸: 调了 unref() 的 spawn 必须同时传 detached', () => {
  const SITES = [
    'src/mcp/tools/goal.ts',
    'src/mcp/tools/dag-tools.ts',
    'src/harness/pathfinder/dispatch.ts',
    'src/harness/session/final-spawn.ts',
    'scripts/session-continuity-hook.ts',
  ];

  test('★ 每个 spawn(...).unref() 的调用块里都出现 detached: true', () => {
    // 怎么让它红: 从上面任一文件里删掉一个 `detached: true` → 这条点名那个文件, 红。
    // 判据取"块内": 从 `spawn(` 到配对的 `unref()` 之间那段文本必须含 detached。
    const offenders: string[] = [];
    for (const rel of SITES) {
      const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8');
      // 每个 unref() 往前回溯到最近的 spawn( —— 中间那段就是它的选项块。
      for (const m of src.matchAll(/\.unref\(\)/g)) {
        const before = src.slice(0, m.index);
        const spawnAt = Math.max(before.lastIndexOf('spawn('), before.lastIndexOf('spawn ('));
        if (spawnAt < 0) continue; // 不是 spawn 出来的 (如 timer.unref()) — 不归本闸管
        const block = before.slice(spawnAt);
        // 只管**进程** spawn: timer/interval 的 unref 不在此列。
        if (!/stdio|stdout|stdin|stderr/.test(block)) continue;
        if (!/detached:\s*true/.test(block)) offenders.push(`${rel} (unref@${m.index})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
