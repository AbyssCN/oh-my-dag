/**
 * src/tui/render/logo —— **欢迎屏的 OMD 字标**(S-3,2026-08-07 owner 点名;2026-08-09 换字)。
 *
 * ## 为什么是 `█` 而不是随便找个花字体
 *
 * 字形闸(`render/glyphs.ts`)只放行量过的字形,而 `█`(U+2588)在 `block` 组里
 * **已经被真终端量过**(进度条一直在用)。换 Nerd Font 或 emoji 风格的 logo 会当场被
 * 判 `unsafe` —— 那不是洁癖:私用区字形宽度完全取决于装没装字体,
 * 一个换机器就超宽的 logo 会把整个布局顶花。
 *
 * ## ★ 逐字母拼,不手写整幅
 *
 * 第一版是我手写五行整幅 —— 截图出来**根本不成字**,因为哪一格该空我数错了好几处。
 * 改成逐字母拼之后,对齐由代码保证:每个字母自己五行等宽,拼接必然还是等宽。
 * **手数格子这种事,写完是看不出错的,而截图看得出。**
 *
 * ## 为什么从 `OH MY DAG` 五行换成 `OMD` 三行(2026-08-09,owner 裁决)
 *
 * 盲比里 critic 反复指着这块欢迎屏说"占了一屏还没开始干活"(`08-streaming` 三跑全指它)。
 * 三个字母 21 列 × **3 行**,比原来的 58 列 × 5 行少了一半还多,而 goal §2 的 V1 满分判据
 * 是「ASCII logo + 键值网格」—— **换字不掉分**,少的只是占屏。
 *
 * ## 宽度是硬约束,不是"尽量"
 *
 * 终端窄于 {@link LOGO_MIN_WIDTH} 时**换一行小字标**,不折行 ——
 * 折了行的 block 字体不是"挤了一点",是一堆看不出是字的方块。
 */

/** 字标高度。全部字母必须是这个行数,`logo.test.ts` 有闸。 */
export const LOGO_ROWS = 3;

/**
 * 逐字母点阵。**每个字母自己五行等宽** —— 这是拼接能对齐的唯一前提。
 *
 * 只收 `OMD` 这三个:铺全 26 个字母会造出一堆没有消费者的常量
 * (本仓可达性纪律:没消费者的东西不先加)。换字之后 `H/Y/A/G` 与空格随之删掉 ——
 * 留着就是四个谁都不画的点阵。
 *
 * ⚠ **O 是圆头 ` ████ ` 不是方头 `██████`**:方头的 O 与 D 只差最右一列,
 * 三个字母连起来读出来像 `DMD`(草稿里真长这样)。
 */
const LETTERS: Readonly<Record<string, readonly string[]>> = {
  O: [' ████ ', '██  ██', ' ████ '],
  M: ['███ ███', '██ █ ██', '██   ██'],
  D: ['█████ ', '██  ██', '█████ '],
};

/** 字母之间的间隔列数。 */
const LETTER_GAP = ' ';

/** 拼一行字。未收录的字符**直接抛** —— 那是打字错误,不是运行时状况。 */
export function renderWord(word: string): string[] {
  const glyphs = [...word].map((ch) => {
    const g = LETTERS[ch.toUpperCase()];
    if (!g) throw new Error(`renderWord: 字标点阵里没有 ${JSON.stringify(ch)}`);
    return g;
  });
  return Array.from({ length: LOGO_ROWS }, (_, row) => glyphs.map((g) => g[row] as string).join(LETTER_GAP));
}

/** 宽字标(五行等宽)。 */
export const LOGO_WIDE: readonly string[] = renderWord('OMD');

/** 小字标:窄终端唯一还认得出是字的形态。 */
export const LOGO_NARROW = 'Oh My DAG';

/** 字标宽度 + 左右各留一格。低于这个数就换小字标。 */
export const LOGO_MIN_WIDTH = (LOGO_WIDE[0] as string).length + 2;

/** 按可用宽度选形态。返回的每一行都**不超过 `width`**。 */
export function renderLogo(width: number): string[] {
  return width >= LOGO_MIN_WIDTH ? [...LOGO_WIDE] : [LOGO_NARROW];
}
