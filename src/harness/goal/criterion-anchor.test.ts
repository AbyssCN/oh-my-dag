/**
 * criterion-anchor 的**反向自检** —— 本仓惯例: 每条闸都要当场证明它真的会红。
 *
 * 每条判据成对断言:该红的样本红 + **同形状但正确**的样本不红。
 * 只证"会红"会养出一条永远红的闸 —— 而一道恒红的闸会被人关掉, 比没有闸更坏。
 *
 * runner 全部注入, 零 git 零磁盘 —— 于是这些断言不会因为跑它的机器有没有 git 而变色
 * (那正是 S-36 「闸量的是那台机器不是这段代码」要杀的形状)。
 */
import { describe, expect, test } from 'bun:test';
import {
  type AnchorRunner,
  type TreeAnchor,
  captureTreeAnchor,
  compareTreeAnchor,
  describeAnchorVerdict,
} from './criterion-anchor';

/** 造一个假 git: HEAD 与 porcelain 由参数给。`null` 表示这一条命令跑不起来。 */
function fakeGit(head: string | null, porcelain: string | null): AnchorRunner {
  return ({ args }) => {
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'status') return porcelain;
    return null;
  };
}

describe('compareTreeAnchor —— 三态不压平', () => {
  const a: TreeAnchor = { head: 'abc123', dirty: 'deadbeefdeadbeef' };

  test('会红: HEAD 变了 → changed', () => {
    expect(compareTreeAnchor(a, { ...a, head: 'def456' })).toBe('changed');
  });

  test('会红: 只有脏面变了 (HEAD 没动) → changed —— 这正是 S-44 现场的形状', () => {
    expect(compareTreeAnchor(a, { ...a, dirty: '0000000000000000' })).toBe('changed');
  });

  test('该绿时不红: 两侧逐字段相同 → same', () => {
    expect(compareTreeAnchor(a, { head: 'abc123', dirty: 'deadbeefdeadbeef' })).toBe('same');
  });

  test('任一侧缺席 → unknown, **不是** same —— 「没量过」不许伪装成「量了且没变」', () => {
    expect(compareTreeAnchor(null, a)).toBe('unknown');
    expect(compareTreeAnchor(a, null)).toBe('unknown');
    expect(compareTreeAnchor(null, null)).toBe('unknown');
  });

  test('unknown 也**不是** changed —— 一道对非 git 目录恒红的闸会被人关掉', () => {
    expect(compareTreeAnchor(null, a)).not.toBe('changed');
  });
});

describe('captureTreeAnchor', () => {
  test('两条命令都通 → 拿到锚, head 去掉尾换行', () => {
    const t = captureTreeAnchor('/repo', fakeGit('abc123\n', ' M src/a.ts\n'));
    expect(t?.head).toBe('abc123');
    expect(t?.dirty).toHaveLength(16);
  });

  test('干净树与脏树的 dirty 不同 —— 否则脏面变化看不见', () => {
    const clean = captureTreeAnchor('/repo', fakeGit('abc', ''));
    const dirty = captureTreeAnchor('/repo', fakeGit('abc', ' M src/a.ts\n'));
    expect(clean?.dirty).not.toBe(dirty?.dirty);
  });

  test('同一份 porcelain → 同一个哈希 (确定性)', () => {
    const x = captureTreeAnchor('/repo', fakeGit('abc', ' M a\n?? b\n'));
    const y = captureTreeAnchor('/repo', fakeGit('abc', ' M a\n?? b\n'));
    expect(x).toEqual(y!);
  });

  test('rev-parse 跑不起来 (非 git 仓) → null, 不抛', () => {
    expect(captureTreeAnchor('/tmp', fakeGit(null, ''))).toBeNull();
  });

  test('status 跑不起来 → null —— 半个锚不是锚', () => {
    expect(captureTreeAnchor('/repo', fakeGit('abc', null))).toBeNull();
  });
});

describe('describeAnchorVerdict —— 判词是人话不是枚举值', () => {
  test('三态各有各的原文, 且 changed 那句点名 S-44', () => {
    expect(describeAnchorVerdict('changed')).toContain('S-44');
    expect(describeAnchorVerdict('unknown')).toContain('未经核对');
    expect(describeAnchorVerdict('same')).toContain('没动过');
  });
});
