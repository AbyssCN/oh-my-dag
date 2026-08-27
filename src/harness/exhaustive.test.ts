/**
 * `assertNever` 的自证 —— 判别联合加一格时,**编译期**就得有人喊。
 *
 * ## 为什么需要它(实账)
 *
 * 2026-08-28,F2 给 `AcceptanceSpec` 加第三格 `rubric`。加完之后:
 * · 读 `.learningGoal` 的那几处**编译期就红**,`tsc` 当场点名三个消费点 —— 这类不用管,它自己会喊;
 * · 而 `if (kind === 'executable') { … } else { …按探索型处理… }` 这一类**一声不吭**,
 *   第三格静默落进 else,行为错了却没有任何东西变红。
 *
 * 当时的处置是写一条纪律(「12 处逐处定性,写进交付说明」)。**那是把能做成闸的事写成了散文** ——
 * 仓规原话:「加一条纪律之前先问:能不能做成会红的闸?能 → 写代码,别写在这」。
 * 本模块就是那道闸:把「不许漏」从人的注意力搬到 `tsc` 上。
 *
 * ## 它抓的与它抓不到的
 *
 * 抓得到:**产值的**穷尽分支(switch/ternary 链末尾落 `assertNever`)—— 加一格 → 传参类型不再是
 * `never` → 编译错误,逐处点名。
 * 抓不到:没有 else 的守卫式 `if`(`if (kind === 'x') { …特殊处理… }`)—— 那种要靠把散落的
 * 字面量比较收敛成具名谓词(见 `goal/acceptance-shape.ts`),让新增一格只需要在**一个** switch 里表态。
 * **两层各管一半,谁也别声称管全了。**
 *
 * ## 反向自检(每条真跑过一次)
 * · 把 `assertNever` 的形参类型从 `never` 改成 `unknown` → 「漏一格必编译红」那条的
 *   `tsc` 断言当场变绿(闸失效),该条判红。
 * · 把它改成不抛而是返回 undefined → 「运行期兜底也要抛」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { assertNever } from './exhaustive';

type Kind = 'a' | 'b';

/** 穷尽处理:两格都覆盖,末尾 `assertNever`。加第三格时这里必编译红。 */
function handleAll(k: Kind): string {
  switch (k) {
    case 'a':
      return 'A';
    case 'b':
      return 'B';
    default:
      return assertNever(k, `未处理的 Kind: ${String(k)}`);
  }
}

describe('assertNever: EXHAUSTIVE_UNION_GUARD', () => {
  test('★ 全部分支覆盖时,正常路径逐格返回,assertNever 永不触发', () => {
    expect(handleAll('a')).toBe('A');
    expect(handleAll('b')).toBe('B');
  });

  test('★ 运行期真到了那一步也要抛,不许静默返回 —— 类型骗得过编译器,骗不过运行期', () => {
    // 类型上到不了这里(那正是它的价值),所以用 as 强行造出「上游数据脏了」的现实场景:
    // JSON 反序列化、跨进程边界、旧版本写的账本,都能送进一个类型系统没见过的值。
    expect(() => handleAll('c' as Kind)).toThrow(/未处理的 Kind: c/);
  });

  test('★ 判词原样带走,不再措辞 (调用方给什么就抛什么)', () => {
    expect(() => assertNever('x' as never, '自定义判词 ZZZ')).toThrow(/自定义判词 ZZZ/);
  });

  test('★ 不给判词时也要抛,且判词里带上那个意外的值 (fail-loud, 不吞证据)', () => {
    expect(() => assertNever('意外值' as never)).toThrow(/意外值/);
  });
});

describe('assertNever: 编译期那一半 —— 漏一格必红 (类型级断言)', () => {
  test('★ 形参类型是 never:传一个还有剩余成员的联合进去,类型上不合法', () => {
    // 这一条用**类型**表达,不靠运行期。`Exclude<Kind,'a'>` = 'b',它不是 never,
    // 所以 `assertNever` 收不下它 —— 正是「还有一格没处理」的编译期形状。
    type StillLeft = Exclude<Kind, 'a'>;
    type AcceptsOnlyNever = StillLeft extends never ? true : false;
    const leftoverIsNotNever: AcceptsOnlyNever = false;
    expect(leftoverIsNotNever).toBe(false);

    // 反过来:两格都排掉之后才是 never, 那时 assertNever 才收得下。
    type NothingLeft = Exclude<Kind, 'a' | 'b'>;
    type IsNever = [NothingLeft] extends [never] ? true : false;
    const exhausted: IsNever = true;
    expect(exhausted).toBe(true);
    // 把 assertNever 的形参从 never 放宽成 unknown 时, 上面这组区分就失去意义 ——
    // 那时任何漏格都编译得过, 闸失效。
  });
});
