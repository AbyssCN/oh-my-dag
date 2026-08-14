/**
 * src/tui/tools/skill-tool —— TUI 侧 re-export 壳 (开放生态 S3: 真源在 harness) +
 * `/skill <name> <rest>` 参数替换的真源。
 *
 * O-S3-2: 真源唯一 —— createSkillTools 实现在 src/harness/skills/skill-tool.ts,
 * 此文件仅 re-export 供 chat-seat.ts 等 TUI 消费方无感迁移。
 *
 * `applySkillArguments` 是例外:它是 `/skill` 参数占位符替换的**唯一实现**,
 * `src/harness/skills/skills.ts:loadSkillBlock` 直接调用它(见该文件顶部注释),
 * 不在两处各写一份 parseCommandArgs/substituteArgs —— 那样两处会漂。
 */
import { parseCommandArgs, substituteArgs } from '@earendil-works/pi-agent-core';

export { createSkillTools, normalizeSkillName, type SkillToolDeps } from '../../harness/skills/skill-tool';
export { parseCommandArgs, substituteArgs } from '@earendil-works/pi-agent-core';

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