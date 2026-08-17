/**
 * src/harness/inspect-tool —— `omd_inspect` 能力目录 meta-tool (A2, dsh/cordis 吸收计划线 A)。
 *
 * ## 它是什么 / 不是什么
 *
 * 对话位与 agent leaf 的**能力目录**入口: 本仓装了哪些 agent 卡 / playbook / skills /
 * 外部 MCP server, 引擎有哪些座位与原语。此前这些清单没有任何模型可读的入口 —— 规划者
 * 只能猜"这个仓有什么", 猜错的形状是引用不存在的模板/座位。
 *
 * **不做**凭证与生效坐标健康检查 —— 那是 `omd_config_status` (MCP 面) 的地盘, 两边各管一面:
 * inspect 答"有什么能力", config_status 答"配没配对、能不能用"。
 *
 * ## 恒定面纪律 (与 mcp_find / read_skill 同族, 第三次复用同一形状)
 *
 * description / promptSnippet / schema 全部静态 —— 任何扫盘算出的数字进冻结前缀 = 废
 * prompt cache (skill-tool.ts:63-74 的原坑)。全部动态内容 (清单/计数/错误) 走**工具返回值**。
 * 与 mcp_find 不同的是它**恒挂载**: 空仓也有座位与原语可报, 不存在"必然失败"形态。
 */
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigIssue } from '../config/issues';
import { loadMcpClientConfig } from '../mcp/client/config';
import { SEATS } from '../model/seats';
import type { AnyOmdTool, OmdTool } from './agent-tools';
import { loadAgentTemplates } from './agent-templates';
import { loadPlaybooks } from './playbook/load';
import { PRIMITIVE_REGISTRY } from './primitive-registry';
import { defaultSkillRoots, listSkills } from './skills/skills';

const SECTIONS = ['seats', 'primitives', 'agents', 'playbooks', 'skills', 'mcp'] as const;
type Section = (typeof SECTIONS)[number];

const INSPECT_SCHEMA = Type.Object({
  what: Type.Optional(
    Type.String({
      description: "One section: 'seats' | 'primitives' | 'agents' | 'playbooks' | 'skills' | 'mcp'. Omit for the overview with per-section counts.",
    }),
  ),
});

export interface InspectToolOpts {
  /** 工作根: agents/playbooks/skills/mcp 全部按它扫。 */
  cwd: string;
}

function seatsSection(): string[] {
  return [
    `座位 (${SEATS.length}, 真源 src/model/seats.ts —— 生效坐标与凭证看 omd_config_status):`,
    ...SEATS.map((s) => `- ${s.id} [${s.tier}] —— ${s.what}`),
  ];
}

function primitivesSection(): string[] {
  const ids = Object.keys(PRIMITIVE_REGISTRY);
  return [
    `控制流原语 (${ids.length}, 封闭菜单 —— conductor 只能选表内原语, 参数 schema 强校验):`,
    ...ids.map((id) => `- ${id}`),
    '直接跑单个原语: omd_primitive (MCP 面); 图式菜单: omd_shapes。',
  ];
}

function agentsSection(cwd: string): string[] {
  const templates = loadAgentTemplates({ root: cwd });
  const lines = [...templates.values()].map(
    (t) => `- ${t.name}${t.model ? ` [${t.model}]` : ''}${t.evidence ? ` [evidence:${t.evidence}]` : ''} —— ${t.description}`,
  );
  return [`agent 模板卡 (${templates.size}, 内置 + ${join('.omd', 'agents')}/*.md 项目卡同名覆盖):`, ...lines];
}

function playbooksSection(cwd: string): string[] {
  try {
    const playbooks = [...loadPlaybooks(cwd).values()];
    if (playbooks.length === 0) return ['playbook: 无 (内置目录与 .omd/playbooks/ 都为空)。'];
    return [
      `playbook (${playbooks.length}, 装载即过三道闸 A-1/A-2/A-3 —— 列出来的都验过判据有判别力):`,
      ...playbooks.map((p) => `- ${p.name} (${p.steps.length} 步${p.loop ? `, loop ≤${p.loop.maxRounds} 轮` : ''})`),
    ];
  } catch (err) {
    // playbook 加载是刻意 fail-loud 的 (坏 playbook 不许被静默丢成"查无此项")。
    // inspect 的职责是把这个 loud 原样端给模型看, 而不是自己也跟着炸。
    return [`playbook: 加载失败 (fail-loud) —— ${err instanceof Error ? err.message : String(err)}`];
  }
}

