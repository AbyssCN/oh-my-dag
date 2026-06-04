/**
 * src/valar/config-extension —— /config slash 命令: 键盘选 daemon 角色模型 (dream/conductor/leaf)。
 *
 * 选择持久化到 .valar/config.json (经 persistRoleModel), 跨进程: daemon 下次 resolveRoleModel
 * 时 mtime 重读即生效, 不重启。与 pi 原生 /model (valar 自己对话的脑子, session 内即焚) 互不干扰。
 *
 * UX = valar 既有的 ctx.ui.select 两步选 (镜像 plan-extension 的 /model), 不引入 pi SettingsList/
 * custom widget (valar 从未用)。挂交互前端 tui.ts, 不挂 headless agent-leaf (无头 leaf 不该有 /config)。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { listProviders } from '../model';
import { listRoleModels, persistRoleModel, type ModelRole } from '../model/role-models';

const ROLE_LABELS: Record<ModelRole, string> = {
  dream: 'Dreaming Model',
  conductor: 'Conductor Model',
  leaf: 'Leaf Model',
};

export function createConfigExtension(): ExtensionFactory {
  // 注: registerCommand 名**不带**前导斜杠 (pi slice(1) 约定, 见 cg-audit-extension)。
  return (pi) => {
    pi.registerCommand('config', {
      description: '键盘选 daemon 角色模型 (dream/conductor/leaf) — 存 .valar/config.json',
      handler: async (_args: string, ctx) => {
        // 1. 列当前态 + 选要改的角色。
        const current = listRoleModels();
        const roleItems = current.map((e) => `${ROLE_LABELS[e.role]}: ${e.resolved} (${e.source})`);
        const pickedRole = await ctx.ui.select('选要改的角色', roleItems);
        if (!pickedRole) return; // esc / 取消
        const role = current[roleItems.indexOf(pickedRole)]!.role;

        // 2. 从已注册 provider 选 model 坐标 (provider 裸名 → 各自 defaultModel)。
        const providers = listProviders();
        if (providers.length === 0) {
          ctx.ui.notify('无已注册 provider — 检查 DEEPSEEK_* / MIMO_* env', 'warning');
          return;
        }
        const pickedModel = await ctx.ui.select(`${ROLE_LABELS[role]} → 选 model`, providers);
        if (!pickedModel) return;

        // 3. 持久化 + 回执。
        try {
          persistRoleModel(role, pickedModel);
          ctx.ui.notify(`${ROLE_LABELS[role]} → ${pickedModel} (已存 .valar/config.json)`, 'info');
        } catch (e) {
          ctx.ui.notify(`保存失败: ${String(e)}`, 'error');
        }
      },
    });
  };
}
