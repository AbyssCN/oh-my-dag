/**
 * src/eval/replay/night-excluded —— 夜链写集排除表的**单一真源** (D-9)。
 *
 * 承 `docs/plan/2026-09-02-夜间自迭代链-执行契约.md` D-9: 校卡闸 (session-card.ts) 与晋升闸
 * (scripts/autoresearch-promote.ts) 两处共用同一份清单, 不各存一份 —— 两份清单必然漂移,
 * 而漂移的那一天没有任何读数会变红。
 *
 * 「排除」的语义: 这些路径是**尺子与规则**, 不是被测物。夜链自己去改尺子 = 自己给自己判分,
 * 于是任何一夜的读数都不再可比。改它们只走人审通道 (objective.md §修订规则)。
 *
 * 反向自检 (night-excluded.test.ts): 删掉表里任一条 → 对应用例由绿转红。
 */

/**
 * 夜链任何自动产物都不许触碰的路径 (glob, 相对仓根)。
 *
 * ⚠ 末条与 `src/eval/replay/**` 重合是**故意**的: 契约 D-9 逐条点名了本文件自身。
 * 哪天有人把 `src/eval/replay/**` 收窄成某几个文件, 这一条仍然把「排除表自己」挡在外面。
 */
export const NIGHT_EXCLUDED_GLOBS: readonly string[] = [
  'docs/plan/autoresearch-objective.md',
  'src/eval/replay/**',
  'runs/autoresearch/corpus/**',
  'scripts/autoresearch-*.ts',
  'src/eval/replay/night-excluded.ts',
];

/** 归一: 去掉 `./` 前缀与反斜杠, 使 `./src/x` 与 `src/x` 判定一致。 */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 命中排除表的路径 (原样返回入参写法, 便于人对着自己写的那一行看)。
 * 返回空数组 = 干净。**不抛** —— 判定与处置分开, 处置由调用方 (校卡拒 / 晋升 held)。
 */
export function touchesExcluded(paths: string[]): string[] {
  const globs = NIGHT_EXCLUDED_GLOBS.map((g) => new Bun.Glob(g));
  return paths.filter((p) => {
    const n = normalize(p);
    return globs.some((g) => g.match(n));
  });
}
