/**
 * omd harness 迁移 —— 把 .claude/ 项目资源装进 Pi runtime。
 *
 * | 档 | 内容 | 入口 |
 * |---|---|---|
 * | A 技能 | .claude/skills 下各 SKILL.md | loadOmdSkills |
 * | B 身份 | CLAUDE.md (root + .claude) | loadOmdIdentity |
 * | C 子代理 | .claude/agents/*.md → spawn_agent | discoverAgents + createSpawnAgentTool |
 *
 * D 钩子 (子进程桥) 已删 (V2-HOOK, 2026-06-01): omd 的 runtime hook 改原生 in-process
 * (`src/harness/hooks/`, 经 OmdController.hooks 注入), 不再 Bun.spawn omd dev-harness .mjs。
 * 战略: docs/plan/PLAN-2026-05-30-omd-harness-pi-migration.md (D 档已被 SDD §11.2 超越)。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { loadOmdIdentity } from './identity';
import { loadOmdSkills, formatSkillsForPrompt, type LoadSkillsResult } from './skills';
import {
  discoverAgents,
  createSpawnAgentTool,
  type AgentDef,
  type AgentSpawner,
} from './agents';

export interface OmdHarness {
  /** 身份契约 (CLAUDE.md 拼接)。 */
  identity: string;
  /** 已加载技能。 */
  skills: LoadSkillsResult;
  /** 已发现子代理 def (name → def)。 */
  agents: Map<string, AgentDef>;
  /** 拼好的 system-prompt 前缀 (身份 + 技能 XML)。 */
  systemPrompt: string;
  /** 注入 createAgentSession 的 customTools。 */
  customTools: ToolDefinition[];
}

/**
 * 组装 omd harness (技能 + 身份 + 子代理)。`spawn` 注入嵌套 session 执行器 (PiRuntime 提供真实 createAgentSession)。
 * runtime hook (fail-closed 闸等) 不在 harness, 由 OmdController.hooks 提供 (V2-HOOK)。
 */
export function installOmdHarness(opts: { cwd?: string; spawn: AgentSpawner }): OmdHarness {
  const cwd = opts.cwd ?? process.cwd();
  const identity = loadOmdIdentity(cwd);
  const skills = loadOmdSkills(cwd);
  const agents = discoverAgents(cwd);
  const agentTool = createSpawnAgentTool({ agents, spawn: opts.spawn });
  const systemPrompt = [identity, formatSkillsForPrompt(skills.skills)]
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  return {
    identity,
    skills,
    agents,
    systemPrompt,
    customTools: [agentTool],
  };
}

export { loadOmdIdentity, IDENTITY_FILES } from './identity';
export { loadOmdSkills, formatSkillsForPrompt, SKILLS_DIR } from './skills';
export {
  parseAgentDef,
  discoverAgents,
  validateDispatch,
  buildAgentSystemPrompt,
  ccToolsToAllowlist,
  createSpawnAgentTool,
  type AgentDef,
  type AgentSpawner,
  type DispatchDecision,
} from './agents';
