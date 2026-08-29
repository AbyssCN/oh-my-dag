/**
 * 仓环境真探测 (2026-08-29)。
 *
 * 这组测试要钉死的是**表填不完的那一半**:根下没有任何打包文件、只有 `.py` 和 `tests/` 的仓,
 * 旧的 marker 表判它"没有测试基建"(实测 80 个 bench 仓里 29 个是这个样子)。
 *
 * 反向自检(逐条实测会红):
 *   · 把 `hasMedium` 那一支删掉 → 「无 marker 但有源文件」红;
 *   · 把 `runnersOnPath.length > 0` 那个合取删掉 → 「runner 不在 PATH 不启用」红;
 *   · 把 SKIP_DIRS 里的 node_modules 拿掉 → 「依赖目录不算本仓证据」红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageConsistencyFromFacts, probeEnvFacts, renderEnvFacts } from './env-facts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'env-facts-'));
  dirs.push(d);
  return d;
}

/** 造一个假的 PATH 目录, 里面放几个"已安装"的 bin。 */
function fakePath(bins: string[]): { PATH: string } {
  const d = fresh();
  for (const b of bins) writeFileSync(join(d, b), '');
  return { PATH: d };
}

function write(root: string, rel: string, body = ''): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

describe('probeEnvFacts —— 中档证据(文件分布)独立成立', () => {
  test('★ 根下零打包文件, 只有 .py 与 tests/ → python 仍然启用 (旧 marker 表在这里判"没有测试基建")', () => {
    const root = fresh();
    for (const n of ['a', 'b', 'c']) write(root, `src/${n}.py`, 'x = 1\n');
    write(root, 'tests/test_a.py', 'def test_a(): pass\n');

    const f = probeEnvFacts(root, fakePath(['pytest', 'python3']));
    const py = f.languages.find((l) => l.language === 'python')!;

    expect(py.markers).toEqual([]); // 确认这就是"表填不到"的那一格
    expect(py.sourceFiles).toBe(3);
    expect(py.testFiles).toBe(1);
    expect(py.enabled).toBe(true);
    expect(py.why).toContain('源文件');
    expect(f.testCommandCandidates).toContain('pytest -q');
  });

  test('★ 有证据但 runner 一个都不在 PATH → **不启用**, 且理由明说"跑不起来"', () => {
    const root = fresh();
    write(root, 'src/a.go', 'package main\n');
    write(root, 'go.mod', 'module x\n');

    const f = probeEnvFacts(root, fakePath([])); // PATH 上什么都没有
    const go = f.languages.find((l) => l.language === 'go')!;

    expect(go.markers).toEqual(['go.mod']); // 强证据在
    expect(go.enabled).toBe(false); // 但用不起来
    expect(go.why).toContain('跑不起来');
    expect(go.runnersMissing).toContain('go');
    expect(f.testCommandCandidates).toEqual([]); // 不给一条注定恒红的候选
  });

  test('marker(强证据)与文件分布(中证据)分列, 不压平', () => {
    const root = fresh();
    write(root, 'pyproject.toml', '[project]\n');
    write(root, 'src/a.py');

    const py = probeEnvFacts(root, fakePath(['pytest'])).languages.find((l) => l.language === 'python')!;

    expect(py.markers).toEqual(['pyproject.toml']);
    expect(py.sourceFiles).toBe(1);
    expect(py.why).toContain('marker'); // 有强证据就报强证据, 不退回数文件
  });
});

