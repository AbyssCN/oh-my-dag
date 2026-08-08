/**
 * 同类扫描:其余三个有上限的工具,到上限时**说不说**?
 * 判据 = 输出里有没有一句能让 agent 知道"还有更多"的话。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools } from '../../src/harness/agent-tools';

const root = mkdtempSync(join(tmpdir(), 'omd-limits-'));
// 一个 5000 行的大文件(超 read 的行上限)
writeFileSync(join(root, 'big.ts'), Array.from({ length: 5000 }, (_, i) => `const l${i} = ${i};`).join('\n'));
// 一个 900 项的目录(超 ls 的 500 默认上限)
mkdirSync(join(root, 'many'));
for (let i = 0; i < 900; i++) writeFileSync(join(root, 'many', `f${i}.ts`), 'x\n');

const tools = Object.fromEntries(createOmdAgentTools({ cwd: root }).map((t) => [t.name, t]));
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const verdict = (label: string, out: string, needle: RegExp) =>
  console.log(`${needle.test(out) ? '✓ 说了' : '✗ **没说**'}  ${label}\n      末尾: ${JSON.stringify(out.slice(-110))}`);

verdict('read 超行上限', text(await (tools.read as any).execute('a', { path: 'big.ts' })), /truncated|截断|共 \d+ 行/);
verdict('ls 超项数上限', text(await (tools.ls as any).execute('b', { path: 'many' })), /还有 \d+ 项|limit/);
verdict('grep 超命中上限', text(await (tools.grep as any).execute('c', { pattern: 'const l', limit: 5 })), /已达 limit|上限/);
verdict('bash 超输出上限', text(await (tools.bash as any).execute('d', { command: 'seq 1 400000' })), /截断|truncat/);
