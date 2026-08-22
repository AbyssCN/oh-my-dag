#!/usr/bin/env bun
/**
 * scripts/omd-deliver —— pathfinder 裁决/交付 CLI(慢回路的无 MCP 入口)。
 *
 * 为什么存在: `scripts/omd-path.ts` 只管导航(列图/建图), 而 rule/deliver 此前只有 MCP 面 ——
 * 没挂 MCP 的 session(bridge/CI)整条慢回路走不完。本脚本复用 `createPathfinderTools` 的
 * **生产装配**(models/agentRunner/commandRunner/recorder 与 assemble 同款), 不另辟执行路径:
 * 账本留痕(entry='path_deliver')、spec 闸、后端解析全部照旧。
 *
 * 用法:
 *   bun run scripts/omd-deliver.ts rule <ticketId> "<ruling>" [--slug <slug>]
 *   bun run scripts/omd-deliver.ts deliver [--slug <slug>]
 *
 * 后端遵从 resolveBackend 解析序(env OMD_PATH_BACKEND > .omd/pathfinder/config.json > md)。
 * ⚠ 本 repo 的 gh 配置指老 remote(见交接 18 勘误), md 图操作要 OMD_PATH_BACKEND=md。
 */
import { createDagRecorder } from '../src/harness/dag/dag-record';
import { createAgentLeafRunner } from '../src/harness/agent-leaf';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../src/harness/command-leaf';
import { createPathfinderTools } from '../src/mcp/tools/pathfinder';
import { resolveEngineModels } from '../src/mcp/assemble';

function usage(): never {
  console.error(
    'usage: omd-deliver rule <ticketId> "<ruling>" [--slug <slug>]\n       omd-deliver confirm <ticketId> <accept|reject> ["新题"] [--slug <slug>]\n       omd-deliver deliver [--slug <slug>]',
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd !== 'rule' && cmd !== 'deliver' && cmd !== 'confirm') usage();
const slugIdx = argv.indexOf('--slug');
const slug = slugIdx >= 0 ? argv[slugIdx + 1] : undefined;
// --slug 成对剔除后的位置参数。
const pos = argv.slice(1).filter((a, i, arr) => a !== '--slug' && arr[i - 1] !== '--slug');

const cwd = process.cwd();
const env = process.env;
// 位置不吃 cwd —— 同 assemble 那处, 真源在 dag-record.ledgerPath()。
const recorder = createDagRecorder();
const tools = createPathfinderTools({
  cwd,
  env,
  models: resolveEngineModels(env),
  agentRunner: createAgentLeafRunner({ cwd, hashlineEdit: true, leafTimeoutMs: 3_600_000 }),
  commandRunner: createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd, timeoutMs: 180_000 }),
  recorder,
});
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具 ${name} 不在装配里`);
  return t;
};

const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => {
  for (const c of r.content) console.log(c.text);
  process.exit(r.isError ? 1 : 0);
};

// ToolCallback 的第二参是 MCP RequestHandlerExtra —— pathfinder 七工具没有一个消费它,
// CLI 直调传空替身即可(与 pathfinder.test 直调 handler 同款做法)。
const extra = {} as never;
if (cmd === 'rule') {
  const [ticketId, ruling] = pos;
  if (!ticketId || !ruling) usage();
  out((await tool('path_rule').handler({ ticketId, ruling, ...(slug ? { slug } : {}) }, extra)) as never);
} else if (cmd === 'confirm') {
  const [ticketId, action, title] = pos;
  if (!ticketId || (action !== 'accept' && action !== 'reject')) usage();
  out((await tool('map_confirm').handler({ ticketId, action, ...(title ? { title } : {}), ...(slug ? { slug } : {}) }, extra)) as never);
} else {
  out((await tool('path_deliver').handler(slug ? { slug } : {}, extra)) as never);
}
