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
    const hits = repoProbe(['resolveSeatModel'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits;
    expect(hits).toEqual([
      { path: 'src/model/role-models.ts:402', text: 'export function resolveSeatModel(' },
    ]);
  });

  // 查询串永远当**字面量**传 (-F) 且不过 shell —— 畸形查询只是搜不到, 不会变成命令。
  test('查询串走 -F 字面量 + argv 数组 (不过 shell)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['a|b$(rm -rf /)'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits;
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
    expect(repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, maxHitsTotal: 5, _spawn: spawn }).hits).toHaveLength(5);
  });

  test('单条命中截断 (一行 35 万字符的压缩产物不该拖着走)', () => {
    const { spawn } = fakeSpawn({ q: `./src/a.ts:1:${'x'.repeat(5000)}` });
    const hits = repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, maxCharsPerHit: 100, _spawn: spawn }).hits;
    expect(hits[0]!.text).toHaveLength(100);
  });

  test('同一 file:line 跨 query 去重', () => {
    const { spawn } = fakeSpawn({ a: './src/x.ts:9:同一行', b: './src/x.ts:9:同一行' });
    expect(repoProbe(['a', 'b'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits).toHaveLength(1);
  });

  // second-pass 整体是增益不是链路: 一条 query 挂了不该带垮整轮。
  test('没搜到 (exit 1) / spawn 抛错 → 该 query 空手而归, 不抛', () => {
    const { spawn } = fakeSpawn({ hit: './src/a.ts:1:有' });
    expect(repoProbe(['miss', 'hit'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits).toHaveLength(1);
    const boom = () => {
      throw new Error('ugrep 不在 PATH');
    };
    expect(repoProbe(['x'], { cwd: '/repo', fullFileTop: 0, _spawn: boom as never }).hits).toEqual([]);
  });

  test('空/空白 query 跳过 (模型偶发吐空串不该变成全仓扫)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['', '   '], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits;
    expect(calls).toHaveLength(0);
  });
});

describe('renderRepoHits — 进语料的形状', () => {
  test('带 repo-probe 标签且标明"仓内事实, 与外部来源分开对待"', () => {
    const s = renderRepoHits({ hits: [{ path: 'src/a.ts:1', text: 'code' }], files: [] });
    expect(s).toContain('<repo-probe>');
    expect(s).toContain('与外部来源分开对待');
    expect(s).toContain('src/a.ts:1');
  });

  test('无命中 → 空串 (不往语料里塞空段)', () => {
    expect(renderRepoHits({ hits: [], files: [] })).toBe('');
  });
});

// ── 名额分配 (2026-07-28 实测驱动的修复) ────────────────────────────────
// 修前是"顺序取, 先到先得": 第一条常见词吃光全部名额, 后面真正想查的符号零命中。
// 实测复现: ["config", "SeatUnresolvedError", "assertSeatsUsable"] → 后两条各 0 条。
describe('repoProbe — 名额按 query 轮转, 不是先到先得', () => {
  test('常见词打头不再饿死后面的 query', () => {
    const flood = Array.from({ length: 40 }, (_, i) => `./src/noise${i}.ts:1:config`).join('\n');
    const { spawn } = fakeSpawn({
      config: flood,
      rareA: './src/a.ts:7:rareA 在这',
      rareB: './src/b.ts:9:rareB 在这',
    });
    const hits = repoProbe(['config', 'rareA', 'rareB'], { cwd: '/repo', fullFileTop: 0, maxHitsTotal: 6, _spawn: spawn }).hits;
    expect(hits.some((h) => h.text.includes('rareA'))).toBe(true);
    expect(hits.some((h) => h.text.includes('rareB'))).toBe(true);
    // 轮转 = 第一轮各取一条, 常见词不会独占
    expect(hits.filter((h) => h.text === 'config').length).toBeLessThanOrEqual(4);
  });

  test('某条 query 早早取完 → 剩余额度流给还有货的 (公平但不浪费)', () => {
    const { spawn } = fakeSpawn({
      few: './src/f.ts:1:只有一条',
      many: Array.from({ length: 10 }, (_, i) => `./src/m${i}.ts:1:many ${i}`).join('\n'),
    });
    const hits = repoProbe(['few', 'many'], { cwd: '/repo', fullFileTop: 0, maxHitsTotal: 8, _spawn: spawn }).hits;
    expect(hits).toHaveLength(8); // 没有因为 few 只有一条就浪费名额
    expect(hits.filter((h) => h.text.startsWith('many')).length).toBe(7);
  });

  test('per-file 上限当 ugrep -m 传 (它就是 per-file 语义)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, maxHitsPerFile: 3, _spawn: spawn }).hits;
    const argv = calls[0]!;
    expect(argv[argv.indexOf('-m') + 1]).toBe('3');
  });
});

