/**
 * src/wright/config-extension —— `/setup` + `/config` slash 命令: 统一配置中心入口。
 *
 * 一处配齐角色模型 / 多模态池 / 自定 API / Web key / 能力 / 语言 (见 config-center.ts)。
 * 落盘: 角色·池·API → .wright/config.json (跨进程 mtime 重读, 不重启); key·开关 → .env。
 * 与 pi 原生 /model (wright 对话脑子, session 内即焚) 互不干扰。挂交互前端 tui.ts, 不挂 headless leaf。
 *
 * `/setup` 与 `/config` 同效 (别名) — /setup 偏首次/全量, /config 是熟手快捷词。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { runConfigCenter, type ConfigUi } from './config-center';
import { m } from './i18n';

export function createConfigExtension(): ExtensionFactory {
  // 注: registerCommand 名**不带**前导斜杠 (pi slice(1) 约定, 见 cg-audit-extension)。
  return (pi) => {
    const run = async (_args: string, ctx: { ui: ConfigUi; cwd?: string }) => {
      try {
        await runConfigCenter(ctx.ui, { cwd: ctx.cwd });
      } catch (e) {
        ctx.ui.notify(m({ en: `Config center error: ${String(e)}`, zh: `配置中心出错: ${String(e)}` }), 'error');
      }
    };
    const description = m({
      en: 'Unified config center — role models / multimodal pool / custom APIs / web keys / capabilities / language',
      zh: '统一配置中心 — 角色模型 / 多模态池 / 自定 API / Web key / 能力 / 语言',
    });
    pi.registerCommand('setup', { description, handler: run });
    pi.registerCommand('config', { description, handler: run });
  };
}
