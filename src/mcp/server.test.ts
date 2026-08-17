/**
 * src/mcp/server.test —— S1 陈旧自检 (SDD 2026-08-10 §2 S1) 反向闸测试。
 *
 * SDD §2 S1 闸: 注入假 sha → 警告行必现; 同 sha → 必无。证伪方式 (每条写死, 临时改生产代码当场红):
 *  - 「假 sha 必现 / 同 sha 必无」: 把 StaleChecker.checkLocked 里 `nowSha !== this.bootSha`
 *    改成恒 true → 「同 sha 必无」红; 改成恒 false → 「假 sha 必现」红。
 *  - 「非仓 fail-open」: 把 bootSha=null 的 early-return 改成 throw/注入 → 本测试红。
 *  - 「脏档降级」: 把 dirty 档改回注入 → 「脏 → 不注入」测试红。
 *  - 「30s 节流」: throttleMs 改 0 → 计数断言红 (30s 是 HUD 新鲜度闸同源档, 不许另立)。
 */
import { describe, expect, test } from 'bun:test';
import { StaleChecker, wrapToolStale, type OmdMcpTool } from './server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { omdRepoRoot } from '../harness/repo-root';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('S1 陈旧自检 (SDD §2 S1)', () => {
  test('同 sha + 工作区干净 → 无警告行 (反向: 比对改恒 true 则本测试红)', () => {
    const chk = new StaleChecker({ headSha: () => SHA_A, worktreeDirty: () => false });
    expect(chk.bootSha).toBe(SHA_A);
    expect(chk.staleLine()).toBeNull();
  });

  test('假 sha (HEAD 漂移) → 警告行必现, SDD §2 原文格式含 (+N commits)', () => {
    let sha = SHA_A;
    const chk = new StaleChecker({
      headSha: () => sha,
      commitsAhead: () => 3,
      worktreeDirty: () => true, // 漂移优先于脏: 脏不影响 stale 判定
    });
    sha = SHA_B;
    expect(chk.staleLine()).toBe(
      `⚠ omd server code is stale: started at ${SHA_A.slice(0, 7)}, disk is now ${SHA_B.slice(0, 7)} (+3 commits). Long-lived runs use in-memory code; reconnect to refresh the shell.`,
    );
  });

  test('ahead 数不出 → 警告行省略 (+N commits) 段', () => {
    let sha = SHA_A;
    const chk = new StaleChecker({ headSha: () => sha, commitsAhead: () => null });
    sha = SHA_B;
    const line = chk.staleLine();
    expect(line).toContain(`disk is now ${SHA_B.slice(0, 7)}.`);
    expect(line).not.toContain('commits');
  });

  test('非仓 (bootSha null) → 永不注入, 即便之后 git 恢复 (fail-open 锁死)', () => {
    let sha: string | null = null;
    const chk = new StaleChecker({ headSha: () => sha });
    sha = SHA_B; // 构造后 git 恢复 —— 也不能注入: boot 时没读到 = 永不再查 (SDD fail-open)
    expect(chk.bootSha).toBeNull();
    expect(chk.staleLine()).toBeNull();
  });

  test('工作区脏但 HEAD 未动 → 降级档不注入 (反向: 脏档改回注入则本测试红)', () => {
    const chk = new StaleChecker({ headSha: () => SHA_A, worktreeDirty: () => true });
    expect(chk.staleLine()).toBeNull();
  });

  test('30s 节流: 窗口内复用不重查, 过期重查 (30s = HUD 同源档)', () => {
    let t = 1_000_000;
    let gitCalls = 0;
    const chk = new StaleChecker({
      headSha: () => {
        gitCalls++;
        return SHA_A;
      },
      worktreeDirty: () => false,
      now: () => t,
    });
    expect(gitCalls).toBe(1); // 构造时 boot 读一次
    chk.staleLine(); // 首次查 → 第 2 次 git
    chk.staleLine(); // 30s 内 → 复用缓存
    expect(gitCalls).toBe(2);
    t += 30_001; // 过期
    chk.staleLine();
    expect(gitCalls).toBe(3);
  });

  test('wrapToolStale: 警告注入结果头部 (第一个 content 块), 无警告原样透传', async () => {
    const tool: OmdMcpTool = {
      name: 't',
      description: 'd',
      inputSchema: {},
      handler: async () => ({ content: [{ type: 'text', text: 'body' }] }),
    };
    let sha = SHA_A;
    const stale = new StaleChecker({ headSha: () => sha, commitsAhead: () => 0 });
    sha = SHA_B;
    const wrapped = wrapToolStale(tool, stale);
    const res = await wrapped.handler({} as never, {} as never);
    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toEqual({ type: 'text', text: expect.stringContaining('⚠ omd server code is stale') });
    expect(res.content[1]).toEqual({ type: 'text', text: 'body' });

    const clean = new StaleChecker({ headSha: () => SHA_A, worktreeDirty: () => false });
    const res2 = await wrapToolStale(tool, clean).handler({} as never, {} as never);
    expect(res2.content).toHaveLength(1);
    expect(res2.content[0]).toEqual({ type: 'text', text: 'body' });
  });
});

describe('#141 真 cwd 语义: 陈旧自检量的是引擎仓, 不是宿主仓', () => {
  test('process.cwd() 指向别的 git 仓时, bootSha 仍是引擎仓 HEAD (证伪: runGit cwd 换回 process.cwd() 即红)', () => {
    // 实测形状 (issue #141): MCP server 被 `cd 宿主仓 && exec bun … mcp` 拉起, 宿主提交 4 个
    // commit → 误报 "omd stale +4"; 而 omd 自己更新反而不报。oracle = 造一个真 git 仓当宿主 cwd。
    const host = mkdtempSync(join(tmpdir(), 'omd-stale-host-'));
    const g = (args: string[]): string =>
      Bun.spawnSync(['git', ...args], { cwd: host, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
    g(['init', '-q']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'host']);
    const hostSha = g(['rev-parse', 'HEAD']);
    const engineSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: omdRepoRoot(), stdout: 'pipe' })
      .stdout.toString().trim();
    expect(hostSha).not.toBe(engineSha); // 前提: 两个仓 HEAD 确实不同, 否则本测量不出方向

    const prev = process.cwd();
    try {
      process.chdir(host);
      const chk = new StaleChecker(); // 全默认 deps = 真 git 路径
      expect(chk.bootSha).toBe(engineSha);
      expect(chk.bootSha).not.toBe(hostSha);
    } finally {
      process.chdir(prev);
      rmSync(host, { recursive: true, force: true });
    }
  });
});
