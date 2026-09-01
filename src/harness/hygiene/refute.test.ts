/**
 * refute.test —— INV-4「证伪双核缺一不可」(GWT-4)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · 把第二核 (`CHECK_REF_COUNT` 那一段) 注释掉 → 「动态 import 的死文件被判 refuted」
 *     那条当场变 confirmed 而红 —— 这正是 GWT-4 要钉的那一刀。
 *   · 把 `checks.every(ok)` 改成 `checks.some(ok)` → 「一核不过就 refuted」那条红。
 *   · 把 `DELETABLE_SOURCES` 放宽到全部类 → 「无第二核的类一律 refuted」那条红。
 *   · 去掉 `SAFE_NEEDLE` → 「搜索针含元字符时不放行」那条红。
 */
import { describe, expect, test } from 'bun:test';
import {
  CHECK_PKG_ALLOWLIST,
  CHECK_REF_COUNT,
  CHECK_REPRO,
  buildWorkList,
  refuteDelete,
  type RefuteVerdict,
} from './refute';
import type { TriageEntry } from './triage';
import type { HygieneItem, HygieneSource } from './types';

const del = (itemId: string, reproCmd = 'ugrep -c -F x src'): TriageEntry => ({
  itemId,
  disposition: 'delete',
  reason: 'knip 判死',
  reproCmd,
});

const item = (over: Partial<HygieneItem> & { source: HygieneSource }): HygieneItem => ({
  id: over.id ?? `${over.source}:x`,
  summary: 's',
  evidence: [],
  ...over,
});

/** 命令 → 假输出的路由替身 (零外部进程)。未匹配的命令 = 无命中 (退出 1, 空输出)。 */
const runner = (routes: [RegExp, { code: number; out: string }][]) => (cmd: string) => {
  for (const [re, res] of routes) if (re.test(cmd)) return res;
  return { code: 1, out: '' };
};

