/**
 * src/model/bootstrap.ts — 短命进程 (dag-* 脚本) 的统一模型运行时引导。
 *
 * 背景: TUI (tui.ts) 启动时 registerProvidersFromEnv() + registerCustomApis(listCustomApis()),
 * 但 dag-* 脚本是独立短命进程, 需要同一套引导。本模块把这两件事收成一个调用
 * bootstrapModelRuntime(), 每个脚本一行搞定:
 *   ① registerProvidersFromEnv()             — provider 注册 (deepseek/mimo/… from .env)
 *   ② registerCustomApis(listCustomApis())   — 用户自定 API (.omd/config.json apis 段) 叠加
 *
 * 返回值 = 全部注册成功的 provider 名数组。
 * 另: 在 stderr 打一行 env 可见性 (provider 空 = .env 真没配, 立即看见), 不进 stdout 产物。
 */
import '../env-alias';
import {
  registerProvidersFromEnv,
  registerCustomApis,
  registerProvidersFromModelsJson,
} from './providers';
import { listCustomApis } from './role-models';
import { warnUnregisteredRoles } from './role-fallback';

/**
 * 引导短命进程的模型运行时: 内置 provider 注册 + 自定 API 叠加。
 * @returns 注册的 provider 名数组。
 */
export function bootstrapModelRuntime(): string[] {
  const registered = registerProvidersFromEnv();
  const custom = registerCustomApis(listCustomApis());
  // ~/.pi/agent/models.json 自定 provider (统一-registry D-2): 于 env/customApis 之后 → 单一真源, 同名覆盖。
  const fromModelsJson = registerProvidersFromModelsJson();
  const seen = new Set(registered);
  const all = [...registered];
  for (const id of [...custom, ...fromModelsJson]) {
    if (!seen.has(id)) {
      seen.add(id);
      all.push(id);
    }
  }
  // 起跑坐席检查 (issue #6): provider 注册完后, 无凭证的角色启动即 WARN (不再跑到一半才炸)。
  warnUnregisteredRoles();
  // 脚本侧 env 可见性 (stderr, 不污染 stdout 产物): provider 空 = .env 没配/没 propagate。
  process.stderr.write(
    `[omd env] providers=[${all.join(',') || '⚠空-检查 .env/--env-file'}] · ` +
      `web=${process.env.TAVILY_API_KEY || process.env.ANYSEARCH_API_KEY ? '✓' : '–'}\n`,
  );
  return all;
}
