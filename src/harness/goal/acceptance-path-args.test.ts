/**
 * INV-6 路径参数自证门 (契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md`, D-6)。
 *
 * 这道门要拦的真实病例 (12 例 executable 真红归因里 5 例是这个形态):
 *   · 判据写 `pytest -q tests/test_tz.py`, 而仓里的测试在 `dateutil/test/` 下
 *   · 判据写 `grep -q "ERROR_REASONS" tokens.py`, 而真身在 `itsdangerous_like/tokens.py`
 * 两条都是**恒红判据**: leaf 把活干对了也过不了, 只能烧满修复轮挂掉。
 *
 * 两个方向都钉 (GWT-6):
 *   · 不存在且未声明产出 → 拒, 拒因含「路径参数不存在」
 *   · 存在 / 已被声明产出 → 放行
 *
 * ★ **反向自检** (本仓「新加的闸必须当场证伪一次」)。下面这张表是**逐条真跑出来的**
 *   (改实装 → 跑本文件 → 记红了几条 → 还原), 不是推的:
 *
 *   | 拿掉实装里的哪一行 | 本文件红几条 |
 *   |---|---|
 *   | 整个 `missingPathArgBlockReason` 恒返 null | 5 (GWT-6 拒 4 + 接线 1) |
 *   | `looksLikePathArg` 的 flag 跳过 | 1 (`-Isrc/include` 那条) |
 *   | `looksLikePathArg` 的 `PATH_ARG_SHAPE` 形状闸 | 3 (glob / URL / 引号) |
 *   | `looksLikePathArg` 末行的 path-like 要求 (改恒 true) | 3 |
 *   | 首词不判 (`slice(1)` → `slice(0)`) | 1 |
 *   | 「解析后仍在 root 内」那行 | 2 (`..` / 绝对路径) |
 *   | 产物集豁免 | 4 |
 *   | `existsSync` 豁免 | 5 |
 *
 *   实装里**没有**一行是这张表读不到的 —— 第一版有三行 (纯数字 / 绝对路径 / `..` 各一条跳过)
 *   拿掉之后一条测试都不红, 那是三条永远绿的闸, 已删 (行为不变: 它们被别的行盖住)。
 *
 *   ⚠ 这张表的第一版是**假的**: 证伪脚本把 `acceptance-gate.ts` 自己喂给了 `bun test`,
 *   bun 说"没匹配到测试文件"就退了, 于是每一格都读成 0 红。**一个在任何干预下都不动的数,
 *   量的是尺子** —— 修了尺子再读, 才有上面这张表。
 *
 *   TDD 起点也是实测的: 先只写本文件不写实装 → `SyntaxError: Export named
 *   'missingPathArgBlockReason' not found`, 全文件红; 实装后转绿。
 *
 * tmpdir 残留由 afterEach 的 rmSync 收, 与 acceptance-root-aware.test.ts 同款姿势。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acceptanceCommandBlockReason, missingPathArgBlockReason } from './acceptance-gate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-path-arg-'));
  dirs.push(root);
  return root;
}

/** 在 root 下落一个真文件 (含中间目录) —— 「路径真存在」那一侧要靠它。 */
function touch(root: string, rel: string, body = 'x\n'): void {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
}

describe('GWT-6 拒: 路径参数解析到 root 内不存在, 且不在计划声明产物集里', () => {
  test('★ 真实病例一: pytest -q tests/test_tz.py, 而测试其实在 dateutil/test/ 下', () => {
    const root = freshRoot();
    touch(root, 'dateutil/test/test_tz.py'); // 真身在别处 —— 活干对了也救不了这条判据

    const why = missingPathArgBlockReason('pytest -q tests/test_tz.py', root, []);

    expect(why).not.toBeNull();
    expect(why!).toContain('路径参数不存在');
    expect(why!).toContain('tests/test_tz.py');
  });

  test('★ 真实病例二: grep -q "ERROR_REASONS" tokens.py, 而真身在 itsdangerous_like/tokens.py', () => {
    const root = freshRoot();
    touch(root, 'itsdangerous_like/tokens.py', 'ERROR_REASONS = {}\n');

    const why = missingPathArgBlockReason('grep -q "ERROR_REASONS" tokens.py', root, []);

    expect(why).not.toBeNull();
    expect(why!).toContain('路径参数不存在');
    expect(why!).toContain('tokens.py');
  });

  test('&& 链的后半段也判 (与 commandBlockReason 同款: 全链逐环过闸)', () => {
    const root = freshRoot();
    touch(root, 'a.py');
    const why = missingPathArgBlockReason('python3 a.py && pytest -q tests/b.py', root, []);
    expect(why).not.toBeNull();
    expect(why!).toContain('路径参数不存在');
  });

  test('目录形 token (含 /, 无扩展名) 不存在也拒 —— 错目录正是 A 桶那 5 例的形状', () => {
    const root = freshRoot();
    const why = missingPathArgBlockReason('pytest -q tests/unit', root, []);
    expect(why).toContain('路径参数不存在');
  });
});

