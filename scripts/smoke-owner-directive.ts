#!/usr/bin/env bun
/**
 * scripts/smoke-owner-directive —— **S3 的 live 冒烟**: owner 指令真的到得了下一轮吗 (2026-07-31)。
 *
 * ## 为什么必须 live
 *
 * S3 的注入式网已经全绿 (收件箱语义 / 引擎逐字注入 / 工具面 / 装配层一跳), 但按证据词表那只到
 * `Wired` —— **一次真用过并留下结果**才是 `Exercised`。而本仓一整年的教训都是同一句:
 * 注入式全绿的东西在真语料上塌过五处。
 *
 * ## 观测怎么做到确凿
 *
 * 难点是"conductor 到底看见没有"在真跑里不可见。这里把 `generate` 包一层 (仍调真模型),
 * 把每一次**展开调用**的 prompt 抄一份到盘上 —— 于是判据变成一个逐字的事实:
 * **第 2 轮的展开 prompt 里有没有那句 owner 原话**。
 *
 * ⚠ 包的是 `configOverrides.generate`, 里面调的仍是生产的 `makeDefaultGenerate` ——
 * 不是拿假模型测一条假链 (那样测的是一个不存在的接线)。
 *
 * 跑: bun --env-file=.env run scripts/smoke-owner-directive.ts [--rounds 2] [--timeout 900000]
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';
import { createRunStore } from '../src/mcp/run-store';
import { createOwnerInbox } from '../src/mcp/owner-inbox';
import { makeDefaultGenerate } from '../src/harness/dag/defaults';
import { bootstrapModelRuntime } from '../src/model/bootstrap';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const rounds = Number(opt('rounds') ?? '2');
const timeoutMs = Number(opt('timeout') ?? '900000');

/** owner 的原话 —— 判据就是它逐字出现在第 2 轮的展开 prompt 里。 */
const DIRECTIVE = '把清单改成英文写, 并且只保留 2 条 —— 这是我的要求, 别自己加回中文。';

bootstrapModelRuntime();

const sandbox = mkdtempSync(join(tmpdir(), 'omd-s3-live-'));
mkdirSync(join(sandbox, '.omd'), { recursive: true });
writeFileSync(join(sandbox, 'README.md'), '# s3 live 冒烟沙箱\n');
const promptLog = join(sandbox, 'expand-prompts.log');

console.log(`沙箱: ${sandbox}`);
console.log(`指令(判据): ${DIRECTIVE}\n`);

// 同一份 runs.db: registry 与 inbox 共用 (装配默认就是这个路径, 这里显式建以便脚本自己也能写)。
const dbPath = join(sandbox, '.omd', 'runs.db');
const registry = new RunRegistry(undefined, { store: createRunStore({ path: dbPath }) });
const inbox = createOwnerInbox({ path: dbPath });

/** 抄一份展开 prompt 到盘上 —— 判据的观测面。仍调生产的 generate。 */
const teeGenerate = (sessionId: string) => {
  const real = makeDefaultGenerate(sessionId);
  return async (req: Parameters<ReturnType<typeof makeDefaultGenerate>>[0]) => {
    const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '[parts]')).join('\n');
    // 展开调用 = 不含 `[omd leaf: …]` 的那一次 (leaf 调用都带它)。
    if (!text.includes('[omd leaf:')) {
      appendFileSync(promptLog, `\n===== EXPAND @${new Date().toISOString()} =====\n${text}\n`);
    }
    return real(req);
  };
};

const tools = assembleOmdMcpTools({
  cwd: sandbox,
  runRegistry: registry,
  inbox,
  configOverrides: { generate: teeGenerate(`s3-live-${Date.now()}`) as never },
});
const goalTool = tools.find((t) => t.name === 'dag_goal');
if (!goalTool) throw new Error('装配里没有 dag_goal');

const out = (await goalTool.handler(
  {
    goal: '在 notes/list.md 里写一份清单, 列出做一次代码审查要看的要点。',
    tier: 'simple',
    maxRounds: rounds,
  } as never,
  {} as never,
)) as { content: { text: string }[]; isError?: boolean };
const runId = /runId: (\S+)/.exec(out.content[0]?.text ?? '')?.[1];
if (out.isError || !runId) {
  console.error(`起跑失败: ${out.content[0]?.text}`);
  process.exit(1);
}
console.log(`runId: ${runId}\n`);

// ── owner 在第 1 轮跑着的时候下指令 (真实用法的顺序) ──────────────────────────
// 等 8 秒让第 1 轮的展开先发出去, 否则指令会被第 1 轮吃掉, 测不到"下一轮才读到"这一位。
await Bun.sleep(8000);
inbox.addDirective(runId, DIRECTIVE);
console.log(`[owner] 已下指令 (第 1 轮跑着的时候)\n`);

const t0 = Date.now();
let last = '';
for (;;) {
  const st = registry.getStatus(runId);
  const line = `[${Math.round((Date.now() - t0) / 1000)}s] ${st}`;
  if (line !== last) { console.log(line); last = line; }
  if (st === 'done' || st === 'failed' || st === 'cancelled') break;
  if (Date.now() - t0 > timeoutMs) { console.error('超时'); break; }
  await Bun.sleep(5000);
}

// ── 判据 ────────────────────────────────────────────────────────────────────
console.log('\n════ 判据 ════');
const log = existsSync(promptLog) ? readFileSync(promptLog, 'utf-8') : '';
const expands = log.split('===== EXPAND').filter((x) => x.trim());
console.log(`展开调用次数: ${expands.length}`);
const hitIdx = expands.findIndex((e) => e.includes(DIRECTIVE));
console.log(`指令逐字出现在第几次展开: ${hitIdx < 0 ? '**没有出现**' : hitIdx + 1}`);
console.log(`第 1 次展开含指令 (不该含): ${expands[0]?.includes(DIRECTIVE) ? '是 ⚠' : '否 ✓'}`);
const blockOk = hitIdx >= 0 && expands[hitIdx]!.includes('<owner 指令>');
console.log(`以独立的 <owner 指令> 块出现: ${blockOk ? '是 ✓' : '否 ⚠'}`);
// 只消费一次: 指令不该在两次以上的展开里出现。
const times = expands.filter((e) => e.includes(DIRECTIVE)).length;
console.log(`出现次数 (应为 1, >1 = 每轮重放): ${times}`);
const pend = inbox.pendingDirectives(runId);
console.log(`残留未消费指令 (应为 0): ${pend.length}`);

console.log('\n════ 产物 ════');
const p = join(sandbox, 'notes', 'list.md');
console.log(existsSync(p) ? readFileSync(p, 'utf-8').slice(0, 1200) : '(没有 notes/list.md)');
console.log(`\n沙箱保留在 ${sandbox}`);
// 2026-07-31 首跑顺带撞到的 (与 S3 无关, 但别让它沉在日志里): 分类调用**输出撞上限被截断**
// (`out=400 cap=400`) → 解析失败 → 全保守档 (complex + 探索型)。也就是说**验收分型在这条路上
// 基本判不出执行型**, 与 2026-07-30 那条 `$` 锚点链是同一个后果、不同的成因。已记进 SDD Open。
inbox.close();