describe('INV-4 GWT-4 动态 import 的死文件被第二核抓住', () => {
  const dead = item({ source: 'knip-files', id: 'knip-files:src/x.ts', path: 'src/x.ts' });

  test('全仓有 await import("./x") → refuted, 且 ugrep 引用计数那条 ok=false', () => {
    const v = refuteDelete(
      { entry: del('knip-files:src/x.ts'), item: dead, repoRoot: '/repo' },
      // 第二核看见 src/loader.ts 里的动态引用; 第一核 (模型的 repro) 照样"无命中"。
      { run: runner([[/-l -w -F "x"/, { code: 0, out: 'src/loader.ts\nsrc/x.ts\n' }]]) },
    );
    expect(v.verdict).toBe('refuted');
    const refCheck = v.checks.find((c) => c.name === CHECK_REF_COUNT)!;
    expect(refCheck.ok).toBe(false);
    expect(refCheck.detail).toContain('src/loader.ts');
  });

  test('真无引用 + 不在 package.json → confirmed (双核都过才放行)', () => {
    const v = refuteDelete(
      { entry: del('knip-files:src/x.ts'), item: dead, repoRoot: '/repo' },
      { run: runner([]) },
    );
    expect(v.verdict).toBe('confirmed');
    expect(v.checks.map((c) => c.name)).toEqual([CHECK_REPRO, CHECK_REF_COUNT, CHECK_PKG_ALLOWLIST]);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  test('只有自身一行命中 → 引用计数按 0 算 (排除自身)', () => {
    const v = refuteDelete(
      { entry: del('knip-files:src/x.ts'), item: dead, repoRoot: '/repo' },
      { run: runner([[/-l -w -F "x"/, { code: 0, out: 'src/x.ts\n' }]]) },
    );
    expect(v.verdict).toBe('confirmed');
  });

  test('出现在 package.json 白名单 → refuted (对外接口不许当死件删)', () => {
    const v = refuteDelete(
      { entry: del('knip-files:src/x.ts'), item: dead, repoRoot: '/repo' },
      { run: runner([[/ugrep -c -F "x" package\.json/, { code: 0, out: '2\n' }]]) },
    );
    expect(v.verdict).toBe('refuted');
    expect(v.checks.find((c) => c.name === CHECK_PKG_ALLOWLIST)!.ok).toBe(false);
  });
});

describe('死导出 / 死依赖各走各的第二核', () => {
  test('死导出用符号名做词搜索', () => {
    let seen = '';
    refuteDelete(
      {
        entry: del('knip-exports:src/a.ts#unusedFn'),
        item: item({ source: 'knip-exports', path: 'src/a.ts', symbol: 'unusedFn' }),
        repoRoot: '/repo',
      },
      {
        run: (cmd) => {
          if (cmd.includes('-w -F')) seen = cmd;
          return { code: 1, out: '' };
        },
      },
    );
    expect(seen).toContain('-w -F "unusedFn"');
  });

  test('死依赖搜的是 import 边而不是裸包名', () => {
    let seen = '';
    const v = refuteDelete(
      {
        entry: del('knip-deps:left-pad'),
        item: item({ source: 'knip-deps', symbol: 'left-pad', path: 'package.json' }),
        repoRoot: '/repo',
      },
      {
        run: (cmd) => {
          if (cmd.includes('from')) seen = cmd;
          return { code: 1, out: '' };
        },
      },
    );
    expect(seen).toContain(`from 'left-pad`);
    // 死依赖只有一核 (它没有 package.json 白名单这一说 —— 它本来就写在 package.json 里)
    expect(v.checks.map((c) => c.name)).toEqual([CHECK_REPRO, CHECK_REF_COUNT]);
    expect(v.verdict).toBe('confirmed');
  });

  test('依赖仍被 import → refuted', () => {
    const v = refuteDelete(
      {
        entry: del('knip-deps:left-pad'),
        item: item({ source: 'knip-deps', symbol: 'left-pad', path: 'package.json' }),
        repoRoot: '/repo',
      },
      { run: runner([[/from 'left-pad/, { code: 0, out: 'src/pad.ts\n' }]]) },
    );
    expect(v.verdict).toBe('refuted');
  });
});

describe('fail-closed 的四个方向', () => {
  test('非 delete 的分诊不进施工清单', () => {
    const v = refuteDelete(
      {
        entry: { itemId: 'knip-files:src/x.ts', disposition: 'ticket', reason: 'r', reproCmd: 'git log -1' },
        item: item({ source: 'knip-files', path: 'src/x.ts' }),
        repoRoot: '/repo',
      },
      { run: runner([]) },
    );
    expect(v.verdict).toBe('refuted');
  });

  test('没有机械第二核的类 (debt / todo / big-file / stale-plan) 一律 refuted', () => {
    for (const source of ['debt', 'todo', 'big-file', 'stale-plan', 'failed-runs'] as const) {
      const v = refuteDelete(
        { entry: del(`${source}:x`), item: item({ source, path: 'src/a.ts' }), repoRoot: '/repo' },
        { run: runner([]) },
      );
      expect(v.verdict).toBe('refuted');
      expect(v.checks[0]!.detail).toContain(source);
    }
  });

  test('reproCmd 过不了白名单 → 当场 refuted, 第二核都不跑', () => {
    let calls = 0;
    const v = refuteDelete(
      {
        entry: del('knip-files:src/x.ts', 'rm -rf src'),
        item: item({ source: 'knip-files', path: 'src/x.ts' }),
        repoRoot: '/repo',
      },
      {
        run: () => {
          calls += 1;
          return { code: 0, out: '' };
        },
      },
    );
    expect(v.verdict).toBe('refuted');
    expect(calls).toBe(0);
    expect(v.checks[0]!.detail).toContain('白名单');
  });

  test('搜索针含 shell 元字符 → 核不了就不放行', () => {
    const v = refuteDelete(
      {
        entry: del('knip-exports:src/a.ts#bad'),
        item: item({ source: 'knip-exports', path: 'src/a.ts', symbol: 'a"; rm -rf /' }),
        repoRoot: '/repo',
      },
      { run: runner([]) },
    );
    expect(v.verdict).toBe('refuted');
    expect(v.checks.find((c) => c.name === CHECK_REF_COUNT)!.detail).toContain('不安全');
  });

  test('ugrep 自己出错 (退出 > 1) → 计数不可信 → refuted', () => {
    const v = refuteDelete(
      { entry: del('knip-files:src/x.ts'), item: item({ source: 'knip-files', path: 'src/x.ts' }), repoRoot: '/repo' },
      { run: runner([[/-l -w -F/, { code: 2, out: 'ugrep: 参数错' }]]) },
    );
    expect(v.verdict).toBe('refuted');
    expect(v.checks.find((c) => c.name === CHECK_REF_COUNT)!.detail).toContain('ugrep 出错');
  });
});

describe('D-4 施工清单只收 confirmed', () => {
  test('confirmed 的路径进 files, refuted 的不进', () => {
    const items = new Map<string, HygieneItem>([
      ['a', item({ source: 'knip-files', id: 'a', path: 'src/a.ts' })],
      ['b', item({ source: 'knip-files', id: 'b', path: 'src/b.ts' })],
    ]);
    const verdicts: RefuteVerdict[] = [
      { itemId: 'a', verdict: 'confirmed', checks: [] },
      { itemId: 'b', verdict: 'refuted', checks: [] },
    ];
    const wl = buildWorkList(verdicts, items);
    expect(wl.files).toEqual(['src/a.ts']);
    expect(wl.confirmed).toHaveLength(1);
    expect(wl.refuted).toHaveLength(1);
  });
});
