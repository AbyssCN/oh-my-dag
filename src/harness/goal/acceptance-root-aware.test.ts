/**
 * C-2 (片 2) —— acceptance 闸 root-aware (D-3)。
 *
 * 三条 INV (GWT 字面照搬契约 §C-2):
 *   · INV-5 有 root 启用包 + 一致闸: 分类时刻与运行期同一份包语义
 *   · INV-6 缺 root 字节兼容: 既有单参调用行为与今天逐字节相同
 *   · INV-7 探针世界 per-root: 自证探针不再错拒包词
 *
 * tmpdir 残留由 afterEach 的 rmSync 收, 与 language-consistency.test.ts 同款姿势;
 * INV-7 用真 git 仓起反面世界, 与 acceptance-discrimination-world.test.ts 同款姿势。
 *
 * **反向自检**每条都钉死: 把 per-root 那条分支拿掉 (退回 base) → INV-5 / INV-7 必红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceCommandBlockReason, probeDiscrimination } from './acceptance-gate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-acceptance-root-'));
  dirs.push(root);
  return root;
}

/** 与 acceptance-discrimination-world.test.ts 同款的 git 起仓姿势: HEAD 上落文件, commit, 收进 dirs 收尾。 */
const git = (root: string, args: string[]): void => {
  const r = Bun.spawnSync(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr).trim()}`);
};

/** 起一个含 `pyproject.toml` 的真 git 仓, 路径收进 dirs 自动清理。 */
function repoWithPyproject(): string {
  const root = freshRoot();
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  writeFileSync(join(root, 'placeholder.txt'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'add pyproject']);
  return root;
}

describe('INV-5: 有 root 启用包 + 一致闸', () => {
  test('pyproject.toml 仓 + pytest -q → null (python 包启用, 一致闸放行)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');
    // 2026-08-29: 加了 missing-bin 那道之后, 这条必须**注入 PATH** —— 否则它量的是
    // 「跑测试这台机器装没装 pytest」(本机就没装), 而它要量的是语言一致闸。
    // 一个随机器变的断言不是断言 (本仓 §加尺子: 量的会变成尺子)。
    writeFileSync(join(root, 'pytest'), '');

    const block = acceptanceCommandBlockReason('pytest -q', { root, env: { PATH: root } });

    expect(block).toBeNull();
  });

  test('★ pyproject.toml 仓 + bun test x.test.ts → 拒因非 null 且含 package.json (lang-mismatch 闸)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');

    const block = acceptanceCommandBlockReason('bun test x.test.ts', { root });

    expect(block).not.toBeNull();
    expect(block!).toContain('package.json');
    // ★ 反向自检 (已实测会红): 把 acceptanceCommandBlockReason(opts.root) 那条分支去掉
    //   (改回恒走 DEFAULT_COMMAND_ALLOWLIST) → bun 在 base, allowlist 放过 → 这条 expect 红。
  });

  test('★ package.json 仓 + pytest -q → 拒因非 null 且含 pyproject.toml (lang-mismatch 闸)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '');

    const block = acceptanceCommandBlockReason('pytest -q', { root });

    expect(block).not.toBeNull();
    expect(block!).toContain('pyproject.toml');
    // ★ 反向自检: 同上, 改回 base 路线 → pytest 在 js 包不在 base, allowlist 拒,
    //   但拒因是 'not-allowed' 不含 pyproject.toml → 这条 expect 红。
  });

  test('package.json 仓 + bun test x.test.ts → null (js 包启用, 一致闸放行)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '');
    expect(acceptanceCommandBlockReason('bun test x.test.ts', { root })).toBeNull();
  });

  test('pyproject.toml 仓 + grep -q x f → null (base 词不被一致闸判)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '');
    expect(acceptanceCommandBlockReason('grep -q x f', { root })).toBeNull();
  });
});

describe('INV-6: 缺 root 字节兼容', () => {
  test('不带 root: pytest -q → not-allowed (与改前逐字相同)', () => {
    expect(acceptanceCommandBlockReason('pytest -q')).toContain('not-allowed');
  });

  test('不带 root: bun test → null (与改前逐字相同)', () => {
    expect(acceptanceCommandBlockReason('bun test')).toBeNull();
  });

  test('不带 root: 元字符闸仍在原位 → shell-metachar', () => {
    expect(acceptanceCommandBlockReason('bun test; echo done')).toContain('shell-metachar');
  });

  test('不带 root: 危险命令闸仍在原位 → dangerous', () => {
    expect(acceptanceCommandBlockReason('bun test; rm -rf /')).toContain('dangerous');
  });

  test('不带 root: git 写子命令闸仍在原位 → git-write', () => {
    expect(acceptanceCommandBlockReason('git commit -am x')).toContain('git-write');
  });

  test('不带 root: 空命令闸仍在原位 → empty', () => {
    expect(acceptanceCommandBlockReason('   ')).toContain('empty');
  });

  test('opts={} (空对象, 等价于无 root) → 与单参调用逐字相同', () => {
    expect(acceptanceCommandBlockReason('pytest -q', {})).toContain('not-allowed');
    expect(acceptanceCommandBlockReason('pytest -q', {})).toBe(acceptanceCommandBlockReason('pytest -q'));
  });
});

describe('INV-7: 探针世界 per-root (defaultProbeRunner 用 allowlistForRoot(cwd))', () => {
  test('★ pyproject.toml 仓 + pytest -q → 探针不被闸拒 (per-root allowlist 生效)', async () => {
    // 不传 runIn → 走 defaultProbeRunner; 反面世界 = repoRoot git archive 出的副本 (含 pyproject.toml)。
    // defaultProbeRunner 内: allowlist = allowlistForRoot(world.cwd) = base ∪ python bins, 含 pytest → 闸放行。
    const repoRoot = repoWithPyproject();
    const v = await probeDiscrimination(
      'pytest -q',
      { path: 'placeholder.txt', content: 'broken' },
      0,
      { repoRoot },
    );

    // 关键断言: 不是 DISCRIM_BLOCKED (那条 why 含 "闸拒") —— 那只在 pytest 不在 allowlist 时触发。
    // ★ 反向自检 (已实测会红): 把 defaultProbeRunner 里的 allowlistForRoot(cwd) 改回 [...DEFAULT_COMMAND_ALLOWLIST]
    //   → pytest 不在 base → commandBlockReason 拒 → exitCode = -1 → DISCRIM_BLOCKED → status='fail_open', why 含 "闸拒"。
    if (v.status === 'fail_open') {
      expect(v.why).not.toContain('闸拒');
    }
    // 真跑场景下 pytest 大概率 not found (127 ≠ expectExit=0), 走 status='ok';
    // pytest 安装且跑通 → status='ring' (但这条用例是错答案样本, 不会让 pytest 绿)。
    // 两种都说明「没被闸拒」, 关键反向自检落在上一条 expect。
    expect(['ok', 'ring']).toContain(v.status);
  });

  test('pyproject.toml 仓 + pytest -q, 注入 fake runner: runner 收到的 cwd 确实含 pyproject.toml', async () => {
    // 辅助钉子: 让测试与 INV-7 的"per-root"语义对齐 —— runner 看到的 cwd 必须是真有 marker 的世界,
    // 而不是一个空目录; 否则 per-root 也救不回 (空目录根本无 marker)。
    //
    // 注: probeDiscrimination 在 finally 里 rmSync(dir, ...) 收世界 —— seenCwd 在调用返回后已不存在。
    // 所以"含 pyproject.toml"必须在调用时 (spy 闭包内) 记下来, 不能事后 existsSync。
    const repoRoot = repoWithPyproject();
    let seenHasPyproject = false;
    let seenCwdNonEmpty = false;
    const spy = async ({ command, cwd: c }: { command: string; cwd: string }): Promise<{ exitCode: number | null }> => {
      seenCwdNonEmpty = c.length > 0;
      seenHasPyproject = existsSync(join(c, 'pyproject.toml'));
      return { exitCode: 0 };
    };
    await probeDiscrimination('pytest -q', { path: 'placeholder.txt', content: 'broken' }, 0, { runIn: spy, repoRoot });
    expect(seenCwdNonEmpty).toBe(true);
    expect(seenHasPyproject).toBe(true);
  });
});

describe('INV-8: 判据的 bin 必须真的存在 (2026-08-29, code80 逼出来的第三道)', () => {
  // 反向自检: 把 acceptanceCommandBlockReason 末尾那行 missingBinaryBlockReason 删掉 → 前两条当场红。
  //
  // 为什么挂在这一层: 空世界自检问「它会不会误绿」, 判别力探针问「错答案骗不骗得过它」,
  // 两道都不问「它有没有可能绿」。bin 不存在 = 恒红 = 活干对了也过不了。
  // 实测触发面: 本次补 marker 让 25 个 bench 仓拿到 pytest, 其中 21 个镜像根本没装 pytest。
  test('marker 仓 + pytest, 但 PATH 上没有 pytest → 拒 (missing-bin)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    const why = acceptanceCommandBlockReason('pytest -q', { root, env: { PATH: root } });
    expect(why).toContain('missing-bin');
    expect(why).toContain('pytest');
  });

  test('同一条命令, PATH 上有 pytest → 放行 (拒的是缺席, 不是这个词)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest]');
    writeFileSync(join(root, 'pytest'), '');
    expect(acceptanceCommandBlockReason('pytest -q', { root, env: { PATH: root } })).toBeNull();
  });

  test('拒因顺序: 缺 marker 时先报 lang-mismatch (信息量更大), 不被 missing-bin 盖掉', () => {
    const root = freshRoot(); // 无任何 marker
    const why = acceptanceCommandBlockReason('pytest -q', { root, env: { PATH: root } });
    expect(why).toContain('lang-mismatch');
  });

  test('INV-6 不受影响: 不给 root 的单参调用不做 PATH 判定', () => {
    // 无 root 那支是纯语法闸 —— 逐字兼容是它的构造保证, 环境事实不该混进来。
    expect(acceptanceCommandBlockReason('bun test')).toBeNull();
  });
});