// ── 上下文行解析 (2026-07-28 实测抓到的两个 bug 的回归钉) ────────────────
describe('repoProbe — 上下文行归并', () => {
  test('±N 行上下文进正文 (裸一行 import 回答不了"怎么用的")', () => {
    const { spawn, calls } = fakeSpawn({
      q: [
        './src/a.ts-40-前一行',
        './src/a.ts:41:命中行',
        './src/a.ts-42-后一行',
      ].join('\n'),
    });
    const hits = repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, contextLines: 1, _spawn: spawn }).hits;
    expect(hits[0]!.path).toBe('src/a.ts:41');
    expect(hits[0]!.text).toBe('前一行\n命中行\n后一行');
    expect(calls[0]).toContain('-A'); // 上下文真的问 ugrep 要了
  });

  // 贪婪匹配下, 正文里的 "2026-07-28" 会把切点吃到最后一处 `-数字-` → 行号与正文全错位。
  test('正文含 `-数字-` 串时非贪婪切分 (行号不错位)', () => {
    const { spawn } = fakeSpawn({ q: './src/a.ts:7:// 2026-07-28 实测: 见 issue-12-bug' });
    const hits = repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn }).hits;
    expect(hits[0]!.path).toBe('src/a.ts:7');
    expect(hits[0]!.text).toBe('// 2026-07-28 实测: 见 issue-12-bug');
  });

  // 实测复现过: 一条命中的尾巴接着另一个文件的 import 行。
  test('跨文件不串味: B 文件的上下文不挂到 A 文件的命中上', () => {
    const { spawn } = fakeSpawn({
      q: [
        './src/a.ts:1:A 的命中',
        './src/b.ts-8-B 的上文',
        './src/b.ts:9:B 的命中',
      ].join('\n'),
    });
    const hits = repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, contextLines: 2, _spawn: spawn }).hits;
    expect(hits[0]!.text).toBe('A 的命中'); // 没被 B 的上文污染
    expect(hits[1]!.text).toBe('B 的上文\nB 的命中');
  });

  test('contextLines:0 → 不向 ugrep 要上下文 (省 IO)', () => {
    const { spawn, calls } = fakeSpawn({});
    repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, contextLines: 0, _spawn: spawn }).hits;
    expect(calls[0]).not.toContain('-A');
  });
});

// ── 整读 (纵深面): web 一个"源"是一整页, 仓内一条"命中"只是一行 —— 差的是粒度不是预算 ──
describe('repoProbe — 命中最集中的文件整读', () => {
  const files: Record<string, string> = {
    '/repo/src/hot.ts': 'export function hot() {}\n'.repeat(20),
    '/repo/src/cold.ts': 'cold',
  };
  const readFile = (p: string): string => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  };

  test('按命中数排序取前 N 个整读 (命中多 = 与缺口最相关)', () => {
    const { spawn } = fakeSpawn({
      q: ['./src/hot.ts:1:a', './src/hot.ts:2:b', './src/cold.ts:5:c'].join('\n'),
    });
    const r = repoProbe(['q'], { cwd: '/repo', fullFileTop: 1, contextLines: 0, _spawn: spawn, _readFile: readFile });
    expect(r.files.map((f) => f.path)).toEqual(['src/hot.ts']); // cold.ts 只 1 条命中, 没进
    expect(r.files[0]!.text).toContain('export function hot()');
  });

  test('单文件上限 = web 腿每源同一个数; 超了带显式截断标记', () => {
    const { spawn } = fakeSpawn({ q: './src/hot.ts:1:a' });
    const r = repoProbe(['q'], {
      cwd: '/repo', fullFileTop: 1, contextLines: 0, maxCharsPerFile: 50, _spawn: spawn, _readFile: readFile,
    });
    expect(r.files[0]!.text).toHaveLength(50);
    expect(r.files[0]!.truncated).toBe(true);
    expect(renderRepoHits(r)).toContain('[已截断, 全文见该路径]');
  });

  test('总闸对两个面一起生效 (行级已花掉的从整读预算里扣)', () => {
    const { spawn } = fakeSpawn({ q: `./src/hot.ts:1:${'x'.repeat(300)}` });
    const r = repoProbe(['q'], {
      cwd: '/repo', fullFileTop: 1, contextLines: 0, maxCharsTotal: 320, _spawn: spawn, _readFile: readFile,
    });
    // 行级占了 300, 整读只剩 20
    expect(r.files[0]!.text.length).toBeLessThanOrEqual(20);
  });

  test('读失败跳过不抛 (second-pass 是增益不是链路)', () => {
    const { spawn } = fakeSpawn({ q: './src/gone.ts:1:a' });
    const r = repoProbe(['q'], { cwd: '/repo', fullFileTop: 1, contextLines: 0, _spawn: spawn, _readFile: readFile });
    expect(r.hits).toHaveLength(1);
    expect(r.files).toEqual([]);
  });

  test('fullFileTop:0 → 关整读 (纯行级, 老行为)', () => {
    const { spawn } = fakeSpawn({ q: './src/hot.ts:1:a' });
    expect(repoProbe(['q'], { cwd: '/repo', fullFileTop: 0, _spawn: spawn, _readFile: readFile }).files).toEqual([]);
  });
});
