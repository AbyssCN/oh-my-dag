/**
 * **git 写操作闸:两条执行路共用同一份判据** (#239, 2026-08-23)。
 *
 * ## 病灶 (实账, 不是假想)
 *
 * run `5ec238df` 交付 #228 时, agent 节点跑了 `git checkout HEAD -- <files>` 当 stash 用来
 * "跑 baseline 对照", 未留副本 → 四个文件的实装**全部丢失**, 该跑作废。
 *
 * 而同一条命令写在 command 节点里是**跑不了的**: `commandBlockReason` ②.6 早就有一道
 * git 只读子命令闸, 注释逐字写着「`git checkout .` 会抹掉 DAG 刚写的文件」。
 *
 * 两条路当时用的是**方向相反**的判据:
 *   · command 节点 = 白名单 (默认拒, 只放行 `GIT_READONLY_SUBCOMMANDS`);
 *   · agent 节点   = 黑名单 (`judgeCommand` + `DEFAULT_SANDBOX_CONFIG`, 默认放行)。
 * 黑名单实测认识 `git reset --hard`, **不认识 `checkout` / `restore`** —— 而这三条对
 * 「抹掉本跑还没提交的写入」是等效的。黑名单必然如此: 它要穷举危险, 而写法不止一种。
 *
 * ## 这条为什么特别坏
 *
 * 它不留痕。写集对账只看**最终盘面**, 写了又被还原 = 看起来什么都没发生, 写穿核验照报
 * `consistent`。要不是那个节点在收尾报告里自己交代, 这次丢失根本查不出来。
 *
 * ## 这份网钉的是什么
 *
 * 不是"agent 那侧也有一道闸" (那还会漂成两份), 是**两处调用同一个导出**:
 * `gitWriteBlockReason` 一份判据、一份判词, 两条路逐字相同。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  GIT_READONLY_SUBCOMMANDS,
  commandBlockReason,
  gitWriteBlockReason,
  gitWriteBlockReasonForLink,
} from './command-leaf';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';

const bashTool = (root: string): AnyOmdTool =>
  createOmdAgentTools({ cwd: root }).find((t) => t.name === 'bash')!;
const runBash = (root: string, command: string): Promise<unknown> =>
  bashTool(root).execute('call-1', { command } as never, undefined, undefined) as Promise<unknown>;

/** 抹掉「本跑刚写、还没提交」的文件 —— 三种写法等效, 一条都不能漏。 */
const WRITE_CMDS = [
  'git checkout HEAD -- src/harness/dag/engine.ts',
  'git checkout .',
  'git restore src/harness',
];

/** command 节点上 `commandBlockReason` 走 dangerous 闸, 不走 git-write 闸 ——
 *  这层防御**更早**且判词格式不同 (test 3 单独断言逐字相等的部分不收它们)。 */
const DANGEROUS_CMDS = [
  'git reset --hard HEAD~1',
  'git push --force origin main',
  'git branch -D main',
];

/** 2026-09-01 owner 显式放开闸后被允许的写子命令 —— 反向自检, 改回拒会红。 */
const ALLOWED_WRITE_CMDS = [
  'git add src/harness/command-leaf.ts',
  'git add -u',
  'git commit -m wip',
  'git commit --amend --no-edit',
];

/** 只读侦察 —— 执行体的日常, 一条都不许误伤。 */
const READONLY_CMDS = ['git status', 'git log --oneline -5', 'git diff --stat', 'git rev-parse HEAD'];

