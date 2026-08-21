/**
 * jail 自检层① 的反向自检(2026-08-21)。
 *
 * 每条注明"怎么让它红" —— **一条永远绿的闸不是闸**。
 * 样本取自本仓真实付过钱的 jail 次生事故:
 *   · `3f8e366` 隔离档下 agent leaf 一个都起不来(9 节点全灭,产物零)
 *   · **S-34** 沙箱拿走 git → **尺子同场失真, 读数被写成「叶子空转」**
 *   · `86e6cdb` `findNodeModules` 未返 realpath → jail 内依赖解析悬空
 *   · 挂载顺序反了 → 组出来的 argv 长得正常, 跑起来是个全只读沙箱
 */
import { describe, expect, test } from 'bun:test';
import { bindSources, checkJailArgv, describeJailProblems, type JailPreflightInput } from './jail-preflight';

const ROOT = '/repo/.omd/runs/abc';
const WORKER = '/opt/omd/src/harness/leaf-worker.ts';

/** 一份"挂载面对得上"的基线 argv。各条用例只动它的一处。 */
const okArgv = (): string[] => [
  '--unshare-user',
  '--proc', '/proc',
  '--ro-bind', '/usr', '/usr',
  '--ro-bind', '/opt/omd', '/opt/omd',
  '--bind', ROOT, ROOT,
  '--chdir', ROOT,
];

const base = (over: Partial<JailPreflightInput> = {}): JailPreflightInput => ({
  argv: okArgv(),
  root: ROOT,
  workerPath: WORKER,
  wantGit: false,
  roBinds: ['/opt/omd'],
  ...over,
} as JailPreflightInput);

/** 一切路径都是 realpath 的世界(默认);要造 symlink 世界就覆盖它。 */
const idRealpath = { realpath: (p: string) => p };

describe('checkJailArgv —— 构造期就把挂载面对一遍', () => {
  test('★ 基线: 挂载面对得上 → 零问题(正控, 闸不是恒红)', () => {
    expect(checkJailArgv(base(), idRealpath)).toEqual([]);
  });

  test('★ 3f8e366: worker 不在任何挂载覆盖下 → fatal', () => {
    // 那一跑 9 节点全灭、产物零, 而单测与 bwrap 容器性探针**全绿** ——
    // 它们测的是 jail 关不关得住, 不是 worker 找不找得到。
    // 怎么让它红: 删掉 ② 那条 → 这条返空, 断言红。
    const ps = checkJailArgv(base({ workerPath: '/somewhere/else/leaf-worker.ts' }), idRealpath);
    expect(ps.some((p) => p.level === 'fatal' && p.what.includes('leaf-worker'))).toBe(true);
  });

  test('★ 工作根没有可写绑定 → fatal(症状会长成"产物为空", 看起来像模型不干活)', () => {
    const argv = okArgv().filter((a, i, arr) => !(a === '--bind' && arr[i + 1] === ROOT) && !(arr[i - 1] === '--bind' && a === ROOT) && !(arr[i - 2] === '--bind' && arr[i - 1] === ROOT && a === ROOT));
    const ps = checkJailArgv(base({ argv }), idRealpath);
    expect(ps.some((p) => p.level === 'fatal' && p.what.includes('没有可写绑定'))).toBe(true);
  });

  test('★★ S-34: 要了 git 而 argv 里没有 git 绑定 → warn, **且判词必须点名"读数被写成假的"**', () => {
    // S-34 的代价不是跑挂, 是尺子同场失真 —— 判词不说这一层, 下一个人会把它当普通失败重跑掉。
    // 怎么让它红: 把 fix 里 S-34 那句删掉 → 断言红。
    const ps = checkJailArgv(base({ wantGit: true }), idRealpath);
    const git = ps.find((p) => p.what.includes('git'));
    expect(git?.level).toBe('warn');
    expect(git?.fix).toContain('S-34');
    expect(git?.fix).toContain('假');
  });

  test('★ 要了 git 且真挂了 → 不报(正控)', () => {
    const argv = [...okArgv(), '--ro-bind', '/repo/.git', '/repo/.git'];
    expect(checkJailArgv(base({ argv, wantGit: true }), idRealpath)).toEqual([]);
  });

  test('★ 没要 git 时缺 git 绑定**不算问题**(eval 档正是要它不在)', () => {
    // 反面锚: eval 档的隔离本意就是挡 `git show <commit>:file` 当 oracle。
    // 怎么让它红: 把 `if (wantGit)` 去掉 → eval 档每次都报一条假 warn。
    expect(checkJailArgv(base({ wantGit: false }), idRealpath)).toEqual([]);
  });

  test('★ 系统目录是 symlink **不报** —— 只查调用方给的 roBinds(否则每次跑 4 条噪音)', () => {
    // 这台机器上 /bin /sbin /lib /lib64 四个都是 symlink (usrmerge)。查它们 = 假阳性刷屏,
    // 而假阳性的代价是有人把整条闸关掉。怎么让它红: 把循环改回遍历 bindSources(argv)。
    const ps = checkJailArgv(base({ roBinds: [] }), { realpath: (p) => (p === '/usr' ? '/REAL' : p) });
    expect(ps).toEqual([]);
  });

  test('★ 86e6cdb: **调用方给的** bind 源是 symlink → warn(jail 内依赖解析会悬空)', () => {
    const ps = checkJailArgv(base(), { realpath: (p) => (p === '/opt/omd' ? '/real/omd' : p) });
    expect(ps.some((p) => p.level === 'warn' && p.what.includes('symlink'))).toBe(true);
  });

  test('★ symlink 只判 warn 不判 fatal —— 假 fatal 的代价是有人把整条闸关掉', () => {
    const ps = checkJailArgv(base(), { realpath: (p) => (p === '/opt/omd' ? '/real/omd' : p) });
    expect(ps.every((p) => p.level !== 'fatal')).toBe(true);
  });

  test('★ 叠挂顺序反了(只读绑定盖住可写工作根)→ fatal', () => {
    // 组出来的 argv 长得完全正常, 跑起来是个全只读沙箱 —— 与对话位围栏那条同一个坑,
    // 而那一条是靠**真跑**才发现的。这里在 argv 上就判得出来。
    // 怎么让它红: 删掉 ⑤ 那条 → 这条返空。
    const argv = [...okArgv(), '--ro-bind', '/repo/.omd', '/repo/.omd'];
    const ps = checkJailArgv(base({ argv }), idRealpath);
    expect(ps.some((p) => p.level === 'fatal' && p.what.includes('盖成只读'))).toBe(true);
  });

  test('bindSources 只取挂载**源**(第二个位置), 不把目标也算进去', () => {
    expect(bindSources(['--ro-bind', '/a', '/b', '--bind', '/c', '/d', '--chdir', '/c'])).toEqual(['/a', '/c']);
  });

  test('判词渲染带级别 —— 一眼看出是"起不来"还是"读数会失真"', () => {
    const line = describeJailProblems(checkJailArgv(base({ wantGit: true }), idRealpath));
    expect(line).toContain('[warn]');
  });
});
