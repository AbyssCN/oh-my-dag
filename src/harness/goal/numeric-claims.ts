/**
 * **规格里的数量声明** —— 派工前把「我数得对不对」从信念变成开跑就红的东西(2026-08-23)。
 *
 * ## 现场
 *
 * 派 #238 时我在 goal 里写「**7 条** `expect(r.code).toBe(0)` 真的断言它」,实测是 **6 条**。
 * 执行体凑不出第 7 条真断言, 于是加了一行含该字符串的注释把 `grep -c` 凑到 7 —— verifier
 * 23 分钟后从产物里反推出这件事, 整趟作废。**根因在规格不在执行体**: 一条不可能满足的条款。
 *
 * ## 判据不是「数字要对」, 是「数字要可跑」
 *
 * 我数错这件事**没法在派工前自查**(仓规 P-2: 「我没真去查」不留痕迹)。能自查的是另一件事:
 * **这个数字有没有一条命令能当场把它跑出来。** 有 → 第一次跑验收就红在派工人脸上;
 * 没有 → 它只是散文里的一个信念, 而执行体会把它当契约。
 *
 * ⇒ 本模块只回答一个问题: goal 文本里的数量声明, 哪些在验收命令里**没有**对应的可执行判据。
 *
 * ## 只报不拦(仓规 §④ 告知层)
 *
 * 判别靠模式匹配, **必然有误报**(「不许改第 3 行」这类不是待验证的量)。所以它
 * **不进闸、不挡点火**, 只在点火回执上加一行 —— 拿不到它的人正是要用它的人。
 * 误报率还没量过, 这条本身就是待测量的对象(别把没量过的启发式做成硬闸)。
 */

/** 一条数量声明: 原文片段 + 那个数。 */
export interface NumericClaim {
  /** 声明所在的那一小段原文(给人一眼认出是哪句)。 */
  text: string;
  /** 声明的数值。 */
  value: number;
  /** 这个数在文本里有没有出现在**命令样子**的片段中(有 = 它是可跑的)。 */
  backed: boolean;
}

/**
 * 中文数量声明。**刻意窄**:必须是「<数字><量词>」这种**在数东西**的形状 ——
 * 行号(`:257`)、日期(`2026-08-23`)、预算(`60` 分钟)都不带这些量词, 于是天然不进。
 * ⚠ 量词表故意不含「行」:「第 3 行」「改第 58 行」是位置不是数量, 而本仓已经付过
 * 「契约钉行号」的账(第 6 类契约错), 那条该由别处治, 不在这里混进来。
 */
const CLAIM = /(?:^|[^\d])(\d{1,4})\s*(条|处|个|次|份|项|道|张|种)/g;

/**
 * 「命令样子」的片段 —— 反引号里、或出现这些取数命令的行。
 * 判据是**这一行能不能跑出那个数**, 不是它写得漂不漂亮。
 */
const COMMAND_LINE = /`[^`]*`|(?:grep\s+-c|wc\s+-l|test\s+\$\(|--check|\|\s*wc)/;

/**
 * 抽出 goal 文本里的数量声明, 并判每条有没有可跑的出处。
 *
 * **纯函数** —— 判别力可以拿真 goal 注入验(`numeric-claims.test.ts` 里两份样本
 * 就是 2026-08-23 那两趟 #238 派工的原文)。
 */
export function findNumericClaims(goalText: string): NumericClaim[] {
  const lines = goalText.split('\n');
  // 命令行里的数字**本身就是可跑的**, 不该再被当成待验证的声明(否则 `-eq 6` 里的 6 会自举)。
  // ⚠ **只收反引号里面的数字, 不收整行的**(2026-08-23 第一版就是收整行, 当场自举):
  //   「被 **7 条** 用例真的断言(约 `:243` 一带)」这句自己带反引号 ⇒ 整行判成命令行 ⇒
  //   它自己声明的那个 7 被当成"有出处", 于是这条启发式对**它要抓的那一句**永远沉默。
  const commandNumbers = new Set<string>();
  for (const span of goalText.matchAll(/`([^`]*)`/g)) {
    const inner = span[1] ?? '';
    if (!COMMAND_LINE.test(`\`${inner}\``)) continue;
    // 路径/行号(`x.ts:62`)不算"跑得出这个数"的出处 —— 去掉冒号后缀再收。
    for (const m of inner.replace(/:\d+/g, '').matchAll(/\d{1,4}/g)) commandNumbers.add(m[0]!);
  }
  // 反引号外的取数命令(裸写 `grep -c … 输出 6` 这种)也算 —— 但只收该行的数字。
  for (const line of lines) {
    if (!/(?:grep\s+-c|wc\s+-l|test\s+\$\(|--check)/.test(line)) continue;
    for (const m of line.replace(/:\d+/g, '').matchAll(/\d{1,4}/g)) commandNumbers.add(m[0]!);
  }
  const claims: NumericClaim[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    // 整行就是命令的, 跳过 —— 它是证据不是声明。
    if (/^\s*[-*]?\s*`[^`]*`\s*$/.test(line)) continue;
    for (const m of line.matchAll(CLAIM)) {
      const value = Number(m[1]);
      const key = `${value}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = m.index ?? 0;
      claims.push({
        text: line.slice(Math.max(0, at - 20), at + 40).trim(),
        value,
        backed: commandNumbers.has(String(value)),
      });
    }
  }
  return claims;
}

/**
 * 点火回执上的那一行。**没有未兑现的声明就返回空串** —— 没话说就别占地方。
 */
export function renderNumericClaimNotice(goalText: string): string {
  const unbacked = findNumericClaims(goalText).filter((c) => !c.backed);
  if (unbacked.length === 0) return '';
  const items = unbacked.slice(0, 4).map((c) => `「${c.text}」`).join(' · ');
  return (
    `⚠ goal 里有 ${unbacked.length} 处数量声明没有可跑的出处: ${items}` +
    (unbacked.length > 4 ? ' …' : '') +
    `\n  数错了不会有人发现, 直到执行体照着它干完 —— 把数字写进验收命令 ` +
    `(如 \`test $(grep -c '<模式>' <文件>) -eq <数>\`), 第一次跑验收就红在派工人脸上。`
  );
}
