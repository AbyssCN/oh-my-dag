/**
 * repo-probe 测试 —— second-pass 的仓内腿。
 *
 * 钉的是分工: **模型只负责点名要查什么, 取多少/从哪取/是不是字面量由代码定**。
 * 给 leaf 一个 grep 工具就等于把这条下限交回模型自由裁量 (D-6 判过的失败形态)。
 */
import { describe, expect, test } from 'bun:test';
import { renderRepoHits, repoProbe } from './repo-probe';

/** 假 spawn: 记录 argv, 按 query 返 ugrep --no-heading 格式 (path:line:text)。 */
function fakeSpawn(byQuery: Record<string, string>) {
  const calls: string[][] = [];
  const spawn = (argv: string[]): { stdout: string; exitCode: number } => {
    calls.push(argv);
    const q = argv[argv.indexOf('--') + 1]!;
    const out = byQuery[q];
    return out === undefined ? { stdout: '', exitCode: 1 } : { stdout: out, exitCode: 0 };
  };
  return { spawn, calls };
}

describe('repoProbe — 确定性仓内检索', () => {
  test('命中解析成 file:line + 原文, ./ 前缀去掉', () => {
    const { spawn } = fakeSpawn({ resolveSeatModel: './src/model/role-models.ts:402:export function resolveSeatModel(' });
    const hits = repoProbe(['resolveSeatModel'], { cwd: '/repo', _spawn: spawn });
    expect(hits).toEqual([
      { path: 'src/model/role-models.ts:402', text: 'export function resolveSeatModel(' },
    ]);
  });

  // 查询串永远当**字面量**传 (-F) 且不过 shell —— 畸形查询只是搜不到, 不会变成命令。
  test('查询串走 -F 字面量 + argv 数组 (不过 shell)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['a|b$(rm -rf /)'], { cwd: '/repo', _spawn: spawn });
    const argv = calls[0]!;
    expect(argv[0]).toBe('ugrep');
    expect(argv).toContain('-F');
    // 查询串原样在 `--` 之后, 没有被拼进任何一段命令串
    expect(argv[argv.indexOf('--') + 1]).toBe('a|b$(rm -rf /)');
    expect(argv.some((a) => a.includes('rm -rf /') && a !== 'a|b$(rm -rf /)')).toBe(false);
  });

  test('总命中封顶 (语料增长必须有闸)', () => {
    const many = Array.from({ length: 50 }, (_, i) => `./src/f${i}.ts:${i}:line ${i}`).join('\n');
    const { spawn } = fakeSpawn({ q: many });
    expect(repoProbe(['q'], { cwd: '/repo', maxHitsTotal: 5, _spawn: spawn })).toHaveLength(5);
  });

  test('单条命中截断 (一行 35 万字符的压缩产物不该拖着走)', () => {
    const { spawn } = fakeSpawn({ q: `./src/a.ts:1:${'x'.repeat(5000)}` });
    const hits = repoProbe(['q'], { cwd: '/repo', maxCharsPerHit: 100, _spawn: spawn });
    expect(hits[0]!.text).toHaveLength(100);
  });

  test('同一 file:line 跨 query 去重', () => {
    const { spawn } = fakeSpawn({ a: './src/x.ts:9:同一行', b: './src/x.ts:9:同一行' });
    expect(repoProbe(['a', 'b'], { cwd: '/repo', _spawn: spawn })).toHaveLength(1);
  });

  // second-pass 整体是增益不是链路: 一条 query 挂了不该带垮整轮。
  test('没搜到 (exit 1) / spawn 抛错 → 该 query 空手而归, 不抛', () => {
    const { spawn } = fakeSpawn({ hit: './src/a.ts:1:有' });
    expect(repoProbe(['miss', 'hit'], { cwd: '/repo', _spawn: spawn })).toHaveLength(1);
    const boom = () => {
      throw new Error('ugrep 不在 PATH');
    };
    expect(repoProbe(['x'], { cwd: '/repo', _spawn: boom as never })).toEqual([]);
  });

  test('空/空白 query 跳过 (模型偶发吐空串不该变成全仓扫)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['', '   '], { cwd: '/repo', _spawn: spawn });
    expect(calls).toHaveLength(0);
  });
});

describe('renderRepoHits — 进语料的形状', () => {
  test('带 repo-probe 标签且标明"仓内事实, 与外部来源分开对待"', () => {
    const s = renderRepoHits([{ path: 'src/a.ts:1', text: 'code' }]);
    expect(s).toContain('<repo-probe>');
    expect(s).toContain('与外部来源分开对待');
    expect(s).toContain('src/a.ts:1 — code');
  });

  test('无命中 → 空串 (不往语料里塞空段)', () => {
    expect(renderRepoHits([])).toBe('');
  });
});
