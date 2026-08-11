#!/usr/bin/env bun
/**
 * scripts/board-publish —— 产物合并后发布 `published` 条目的 CLI (S4)。
 *
 * 为什么存在: 合并/发布是**人/CI 的动作**, 不是引擎 run —— 引擎在 run-goal 里只写
 * claimed/terminal, 产物落定后的 published 由本脚本追加。零 LLM、零 daemon, 纯文件 IO,
 * 消费 run-board 的冻结接口 `appendBoard`。
 *
 * 用法:
 *   bun run scripts/board-publish.ts <root> <runId> <artifact> <commit>
 *
 *   root     —— 执行根 (board 在 <root>/.omd/run-board.jsonl)
 *   runId    —— 被发布产物的 run 回执锚 (与 claimed/terminal 同一条)
 *   artifact —— 产物相对路径 (相对 root; 真源在盘上, 板只记指针 —— D-3/INV-1)
 *   commit   —— 产物合并时的 commit hash
 *
 * 退出码: 0 = 已追加; 2 = 用法错 (缺参); 1 = 追加失败 (appendBoard 抛)。
 */
import { appendBoard } from '../src/harness/board/run-board';

/** 追加一条 published 条目 (纯函数面, 测试直调; CLI 解析后也走这里)。 */
export function publishEntry(root: string, runId: string, artifact: string, commit: string): void {
  appendBoard(root, {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    event: 'published',
    artifact,
    commit,
  });
}

function usage(): never {
  console.error('usage: board-publish <root> <runId> <artifact> <commit>');
  process.exit(2);
}

if (import.meta.main) {
  const [root, runId, artifact, commit] = process.argv.slice(2);
  if (!root || !runId || !artifact || !commit) usage();
  try {
    publishEntry(root, runId, artifact, commit);
  } catch (e) {
    console.error(`[board-publish] 追加失败: ${String(e)}`);
    process.exit(1);
  }
}
