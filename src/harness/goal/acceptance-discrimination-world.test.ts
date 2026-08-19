/**
 * 判别力探针的**反面世界**与**逐段判** (#204, 承 #199 D1/D2)。
 *
 * ## 这条网钉的是什么
 *
 * 账本读数逼出来的: 348 跑里真跑过探针的 69 跑, 这道闸**红过 0 次** (3 次 demoted 全是空世界
 * 自检打的, why 逐字 `[vacuous]`)。66/66 零方差 —— 而本仓自己的话是「一个在任何干预下都不动
 * 的数, 通常量的是尺子, 不是被测物」。
 *
 * 尺子错在两处, 本文件各钉一条:
 *  · **世界造错了** —— 原来是 `mkdtemp` 空目录 + 一个样本文件。任何仓内判据在空目录里必然失败,
 *    于是探针恒判「分得出」。它量的是「这条命令在仓外会不会挂」, 答案恒为「会」。
 *  · **整条判** —— `A && B && C` 只要有一段强, 整条就"分得出", 弱段被强段背书。#165 的
 *    `grep -q "反向自检" <本次要产出的测试文件>` 正是这样溜过去的。
 *
 * ## 为什么用真 git 仓
 *
 * 同 `run-landed.test.ts`: 这两条的价值都在「对真仓判得准」。拿注入的假 runner 去测世界怎么造,
 * 测的是我对 `git archive` 的记忆。故主路真 `git init`; 注入面只用来钉逐段判的形状。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDiscrimination, splitCriterionSegments } from './acceptance-gate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (root: string, args: string[]): void => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr).trim()}`);
};

/** 起一个真仓: HEAD 上有 `gate.txt` (含「反向自检」四个字) 与 `impl.txt` (正确实装)。 */
function repoAtHead(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-negworld-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'gate.txt'), '// 反向自检: 破坏 X 这条会红\n');
  writeFileSync(join(root, 'impl.txt'), 'OK\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'head']);
  return root;
}

/** 单段求值 —— 在给定 cwd 上**真读盘**, 于是"世界造成什么样"是可观测的。 */
const runOne = (seg: string, cwd: string): number => {
  if (seg === 'has-gate') return existsSync(join(cwd, 'gate.txt')) && readFileSync(join(cwd, 'gate.txt'), 'utf8').includes('反向自检') ? 0 : 1;
  if (seg === 'impl-ok') return existsSync(join(cwd, 'impl.txt')) && readFileSync(join(cwd, 'impl.txt'), 'utf8').trim() === 'OK' ? 0 : 1;
  return 1;
};

/**
 * 假 shell: 按 `&&` **短路**求值, 与真 shell 语义一致。
 *
 * ⚠ 第一版这里写的是 `command.startsWith('has-gate')` —— 于是整条 `has-gate && impl-ok` 被当成
 * 单条 `has-gate` 求值, 两条用例因此红了。**替身不按被替代物的语义走, 测出来的红绿就都不作数** ——
 * 记一笔, 这跟本文件在钉的是同一种病 (量的是尺子)。
 */
const runner = async ({ command, cwd }: { command: string; cwd: string }): Promise<{ exitCode: number | null }> => {
  for (const seg of command.split('&&').map((s) => s.trim())) {
    const code = runOne(seg, cwd);
    if (code !== 0) return { exitCode: code };
  }
  return { exitCode: 0 };
};

describe('#204 反面世界 = 真仓副本 (D1)', () => {
  test('给了 repoRoot → 世界里有 HEAD 的文件 (空目录形态下它们根本不存在)', async () => {
    const root = repoAtHead();
    // `has-gate` 只在世界里真有 gate.txt 时退 0。空目录世界 → 恒 1 → 探针恒判「分得出」,
    // 那正是 #199 量到的病。真副本世界 → 退 0 → 探针这才看得见「这条判据什么都没证明」。
    const v = await probeDiscrimination('has-gate', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    // ★ 反向自检 (已实测会红): 把 buildNegativeWorld 里 repoRoot 那一支去掉 (恒返空目录)
    //   → 这条变成 status 'ok', 当场红。
    expect(v.status).toBe('ring');
  });

  test('不给 repoRoot → 退回空目录形态 (fail-open, 行为与 #204 之前逐字一致)', async () => {
    const v = await probeDiscrimination('has-gate', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner });
    expect(v.status).toBe('ok'); // 空目录里 gate.txt 不存在 → 命令失败 → "分得出"
  });

  test('repoRoot 不是 git 仓 → 也退回空目录, 不抛 (探针是加固不是前置条件)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'omd-negworld-nogit-'));
    dirs.push(bare);
    const v = await probeDiscrimination('has-gate', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: bare });
    expect(v.status).toBe('ok');
  });

  test('反面样本**覆盖**在真副本之上 —— 世界 = HEAD 且恰好一处坏掉', async () => {
    const root = repoAtHead();
    // impl.txt 被样本改坏 → `impl-ok` 在这个世界里失败 ⇒ 这条判据真的分得出。
    const v = await probeDiscrimination('impl-ok', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    expect(v.status).toBe('ok');
    // 而没被样本碰过的 gate.txt 仍是 HEAD 的样子 —— 这才叫"恰好一处坏掉"。
    const v2 = await probeDiscrimination('has-gate', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    expect(v2.status).toBe('ring');
  });
});

