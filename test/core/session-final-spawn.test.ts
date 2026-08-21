/**
 * test/core/session-final-spawn —— omd 会话**收口存档**(#212)。
 *
 * 补的是 #211 缺的那一角:omd 自己的会话此前只在「轮尾跨档」与「压缩」存档,
 * **退出时没有收口那一次** —— 而 Claude Code 那条腿(`continuity-end.mjs` → 现在是
 * omd hook 的 SessionEnd)一直有。omd 才是要建的 harness, 它不该比 Claude 那条少一角。
 *
 * 时机是这件事的全部难点, 两条都不行:
 *   - 同步等 → 退出卡几秒(蒸馏要打一次模型);
 *   - 进程内 fire-and-forget → 活不过 `process.exit`。
 * 所以走 detached 子进程。本件钉:派了什么(纯函数)+ 真派出去之后盘上真出东西(端到端)。
 *
 * 反向自检(实跑):
 *   - `finalWriterArgv` 里 `--final` 去掉 → 「收口用 final 档」红;
 *   - `spawnFinalCheckpoint` 的 `spawn` 那行去掉 → 端到端红;
 *   - session-writer 的 `--omd-session` 分支去掉 → 端到端红(会走成"缺 transcript"直接退)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { finalWriterArgv, spawnFinalCheckpoint } from '../../src/harness/session/final-spawn';
import { createOmdSessionStore, resetSessionCacheForTest } from '../../src/harness/chat/session-store';

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-final-spawn-'));
  resetSessionCacheForTest();
  for (const k of ['OMD_DATA_HOME', 'OMD_CONTINUITY_MECHANICAL', 'MEMORY_HUB_DATA']) {
    savedEnv[k] = process.env[k];
  }
  process.env.OMD_DATA_HOME = join(root, 'data');
  process.env.OMD_CONTINUITY_MECHANICAL = '1'; // 零模型调用
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** 递归找一个文件名, 找到返绝对路径。用扫的不用猜路径 —— 猜错时症状与"没产出"一样。 */
function findNamed(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findNamed(full, name);
      if (hit) return hit;
    } else if (e.name === name) return full;
  }
  return null;
}

async function waitForNamed(dir: string, name: string, timeoutMs = 40_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = findNamed(dir, name);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(100);
  }
}

/**
 * ★ 等一个文件**长出某段内容**, 不是等它出现(2026-08-22 修一条真 flaky)。
 *
 * 症状与诊断:单跑这个文件 3/3 绿, 进全量 `bun test` 就红在
 * `readFileSync(writer.log).toContain('mode=final')`, 判词是 `Received: ""` ——
 * **文件在、内容空**。根因是收口子进程**先建 checkpoint.md 再把 writer.log 刷出去**,
 * 而判据只等了前者; 机器一忙(本机当时并行跑着两个 omd run), 这个窗口就够大到被撞上。
 *
 * ⚠ 它不是"偶发噪声"这种可以按掉的东西:全量 `bun test` 是每个 omd run 的 **accept 命令**,
 * 一条按负载翻面的闸会把**任意一个做对了的 run** 判成 not-converged。
 * 证伪方式:把下面的循环换回单次 `readFileSync`, 在满载的机器上跑全量 —— 它会再红。
 */
async function waitForContent(path: string, needle: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 读失败(还没建出来)与内容还没到, 是同一档处理 —— 都继续等, 超时后把**当时读到的**原样返回,
    // 让断言的判词仍然印真实内容(不吞证据)。
    let text = '';
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      /* 还没建出来 */
    }
    if (text.includes(needle)) return text;
    if (Date.now() >= deadline) return text;
    await Bun.sleep(100);
  }
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(100);
  }
}

describe('派了什么 — finalWriterArgv', () => {
  test('走 --omd-session(不是 --transcript)且带 --final 与 --cwd', () => {
    const argv = finalWriterArgv('sess-1', '/repo/x', {});
    expect(argv).toContain('--omd-session');
    expect(argv).toContain('sess-1');
    expect(argv).toContain('--cwd');
    expect(argv).toContain('/repo/x');
    expect(argv).toContain('--final'); // 收口就是 final 档:它会 splice _NEXT.md 的 AUTO 区
    expect(argv).not.toContain('--transcript'); // omd 会话没有 transcript 文件
    expect(argv).not.toContain('--mechanical'); // env 没开就不该有
  });

  test('OMD_CONTINUITY_MECHANICAL=1 才追加 --mechanical', () => {
    expect(finalWriterArgv('s', '/c', { OMD_CONTINUITY_MECHANICAL: '1' } as NodeJS.ProcessEnv)).toContain('--mechanical');
  });

  test('空 sessionId → 不派(返回 false), 不去建一个空目录', () => {
    expect(spawnFinalCheckpoint('', root)).toBe(false);
  });
});

describe('端到端 — 退出那一刻真存下来', () => {
  test(
    '真 omd 会话 → 派收口 → checkpoint.md 落盘且是 final 档',
    async () => {
      const store = createOmdSessionStore(root);
      const session = await store.create('final-e2e', '收口冒烟');
      await session.append({
        role: 'user',
        content: [{ type: 'text', text: '这一段在做 #212 的收口存档' }],
        timestamp: 1,
      } as unknown as AgentMessage);
      await session.append({
        role: 'assistant',
        content: [{ type: 'text', text: '好, 退出时派一次 final' }],
        timestamp: 2,
      } as unknown as AgentMessage);

      expect(spawnFinalCheckpoint('final-e2e', root)).toBe(true);

      // slug 由 repo 目录 basename 派生 —— 不去猜它, 扫出来(猜错会把"没产出"读成"路径不对")
      const cp = await waitForNamed(join(root, 'data'), 'checkpoint.md');
      expect(cp).not.toBeNull();
      const log = join(cp!, '..', 'writer.log');
      // 等它长出 `mode=final` —— checkpoint.md 先落、writer.log 后刷, 见 waitForContent 的注。
      expect(await waitForContent(log, 'mode=final')).toContain('mode=final');
      expect(readFileSync(cp!, 'utf-8')).toContain('## §1 Active intent');
    },
    60_000,
  );

  test('会话不存在 → 子进程响亮说一句就退, **不产空 checkpoint**', async () => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    expect(spawnFinalCheckpoint('no-such-session', root)).toBe(true); // 派是派了
    await Bun.sleep(2_500);
    expect(findNamed(join(root, 'data'), 'checkpoint.md')).toBeNull(); // 一份都不该有
  });
});

describe('persona 注入面 — 与 Claude 那条同一份文件', () => {
  test('MEMORY_HUB_DATA 指到哪就读哪(测试不碰真用户的画像文件)', async () => {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'persona'), { recursive: true });
    writeFileSync(join(hub, 'persona', 'persona.md'), '## 工作方式\n- 文档先行\n<!-- persona-distill 2026-08-06 -->');
    process.env.MEMORY_HUB_DATA = hub;

    const { buildSessionStartContext, personaPath } = await import('../../src/harness/session/resume');
    expect(personaPath(process.env)).toBe(join(hub, 'persona', 'persona.md'));
    const out = buildSessionStartContext({ cwd: root });
    expect(out).toContain('文档先行');
    expect(out).not.toContain('persona-distill'); // 尾部标记不进正文
  });
});
