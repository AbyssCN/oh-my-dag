/**
 * S3 走**真装配**的一跳 (2026-07-31)。
 *
 * 前面的网各自钉住一个接缝 (收件箱语义 / 引擎逐字注入 / 工具面)。这一条钉的是**它们被装到一起了**:
 * `assembleOmdMcpTools` 有没有真把 inbox 传给 goal 工具, 那个闭包用的是不是**这次 run 的 runId**。
 *
 * 这正是本仓反复撞见的形态 —— 每一段都对, 装配层漏一根线, 症状是沉默的:
 * owner 裁了, 环照旧跑错的那条路, 读数上没有区别。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleOmdMcpTools } from '../../src/mcp/assemble';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createOwnerInbox } from '../../src/mcp/owner-inbox';
import type { ExecutorDagConfig } from '../../src/harness/executor-dag-types';

const RAW = '别动 test/ 目录 —— 那批夹具是手写的, 重生成会把 golden 冲掉。';

describe('S3 装配层的一跳', () => {
  test('inbox → dag_goal → 引擎 ownerDirectives 闭包, 用的是**这次 run 的 runId**', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s3e2e-'));
    const inbox = createOwnerInbox({ db: new Database(':memory:') });
    let seenDag: ExecutorDagConfig | undefined;

    const tools = assembleOmdMcpTools({
      cwd,
      runRegistry: new RunRegistry(),
      inbox,
      // ⚠ `engine` 接缝**覆盖不到 goal 这条路** (它走自己的 runGoal) —— 这条测试第一版就栽在这儿,
      //   于是给装配层补了 runGoal 注入口。这里回收 goal 拿到的 dag config。
      runGoal: (async (_goal: string, cfg: { dag: ExecutorDagConfig }) => {
        seenDag = cfg.dag;
        return {
          goal: _goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
          stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [],
        };
      }) as never,
      configOverrides: { conductorModel: 'c:m', leafModel: 'l:m' },
    });

    const goalTool = tools.find((t) => t.name === 'dag_goal')!;
    const out = (await goalTool.handler({ goal: '干点活' } as never, {} as never)) as { content: { text: string }[] };
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    await Bun.sleep(30);

    expect(seenDag?.ownerDirectives).toBeDefined(); // 装配真把通道接上了

    // owner 事后下一条指令 —— 引擎下一轮才取, 所以顺序就是真实用法的顺序。
    inbox.addDirective(runId, RAW);
    const rendered = seenDag!.ownerDirectives!(2);
    expect(rendered).toContain(RAW);      // 逐字
    expect(rendered).toContain('<owner 指令>');

    // 取完即记账: 第 3 轮不该再看到它。
    expect(seenDag!.ownerDirectives!(3)).toBe('');

    // 别的 run 的指令不许串台。
    inbox.addDirective('别的 run', '这条不该出现');
    expect(seenDag!.ownerDirectives!(4)).toBe('');

    inbox.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  test('dag_triage / dag_rule 在装配面上真的挂着, 且共用同一个 inbox', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-s3e2e-'));
    const inbox = createOwnerInbox({ db: new Database(':memory:') });
    const tools = assembleOmdMcpTools({ cwd, runRegistry: new RunRegistry(), inbox, configOverrides: { conductorModel: 'c:m', leafModel: 'l:m' } });

    inbox.openFork({
      id: 'fk1', runId: 'r1', nodeId: 'n', round: 1,
      question: '要不要拆两份?', recommendation: '拆', assumption: '拆', blocking: false,
    });
    const triage = tools.find((t) => t.name === 'dag_triage')!;
    const rule = tools.find((t) => t.name === 'dag_rule')!;
    expect(triage).toBeDefined();
    expect(rule).toBeDefined();

    const seen = (await triage.handler({} as never, {} as never)) as { content: { text: string }[] };
    expect(seen.content[0]!.text).toContain('要不要拆两份?');

    await rule.handler({ forkId: 'fk1', ruling: '合成一份' } as never, {} as never);
    // 裁决落进同一个 inbox → 变成待消费指令。
    expect(inbox.pendingDirectives('r1')[0]!.text).toContain('合成一份');

    inbox.close();
    rmSync(cwd, { recursive: true, force: true });
  });
});