describe('#204 逐段判 (D2)', () => {
  test('切分: 按裸 && 切, 去空白与空段', () => {
    expect(splitCriterionSegments('a && b&&c ')).toEqual(['a', 'b', 'c']);
    expect(splitCriterionSegments('  solo  ')).toEqual(['solo']);
  });

  /**
   * **这条就是 #165 的复现**: 判据 = `grep 一个字面串` && `真会红的命令`。整条在反面世界里失败
   * (因为后半段红了), 所以探针放行 —— 今天到此为止, 而那条 grep 段在任何代码下都退 0。
   * 逐段判之后它必须被点名。
   */
  test('★ #165 复现: 整条分得出, 而 grep 那段零判别力 → 必须点名', async () => {
    const root = repoAtHead();
    const v = await probeDiscrimination('has-gate && impl-ok', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    // 整条: has-gate 过 (0) 但 impl-ok 红 (1) → 整条非 0 → 裁决仍是 ok, 判据收下。
    expect(v.status).toBe('ok');
    // ★ 反向自检 (已实测会红): 把 probeDiscrimination 里的 weakSegments 调用去掉 (改回整条判)
    //   → weak 恒 undefined, 下面两条同时红。
    // 先断言 status 再收窄: 上面那条 expect 保证走得到这里, 所以 if 不会让断言静默跳过。
    if (v.status !== 'ok') throw new Error(`期望 ok, 实得 ${v.status}`);
    expect(v.weak).toEqual(['has-gate']);
    expect(v.weak).not.toContain('impl-ok'); // 真在证事的那段不许被误报
  });

  test('单段判据不跑逐段 (逐段结果就是整条结果, 再跑一遍是白花一次命令的钱)', async () => {
    const root = repoAtHead();
    const v = await probeDiscrimination('impl-ok', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    expect(v.status).toBe('ok');
    if (v.status !== 'ok') throw new Error('unreachable');
    expect(v.weak).toBeUndefined();
  });

  test('整条也过 → 仍是 ring, 且弱段一并带出 (裁决不受逐段影响, 逐段只加信息)', async () => {
    const root = repoAtHead();
    // 两段都在真副本世界里过 → 整条过 → ring; 两段都该被点名。
    const v = await probeDiscrimination('has-gate && has-gate', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: runner, repoRoot: root });
    expect(v.status).toBe('ring');
    if (v.status === 'ring') expect(v.weak).toEqual(['has-gate', 'has-gate']);
  });

  test('段跑不起来 ≠ 该段没判别力 (抛错的段不记 —— 把"没跑成"读成"没判别力"是拿猜当事实)', async () => {
    const root = repoAtHead();
    const boom = async ({ command, cwd }: { command: string; cwd: string }) => {
      if (command === 'has-gate') throw new Error('段炸了');
      return runner({ command, cwd });
    };
    const v = await probeDiscrimination('has-gate && impl-ok', { path: 'impl.txt', content: 'BROKEN' }, 0, { runIn: boom, repoRoot: root });
    // 整条那次不抛 (boom 只在**恰好等于** 'has-gate' 时抛, 整条是 'has-gate && impl-ok'),
    // 于是整条走假 shell → impl-ok 红 → 裁决 ok。逐段时 has-gate 那段才抛。
    expect(v.status).toBe('ok');
    if (v.status !== 'ok') throw new Error('unreachable');
    // ★ 这条钉的是: 抛掉的那段**不记为弱段**。把"没跑成"读成"没判别力"就是拿猜当事实。
    //   反向自检 (已实测会红): 把 weakSegments 的 catch 改成 `weak.push(seg)` → 这条红。
    expect(v.weak).toBeUndefined();
  });
});
