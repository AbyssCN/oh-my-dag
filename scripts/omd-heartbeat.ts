#!/usr/bin/env bun
/**
 * scripts/omd-heartbeat —— 慢回路的**无人在场心跳**(t6/S-4 最小档,设计
 * docs/plan/2026-08-04-t6-s4-heartbeat.md)。
 *
 * 对每张开放 md 图:① `path_tickets` 回流(收 landed solve/research 结果:三态映射 +
 * 发现物→suggested)② 区域散尽且 `--apply` → `path_deliver`(fire goal 票 / 跑 slice)。
 *
 * INV-T6-1:**只执行已裁决的票,永不 rule/confirm** —— 层间人解锁不被无人入口绕过。
 * INV-T6-2:默认 dry-run;真执行显式 `--apply`。
 * INV-T6-3:幂等零新状态(回流归档改名 + `.goal-dispatched` 标记都在下层)。
 *
 * 安装(owner 自己加,脚本不碰 crontab):
 *   *[/]30 * * * * cd <repo> && OMD_PATH_BACKEND=md bun run scripts/omd-heartbeat.ts --apply >> .omd/heartbeat.log 2>&1
 */
import { join } from 'node:path';
import type { OmdMcpTool } from '../src/mcp/server';

/** 心跳需要的工具面切片 (注入接缝: 测试传 fake, main 走真装配)。 */
export interface HeartbeatTools {
  listMaps: () => Array<{ slug: string }>;
  tickets: (slug: string) => Promise<string>;
  deliver: (slug: string) => Promise<string>;
  /** 区域散尽探测 (dry-run 用): 返回 null = 无可交付。 */
  region: (slug: string) => { slice: string[]; goals: string[] } | null;
}

/** 一次心跳 (纯编排, 全部副作用在注入面之后)。返回人读报告行。 */
export async function heartbeatOnce(tools: HeartbeatTools, opts: { apply: boolean }): Promise<string[]> {
  const lines: string[] = [];
  for (const { slug } of tools.listMaps()) {
    // ① 回流 (pull 本就只读折入 + 既有幂等锚, dry-run 也执行 —— 它不产生新的执行力)。
    const reflow = await tools.tickets(slug);
    const reflowLines = reflow.split('\n').filter((l) => l.startsWith('◈') || l.startsWith('⚠'));
    lines.push(...reflowLines.map((l) => `[${slug}] ${l}`));
    // ② 区域散尽 → deliver (只在 --apply; 心跳只执行**已裁决**区域, INV-T6-1)。
    const region = tools.region(slug);
    if (!region) continue;
    const what = `slice ${region.slice.length} 张 · goal ${region.goals.length} 张`;
    if (!opts.apply) {
      lines.push(`[${slug}] dry-run: 区域散尽 (${what}) — 带 --apply 才执行 deliver`);
      continue;
    }
    lines.push(`[${slug}] 区域散尽 (${what}) → deliver`);
    const out = await tools.deliver(slug);
    lines.push(...out.split('\n').slice(0, 3).map((l) => `[${slug}] ${l}`));
  }
  if (lines.length === 0) lines.push('心跳: 无开放图或无事可做。');
  return lines;
}

if (import.meta.main) {
  // 真装配 (与 scripts/omd-deliver.ts 同款生产件, 含账本留痕)。
  const { createDagRecorder } = await import('../src/harness/dag-record');
  const { createAgentLeafRunner } = await import('../src/harness/agent-leaf');
  const { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } = await import('../src/harness/command-leaf');
  const { createPathfinderTools, readyRegion } = await import('../src/mcp/tools/pathfinder');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  const { resolveBackend } = await import('../src/harness/pathfinder/backend');

  const cwd = process.cwd();
  const apply = process.argv.includes('--apply');
  const env = process.env;
  const backend = resolveBackend(cwd, { env });
  const mcpTools = createPathfinderTools({
    cwd,
    env,
    models: resolveEngineModels(env),
    agentRunner: createAgentLeafRunner({ cwd, hashlineEdit: true, leafTimeoutMs: 3_600_000 }),
    commandRunner: createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd, timeoutMs: 180_000 }),
    recorder: createDagRecorder({ path: join(cwd, '.omd', 'dag-runs.db') }),
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const t = mcpTools.find((x: OmdMcpTool) => x.name === name)!;
    const r = (await t.handler(args, {} as never)) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join('\n');
  };
  const tools: HeartbeatTools = {
    listMaps: () => backend.listMaps(cwd),
    tickets: (slug) => call('path_tickets', { slug }),
    deliver: (slug) => call('path_deliver', { slug }),
    region: (slug) => {
      const m = backend.readMap(cwd, slug);
      return m ? readyRegion(m) : null;
    },
  };
  const report = await heartbeatOnce(tools, { apply });
  for (const l of report) console.log(l);
}
