/**
 * src/tui/prompts —— **custom prompts(用户自定义 `/命令` 模板)**(W4 第一件)。
 *
 * pi 的形状(视频台账 I7):模板在**交互层完全展开**,core 不感知用户打过斜杠命令。
 * 装载/参数替换全用 pi-agent-core 的现成纯函数(`loadPromptTemplates` /
 * `parseCommandArgs` / `formatPromptTemplateInvocation`)—— 一行解析都不自写。
 *
 * 目录:`.omd/prompts/*.md`,一文件一命令(文件名 = 命令名,frontmatter description 可选,
 * 正文里 `$1..$n` / `$ARGUMENTS` 占位 —— 具体语法由 pi 的 loader 定义,这里不复述)。
 *
 * 一致取舍(与 skill 组同款,`commands.ts:130` 的说明):**补全启动时冻结、分发每次现扫**
 * —— 新建模板文件立即可用,只是补全列表要重启才见;每敲一个字符扫一遍目录不值当。
 */
import { formatPromptTemplateInvocation, loadPromptTemplates, parseCommandArgs, type PromptTemplate, type PromptTemplateDiagnostic } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

export const PROMPTS_DIR = '.omd/prompts';

/** 现扫模板目录。目录不存在 = 没配置过, **空表不是错误**;parse 坏件进 diagnostics 由调用方决定画不画。 */
export async function loadUserPrompts(cwd: string): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
  const env = new NodeExecutionEnv({ cwd });
  return loadPromptTemplates(env, [PROMPTS_DIR]);
}

/**
 * `/名 参数…` → 展开正文;不认识的名字返 `null`(回落给内建命令/聊天,**不抢内建**由
 * 调用方保证 —— 本函数只在内建全部未命中之后被问)。纯函数,模板表由调用方现扫喂进。
 */
export function expandPrompt(templates: readonly PromptTemplate[], input: string): string | null {
  const m = /^\/(\S+)(?:\s+([^]*))?$/.exec(input.trim());
  if (!m) return null;
  const t = templates.find((x) => x.name === m[1]);
  if (!t) return null;
  return formatPromptTemplateInvocation(t, m[2] ? parseCommandArgs(m[2]) : []);
}
