/**
 * Valar 子代理迁移 (harness 迁移 C 档)。
 *
 * Pi 无原生 subagent/Task 机制 → 用 `defineTool` 造 `spawn_agent` 工具:
 *   - `parseAgentDef` / `discoverAgents`: 读 .claude/agents/*.md (frontmatter+body) → AgentDef (纯, 可测)
 *   - `validateDispatch`: pre-dispatch-gate 阈值的精简翻译 (CLAUDE.md §⚡ spawn_agent_when), 折叠进工具 (吸收 3 个 dispatch hook)
 *   - `createSpawnAgentTool`: ToolDefinition; 嵌套 session 的实际 spawn 由调用方注入 (decouple → 可测)
 *
 * 净新增编排层。nested session spawn 是 live 路径 (NAS 验), 其余纯逻辑本地 TDD。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface AgentDef {
  name: string;
  description: string;
  /** CC `tools:` frontmatter 原文 (allowlist), 迁移期保留供后续 scope 映射。 */
  tools?: string;
  /** frontmatter 之后的正文 = 子代理 system prompt。 */
  systemPrompt: string;
  /** 相对 .claude/agents/ 的来源路径。 */
  source: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** 极简 top-level YAML (够 agent frontmatter: name/description/tools 用)。 */
function parseTopLevelYaml(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && m[1]) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** 解析单个 agent .md → AgentDef。无 frontmatter 或无 name → null (非 agent def, 如 knowledge 文件)。 */
export function parseAgentDef(md: string, source = ''): AgentDef | null {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return null;
  const fm = parseTopLevelYaml(m[1]!);
  const name = (fm.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    description: (fm.description ?? '').trim(),
    tools: fm.tools ? fm.tools : undefined,
    systemPrompt: (m[2] ?? '').trim(),
    source,
  };
}

/** 非 agent-def 的子目录 (知识库 / 每-agent 记忆 / 模板 / 归档), discover 跳过。 */
const SKIP_PATH_RE = /(^|\/)(knowledge|memory|archive|_archived)(\/|$)|(^|\/)(INDEX|_README|_TEMPLATE)\.md$|(^|\/)_/;

function walkMarkdown(dir: string, base: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkMarkdown(abs, rel, acc);
    else if (entry.name.endsWith('.md')) acc.push(rel);
  }
}

/** 发现 .claude/agents 下所有真正的 agent def (有 name frontmatter, 排除 knowledge/memory/模板)。 */
export function discoverAgents(cwd: string = process.cwd()): Map<string, AgentDef> {
  const root = join(cwd, '.claude', 'agents');
  const rels: string[] = [];
  try {
    walkMarkdown(root, '', rels);
  } catch {
    return new Map();
  }
  const map = new Map<string, AgentDef>();
  for (const rel of rels) {
    if (SKIP_PATH_RE.test(rel)) continue;
    const def = parseAgentDef(readFileSync(join(root, rel), 'utf8'), rel);
    if (def) map.set(def.name, def);
  }
  return map;
}

export interface DispatchDecision {
  allow: boolean;
  reason: string;
}

/**
 * Dispatch 闸 (pre-dispatch-gate + spawn_agent_when 精简翻译)。
 * 当前硬约束: 目标 agent 必须是已发现的 def。未知 agent 直接拒 (防幻觉 spawn)。
 */
export function validateDispatch(agent: string, known: Map<string, AgentDef>): DispatchDecision {
  if (!agent.trim()) return { allow: false, reason: 'agent 名为空' };
  if (!known.has(agent)) {
    return { allow: false, reason: `未知 agent '${agent}'。已知: ${[...known.keys()].join(', ') || '(无)'}` };
  }
  return { allow: true, reason: 'ok' };
}

/** 子代理 system prompt = 身份头 + def 正文。 */
export function buildAgentSystemPrompt(def: AgentDef): string {
  return `你是 Valar Dream Team 的 sub-agent「${def.name}」。\n${def.description}\n\n---\n${def.systemPrompt}`;
}

/**
 * CC 工具名 (frontmatter `tools:`, 如 'Read, Grep, Glob, Bash') → pi 内建工具名 allowlist。
 * pi 内建: read / bash / edit / write / grep / find / ls。CC 的 Glob 概念 = pi 的 find。
 * 用于把子代理 def 的工具白名单焊进 createAgentSession({ tools })。
 *
 * 返回 undefined = def 未声明 tools (继承全部工具, 与 pi 默认一致)。
 * 无法识别的 CC 工具名静默丢弃 (如 Task/WebFetch 在 pi 无对应内建工具)。
 */
export function ccToolsToAllowlist(tools?: string): string[] | undefined {
  if (tools === undefined) return undefined;
  const map: Record<string, string> = {
    read: 'read',
    bash: 'bash',
    edit: 'edit',
    write: 'write',
    grep: 'grep',
    glob: 'find',
    find: 'find',
    ls: 'ls',
  };
  const allow: string[] = [];
  for (const raw of tools.split(',')) {
    const piName = map[raw.trim().toLowerCase()];
    if (piName && !allow.includes(piName)) allow.push(piName);
  }
  return allow;
}

/** 嵌套 session 执行器 (由 PiRuntime 注入真实 createAgentSession spawn; 此处仅签名)。 */
export type AgentSpawner = (def: AgentDef, prompt: string) => Promise<string>;

/**
 * 造 spawn_agent 工具。`spawn` 注入实际嵌套 session 逻辑 (live, NAS 验)。
 * dispatch 闸折叠在 execute 里 (未知 agent → isError, 不真 spawn)。
 */
export function createSpawnAgentTool(opts: {
  agents: Map<string, AgentDef>;
  spawn: AgentSpawner;
}): ToolDefinition {
  const names = [...opts.agents.keys()].join(', ');
  return defineTool({
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description: `派一个 scoped 只读子代理 (Valar scouts / Dream Team review)。可用: ${names}`,
    parameters: Type.Object({
      agent: Type.String({ description: `子代理名, 之一: ${names}` }),
      prompt: Type.String({ description: '给子代理的任务描述 (含足够 context, 子代理无主对话记忆)' }),
    }),
    async execute(_toolCallId, params) {
      const { agent, prompt } = params as { agent: string; prompt: string };
      const gate = validateDispatch(agent, opts.agents);
      if (!gate.allow) {
        return { content: [{ type: 'text', text: `dispatch 拒绝: ${gate.reason}` }], details: { agent, blocked: true } };
      }
      const def = opts.agents.get(agent)!;
      const out = await opts.spawn(def, prompt);
      return { content: [{ type: 'text', text: out }], details: { agent, blocked: false } };
    },
  });
}
