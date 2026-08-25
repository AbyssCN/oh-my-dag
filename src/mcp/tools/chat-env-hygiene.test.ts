/**
 * chat 测试面卫生自证(SDD D6 INV-D6-2):子进程以毒化 `OMD_TUI_USAGE_DIR`
 * 跑 `bun test src/mcp/tools/chat.test.ts`,断言 exit 0 且 stdout 含 `0 fail`。
 *
 * ## 为什么必须**子进程**
 *
 * `chat.test.ts` 的 `beforeEach` 现读 `OMD_TUI_USAGE_DIR`(chat.ts:190/211 → budget.ts)。
 * 在**同一进程**里,即使先 delete env 再用 `usageLedgerDir()`,memo cache (`budget.ts:63`)
 * 也已用旧路径命中。所以**只有子进程**才能从干净的世界起跑,这条测试才有判别力。
 *
 * ## 反向自检(让红)怎么验
 *
 * INV-D6-1 落地前跑本测试 → 8/21 红(2026-08-25 活体复现的指纹,见 #255);
 * 落地后改 chat.test.ts 顶层 `beforeEach` 漏掉某 env 清洗 → 本测试当场红
 * (因为那条漏的 env 会让目标文件在子进程里仍被污染)。
 *
 * ## 跑法
 *
 * `bun test ./src/mcp/tools/chat-env-hygiene.test.ts` —— 只跑本件;
 * verify 段会把 `chat.test.ts` / `role-fallback.test.ts` / `pi-transport.test.ts` 一并跑过。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const poisonRoot: string[] = [];

const freshPoisonDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-chat-poison-'));
  poisonRoot.push(d);
  // 与 budget.ts:105 同款刀法:`ts:number ∧ model:string` 算一条;costUsd=100 触发超限。
  writeFileSync(
    join(d, 'tui-usage.jsonl'),
    `${JSON.stringify({ ts: Date.now(), model: 'x:y', costUsd: 100, source: 'engine', in: 1, out: 1, cacheHit: 0, unpriced: false })}\n`,
  );
  return d;
};
afterEach(() => {
  for (const d of poisonRoot.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('chat 测试面卫生自证(D6 INV-D6-2)', () => {
  test('★ 毒化 OMD_TUI_USAGE_DIR → 子进程跑 chat.test.ts 全绿 (0 fail)', async () => {
    const dir = freshPoisonDir();
    // 子进程继承 env(默认)+ 只覆写 OMD_TUI_USAGE_DIR;chat.test.ts 在子进程里从干净世界起跑。
    // 必须显式传 `env: { ...process.env }` —— 见 test/setup/tmpdir-isolation.ts 头注:
    // `Bun.spawn` 默认 env 是**进程启动时快照**,运行时改的 process.env 不跟过去。
    const proc = Bun.spawn(['bun', 'test', 'src/mcp/tools/chat.test.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, OMD_TUI_USAGE_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    // bun test 把用例统计写到 stderr(实测),不是 stdout —— 两股并起来判。
    const combined = stdout + stderr;
    if (exit !== 0 || !/\b0 fail(?:ed)?\b/.test(combined)) {
      // eslint-disable-next-line no-console
      console.error('--- chat.test.ts 子进程 stdout ---\n' + stdout);
      // eslint-disable-next-line no-console
      console.error('--- chat.test.ts 子进程 stderr ---\n' + stderr);
    }
    expect(exit).toBe(0); // bun test 失败时 exit=1
    expect(combined).toMatch(/\b0 fail(?:ed)?\b/); // 钉住 bun test 默认输出里的「0 fail」字面
  });
});