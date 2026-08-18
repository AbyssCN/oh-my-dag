/**
 * `loadProjectContext` 的两条 2026-08-18 变更(owner 裁):
 *  ① `.claude/CLAUDE.md` 进名单 —— 加之前本仓根目录一份都没命中(说明书住在 `.claude/` 里),
 *     "给叶子喂项目说明书"这个机制在本仓从来没生效过,而且**没有症状**;
 *  ② 走到 `$HOME` 就停 —— `~/.claude/CLAUDE.md` 是人的全局 harness(身份/派遣/安全底线),
 *     不是仓库说明书;喂给叶子等于把 `a426e09` 从 conductor 拆掉的东西从后门放回来。
 *
 * 反向自检(2026-08-18 真跑过):
 *  - 把 `.claude/CLAUDE.md` 从 `CONTEXT_FILE_NAMES` 删掉 → 第一条红;
 *  - 把 `if (dir === home) break;` 删掉 → **第一、二、三条一起红**。红得比预期宽, 而红得对:
 *    bun 的 tmpdir 在 `~/.cache/tmp` 下, 于是走过假 home 之后还会走到**真** `$HOME`,
 *    把真的 `~/.claude/CLAUDE.md` 收进来 —— 这条证伪顺手证明了那份全局 harness 此前
 *    确实在叶子的可达范围内, 不是我推的。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectContext } from './agent-leaf';

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'omd-fakehome-'));
  repo = join(home, 'repos', 'proj');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('loadProjectContext', () => {
  test('★ 仓根只有 .claude/CLAUDE.md(本仓的真实形状)→ 读到它', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '项目说明书');
    const got = loadProjectContext(repo, 8, home);
    expect(got.map((f) => f.path)).toEqual([join(repo, '.claude', 'CLAUDE.md')]);
    expect(got[0]?.content).toBe('项目说明书');
  });

  test('★ 同级 AGENTS.md 优先(每级只取第一个命中, 名单顺序就是优先级)', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '住 .claude 的那份');
    writeFileSync(join(repo, 'AGENTS.md'), '仓根那份');
    expect(loadProjectContext(repo, 8, home).map((f) => f.path)).toEqual([join(repo, 'AGENTS.md')]);
  });

  test('★ 走到 $HOME 就停 —— ~/.claude/CLAUDE.md 是人的 harness, 不是仓库说明书', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '全局身份与派遣纪律');
    writeFileSync(join(repo, 'AGENTS.md'), '仓根那份');
    const paths = loadProjectContext(repo, 8, home).map((f) => f.path);
    expect(paths).toEqual([join(repo, 'AGENTS.md')]);
    expect(paths.some((p) => p.startsWith(home + '/.claude'))).toBe(false);
  });

  test('★ 多级都有 → 外层在前(近的覆盖远的, 顺序就是覆盖顺序)', () => {
    writeFileSync(join(repo, 'AGENTS.md'), '仓根');
    writeFileSync(join(repo, 'src', 'AGENTS.md'), '子目录');
    expect(loadProjectContext(join(repo, 'src'), 8, home).map((f) => f.content)).toEqual(['仓根', '子目录']);
  });

  test('一份都没有 → 空数组(缺席不是错误)', () => {
    expect(loadProjectContext(repo, 8, home)).toEqual([]);
  });
});
