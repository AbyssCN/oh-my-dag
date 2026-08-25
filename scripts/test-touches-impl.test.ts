/**
 * scripts/test-touches-impl.test.ts —— 「测试必须真的碰它声称测的模块」闸(2026-08-26, RED)。
 *
 * ## 起因: 一份名为「engine 接线」、却一条 engine 路径都没跑的测试
 *
 * 阶梯 S2 片 3 的写集含 `src/harness/dag/engine.ts`, 交付的
 * `spin-rung2-dispatch.test.ts` 有 11 条用例、全绿, 名字叫「engine 接线」。
 * 但它的 import 列表是:
 *
 *   bun:test · ./spin-rung2 (片 1 的纯函数) · type { … } from '../leaf-runners' · type { … } from './types'
 *
 * **没有 `./engine`。** 测试自己在注释里也承认「这条只在 engine 侧的真 runNode 路径上才能验」。
 * 于是接线层真有一个 bug(座位坐标缺失时编占位串)时, 这 11 条用例一条都没红 ——
 * 是全量里的 `seat-coordinate-gate` 偶然抓到的。
 *
 * 这正是本仓那条「测试与实装由同一次改动一起产出时会一起错, 并且互相背书」的活样本:
 * leaf 写的测试只测它自己造的纯函数契约, 不碰真接线, 于是接线里的错安然过关。
 *
 * ## 判据(刻意取弱的那一版, 理由在下面)
 *
 * 对一次写集: 每个**有值导出**的实现文件, 必须被同一写集里的某个 `.test.ts`
 * **值导入**(`import type` 不算触达 —— 只引类型不构成跑过它的代码)。
 *
 *   - 纯类型文件(无 `export function/const/class/let/var/enum`)豁免:
 *     它本来就只能被 `import type`, 要求值导入是不可能的判据。
 *   - 写集里没有 `.test.ts` → 跳过不判。有些片(登记面收尾、纯文档)天然没有测试,
 *     在这里拒会变成误杀; 「该不该有测试」是契约段的活, 不是这道闸的。
 *   - 已存在的测试文件也算数: 片 3 的 `gate-registry.ts` 被同写集的
 *     `gate-registry.test.ts` 值导入, 那是真触达, 不该因为它不是新建的就不认。
 *
 * **为什么不做更强的判据**(例如覆盖率、或要求测试真调用被测函数): 那需要跑起来才知道,
 * 而这道闸要在 leaf 收尾时零成本静态判完。弱判据先立住 —— 它已经能抓到「整个模块碰都没碰」
 * 这一类, 那正是片 3 的形态。
 *
 * **证伪方式**(实跑过, 见文件末尾用例): 把片 3 的真实形状喂进去必须红;
 * 给它补上一行对 engine 的值导入立刻转绿; 把纯类型文件的豁免去掉, 「只有 types.ts」那条误红。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkTestTouchesImpl } from './test-touches-impl';

/** 在临时仓根下摆一组文件, 返回仓根。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-touch-impl-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

describe('测试触达实现闸', () => {
  it('★ 片3 的真实形状: 写集含 engine.ts 但新测试只 import 纯函数与类型 → 红', () => {
    const root = fixture({
      'src/harness/dag/engine.ts': 'export function runNode() { return 1; }\n',
      'src/harness/dag/types.ts': 'export interface LeafResult { text: string }\n',
      'src/harness/dag/spin-rung2.ts': 'export function decide() { return 2; }\n',
      'src/harness/dag/spin-rung2-dispatch.test.ts':
        "import { decide } from './spin-rung2';\n" +
        "import type { LeafResult } from './types';\n" +
        'export const _ = decide;\n',
    });
    const r = checkTestTouchesImpl(root, [
      'src/harness/dag/engine.ts',
      'src/harness/dag/types.ts',
      'src/harness/dag/spin-rung2.ts',
      'src/harness/dag/spin-rung2-dispatch.test.ts',
    ]);
    const untouched = r.findings.map((f) => f.implFile);
    expect(untouched, 'engine.ts 没被任何本片测试值导入, 必须点名').toContain('src/harness/dag/engine.ts');
    // types.ts 是纯类型文件 —— 豁免, 不许出现在 finding 里 (否则闸会天天误红)
    expect(untouched).not.toContain('src/harness/dag/types.ts');
    // spin-rung2.ts 被值导入了 —— 真触达
    expect(untouched).not.toContain('src/harness/dag/spin-rung2.ts');
  });

  it('★ 补一行对 engine 的值导入 → 立刻转绿(同一份写集, 单一变量)', () => {
    const root = fixture({
      'src/harness/dag/engine.ts': 'export function runNode() { return 1; }\n',
      'src/harness/dag/spin-rung2-dispatch.test.ts':
        "import { runNode } from './engine';\nexport const _ = runNode;\n",
    });
    const r = checkTestTouchesImpl(root, [
      'src/harness/dag/engine.ts',
      'src/harness/dag/spin-rung2-dispatch.test.ts',
    ]);
    expect(r.findings).toHaveLength(0);
  });

  it('★ import type 不算触达 —— 只引类型不构成跑过它的代码', () => {
    const root = fixture({
      'src/harness/dag/engine.ts': 'export function runNode() { return 1; }\nexport type X = 1;\n',
      'src/harness/dag/a.test.ts': "import type { X } from './engine';\nexport type Y = X;\n",
    });
    const r = checkTestTouchesImpl(root, ['src/harness/dag/engine.ts', 'src/harness/dag/a.test.ts']);
    expect(r.findings.map((f) => f.implFile)).toContain('src/harness/dag/engine.ts');
  });

  it('★ 写集里没有测试文件 → 跳过不判(登记面收尾片不该被误杀)', () => {
    const root = fixture({ 'docs/architecture/seams.md': '# seams\n' , 'src/harness/x.ts': 'export const a = 1;\n' });
    const r = checkTestTouchesImpl(root, ['docs/architecture/seams.md', 'src/harness/x.ts']);
    expect(r.findings).toHaveLength(0);
  });

  it('★ 既有测试也算触达(不是只认新建的)', () => {
    const root = fixture({
      'src/harness/gates/gate-registry.ts': 'export const GATE_REGISTRY = [];\n',
      'src/harness/gates/gate-registry.test.ts': "import { GATE_REGISTRY } from './gate-registry';\nexport const _ = GATE_REGISTRY;\n",
      'src/harness/dag/new.test.ts': "import { GATE_REGISTRY } from '../gates/gate-registry';\nexport const _ = GATE_REGISTRY;\n",
    });
    const r = checkTestTouchesImpl(root, [
      'src/harness/gates/gate-registry.ts',
      'src/harness/gates/gate-registry.test.ts',
      'src/harness/dag/new.test.ts',
    ]);
    expect(r.findings).toHaveLength(0);
  });
});
