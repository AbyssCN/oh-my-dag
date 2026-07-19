/**
 * src/harness/agent-templates —— agent 模板注册表 (本地 Agent Registry, LangChain 三档中的第②档)。
 *
 * 是什么: 高频节点形状 (reviewer/verifier/researcher/synth/implementer) 固化成冻结角色卡。
 * conductor 在 plan 里按名引用 (node.template), 执行期把卡片 body 注入 leaf prompt 前缀 —
 * conductor 上下文只付每卡一行 description (注册表), body 只进 executor 自己的窗口 (spawn 时加载)。
 *
 * 为什么 (对 conductor 每图现写 persona 的三重优势):
 *  ① token: 现写 = 最贵的 output token, 每图重付且唯一字符串永不 cache; 模板静态 → 同模板 sibling
 *    共享 (system+模板) 前缀, warmThenFanout 暖发后命中 prompt-cache。
 *  ② 质量: 弱 conductor 每次重写角色卡会漂移/幻觉 (RESEARCH_LENS_TEMPLATE 冻结的同一理由, 推广之)。
 *  ③ 路由: 卡片可携 model tier → conductor 不必每图重新推理该节点配什么模型。
 *
 * 分层: 内置卡 (agent-templates-builtin, 随包出厂) + 项目卡 (.omd/agents/*.md, 同名覆盖内置)。
 * 注册表纪律 (防膨胀税, 400 卡注册表 = 10-20k tokens/图): 内置 5 张, 项目总量建议 ≤20 张, description 一行。
 *
 * Invariants:
 *  TPL-1 fail-open: 坏卡文件 (无 frontmatter/无 description/读不了) → warn + 跳过, 永不阻断规划。
 *  TPL-2 未知模板名: 规划期 parsePlan(knownTemplates) 拒 → 驱动 conductor 重试; 执行期 (预构造 plan
 *        绕过规划校验) → warn + 忽略模板继续跑 (弱模型不可信原则: 校验在规划层, 执行层兜底不崩)。
 *  TPL-3 model 优先级: node.model 显式 > template.model > router/静态 (显式永远赢, 同 node.model 绕 router)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter } from './skills/scanner';
import { BUILTIN_AGENT_TEMPLATES } from './agent-templates-builtin';
import { logger } from './logger';

export interface AgentTemplate {
  /** 注册表键 (conductor 在 node.template 按此名引用)。kebab-case 惯例, 不强制。 */
  name: string;
  /** 一行卡片描述 — 进 conductor 注册表 (每卡在规划 prompt 里只付这一行)。 */
  description: string;
  /** 可选 model tier ('provider:modelId') — 卡片级模型路由 (TPL-3: node.model 显式仍最高优先)。 */
  model?: string;
  /** 卡片正文 (方法论+检查单+输出纪律) — 执行期注入 leaf prompt 前缀, 规划期不进上下文。 */
  body: string;
}

/** 项目卡目录 (repoRoot 相对)。 */
export const AGENT_TEMPLATE_DIR = '.omd/agents';

/**
 * 加载注册表: 内置卡 + root/.omd/agents/*.md 项目卡 (同名项目卡覆盖内置)。
 * 每文件独立 fail-open (TPL-1); 目录不存在 = 纯内置。README* 不当卡片。
 */
export function loadAgentTemplates(opts: { root?: string } = {}): Map<string, AgentTemplate> {
  const templates = new Map<string, AgentTemplate>();
  for (const t of BUILTIN_AGENT_TEMPLATES) templates.set(t.name, t);

  const dir = join(opts.root ?? process.cwd(), AGENT_TEMPLATE_DIR);
  if (!existsSync(dir)) return templates;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme/i.test(f));
  } catch (err) {
    logger.warn({ dir, err }, '[omd/agent-templates] 项目卡目录读取失败 → 纯内置 (TPL-1 fail-open)');
    return templates;
  }
  for (const file of files.sort()) {
    try {
      const { fm, body } = splitFrontmatter(readFileSync(join(dir, file), 'utf8'));
      const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : file.replace(/\.md$/, '');
      const description = typeof fm.description === 'string' ? fm.description.trim() : '';
      if (!description) {
        // description 是注册表的全部 — 没有它 conductor 无从路由此卡 (TPL-1: 跳过不阻断)。
        logger.warn({ file }, '[omd/agent-templates] 卡片缺 description → 跳过 (TPL-1)');
        continue;
      }
      const model = typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : undefined;
      const trimmedBody = body.trim();
      if (!trimmedBody) {
        logger.warn({ file }, '[omd/agent-templates] 卡片 body 为空 → 跳过 (TPL-1)');
        continue;
      }
      if (templates.has(name)) logger.info({ name, file }, '[omd/agent-templates] 项目卡覆盖同名卡');
      templates.set(name, { name, description, ...(model ? { model } : {}), body: trimmedBody });
    } catch (err) {
      logger.warn({ file, err }, '[omd/agent-templates] 卡片解析失败 → 跳过 (TPL-1 fail-open)');
    }
  }
  return templates;
}

/** 注册表 → conductor prompt 的 roster 行 ({name, description} 投影, body 不进规划上下文)。 */
export function templateRoster(templates: ReadonlyMap<string, AgentTemplate>): { name: string; description: string }[] {
  return [...templates.values()].map((t) => ({ name: t.name, description: t.description }));
}
