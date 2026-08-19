/**
 * conductor prompt 字节级快照锁 (#182 H1)。
 *
 * 起因 (2026-08-19): 三档 (full/lean/lean-kb) 装配产物 —— 以及 #182 新增的 bare 基线 —— 此前只有
 * 「含某串 / 不含某串」的散点断言。那种断言抓得住"整段没了", 抓不住**改一字符**: 教练段里手滑删掉
 * 一个词、把 `expect_exit` 拼成 `expect_exit:`、把白名单一个二进制名改错 —— 散点全绿, 而 prompt 已经
 * 漂了。A/B (#171 有) 管的是「值不值」, 快照管的是「没人手滑改坏」, 两者不互替 (issue #182 verify)。
 *
 * 证伪方式 (当场验过): 在 `conductorSystemPrompt` 任一处改/删/插一个字符 → 对应档的快照断言红;
 * 恢复后绿。重生成 golden 见 `scripts/update-conductor-prompt-snapshots.ts`。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bareConductorSystemPrompt, conductorSystemPrompt } from './conductor-plan';

const SNAPSHOT_DIR = join(import.meta.dir, '__fixtures__', 'conductor-prompt');

// 三档 + bare 基线 (full-kb 传递性覆盖: 见 update-conductor-prompt-snapshots.ts 头注释)。
const PROFILES = ['full', 'lean', 'lean-kb', 'bare'] as const;

function golden(profile: string): string {
  return readFileSync(join(SNAPSHOT_DIR, `${profile}.txt`), 'utf8');
}

describe('conductor prompt 字节级快照锁 (#182)', () => {
  for (const profile of PROFILES) {
    test(`${profile} 档装配产物逐字节锁死 (改一字符必红)`, () => {
      const actual = conductorSystemPrompt({ profile });
      const expected = golden(profile);
      // `toBe` 对字符串是逐字节相等 —— 任一字节漂移即红, 且 Bun 给出两串的 diff (可读哪一处变了)。
      expect(actual).toBe(expected);
    });
  }

  test('bare 档经 conductorSystemPrompt 分派到零附加内容基线 (单一真源)', () => {
    expect(conductorSystemPrompt({ profile: 'bare' })).toBe(bareConductorSystemPrompt());
  });

  test('bare 档 = 零附加内容: 只留身份 + 分解指令 + 输出 schema', () => {
    const bare = bareConductorSystemPrompt();
    // 有: 身份 + 分解指令 + 可解析的 schema 契约。
    expect(bare).toContain('Decompose the task');
    expect(bare).toContain('Output STRICTLY one JSON object');
    expect(bare).toContain('"nodes"');
    // 无: 任何教练 / 环境事实 (这些是 full/lean 的 harness 增量)。
    const harnessMarkers = [
      'Decomposition stance', // full 教练
      'Granularity economics', // full 教练
      'Redraw economics', // full 教练
      'Parallel-safety', // 环境事实 (两档都有)
      'HARD RULE', // 环境事实 (两档都有)
      'allowed binaries', // command 闸白名单 (两档都有)
      'TRUST_FENCE_RULE', // 冻结前缀信任边界 (两档都有)
      'Graph shapes', // shapes 渲染 (两档都有)
      'Constrained control-flow primitives', // 原语菜单 (两档都有)
      'KNOWLEDGE boundaries', // -kb 段
    ];
    for (const marker of harnessMarkers) expect(bare).not.toContain(marker);
  });

  test('bare 与 full/lean 明显不同 (不是空转恒等档)', () => {
    const bare = bareConductorSystemPrompt();
    expect(bare).not.toBe(conductorSystemPrompt());
    expect(bare).not.toBe(conductorSystemPrompt({ profile: 'lean' }));
    expect(bare).not.toBe(conductorSystemPrompt({ profile: 'lean-kb' }));
  });
});
