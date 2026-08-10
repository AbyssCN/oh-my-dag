/**
 * src/tui/tools/skill-tool —— TUI 侧 re-export 壳 (开放生态 S3: 真源在 harness)。
 *
 * O-S3-2: 真源唯一 —— createSkillTools 实现在 src/harness/skills/skill-tool.ts,
 * 此文件仅 re-export 供 chat-seat.ts 等 TUI 消费方无感迁移。
 */
export { createSkillTools, normalizeSkillName, type SkillToolDeps } from '../../harness/skills/skill-tool';
