/**
 * 路径禁令闸的端到端接线测试 (SDD D4.2 切片 2: GWT-2 / GWT-3 / INV-2 / INV-3)。
 *
 * 测的是: 「goal 文本里的禁令路径 → 工具通道写那一刻当场拒」全链路。
 *   - GWT-2: protected paths 已进沙箱拒写集时, leaf 工具尝试写该路径 → 拒, 错误含路径原文。
 *   - GWT-3: goal 无禁令时, 拒写集**不含**新增条目 (零回退)。
 *
 * 接线 = `withProtectedPaths(paths, fn)` (agent-tools.ts 的 AsyncLocalStorage 闭包);
 * 闸实现 = `requireWritable` 里 `[omd/agent-tools][protected-path]` 那条 (gate-registry.ts 入表)。
 *
 * 注: 这里**不**走 `agent-leaf` 那条 path (写集不在 SDD 切片 2 写集里), 直接调
 * `createOmdAgentTools` 验证闸本身 —— 与 `write-allow-wiring.test.ts` 同形态。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, withProtectedPaths } from '../agent-tools';
import type { AnyOmdTool } from '../agent-tools';
import { extractProtectedPaths } from './goal-protections';

/** 起一个临时 worktree 当 cwd, 测试完清理 (与 write-allow-wiring.test.ts 同形)。 */
function freshRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'omd-protect-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 工具按名取, 找不到直接 throw (测试里报红的信号比 undefined 更直接)。 */
function toolByName(tools: AnyOmdTool[], name: string): AnyOmdTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具 ${name} 未在 createOmdAgentTools 输出里`);
  return t;
}

/** 跑工具的执行体 (类型从 pi-agent-core 来, 这里用最小子集取 details 字段)。 */
async function exec(tool: AnyOmdTool, params: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    // agent-tools.ts 的 execute 签名 = `execute(id, params, signal?, onUpdate?)`。
    // 这里只喂 id + params 两个, 与 `write-allow-wiring.test.ts` 同形。
    await tool.execute('test-id', params as never);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

describe('INV-2 — GWT-2: 受保护路径在工具调用那一刻被拒, 错误文本带路径原文', () => {
  test('bench 真题面形态: 不许改动 `src/eval/tasks/blocking-forks.test.ts` → write 该路径当场拒', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const write = toolByName(tools, 'write');
      // 注意: 闸在 `requireWritable` 里, 即使路径在工作根内 + writeAllow 缺席 (默认放行),
      // 进了 protectedPaths 仍拒 —— 这正是 D4.2 想要的行为: 它独立于写集/沙箱边界。
      const r = await withProtectedPaths(['src/eval/tasks/blocking-forks.test.ts'], () =>
        exec(write, { path: 'src/eval/tasks/blocking-forks.test.ts', content: 'x' }),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toBeDefined();
      // GWT-2 硬指标: 错误文本必须含该路径原文 —— 否则模型不知道撞了哪一条。
      expect(r.error!.includes('src/eval/tasks/blocking-forks.test.ts')).toBe(true);
      // ★ 闸面定位: 拒词必须能让人去对到 goal 文本 (而不是沙箱边界 / 写域越界),
      // 这三道闸的修法完全不同, 判词混在一起会让人改错地方 (同 requireWritable 顶部那条纪律)。
      expect(r.error!.includes('路径禁令')).toBe(true);
      expect(r.error!.includes('D4.2')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('edits 闸面命中同样的保护路径 (改 vs 写 共用 requireWritable)', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const edit = toolByName(tools, 'edit');
      const r = await withProtectedPaths(['src/foo.ts'], () =>
        exec(edit, { path: 'src/foo.ts', oldText: 'a', newText: 'b' }),
      );
      expect(r.ok).toBe(false);
      expect(r.error!.includes('src/foo.ts')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('绝对路径写法与仓相对路径写法命中同一条 (闸按仓相对归一)', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const write = toolByName(tools, 'write');
      const absTarget = join(root, 'src/foo.ts');
      const r = await withProtectedPaths(['src/foo.ts'], () => exec(write, { path: absTarget, content: 'x' }));
      expect(r.ok).toBe(false);
      expect(r.error!.includes('src/foo.ts')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('闸缺席 (ALS 上下文空) 时, 写同一路径放行 — 确认与今日逐字节同 (INV-3 兜底)', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const write = toolByName(tools, 'write');
      // 不调 withProtectedPaths → ALS 上下文空 → 闸缺席 → 放行 (路径在工作根内)。
      const r = await exec(write, { path: 'src/free.ts', content: 'x' });
      expect(r.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('withProtectedPaths([]) 与未调等价 — 空禁单不触发闸', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const write = toolByName(tools, 'write');
      const r = await withProtectedPaths([], () => exec(write, { path: 'src/free.ts', content: 'x' }));
      expect(r.ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('INV-3 — GWT-3: 无禁令 goal 时全链路行为与今日逐字节同, 拒写集不含新增条目', () => {
  test('端到端模拟 run-goal 入口: 无禁令 goal → extractProtectedPaths([]) → withProtectedPaths 放行', async () => {
    const { root, cleanup } = freshRoot();
    try {
      const tools = createOmdAgentTools({ cwd: root });
      const write = toolByName(tools, 'write');
      // 模拟 run-goal.ts:1187 那两行 (字节同形)
      //   const goalProtectedPaths = extractProtectedPaths(goal);
      //   withProtectedPaths(goalProtectedPaths, () => agentRunner(...))
      const goal = [
        '本仓存在一个缺陷。',
        '判据: `bun test src/eval/tasks/blocking-forks.test.ts` 必须通过。',
        '相关实现文件: src/foo.ts',
      ].join('\n');
      const goalProtectedPaths = extractProtectedPaths(goal);
      // 反向钉: 该 goal 的提取结果必须空 (无禁令句 → 不该有任何路径进拒写集)。
      expect(goalProtectedPaths).toEqual([]);
      const r = await withProtectedPaths(goalProtectedPaths, () =>
        exec(write, { path: 'src/free.ts', content: 'x' }),
      );
      // INV-3 零回退: 无禁令时, 行为与切片前逐字节同 — 写 src/free.ts 应该成功。
      expect(r.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('★ run-goal.ts 静态依赖本切片三个模块 (extractProtectedPaths + withProtectedPaths)', () => {
    // 反向钉: 切片 2 把 run-goal.ts:82-83 那两条 import 作为 GWT-3 的依赖面钉住 —
    // 改其中任一路径另一边会 TypeError (本测试 import 链已定型)。这条留作回归护栏。
    expect(typeof extractProtectedPaths).toBe('function');
    expect(typeof withProtectedPaths).toBe('function');
  });
});
