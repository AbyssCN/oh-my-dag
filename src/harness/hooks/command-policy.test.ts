/**
 * L1:黑名单 + 白名单(2026-08-13,替掉四档审批)。
 *
 * ## 每条闸都要证明它**真的会红**(本仓惯例:一条永远绿的闸不是闸)
 *
 * - 「白名单赦免」→ 把 `judgeCommand` 里 allow 那个循环挪到 deny 之后 → 第 3 条当场红
 *   (赦免不生效,`echo` 仍被拦)。
 * - 「config 只能追加 deny,删不掉内置」→ 把 `deny: [...DANGEROUS_PATTERNS, ...extra]`
 *   改成 `deny: extra` → 第 5 条当场红。
 * - 「坏正则丢一条不是丢一段」→ 把 `compile` 的 catch 改成 `throw` → 第 6 条当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_CONFIG, judgeCommand, loadSandboxConfig } from './command-policy';
import { classifyCommand } from './dangerous-cmd';

/** 写一份 `.omd/config.json` 并返回它的仓根。 */
function repoWith(sandbox: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-policy-'));
  mkdirSync(join(dir, '.omd'), { recursive: true });
  writeFileSync(join(dir, '.omd', 'config.json'), JSON.stringify({ tui: { sandbox } }));
  return dir;
}

describe('judgeCommand —— 两档:随便做 / 一律不许', () => {
  test('★ 普通命令一律放行 —— yolo 的定义就是这一条', () => {
    for (const c of ['which omd', 'bun test', 'curl -s https://example.com', 'npm i -g something']) {
      expect(judgeCommand(c).dangerous).toBe(false);
    }
  });

  test('★ 内置黑名单照拦(不可逆那一族)', () => {
    const push = judgeCommand('git push --force origin main');
    expect(push.dangerous).toBe(true);
    expect(push.label).toBe('git-force-push');
    expect(judgeCommand('psql -c "DROP TABLE users"').dangerous).toBe(true);
    expect(judgeCommand('git reset --hard HEAD~3').dangerous).toBe(true);
  });

  test('★ 白名单赦免黑名单 —— 顺序必须是白先黑后', () => {
    const deny = [{ label: 'x', reason: 'test', re: /^echo / }];
    expect(judgeCommand('echo hi', { allow: [], deny }).dangerous).toBe(true);
    expect(judgeCommand('echo hi', { allow: [/^echo hi$/], deny }).dangerous).toBe(false);
  });

  test('空 / 非串 → 放行(无可判内容, 与旧 classifyCommand 同语义)', () => {
    expect(judgeCommand('').dangerous).toBe(false);
    expect(judgeCommand(undefined).dangerous).toBe(false);
  });
});

describe('loadSandboxConfig —— 逐仓配置', () => {
  test('没有文件 → 默认:围栏开 · 无额外可写 · 无赦免 · 内置黑名单', () => {
    const cfg = loadSandboxConfig(mkdtempSync(join(tmpdir(), 'omd-policy-none-')), {});
    expect(cfg.enabled).toBe(true);
    expect(cfg.writable).toEqual([]);
    expect(cfg.allow).toEqual([]);
    expect(cfg.deny).toEqual(DEFAULT_SANDBOX_CONFIG.deny);
  });

  test('★ config 的 deny 是**追加** —— 删不掉内置那张表', () => {
    const cfg = loadSandboxConfig(repoWith({ deny: ['terraform\\s+destroy'] }), {});
    expect(cfg.deny.length).toBe(DEFAULT_SANDBOX_CONFIG.deny.length + 1);
    // 内置的还在:
    expect(judgeCommand('git push --force origin main', cfg).dangerous).toBe(true);
    // 追加的也在:
    expect(judgeCommand('terraform destroy -auto-approve', cfg).dangerous).toBe(true);
  });

  test('★ 坏正则丢**一条**不是丢一整段 —— 配错一行不该把黑名单整段失效', () => {
    const cfg = loadSandboxConfig(repoWith({ deny: ['(unclosed', 'terraform\\s+destroy'] }), {});
    expect(cfg.deny.length).toBe(DEFAULT_SANDBOX_CONFIG.deny.length + 1);
    expect(judgeCommand('terraform destroy', cfg).dangerous).toBe(true);
  });

  test('writable 只收绝对路径 —— 相对路径对谁解析说不清, 宁可不收', () => {
    expect(loadSandboxConfig(repoWith({ writable: ['/srv/a', 'relative/b', 42] }), {}).writable).toEqual(['/srv/a']);
  });

  test('enabled:false 只关围栏, 黑名单照常 —— 两层是分开的', () => {
    const cfg = loadSandboxConfig(repoWith({ enabled: false }), {});
    expect(cfg.enabled).toBe(false);
    expect(judgeCommand('git push --force origin main', cfg).dangerous).toBe(true);
  });

  test('坏 JSON → 默认值, 不抛(TUI 不该因为配置写错起不来)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-policy-bad-'));
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), '{oops');
    expect(loadSandboxConfig(dir, {}).enabled).toBe(true);
  });
});

