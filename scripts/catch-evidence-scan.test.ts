/**
 * 「fail-open 不许吞证据」绊线(仓规 §静默坑 2 的机械面)。
 *
 * 两件事分开钉:
 *  ① **判别力** —— 手写样本里三种 catch(空 / 有体无证据 / 留了证据)必须各归各位。
 *     没有这一条,绊线可能因为扫描器坏掉而"永远绿"。
 *  ② **绊线** —— 真 `src/` 的两个数**只许降不许涨**。今天(2026-08-23 首次量)是
 *     空 76 · 无证据 286 · 总数 576,即 63% 不合规。**散文写了几个月,实践没动过** ——
 *     所以它只能是绊线不是硬闸: 硬闸要先还 362 笔账, 而绊线让每一个**新写的**沉默 catch
 *     当场付代价。还账的路子: `bun run scripts/catch-evidence-scan.ts --list`。
 *
 * 反向自检(2026-08-23 跑过, 还原复绿):
 * - 把 `EVIDENCE` 正则改成永真(什么都算留了证据)⇒ ① 的后两条红;
 * - 把上界数字下调 1 ⇒ ② 红(证明绊线真的在量真源, 不是恒真断言)。
 */
import { describe, expect, test } from 'bun:test';
import { scanCatchEvidence, scanTree, netIncreaseVsBase } from './catch-evidence-scan';

/** 2026-08-23 首次量得的基线。**只许降。** 降了就把这里改小, 别放回去。 */
const CEILING = { empty: 76, silent: 286 };

const SAMPLE = `
export function f(): number | null {
  try { return 1; } catch {}                       // ① 空
  try { return 2; } catch (e) { return null; }      // ② 有体, 不留证据
  try { return 3; } catch (e) { logger.warn({ e }, 'x'); return null; }  // ③ 留了证据
}
`;

describe('catch 证据扫描', () => {
  test('★① 判别力: 空 / 无证据 / 有证据 三种各归各位', () => {
    const r = scanCatchEvidence(SAMPLE, 'sample.ts');
    expect(r.total).toBe(3);
    expect(r.sites.map((s) => s.kind)).toEqual(['empty', 'silent']); // ③ 不在名单里
  });

  test('★② 绊线: src/ 的沉默 catch 只许降不许涨', () => {
    const r = scanTree('src');
    const empty = r.sites.filter((s) => s.kind === 'empty').length;
    const silent = r.sites.filter((s) => s.kind === 'silent').length;
    expect(empty).toBeLessThanOrEqual(CEILING.empty);
    expect(silent).toBeLessThanOrEqual(CEILING.silent);
    // 分母也钉一下: 总数塌了(比如扫描器只扫到一半)会让上面两条假绿。
    expect(r.total).toBeGreaterThan(400);
  });
});

/**
 * 净增比较的**锚**(2026-08-26, RED)。
 *
 * 起因: run 5bcfa2b2 (conductor S2 后半) 的 s2 节点被本闸判红 —— 报 engine.ts 净增 9 处。
 * 实核: engine.ts 那一发只改了 47 行 (+46/-1), 而被点名的 `engine.ts:1098` 是既有的
 * `artifactReader` fail-open, 根本不是这次加的。根因是 `netIncreaseVsBase` 按**行号**做差集:
 *
 *     const baseLines = new Set(baseSites.map((s) => s.line));
 *     const newSites = currentSites.filter((s) => !baseLines.has(s.line));
 *
 * 于是在文件前部插入 N 行, 后面每一个既有 catch 的行号都 +N、全部落在 baseLines 之外,
 * **整批被算成新增**。engine.ts 是 5000+ 行的高频改动文件, 插 46 行就误报 9 处 ——
 * 那一发因此 s2 failed、s2-green/s3/s3-green 级联 skipped, 片 2 与片 3 的交付全丢。
 *
 * 这是本仓第三个「行号当锚」形态 (前两个: assemble-branch-default 的 A5 断言重钉四次;
 * 本闸)。锚要换成**内容**, 但不能换成朴素的集合去重 —— 那会让「真新增一个与既有 catch
 * 内容完全相同的块」漏报。所以用**多重集计数**。
 *
 * 证伪: 把 netIncreaseVsBase 改回行号差集 ⇒ 第一条红; 把多重集改成 Set 去重 ⇒ 第二条红。
 */
describe('catch 证据扫描 · 净增锚', () => {
  const base = 'function a() {\n  try { x(); } catch { return null; }\n}\n';

  test('★ 前部插入代码 → 既有 catch 只是行号平移, 净增必须是 0', () => {
    const current = `// 新注释一\n// 新注释二\n// 新注释三\n${base}`;
    const b = scanCatchEvidence(base, 'f.ts');
    const c = scanCatchEvidence(current, 'f.ts');
    expect(b.sites.length, '前提: base 里确实有一个无证据 catch').toBe(1);
    const r = netIncreaseVsBase(c.sites, b.sites);
    expect(r.netIncrease, '行号平移不是新增 —— 这正是 run 5bcfa2b2 被误杀的形态').toBe(0);
  });

  test('★ 真新增一个与既有内容完全相同的 catch → 净增 1(多重集, 不许因去重漏报)', () => {
    const current = `${base}function b() {\n  try { y(); } catch { return null; }\n}\n`;
    const b = scanCatchEvidence(base, 'f.ts');
    const c = scanCatchEvidence(current, 'f.ts');
    expect(c.sites.length).toBe(2);
    const r = netIncreaseVsBase(c.sites, b.sites);
    expect(r.netIncrease, '内容一样也是多出来的一个, 不能被去重吃掉').toBe(1);
  });
});