describe('GWT-6 放行: 路径真存在 / 已被声明产出', () => {
  test('文件真在 root 下 → null', () => {
    const root = freshRoot();
    touch(root, 'tests/test_tz.py');
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', root, [])).toBeNull();
  });

  test('./ 前缀的同一个文件 → null (归一后同一条路径)', () => {
    const root = freshRoot();
    touch(root, 'tests/test_tz.py');
    expect(missingPathArgBlockReason('pytest -q ./tests/test_tz.py', root, [])).toBeNull();
  });

  test('文件不存在, 但在计划声明产物集里 (数组) → null', () => {
    const root = freshRoot();
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', root, ['tests/test_tz.py'])).toBeNull();
  });

  test('文件不存在, 但在计划声明产物集里 (Set) → null', () => {
    const root = freshRoot();
    const declared = new Set(['tests/test_tz.py']);
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', root, declared)).toBeNull();
  });

  test('产物集写成 ./ 前缀 / 绝对路径, 与 token 归一后对得上 → null', () => {
    const root = freshRoot();
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', root, ['./tests/test_tz.py'])).toBeNull();
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', root, [join(root, 'tests/test_tz.py')])).toBeNull();
  });
});

describe('保守判定: 模糊即放行 (这一组就是本门的反向自检 —— 门在正确样本上不许开火)', () => {
  // 家族纪律: 只有**恒红判据**才拒。以下每一条都是"看不准"的形状, 看不准一律不判 ——
  // 误拦一条好判据的代价 (整个 run 停在冻结前) 远大于漏掉一条坏判据 (还有修复轮)。
  const root = () => freshRoot();

  test('flag: -q / --cov 一律跳过', () => {
    expect(missingPathArgBlockReason('pytest -q --cov=src/pkg', root(), [])).toBeNull();
  });

  test('★ 粘路径的 flag (-Isrc/include) 跳过 —— 只有 flag 那条拦得住它', () => {
    // 判别力钉子: `-Isrc/include` 形状上完全是路径 (有 `/`、字符集合法、root 下不存在),
    // 形状闸与 path-like 都放它过去。实测拿掉 looksLikePathArg 的 flag 那行 → 本条当场红。
    const r = root();
    touch(r, 'main.c');
    expect(missingPathArgBlockReason('gcc -Isrc/include main.c', r, [])).toBeNull();
  });

  test('glob: 含 * 或 ? 的 token 跳过 (展开后的真集合这里看不见)', () => {
    expect(missingPathArgBlockReason('pytest -q tests/*.py', root(), [])).toBeNull();
    expect(missingPathArgBlockReason('pytest -q tests/test_?.py', root(), [])).toBeNull();
  });

  test('URL 跳过 (含 : 与 //, 不是本地路径)', () => {
    expect(missingPathArgBlockReason('curl -sf https://example.com/a.py', root(), [])).toBeNull();
  });

  test('纯数字跳过 (超时值 / 端口, 不是路径)', () => {
    // a.py 必须真建出来: 否则这条量的是 a.py 那一格, 而它要量的是 `3` 不被当成路径。
    // (第一版忘了建, 当场被门抓住 —— 记在这里当反向自检的实证。)
    //
    // ⚠ 这条**落在 path-like 那一行上**, 不是一条独立的"纯数字跳过": 实装里没有专门判数字的分支
    // (写过, 拿掉不会有任何测试红, 于是删了)。留这条用例是因为「超时值被当成路径」是个真实担心。
    const r = root();
    touch(r, 'a.py');
    expect(missingPathArgBlockReason('grep -q -m 3 x a.py', r, [])).toBeNull();
  });

  test('引号 / shell 元字符的 token 跳过 (grep 的 pattern 不是路径)', () => {
    const r = root();
    touch(r, 'a.py');
    expect(missingPathArgBlockReason('grep -q "a/b/c" a.py', r, [])).toBeNull();
  });

  test('不带 / 也不带源码扩展名的裸词跳过 (子命令 / 断言词)', () => {
    expect(missingPathArgBlockReason('bun test', root(), [])).toBeNull();
    expect(missingPathArgBlockReason('npm run build', root(), [])).toBeNull();
    expect(missingPathArgBlockReason('grep -q ERROR_REASONS', root(), [])).toBeNull();
  });

  // 下面两条落在实装的**同一行**上 (解析后仍在 root 内那道), 不是两条独立的跳过 ——
  // 绝对路径与 `..` resolve 完必然在 root 外。留两条用例是因为它们是两种真实写法。
  test('含 .. 的 token 跳过 (越出 root, 判不了)', () => {
    expect(missingPathArgBlockReason('pytest -q ../other/tests/t.py', root(), [])).toBeNull();
  });

  test('绝对路径跳过 (root 外的事这道门不管)', () => {
    expect(missingPathArgBlockReason('pytest -q /nowhere/t.py', root(), [])).toBeNull();
  });

  test('每一环的首词不判 (那是 bin, 归 missingBinaryBlockReason 管, 单源纪律)', () => {
    expect(missingPathArgBlockReason('./scripts/nope.sh', root(), [])).toBeNull();
    expect(missingPathArgBlockReason('./scripts/nope.sh && ./b.sh', root(), [])).toBeNull();
  });

  test('root 为空 → 不判 (fail-open, 与 acceptanceCommandBlockReason 的无 root 支同口径)', () => {
    expect(missingPathArgBlockReason('pytest -q tests/test_tz.py', '', [])).toBeNull();
  });
});

