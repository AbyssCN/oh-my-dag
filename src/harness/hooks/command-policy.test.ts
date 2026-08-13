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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_CONFIG, judgeCommand, loadSandboxConfig } from './command-policy';

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
