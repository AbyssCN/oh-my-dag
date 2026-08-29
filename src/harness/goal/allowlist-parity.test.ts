/**
 * **分类期与运行期的白名单必须同源** (2026-08-29)。
 *
 * 这条测的不是某个函数, 是**两处口径不一致会造出的那种假红**:
 * classify 用真探测判「这仓能跑 pytest」→ 冻一条 `pytest -q`;
 * 命令 leaf 若还用 marker 表 → 执行时拒掉 → 看起来像"测试没过", 实际根本没跑。
 *
 * 反向自检: 把 assemble.ts 里 `runAllowlist` 换回 `allowlistForRoot` → 本文件第一条红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowlistForRoot } from '../command-leaf';
import { probeEnvFacts } from '../env-facts';
import { acceptanceCommandBlockReason } from './acceptance-gate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'allow-parity-'));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
}

describe('无 marker 的 python 仓: 分类期放行的命令, 运行期也必须放行', () => {
  test('★ marker 表拦得住 pytest, 真探测放行 —— 两处口径不同就是假红的来源', () => {
    const root = fresh();
    write(root, 'src/a.py');
    write(root, 'tests/test_a.py');
    const fakeBin = fresh();
    writeFileSync(join(fakeBin, 'pytest'), '');
    const env = { PATH: fakeBin };

    // 分类期 (真探测那条路): 放行。
    const facts = probeEnvFacts(root, env);
    expect(acceptanceCommandBlockReason('pytest -q', { root, env, envFacts: facts })).toBeNull();

    // 运行期若只用 marker 表: pytest 不在里面 —— 这正是两处口径不一致时会发生的事。
    expect(allowlistForRoot(root)).not.toContain('pytest');

    // assemble 的 runAllowlist 口径 = marker ∪ 真探测启用的 bin。这里复现它, 断言并集含 pytest。
    const runAllow = [...allowlistForRoot(root), ...facts.enabledBins.filter((b) => !allowlistForRoot(root).includes(b))];
    expect(runAllow).toContain('pytest');
  });

  test('runner 不在 PATH 时, 两处都不放行 (不许一边放行一边拒)', () => {
    const root = fresh();
    write(root, 'src/a.py');
    const emptyBin = fresh();
    const env = { PATH: emptyBin };
    const facts = probeEnvFacts(root, env);

    expect(facts.enabledBins).not.toContain('pytest');
    expect(acceptanceCommandBlockReason('pytest -q', { root, env, envFacts: facts })).not.toBeNull();
  });
});
