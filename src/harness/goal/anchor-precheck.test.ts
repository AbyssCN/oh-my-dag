/**
 * #147 点火锚预检 —— 判据网 (反向自检: 新闸必须当场证明它会红)。
 *
 * 用两个真临时"仓" (mkdtemp + .git 目录) 而不是 mock stat: 判据的每一跳 (存在性 / toplevel /
 * realpath 归一) 都走真文件系统, mock 会把"闸虚"藏起来。
 *
 * 证伪方式 (实现改成什么样会让这条静默变绿):
 * - 把 toplevel 判定改成"路径字面量相等" → 子路径提及 (repoB/packages/engine) 那条红;
 * - 把"最近存在祖先"那步删了 → 不存在的子路径直接 stat 失败被跳过, 同一条红;
 * - fail-open 忘了 (锚不是 git 仓也报) → 最后一条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAnchorMismatch, gitToplevelOf } from './anchor-precheck';

/** 造一个最小"git 仓": 目录 + .git 子目录 (toplevel 判定只看 .git 存在)。 */
function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omd-anchor-${name}-`));
  mkdirSync(join(dir, '.git'));
  return realpathSync(dir);
}

describe('#147 detectAnchorMismatch', () => {
  const repoA = makeRepo('a');
  const repoB = makeRepo('b');
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'omd-anchor-bare-'))); // 无 .git

  test('goal 提到别仓路径 (含不存在的子路径) → 报锚不匹配, foreign 是 toplevel', () => {
    // B0 的形状: goal 写的是 <别仓>/packages/engine —— 那个子路径在盘上不存在,
    // 判据要靠"最近存在祖先"走到 repoB 才够得着。
    const goal = `在 ${repoB} 仓做一笔回流, 改 ${repoB}/packages/engine/src/core/types.ts`;
    const r = detectAnchorMismatch(goal, repoA);
    expect(r).not.toBeNull();
    expect(r!.anchorRoot).toBe(repoA);
    expect(r!.foreign).toEqual([repoB]);
  });

  test('goal 只提锚仓自己的路径 → 不报 (同仓不是错配)', () => {
    expect(detectAnchorMismatch(`改 ${repoA}/src/index.ts`, repoA)).toBeNull();
  });

  test('goal 提到的路径不在任何 git 仓里 → 不报 (报不出"别仓")', () => {
    expect(detectAnchorMismatch(`看看 ${bare}/notes.md 和 /usr/nonexist/x.md`, repoA)).toBeNull();
  });

  test('锚自己不是 git 仓 → 闸缺席 (fail-open), 哪怕 goal 提了真别仓', () => {
    expect(detectAnchorMismatch(`改 ${repoB}/src/x.ts`, bare)).toBeNull();
  });

  test('gitToplevelOf: 子路径归到 toplevel; 不存在的路径 → null', () => {
    mkdirSync(join(repoA, 'deep', 'nest'), { recursive: true });
    expect(gitToplevelOf(join(repoA, 'deep', 'nest'))).toBe(repoA);
    expect(gitToplevelOf('/no/such/dir/anywhere')).toBeNull();
  });

  test('清理', () => {
    for (const d of [repoA, repoB, bare]) rmSync(d, { recursive: true, force: true });
  });
});
