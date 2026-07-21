/**
 * test/core/hud-statusline.test.ts — omd-hud opt-in 安装单测。
 *
 * 覆盖: 全新写入 · 保留既有 key (非破坏 merge) · 幂等 (已装→already) · 坏 JSON 拒绝覆盖 ·
 * 顶层非对象拒绝 · 绝对路径命令 · installHudStatusLine 注入 fs 全路径。
 */
import { describe, expect, test } from 'bun:test';
import { hudStatusLineCommand, installHudStatusLine, mergeHudStatusLine } from '../../src/harness/init/hud-statusline';

const REPO = '/home/x/repos/oh-my-dag';

describe('mergeHudStatusLine', () => {
  test('null (无文件) → 全新, statusLine 就位, alreadyInstalled=false', () => {
    const r = mergeHudStatusLine(null, REPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyInstalled).toBe(false);
    const obj = JSON.parse(r.content);
    expect(obj.statusLine.type).toBe('command');
    expect(obj.statusLine.command).toBe(`bun run ${REPO}/scripts/omd-hud.ts`);
    expect(obj.statusLine.refreshInterval).toBe(2);
  });

  test('非破坏 merge: 保留既有其余 key', () => {
    const existing = JSON.stringify({ permissions: { allow: ['Bash(bun test)'] }, env: { FOO: '1' } });
    const r = mergeHudStatusLine(existing, REPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const obj = JSON.parse(r.content);
    expect(obj.permissions.allow).toEqual(['Bash(bun test)']);
    expect(obj.env.FOO).toBe('1');
    expect(obj.statusLine.command).toContain('omd-hud.ts');
  });

  test('幂等: 已是 omd-hud → alreadyInstalled=true', () => {
    const first = mergeHudStatusLine(null, REPO);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = mergeHudStatusLine(first.content, REPO);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyInstalled).toBe(true);
  });

  test('既有别的 statusLine → 覆盖为 omd-hud 但非幂等', () => {
    const existing = JSON.stringify({ statusLine: { type: 'command', command: '~/other.sh' } });
    const r = mergeHudStatusLine(existing, REPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyInstalled).toBe(false);
    expect(JSON.parse(r.content).statusLine.command).toContain('omd-hud.ts');
  });

  test('坏 JSON → ok:false, 拒绝覆盖', () => {
    const r = mergeHudStatusLine('{ not valid json', REPO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('非法 JSON');
  });

  test('顶层非对象 (数组) → ok:false', () => {
    const r = mergeHudStatusLine('[1,2,3]', REPO);
    expect(r.ok).toBe(false);
  });
});

describe('installHudStatusLine (注入 fs)', () => {
  test('新装: ensureDir + write settings.local.json', () => {
    const writes: Record<string, string> = {};
    const dirs: string[] = [];
    const r = installHudStatusLine(REPO, {
      readFile: () => null,
      writeFile: (p, c) => { writes[p] = c; },
      ensureDir: (d) => dirs.push(d),
    });
    expect(r.status).toBe('installed');
    expect(r.path).toBe(`${REPO}/.claude/settings.local.json`);
    expect(dirs).toContain(`${REPO}/.claude`);
    expect(JSON.parse(writes[r.path]!).statusLine.command).toBe(hudStatusLineCommand(REPO));
  });

  test('已装 → already, 不写', () => {
    const existing = mergeHudStatusLine(null, REPO);
    if (!existing.ok) throw new Error('setup');
    let wrote = false;
    const r = installHudStatusLine(REPO, {
      readFile: () => existing.content,
      writeFile: () => { wrote = true; },
      ensureDir: () => {},
    });
    expect(r.status).toBe('already');
    expect(wrote).toBe(false);
  });

  test('坏既有文件 → failed, 不写 (不吞用户内容)', () => {
    let wrote = false;
    const r = installHudStatusLine(REPO, {
      readFile: () => '{bad',
      writeFile: () => { wrote = true; },
      ensureDir: () => {},
    });
    expect(r.status).toBe('failed');
    expect(wrote).toBe(false);
  });

  test('写抛错 → failed (不冒泡)', () => {
    const r = installHudStatusLine(REPO, {
      readFile: () => null,
      writeFile: () => { throw new Error('EACCES'); },
      ensureDir: () => {},
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('EACCES');
  });
});
