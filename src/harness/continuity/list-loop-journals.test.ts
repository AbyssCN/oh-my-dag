/**
 * `listNodeLoopJournals` —— 读数板的第二处数据源(N9, 2026-07-31)。
 *
 * 为什么要它:轮数与「凭什么停的」(N6 的 `stop`)**只活在 journal 文件里**,留痕库一个字都没有。
 * 而读数板按 runId 汇总,手上没有 nodeId,`loadNodeLoopJournal` 用不上。
 *
 * 这份网钉两件事,都是"读不到的时候该怎么办":
 *   ① **按文件内容认 nodeId,不解析文件名** —— 文件名的安全化是有损的(`a/b` 与 `a_b` 同名);
 *   ② 目录不在 / 某份坏了 → 那一份跳过,**不抛** —— 读数板是观察者,它读不出东西时的正确行为是
 *      "这一格没有数据",不是把调用方拖下水。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './checkpoint-manager';
import type { NodeLoopJournal } from './types';

const journal = (nodeId: string, over: Partial<NodeLoopJournal> = {}): NodeLoopJournal => ({
  runId: 'r1',
  nodeId,
  completedRounds: 2,
  poisoned: [],
  updatedAt: '2026-07-31T00:00:00Z',
  schemaVersion: 1,
  ...over,
});

/** 造一个 repoRoot,把若干 journal 直接写进去(经 manager 自己的写口,不手拼路径)。 */
function fixture(js: NodeLoopJournal[]): { root: string; cm: CheckpointManager } {
  const root = mkdtempSync(join(tmpdir(), 'omd-loopj-'));
  const cm = new CheckpointManager(root);
  for (const j of js) cm.writeNodeLoopJournal('r1', j);
  return { root, cm };
}

describe('listNodeLoopJournals', () => {
  test('一次 run 的全部内环都列得回来', () => {
    const { cm } = fixture([journal('build'), journal('verify', { completedRounds: 4 })]);
    const got = cm.listNodeLoopJournals('r1');
    expect(got.length).toBe(2);
    expect(got.map((j) => j.nodeId).sort()).toEqual(['build', 'verify']);
    expect(got.reduce((a, j) => a + j.completedRounds, 0)).toBe(6);
  });

  test('★ nodeId 按**内容**认 —— 文件名的安全化是有损的, 反推会把两个节点读成一个', () => {
    // `a/b` 与 `a_b` 安全化之后是同一个文件名。这里只断言读回来的 nodeId 是原文,
    // 而不是被 `_` 替换过的样子 —— 一旦有人改成从文件名反推, 这条会红。
    const { cm } = fixture([journal('parent::child/leaf')]);
    expect(cm.listNodeLoopJournals('r1')[0]!.nodeId).toBe('parent::child/leaf');
  });

  test('stop 原样读回 (kind / evidence / atRound 三位都在)', () => {
    const { cm } = fixture([
      journal('a', { stop: { kind: 'blocked', evidence: '材料自相矛盾, 再转也一样', atRound: 2 } }),
    ]);
    expect(cm.listNodeLoopJournals('r1')[0]!.stop).toEqual({
      kind: 'blocked',
      evidence: '材料自相矛盾, 再转也一样',
      atRound: 2,
    });
  });

  test('目录不存在 → 空数组, 不抛 (= 这一格没有数据, 不是错误)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-loopj-'));
    expect(new CheckpointManager(root).listNodeLoopJournals('从来没跑过的 run')).toEqual([]);
  });

  test('★ 坏一份跳一份 —— 一份半截 JSON 不该让整批读数消失', () => {
    const { root, cm } = fixture([journal('good')]);
    // 直接往目录里塞一份坏的 + 一份不是 journal 的文件。
    const dir = join(root, '.omd', 'continuity', 'r1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_loop-broken.json'), '{ 半截');
    writeFileSync(join(dir, '_dag.json'), '{"runId":"r1"}'); // 不是 _loop-, 不该被收
    const got = cm.listNodeLoopJournals('r1');
    expect(got.length).toBe(1);
    expect(got[0]!.nodeId).toBe('good');
  });
});