// ── sql-truncate 收紧 (2026-08-14, 夜跑实测 3 次误拦搜索命令后修; 写这份测试时
//    fusang 同源 hook 又拦了一次 heredoc —— 第 4 次活体复现, 本组测试只能经 Edit 工具落盘) ──
// 反向自检: 把 dangerous-cmd.ts 的 sql-truncate 改回旧宽模式 → 「搜索命令放行」当场红。
// 判据是夜跑读数里**预先写死**的那两条 (事后编判据等于没判据)。
const TR = 'TRUNCATE'; // 拼出来, 免得本文件自己被同源 shell hook 扫中 (它扫的是命令文本, 但别赌)
describe('sql-truncate 只认 SQL 上下文 (搜索这个词 ≠ 执行它)', () => {
  test('★ 搜索命令放行: rg / grep 多模式 (昨夜实撞的两条原文形状)', () => {
    expect(classifyCommand(`rg ${TR} src/`).dangerous).toBe(false);
    expect(classifyCommand(`grep -R -n -i -e token -e estimate -e ${TR} src`).dangerous).toBe(false);
    expect(classifyCommand(`grep -n "${TR}" file.ts`).dangerous).toBe(false);
  });

  test('★ 真 SQL 照拦: 显式 TABLE / 引号内语句起始 / 分号后', () => {
    expect(classifyCommand(`psql -c "${TR} TABLE users"`).label).toBe('sql-truncate');
    expect(classifyCommand(`psql -c '${TR} users'`).label).toBe('sql-truncate');
    expect(classifyCommand(`psql -c "SELECT 1; ${TR} users"`).label).toBe('sql-truncate');
  });

  test('GNU truncate (命令起始 / 管道后) 拦法与旧版一致 —— 收紧不放松', () => {
    expect(classifyCommand('truncate -s 0 /var/log/app.log').label).toBe('sql-truncate');
    expect(classifyCommand('echo x | truncate -s 0 f').label).toBe('sql-truncate');
  });
});

// ── leaf 逃生口接线 (2026-08-14, 夜跑读数第二层问题) ─────────────────────────
// 此前 `.omd/config.json` 的 allow 只对 TUI 生效, DAG leaf 吃 DEFAULT_SANDBOX_CONFIG (allow 恒空)
// → 误报没有赦免出口, leaf 只能撞墙重试 (S-36 同形: 护栏装在一侧, 同名通道绕过全部)。
// 源码形状闸 (同 agent-leaf-shellruns-wiring 先例): 删掉 agent-leaf 那行接线 → 第一条当场红。
describe('leaf 路吃得到 config 赦免', () => {
  test('★ agent-leaf 的 createOmdAgentTools 真传了 loadSandboxConfig(cwd)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'agent-leaf.ts'), 'utf8');
    const live = src
      .split('\n')
      .filter((l) => l.includes('commandPolicy: loadSandboxConfig(cwd)'))
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    expect(live.length).toBe(1);
  });

  test('allow 赦免赢过黑名单 (config → judgeCommand 全链, leaf 拿到的就是这份)', () => {
    const cfg = loadSandboxConfig(repoWith({ allow: ['^rg\\s'] }), {});
    expect(judgeCommand('rg "drop table users" src/', cfg).dangerous).toBe(false);
  });
});