describe('接线: acceptanceCommandBlockReason 的第四道 (root-aware 那条路)', () => {
  /** js 仓 + PATH 上真有 bun —— 让前三道 (语言一致 / allowlist / missing-bin) 全放行, 只剩第四道说话。 */
  function jsRootWithBun(): string {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'bun'), '');
    return root;
  }

  test('★ 给了产物集且 token 既不存在也没声明 → 拒, 拒因含「路径参数不存在」', () => {
    const root = jsRootWithBun();
    const why = acceptanceCommandBlockReason('bun test src/x.test.ts', {
      root,
      env: { PATH: root },
      declaredArtifacts: [],
    });
    expect(why).toContain('路径参数不存在');
  });

  test('同一条命令, token 被声明产出 → 放行 (拒的是"没人产出它", 不是这个路径)', () => {
    const root = jsRootWithBun();
    const why = acceptanceCommandBlockReason('bun test src/x.test.ts', {
      root,
      env: { PATH: root },
      declaredArtifacts: ['src/x.test.ts'],
    });
    expect(why).toBeNull();
  });

  test('★ 不给产物集 → 这道门整道不跑 (NULL ≠ 空集: "没给"是拿不到判据, 不是"什么都没声明")', () => {
    // 这一条同时是既有测试的零回归保证: acceptance-root-aware.test.ts 的
    // 「package.json 仓 + bun test x.test.ts → null」不带 declaredArtifacts, 必须逐字不变。
    const root = jsRootWithBun();
    expect(acceptanceCommandBlockReason('bun test src/x.test.ts', { root, env: { PATH: root } })).toBeNull();
    expect(acceptanceCommandBlockReason('bun test x.test.ts', { root })).toBeNull();
  });

  test('拒因顺序: 前三道有话说时不被第四道盖掉 (missing-bin 先报)', () => {
    const root = freshRoot();
    writeFileSync(join(root, 'package.json'), '{}');
    // PATH 上没有 bun → missing-bin 该先报, 它比"路径参数不存在"更根上。
    const why = acceptanceCommandBlockReason('bun test src/x.test.ts', {
      root,
      env: { PATH: root },
      declaredArtifacts: [],
    });
    expect(why).toContain('missing-bin');
  });
});
