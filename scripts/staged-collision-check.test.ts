/**
 * staged-collision-check 的判据自证(T-4,2026-08-28)。
 *
 * 被测的是纯函数 `collide` —— 两侧(暂存集、台账)都是入参,所以造得出真仓造不出来的格。
 *
 * ## 反向自检(真跑过)
 * · 把 `writeSessions >= 2` 放宽成 `>= 1` → ★② 红(自己一个人写的文件也被报成碰撞,
 *   而一条总是误报的闸会被人关掉 —— 那和没有闸是一回事)。
 * · 把路径比对换成 `endsWith` → ★③ 红(`a/x.ts` 撞上 `b/a/x.ts`)。
 */
import { describe, expect, test } from 'bun:test';
import { collide } from './staged-collision-check';

const ROOT = '/repo';
const led = (absPath: string, writeSessions: number, lastTs = 1_700_000_000_000) => ({
  absPath,
  writeSessions,
  lastTs,
});

describe('staged-collision-check · collide', () => {
  test('★① 暂存了别人也在写的文件 → 报出来, 带 session 数与时间', () => {
    const hits = collide(['src/a.ts', 'src/b.ts'], [led('/repo/src/a.ts', 2, 42)], ROOT);
    expect(hits).toEqual([{ path: 'src/a.ts', writeSessions: 2, lastTs: 42 }]);
  });

  test('★② 只有一个 session 写过 → **不报** (一条总是误报的闸会被人关掉)', () => {
    // 这条是本文件最要紧的判别力: 判据是「被多个 session 写过」, 不是「台账里有它」。
    // 我自己用 heredoc 改的文件压根不进台账, 拿「我碰没碰过」当判据的话假阳性会淹掉真信号。
    expect(collide(['src/a.ts'], [led('/repo/src/a.ts', 1)], ROOT)).toEqual([]);
  });

  test('★③ 路径按绝对路径比, 不按后缀 (`a/x.ts` 不许撞上 `b/a/x.ts`)', () => {
    expect(collide(['a/x.ts'], [led('/repo/b/a/x.ts', 3)], ROOT)).toEqual([]);
    expect(collide(['a/x.ts'], [led('/repo/a/x.ts', 3)], ROOT)).toHaveLength(1);
  });

  test('★④ 台账里有碰撞但那个文件没被暂存 → 不报 (只管暂存区, 不替人管整棵树)', () => {
    expect(collide(['src/mine.ts'], [led('/repo/src/theirs.ts', 4)], ROOT)).toEqual([]);
  });

  test('★⑤ 暂存区为空 / 台账为空 → 空结果, 不抛', () => {
    expect(collide([], [led('/repo/src/a.ts', 2)], ROOT)).toEqual([]);
    expect(collide(['src/a.ts'], [], ROOT)).toEqual([]);
  });
});
