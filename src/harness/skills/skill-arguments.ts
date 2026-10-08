/**
 * src/harness/skills/skill-arguments —— `/skill <name> <rest>` 参数替换的真源
 * (原在 `src/tui/tools/skill-tool.ts`, 2026-10-08 S1 随 TUI 删除迁出)。
 *
 * `src/harness/skills/skills.ts:loadSkillBlock` 直接调用它, 不在两处各写一份
 * parseCommandArgs/substituteArgs —— 那样两处会漂。
 */
import { parseCommandArgs, substituteArgs } from '@earendil-works/pi-agent-core';

/**
 * 把 skill 正文里的占位符(`$1`/`$2`/`${@:N}`/`${@:N:L}`/`$ARGUMENTS`/`$@`)
 * 替换成用户在 `/skill <name> <rest>` 里补的那段话。
 *
 * `rest` 先经 `parseCommandArgs` 按 shell 式引号切成 `string[]`(不是裸 `split(/\s+/)`,
 * 否则 `"src/foo bar.ts"` 这种带空格的单个参数会被拆散), 再经 `substituteArgs` 代入正文。
 */
export function applySkillArguments(body: string, rest: string): string {
  const args = parseCommandArgs(rest);
  return substituteArgs(body, args);
}
