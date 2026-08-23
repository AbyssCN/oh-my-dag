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
import { scanCatchEvidence, scanTree } from './catch-evidence-scan';

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