describe('#239 git 写闸: agent 节点与 command 节点同一份判据', () => {
  it('★ agent 节点的 bash 拒掉"抹掉本跑写入"的写法 (commit 流放行后, 闸仍拦真毁灭性的)', async () => {
    // 怎么让它红 (实装前): agent bash 只过 `judgeCommand` 黑名单, 实测
    // `git checkout HEAD -- <f>` / `git checkout .` / `git restore <p>` 判决全是 dangerous:false
    // → 三条全放行, 这里三条断言全红。
    // 2026-09-01 owner 开口放闸后, `add` / `commit` 已放行; 但 `checkout .` / `restore` /
    // `reset --hard` / `push --force` / `branch -D main` 仍必拒。
    const root = mkdtempSync(join(tmpdir(), 'omd-gitgate-'));
    for (const cmd of WRITE_CMDS) {
      await expect(runBash(root, cmd), `应拒: ${cmd}`).rejects.toThrow(/blocked git-write/);
    }
  });

  it('★ 2026-09-01 owner 显式放开的 commit 流子命令在 agent 节点仍放行 (闸不是一刀切)', async () => {
    // 反向自检: 把 `add` / `commit` 从 `GIT_READONLY_SUBCOMMANDS` 删掉 → 这一条当场红。
    const root = mkdtempSync(join(tmpdir(), 'omd-gitgate-add-'));
    for (const cmd of ALLOWED_WRITE_CMDS) {
      // 临时目录不是 git 仓 / 没文件 → 命令本身会以非 0 退出 —— 那是命令的事, 闸不该在它之前拦。
      // 判据只有一条: **不抛 BLOCKED**。
      await runBash(root, cmd);
    }
  });

  it('★ 只读子命令在 agent 节点仍放行 (闸不是一刀切)', async () => {
    // 反向自检: 把 `GIT_READONLY_SUBCOMMANDS` 清空 → 这一条当场红。
    // 没有这一条, "拒得对不对"就退化成"拒得够不够狠", 而那是把执行体的手砍掉。
    const root = mkdtempSync(join(tmpdir(), 'omd-gitgate-ro-'));
    for (const cmd of READONLY_CMDS) {
      // 临时目录不是 git 仓, 命令本身会以 128 退出 —— 那是命令的事, 闸不该在它之前拦。
      // 判据只有一条: **不抛 BLOCKED**。
      await runBash(root, cmd);
    }
    expect(GIT_READONLY_SUBCOMMANDS.length).toBeGreaterThan(0);
  });

  it('★ 两条路的判词逐字相同 —— 同一个导出, 不是两份会漂的文案', () => {
    // 怎么让它红: 在 agent 那侧另写一句自己的判词 (哪怕只差一个标点), 这条即红。
    // 钉的是「同一份」而不是「都有」—— 两份判词必然随时间漂成两个意思。
    for (const cmd of WRITE_CMDS) {
      const viaCommandLeaf = commandBlockReason(cmd, DEFAULT_COMMAND_ALLOWLIST);
      const viaShared = gitWriteBlockReason(cmd);
      expect(viaShared, `共用判据必须拒: ${cmd}`).not.toBeNull();
      expect(viaCommandLeaf, `command 节点判词应逐字等于共用判据: ${cmd}`).toBe(viaShared);
    }
  });

  it('★ 拆段: 藏在链尾的 git 写操作也要被看见', () => {
    // 怎么让它红: 共用判据只看整串首 token → `ls && git checkout .` 的首 token 是 `ls`,
    // 闸看不见尾环, 直接放行。agent 那条路的凭证检查早就按 `;&|` 拆段了 (agent-tools.ts:812),
    // 同一条命令串里两道闸拆法不一致本身就是缺陷。
    expect(gitWriteBlockReason('ls -la && git checkout .')).toMatch(/blocked git-write/);
    expect(gitWriteBlockReason('echo hi ; git restore src')).toMatch(/blocked git-write/);
    // 只读的链不受影响。
    expect(gitWriteBlockReason('ls -la && git status')).toBeNull();
    // 2026-09-01 放开闸后, commit 流子命令即使藏在链尾也放行 (闸不再拦)。
    expect(gitWriteBlockReason('ls -la && git add .')).toBeNull();
    expect(gitWriteBlockReason('echo hi ; git commit -m x')).toBeNull();
  });

  it('★ 真毁灭性写法在两条路上都必拒 (一层闸不够, 多层互不漂移)', () => {
    // `reset --hard` / `push --force` / `branch -D main` 走的是 dangerous 闸 (`classifyCommand`),
    // 不走 git-write 闸 —— 但两条路都必须拒。
    for (const cmd of DANGEROUS_CMDS) {
      const viaCommandLeaf = commandBlockReason(cmd, DEFAULT_COMMAND_ALLOWLIST);
      const viaShared = gitWriteBlockReason(cmd);
      expect(viaCommandLeaf, `command 节点必拒: ${cmd}`).toMatch(/blocked/);
      // agent 那条对 `push --force` 等可能走 dangerous 闸也走 git-write 闸 —— 任一层拒即可。
      expect(viaCommandLeaf ?? viaShared, `任一层必须拒: ${cmd}`).toMatch(/blocked/);
    }
  });

  it('★ 单段版判据: 非 git 命令一律不管 (闸只管自己那一格)', () => {
    // 怎么让它红: 把判据写成"命令串里出现 checkout 就拒" → `echo checkout` 被误伤, 这条红。
    expect(gitWriteBlockReasonForLink('bun test')).toBeNull();
    expect(gitWriteBlockReasonForLink('echo git checkout .')).toBeNull(); // 首 token 是 echo
    expect(gitWriteBlockReasonForLink('git status')).toBeNull();
    expect(gitWriteBlockReasonForLink('git -C /repo status')).toBeNull(); // 带值全局 flag 要跳过
    expect(gitWriteBlockReasonForLink('git -C /repo checkout .')).toMatch(/blocked git-write/);
  });
});
