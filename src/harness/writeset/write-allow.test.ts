/**
 * 写域闸的反向自检(2026-08-21,run `e2d204b7` 节点 s4 复盘)。
 *
 * ## 现场
 *
 * 一个 leaf 把隔离 worktree 的整个 `src/` 删了。事后查,当天所有闸一条都没拦住:
 *   · `write-set.ts` 是**跑后对账** —— 那时东西已经没了;
 *   · 产物闸问「本轮改了文件吗」—— 删也算改;
 *   · 写集当时**只以散文进 prompt**(`goal/sdd-compile.ts`:「写集 (只许动这些文件): …」),
 *     而本仓实测结论是**讲道理拦不住**。
 *
 * 本闸是**写前**那一道。
 *
 * ## 两侧同等重要
 *
 * 拦住越界只是一半。另一半是**别拦正当的写** —— 契约里写集有三种写法(逐条路径 /
 * glob / 目录),只认一种就会造出"明明声明了却被拒"的假 major,而
 * **假 major 的代价是有人把整条闸关掉**。下面两组用例数量对等。
 */
import { describe, expect, test } from 'bun:test';
import { checkWriteAllowed, describeWriteDenied, resolveNodeWriteAllow } from './write-allow';

const ROOT = '/repo';
const ok = (t: string, allow: string[]) => checkWriteAllowed(t, allow, ROOT).allowed;

describe('写域闸 —— 拦住的那一侧', () => {
  test('★★ 目标不在声明写集里 → 拒', () => {
    // 怎么让它红: 让 checkWriteAllowed 恒返 allowed:true → 这条红。
    expect(ok('src/harness/other.ts', ['src/harness/session/registry.ts'])).toBe(false);
    expect(ok('/repo/src/harness/other.ts', ['src/harness/session/registry.ts'])).toBe(false);
  });

  test('★ 空写集 = 什么都不许写(与"缺席"是两件事 —— 缺席由调用方判, 不传进来)', () => {
    expect(ok('src/anything.ts', [])).toBe(false);
  });

  test('★ 声明了同目录的**兄弟文件**不等于放行整个目录', () => {
    // `src/a/x.ts` 声明了, 不代表 `src/a/y.ts` 可写 —— 那正是 F-1「在实装与测试文件之间横跳」的形状。
    expect(ok('src/a/y.ts', ['src/a/x.ts'])).toBe(false);
  });

  test('★ 判词必须列出允许清单 —— 只说"越界了"会让执行体反复试同一批路径', () => {
    // requireWritable 那条早就是这么写的, 同一条纪律。反复试 = spin 熔断吃掉的那些回合。
    const msg = describeWriteDenied('src/other.ts', ['src/a.ts', 'src/b.ts'], 'write');
    expect(msg).toContain('src/a.ts');
    expect(msg).toContain('src/b.ts');
    expect(msg).toContain('契约');
  });
});

describe('写域闸 —— **放行**的那一侧(假 major 阀门)', () => {
  test('★ 逐条路径:声明什么就能写什么(正控, 闸不是恒拒)', () => {
    expect(ok('src/harness/session/registry.ts', ['src/harness/session/registry.ts'])).toBe(true);
  });

  test('★ 绝对路径与相对路径同判(契约写相对, 工具拿到的是绝对)', () => {
    expect(ok('/repo/src/a.ts', ['src/a.ts'])).toBe(true);
    expect(ok('src/a.ts', ['src/a.ts'])).toBe(true);
  });

  test('★ glob 写法认(`src/**/*.ts` 是契约里常见的一种)', () => {
    expect(ok('src/harness/deep/x.ts', ['src/**/*.ts'])).toBe(true);
    expect(ok('src/harness/deep/x.md', ['src/**/*.ts'])).toBe(false); // 但别放宽到别的后缀
  });

  test('★ 声明的是**目录**时覆盖其下全部(第三种写法)', () => {
    expect(ok('src/harness/session/inbox.ts', ['src/harness/session'])).toBe(true);
    expect(ok('src/harness/other.ts', ['src/harness/session'])).toBe(false);
  });

  test('★ 前缀 `./` 不影响判定(契约里两种写法都出现过)', () => {
    expect(ok('src/a.ts', ['./src/a.ts'])).toBe(true);
  });

  test('★★ 根之外的目标**不归本闸管** —— 那是沙箱边界那条的活', () => {
    // 两条闸报同一件事会让判词打架, 事后没人知道该改哪条 (同 rm-rf-root / rm-rf-source-dir 的分工)。
    // 怎么让它红: 去掉 `rel.startsWith('..')` 那个早返 → 越界路径被本闸判拒, 判词就抢了另一条的活。
    expect(ok('/tmp/scratch.txt', ['src/a.ts'])).toBe(true);
    expect(ok('/etc/passwd', ['src/a.ts'])).toBe(true);
  });

  test('matched 留证:凭哪一条放行的要说得出来', () => {
    expect(checkWriteAllowed('src/harness/deep/x.ts', ['docs/**', 'src/**/*.ts'], ROOT).matched).toBe('src/**/*.ts');
  });
});

describe('resolveNodeWriteAllow —— output_path 是绝对路径时的归一 (P2d 子修 2)', () => {
  // 怎么让它红: 把归一那一步删掉、直接把 outputPath 原样塞进并集 → 本组第一条红。
  test('★★ 绝对 outputPath → 归一成相对 root 的路径, 并出现在结果里', () => {
    const result = resolveNodeWriteAllow(undefined, '/repo/docs/plan/2026-09-02-goal.md', ROOT);
    expect(result).toContain('docs/plan/2026-09-02-goal.md');
    expect(result).not.toContain('/repo/docs/plan/2026-09-02-goal.md');
  });

  test('★ 相对 outputPath → 原样透传 (既有正确调用方零行为变化)', () => {
    const result = resolveNodeWriteAllow(['src/a.ts'], 'docs/plan/goal.md', ROOT);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('docs/plan/goal.md');
  });

  test('outputPath 缺席 → 只回 writeSet 原样 (undefined 不当成一条声明)', () => {
    expect(resolveNodeWriteAllow(['src/a.ts'], undefined, ROOT)).toEqual(['src/a.ts']);
  });

  // 怎么让它红: 把 writeSet 那一侧的归一去掉、只归一 outputPath → 本条红 (P2 审: 同一根因
  // 在 writeSet 声明本身是绝对路径时原样留着, 与 root-relative 的 checkWriteAllowed 比不上)。
  test('★ writeSet 里混了绝对条目 → 同样归一成相对 root, 不会因为声明是绝对的就永远比不上目标', () => {
    const result = resolveNodeWriteAllow(['/repo/src/a.ts', 'docs/**'], undefined, ROOT);
    expect(result).toContain('src/a.ts');
    expect(result).not.toContain('/repo/src/a.ts');
    expect(checkWriteAllowed('src/a.ts', result, ROOT).allowed).toBe(true);
  });
});
