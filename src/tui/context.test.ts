/**
 * L1 判据:conductor 上下文装配(TUI SDD §5.3,切片 S4)。
 *
 * 三条,SDD 点名的:正向(两份都在、顺序对)· **反向**(改名之后它必须不在)·
 * 回归钉(`loadProjectContext` 自己没被顺手动过)。
 *
 * `home` 从外面注入 —— 不注入的话这个函数会读到跑测试那台机器上的真 `~/.claude/CLAUDE.md`,
 * 断言就成了"取决于谁在跑"。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectContext } from '../harness/agent-leaf';
import { findRepoRoot, formatContextLine, loadConductorContext } from './context';

/**
 * 造一个临时世界:`<world>/home/.claude/CLAUDE.md` + `<world>/repo/{.git,.claude/CLAUDE.md}`。
 * @returns `{ home, repo }`
 */
function makeWorld(opts: { projectHarness?: boolean; agentsMd?: boolean } = {}) {
  const world = mkdtempSync(join(tmpdir(), 'omd-tui-ctx-'));
  const home = join(world, 'home');
  const repo = join(world, 'repo');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'GLOBAL-HARNESS-BODY');
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (opts.projectHarness !== false) {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), 'PROJECT-HARNESS-BODY');
  }
  if (opts.agentsMd) writeFileSync(join(repo, 'AGENTS.md'), 'AGENTS-BODY');
  return { world, home, repo };
}

describe('loadConductorContext (§5.2)', () => {
  test('★ 正向: 全局与项目两份 harness 都进来了, 且项目那份在后 (后者覆盖前者)', () => {
    const { home, repo } = makeWorld();
    const files = loadConductorContext(repo, { home });
    const bodies = files.map((f) => f.content);
    expect(bodies).toContain('GLOBAL-HARNESS-BODY');
    expect(bodies).toContain('PROJECT-HARNESS-BODY');
    expect(bodies.indexOf('GLOBAL-HARNESS-BODY')).toBeLessThan(bodies.indexOf('PROJECT-HARNESS-BODY'));
  });

  test('★ 反向: 把 .claude/CLAUDE.md 改名 → 它必须不在返回值里(证明这条闸会红)', () => {
    const { home, repo } = makeWorld();
    // 先证明它本来在 —— 否则"改名后不在"可能只是它从来就没在过。
    expect(loadConductorContext(repo, { home }).map((f) => f.content)).toContain('PROJECT-HARNESS-BODY');
    renameSync(join(repo, '.claude', 'CLAUDE.md'), join(repo, '.claude', 'CLAUDE.md.bak'));
    const after = loadConductorContext(repo, { home });
    expect(after.map((f) => f.content)).not.toContain('PROJECT-HARNESS-BODY');
    // 缺席不是错误: 全局那份照常在。
    expect(after.map((f) => f.content)).toContain('GLOBAL-HARNESS-BODY');
  });

  test('中间那段仍走既有的向上链 (AGENTS.md 进得来, 且夹在全局与项目之间)', () => {
    const { home, repo } = makeWorld({ agentsMd: true });
    const bodies = loadConductorContext(repo, { home }).map((f) => f.content);
    expect(bodies).toEqual(['GLOBAL-HARNESS-BODY', 'AGENTS-BODY', 'PROJECT-HARNESS-BODY']);
  });

  test('不是 git 仓 → 没有项目 harness 这一档, 不报错', () => {
    const world = mkdtempSync(join(tmpdir(), 'omd-tui-ctx-bare-'));
    const home = join(world, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'GLOBAL-ONLY');
    expect(loadConductorContext(join(world, 'nowhere-in-particular'), { home }).map((f) => f.content)).toEqual([
      'GLOBAL-ONLY',
    ]);
  });

  test('同一个文件被两条路命中时只留一份', () => {
    const { repo } = makeWorld();
    // home 就是仓根的极端情形: 全局档与项目档指向同一个绝对路径。
    const files = loadConductorContext(repo, { home: repo });
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('★ 回归钉: 没有顺手动到 leaf 那条冻结前缀', () => {
  // 这条钉的是 SDD §5.2 的整个理由 —— 改 loadProjectContext = 全 leaf prompt-cache 失效。
  // 反向自检: 若把 loadConductorContext 实现成"改 CONTEXT_FILE_NAMES 加 .claude/CLAUDE.md",
  // 下面这条会当场红 (loadProjectContext 会开始返回项目 harness)。
  test('loadProjectContext 只认目录下的 AGENTS/CLAUDE, 看不见 .claude/CLAUDE.md', () => {
    const { repo } = makeWorld();
    expect(loadProjectContext(repo)).toEqual([]);
  });

  test('loadProjectContext 对 AGENTS.md 的行为不变', () => {
    const { repo } = makeWorld({ agentsMd: true });
    expect(loadProjectContext(repo).map((f) => f.content)).toEqual(['AGENTS-BODY']);
  });
});

describe('findRepoRoot', () => {
  test('★ 找不到 .git 时返回 null, 不是返回 cwd —— 两者不是一回事', () => {
    expect(findRepoRoot(mkdtempSync(join(tmpdir(), 'omd-tui-nogit-')))).toBeNull();
  });

  test('从子目录往上找得到仓根', () => {
    const { repo } = makeWorld();
    const deep = join(repo, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(repo);
  });
});

describe('formatContextLine —— 一份都没有时说真话', () => {
  test('★ 0 份时说的是"未找到", 不是编一个"已就绪"', () => {
    expect(formatContextLine([], { cwd: '/x', home: '/h' })).toBe('harness 0 份 (未找到 AGENTS.md / CLAUDE.md)');
  });

  test('cwd 内的路径显示成相对, home 内的显示成 ~', () => {
    const line = formatContextLine(
      [
        { path: '/h/.claude/CLAUDE.md', content: '' },
        { path: '/x/.claude/CLAUDE.md', content: '' },
      ],
      { cwd: '/x', home: '/h' },
    );
    expect(line).toBe('harness 2 份: ~/.claude/CLAUDE.md, .claude/CLAUDE.md');
  });

  test('超过 4 份时折成 +N, 不把一行撑爆', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `/x/f${i}.md`, content: '' }));
    expect(formatContextLine(files, { cwd: '/x', home: '/h' })).toBe('harness 7 份: f0.md, f1.md, f2.md, f3.md, +3');
  });
});
