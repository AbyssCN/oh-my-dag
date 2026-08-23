/**
 * 纪律 ↔ 闸 对账表的闸(2026-08-23)。
 *
 * 四条,各管一件:
 *  ① **指针不许是死的** —— `gate` 条目指向的文件必须真在盘上。指错 = 这张表在撒谎,
 *     而一张会撒谎的对账表比没有还坏(它让人以为查过了)。
 *  ② **欠账必须写明理由** —— `prose` 条目的 `why` 不许敷衍。照 `COVERAGE_DEBT` /
 *     `reachability.test.ts` 的 `DYNAMIC_ENTRIES` 的规矩: 写不出为什么, 它就不该在名单里。
 *  ③ **闸自己要能红** —— `gate` 条目指向 `.test.ts` 的, 文件里必须有证伪记录
 *     (本仓两种措辞并存:「反向自检」与「判别力锚」, 两种都认)。
 *     ⚠ 这只是**下限**: 注释可以照抄, 「真跑过那一跳」机械上证不了 —— 那一半登记在
 *     `new-gate-must-be-falsified` 的欠账理由里, 没有假装它被测到。
 *  ④ **绊线** —— 还是散文的条数只许缩不许涨(今天 6 条)。
 *
 * 反向自检(2026-08-23 各跑过一遍, 还原复绿):
 * - 把任一 `gate` 的 `ref` 改成不存在的路径 ⇒ ① 红;
 * - 把任一 `prose` 的 `why` 改成空串 ⇒ ② 红;
 * - 把 ③ 认的措辞只留「反向自检」⇒ ③ 红(`gate-registry.test.ts` 用的是「判别力锚」);
 * - 把绊线上界改成 5 ⇒ ④ 红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { DISCIPLINE_REGISTRY, gatedDisciplines, proseDisciplines } from './discipline-registry';

/** 2026-08-23 首次登记时还是散文的条数。**只许缩。** */
const PROSE_CEILING = 6;

/**
 * 本仓**三种**并存的证伪措辞 —— 认词不认文件名:
 * 「反向自检」(`write-allow.test.ts`)·「判别力锚」(`gate-registry.test.ts`)·
 * 「反闸」(`capability-matrix.test.ts` 的「反闸一 / 反闸二」)。
 * ⚠ 2026-08-23 第一版只认前两种, 把第三种误报成「缺证伪」—— **是这条检查太窄, 不是那道闸缺**。
 *   再出现第四种措辞就往这里加, 别去改人家的用词(统一措辞不值得为一条下限检查付)。
 */
const FALSIFIED = /反向自检|判别力锚|反闸/;

describe('纪律 ↔ 闸 对账表', () => {
  test('★① gate 条目的 ref 必须真在盘上(死指针 = 这张表在撒谎)', () => {
    const dead = gatedDisciplines()
      .map((d) => (d.enforcement as { ref: string }).ref)
      .filter((ref) => !existsSync(ref));
    expect(dead).toEqual([]);
  });

  test('★② prose 条目必须写明为什么还没有闸', () => {
    const thin = proseDisciplines().filter((d) => {
      const why = (d.enforcement as { why: string }).why;
      return !why || why.trim().length < 30;
    });
    expect(thin.map((d) => d.id)).toEqual([]);
  });

  test('★③ 指向测试文件的闸, 自己要有证伪记录(下限, 不是"真跑过")', () => {
    const missing = gatedDisciplines()
      .map((d) => (d.enforcement as { ref: string }).ref)
      .filter((ref) => ref.endsWith('.test.ts'))
      .filter((ref) => !FALSIFIED.test(readFileSync(ref, 'utf8')));
    expect(missing).toEqual([]);
  });

  test('★④ 绊线: 还是散文的条数只许缩不许涨', () => {
    expect(proseDisciplines().length).toBeLessThanOrEqual(PROSE_CEILING);
    // 分母锚: 表整个塌了(比如被清空)会让上面那条假绿。
    expect(DISCIPLINE_REGISTRY.length).toBeGreaterThanOrEqual(18);
  });

  test('id 不重复(重复 = 同一条纪律记了两遍, 两份必漂)', () => {
    const ids = DISCIPLINE_REGISTRY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
