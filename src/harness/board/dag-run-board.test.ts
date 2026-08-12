/**
 * `dag_run` 接进 run-board 的契约测试(2026-08-12)。
 *
 * 钉四条,每条都是 2026-08-12 那天真付过的账:
 * 1. **claim 不写 `writeSet`** —— `dag_run` 起跑时没有声明面,写 `[]` 会把「判不了」
 *    伪装成「无冲突」(NULL ≠ 0 ≠ 不适用)。
 * 2. **未声明必须念成「判不了」**,不许念成「无交集」。
 * 3. **terminal 之后不再算活** —— 不写终态,这个 run 会在板上永远活着,
 *    把后来每一次起跑都报成冲突,闸就会被当噪声关掉。
 * 4. **零活 run 整段缺席** —— 事件不是分格(同 `RunProgress.replans` 那条口径)。
 *
 * 反向自检:每条注释里写了「怎么让它红」,四条都当场证伪过。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard } from './run-board';
import {
  claimDagRun,
  liveRunsNotice,
  otherLiveRuns,
  renderLiveRunsNotice,
  terminalDagRun,
} from './dag-run-board';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omd-board-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('dag_run 的板上登记', () => {
  test('★ 1: claim 不写 writeSet 字段(缺席 ≠ 空集)', () => {
    claimDagRun(root, 'r-aaaaaaa1', '把叶级活性变成可读事实');
    const claimed = readBoard(root).filter((e) => e.event === 'claimed');
    expect(claimed).toHaveLength(1);
    // 怎么让它红: claimDagRun 里补一个 `writeSet: []` → 红。
    // 空集是**声明**(可断言无冲突), 缺席是**没声明**(只能说判不了) —— 两者不许互换。
    expect(claimed[0]!.writeSet).toBeUndefined();
    // 任务摘要要带上 —— 「在跑的是什么」是重复派工的唯一可读线索
    expect(claimed[0]!.note).toContain('把叶级活性变成可读事实');
  });

  test('★ 2: 未声明写集 → 念成「判不了」, 不许念成「无交集」', () => {
    claimDagRun(root, 'r-bbbbbbb2', '别的活');
    const lines = liveRunsNotice(root, 'r-self', ['src/a.ts']).join('\n');
    // 怎么让它红: renderLiveRunsNotice 把 `writeSet === undefined` 那支并进「无交集」→ 红。
    expect(lines).toContain('判不了');
    // ⚠ 断 `not.toContain('无交集')` 是错的 —— 判词里那句「不是「无交集」」自己就含这三个字。
    // 断的是**判定用语**(「写集无交集」这个结论), 不是随便一处字面出现。
    expect(lines).not.toContain('写集无交集');
  });

  test('★ 3: terminal 之后不再算活(不写终态 = 板上永远活着)', () => {
    claimDagRun(root, 'r-ccccccc3', '活');
    expect(otherLiveRuns(readBoard(root), 'r-self')).toHaveLength(1);
    terminalDagRun(root, 'r-ccccccc3', 'done');
    // 怎么让它红: terminalDagRun 不写 event:'terminal'(比如写成 'note')→ 红。
    expect(otherLiveRuns(readBoard(root), 'r-self')).toHaveLength(0);
  });

  test('★ 4: 零活 run → 整段缺席, 不印「0 个」', () => {
    // 怎么让它红: renderLiveRunsNotice 去掉 length===0 的早返回 → 红。
    expect(renderLiveRunsNotice([], ['src/a.ts'])).toEqual([]);
    expect(liveRunsNotice(root, 'r-self')).toEqual([]);
  });

  test('★ 5: 自己不算进「别人」', () => {
    claimDagRun(root, 'r-ddddddd4', '我自己');
    // 怎么让它红: otherLiveRuns 去掉 `e.runId === selfRunId` 的排除 → 红。
    expect(otherLiveRuns(readBoard(root), 'r-ddddddd4')).toHaveLength(0);
  });

  test('★ 6: 双方都声明写集时, 交集要真算出来', () => {
    const live = [{ runId: 'r-eeeeeee5', writeSet: ['src/a.ts', 'src/b.ts'] }];
    const lines = renderLiveRunsNotice(live, ['src/b.ts', 'src/c.ts']).join('\n');
    // 怎么让它红: 把 overlap 恒设成空数组 → 红。
    expect(lines).toContain('写集交集: src/b.ts');
    expect(renderLiveRunsNotice(live, ['src/z.ts']).join('\n')).toContain('写集无交集');
  });
});
