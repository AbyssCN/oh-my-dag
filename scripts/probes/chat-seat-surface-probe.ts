/**
 * 量:对话位在两个仓里**实际**装到了哪些工具。
 * (MCP 指挥面跳过 —— 它在空 mcpTools 下 fail-closed 抛错, 那是对的:白名单与装配层漂了要当场炸。
 *  这里量的是与"仓大小"有关的那三段:手 / codegraph 符号面 / skill。)
 */
import { createOmdAgentTools } from '../../src/harness/agent-tools';
import { createCodegraphTools } from '../../src/tui/tools/codegraph';
import { createSkillTools } from '../../src/tui/tools/skill-tool';

for (const cwd of ['/home/nick/repos/oh-my-dag', '/home/nick/repos/talous-v2']) {
  const hands = createOmdAgentTools({ cwd }).map((t) => t.name);
  const cg = createCodegraphTools({ cwd }).map((t) => t.name);
  const sk = createSkillTools().map((t) => t.name);
  console.log(`\n── ${cwd}`);
  console.log(`   手 (${hands.length}): ${hands.join(' · ')}`);
  console.log(`   codegraph 符号面 (${cg.length}): ${cg.join(' · ') || '**一个都没挂**(探测不到)'}`);
  console.log(`   skill (${sk.length}): ${sk.join(' · ') || '(无)'}`);
  console.log(`   ⚠ 按文件名找文件的工具: ${[...hands, ...cg].some((n) => /glob|find|file/.test(n)) ? '有' : '**没有** —— 只能走 bash: find'}`);
}