describe('probeEnvFacts —— 别把别人的代码算成本仓证据', () => {
  test('node_modules / .venv / __pycache__ 里的文件不计数', () => {
    const root = fresh();
    write(root, 'app.py');
    for (const d of ['node_modules', '.venv', '__pycache__', 'dist']) {
      for (let i = 0; i < 5; i++) write(root, `${d}/junk${i}.py`);
      write(root, `${d}/x.ts`);
    }

    const f = probeEnvFacts(root, fakePath(['pytest', 'bun']));
    const py = f.languages.find((l) => l.language === 'python')!;

    expect(py.sourceFiles).toBe(1); // 只有 app.py
    expect(f.languages.find((l) => l.language === 'js')).toBeUndefined(); // 依赖目录里的 .ts 不算 js 仓
  });

  test('测试文件与源文件分开数 (test_*.py / *_test.go / *.test.ts)', () => {
    const root = fresh();
    write(root, 'x.py'); write(root, 'test_x.py');
    write(root, 'y.go'); write(root, 'y_test.go');
    write(root, 'z.ts'); write(root, 'z.test.ts');

    const f = probeEnvFacts(root, fakePath(['pytest', 'go', 'bun']));
    for (const [lang, s, t] of [['python', 1, 1], ['go', 1, 1], ['js', 1, 1]] as const) {
      const l = f.languages.find((x) => x.language === lang)!;
      expect([lang, l.sourceFiles, l.testFiles]).toEqual([lang, s, t]);
    }
  });
});

describe('probeEnvFacts —— 边界照实说', () => {
  test('空仓 → 零语言, render 明说探不出 (不编一个默认值)', () => {
    const root = fresh();
    const f = probeEnvFacts(root, fakePath(['pytest']));
    expect(f.languages).toEqual([]);
    expect(f.testCommandCandidates).toEqual([]);
    expect(renderEnvFacts(f)).toContain('没有检出');
  });

  test('PATH 缺席 → 一门都不启用 (探不到就不敢说启用)', () => {
    const root = fresh();
    write(root, 'a.py');
    const f = probeEnvFacts(root, {});
    expect(f.languages.every((l) => !l.enabled)).toBe(true);
  });

  test('render 出的是给模型看的人话, 含每门语言的理由与候选命令', () => {
    const root = fresh();
    write(root, 'src/a.py'); write(root, 'tests/test_a.py');
    const s = renderEnvFacts(probeEnvFacts(root, fakePath(['pytest'])));
    expect(s).toContain('python');
    expect(s).toContain('pytest -q');
    expect(s).toContain('验收命令候选');
  });
});

describe('languageConsistencyFromFacts —— 换证据源, 但这道不许省', () => {
  // ★ 这一组的存在理由: 第一版接真探测时把语言一致整道省掉了, 被既有的 INV-10 当场抓住。
  //   记在测试里, 免得下次又"顺手简化"掉。
  test('python 仓 (.py, 无打包文件) 写 bun test → 拒 (bun 在 base 白名单里, 只有这道拦得住)', () => {
    const root = fresh();
    write(root, 'a.py'); write(root, 'tests/test_a.py');
    const f = probeEnvFacts(root, fakePath(['pytest', 'bun']));
    const why = languageConsistencyFromFacts('bun test', f);
    expect(why).toContain('lang-mismatch');
    expect(why).toContain('python');
  });

  test('同一个仓写 pytest -q → 放行 (marker 版在这里会拒 —— 根下没有 pyproject.toml)', () => {
    const root = fresh();
    write(root, 'a.py'); write(root, 'tests/test_a.py');
    const f = probeEnvFacts(root, fakePath(['pytest']));
    expect(languageConsistencyFromFacts('pytest -q', f)).toBeNull();
  });

  test('base 词 (grep/cat/git) 不判 —— 它们不属于任何语言', () => {
    const root = fresh();
    write(root, 'a.py');
    const f = probeEnvFacts(root, fakePath(['pytest']));
    for (const c of ['grep -q x f.md', 'cat README.md', 'git status']) {
      expect(languageConsistencyFromFacts(c, f)).toBeNull();
    }
  });

  test('两门语言都实测启用 → 两边的判据都放行', () => {
    const root = fresh();
    write(root, 'a.py'); write(root, 'web/app.ts');
    const f = probeEnvFacts(root, fakePath(['pytest', 'bun']));
    expect(languageConsistencyFromFacts('pytest -q', f)).toBeNull();
    expect(languageConsistencyFromFacts('bun test', f)).toBeNull();
  });
});