function skillsSection(cwd: string): string[] {
  const skills = listSkills(defaultSkillRoots(cwd));
  if (skills.length === 0) return ['skills: 无 (项目/包内/用户三层都没扫到)。'];
  const shown = skills.slice(0, 60);
  return [
    `skills (${skills.length}, 项目层 > 包内 > 用户层, 正文经 read_skill 取):`,
    ...shown.map((s) => `- ${s.name}${s.description ? ` —— ${s.description}` : ''}`),
    ...(skills.length > shown.length ? [`… 另 ${skills.length - shown.length} 条 (read_skill 可全量列)`] : []),
  ];
}

function mcpSection(cwd: string): string[] {
  const issues: ConfigIssue[] = [];
  const cfg = loadMcpClientConfig(cwd, issues);
  const lines: string[] = [];
  if (cfg.servers.length === 0 && !cfg.loadError) {
    lines.push('外部 MCP: 无注册 (.omd/mcp.json 不存在或为空)。');
  } else {
    lines.push(`外部 MCP server (${cfg.servers.length}, 经 mcp_find / mcp_call 双 meta-tool 使用):`);
    lines.push(...cfg.servers.map((s) => `- ${s.name} [${s.kind}]`));
  }
  if (cfg.loadError) lines.push(`⚠ 注册表读取失败: ${cfg.loadError}`);
  for (const i of issues) lines.push(`⚠ ${i.source}${i.path ? ` · ${i.path}` : ''}: ${i.message}`);
  return lines;
}

function overview(cwd: string): string {
  const templates = loadAgentTemplates({ root: cwd });
  let playbookCount: string;
  try {
    playbookCount = String(loadPlaybooks(cwd).size);
  } catch {
    playbookCount = '加载失败 (详见 omd_inspect("playbooks"))';
  }
  const skills = listSkills(defaultSkillRoots(cwd));
  const mcp = loadMcpClientConfig(cwd);
  const mcpLine = mcp.loadError ? `注册表读取失败` : String(mcp.servers.length);
  return [
    'omd 能力目录 (本仓视角):',
    `- seats: ${SEATS.length} 座`,
    `- primitives: ${Object.keys(PRIMITIVE_REGISTRY).length} 个`,
    `- agents (模板卡): ${templates.size} 张`,
    `- playbooks: ${playbookCount}`,
    `- skills: ${skills.length} 条`,
    `- mcp (外部 server): ${mcpLine}`,
    `细看某一节: omd_inspect({ what: "seats" | "primitives" | "agents" | "playbooks" | "skills" | "mcp" })`,
  ].join('\n');
}

/** 装配 `omd_inspect`。恒挂载 (空仓也有座位/原语可报, 无"必然失败"形态)。 */
export function createInspectTool(o: InspectToolOpts): AnyOmdTool[] {
  const inspect: OmdTool<{ what: string | null }> = {
    name: 'omd_inspect',
    label: 'omd_inspect',
    description:
      'Capability catalog of this workspace: engine seats, control-flow primitives, installed agent template cards, playbooks, skills, and registered external MCP servers. Omit `what` for an overview with counts.',
    promptSnippet:
      'omd_inspect(what?) —— 本仓能力目录: 座位/原语/agent 卡/playbook/skills/外部 MCP。不带参数出总览, what 细看某节。规划前先看一眼, 别引用不存在的模板或座位。',
    parameters: INSPECT_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { what } = params as Static<typeof INSPECT_SCHEMA>;
      const section = what?.trim().toLowerCase() ?? '';
      if (!section) {
        return { content: [{ type: 'text', text: overview(o.cwd) }], details: { what: null } };
      }
      if (!(SECTIONS as readonly string[]).includes(section)) {
        return {
          content: [{ type: 'text', text: `未知 section "${section}"。可选: ${SECTIONS.join(', ')} (或省略 what 出总览)。` }],
          details: { what: section },
        };
      }
      const render: Record<Section, () => string[]> = {
        seats: seatsSection,
        primitives: primitivesSection,
        agents: () => agentsSection(o.cwd),
        playbooks: () => playbooksSection(o.cwd),
        skills: () => skillsSection(o.cwd),
        mcp: () => mcpSection(o.cwd),
      };
      return { content: [{ type: 'text', text: render[section as Section]().join('\n') }], details: { what: section } };
    },
  };
  return [inspect as AnyOmdTool];
}

/**
 * seam 目录指针 (docs/architecture/seams.md, 生成物)。只在源码 checkout 里存在 ——
 * 它是 omd 自身开发者的目录, 不进对模型的 section 词表, 单独导出给需要的装配面。
 */
export function seamCatalogPath(): string | null {
  const p = join(import.meta.dir, '..', '..', 'docs', 'architecture', 'seams.md');
  return existsSync(p) ? p : null;
}
