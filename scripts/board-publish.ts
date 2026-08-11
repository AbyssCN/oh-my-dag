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
 * 退出码: 0 = 已追加; 2 = 用法错 (缺参); 1 = 校验不过 / 追加失败 (抛)。
 */
import { appendBoard } from '../src/harness/board/run-board';
import { isAbsolute, normalize } from 'node:path';

/**
 * 确定性校验 + 追加一条 published 条目 (纯函数面, 测试直调; CLI 解析后也走这里)。
 *
 * 校验 (同输入必同结论, 不合规直接抛、不静默截断):
 *  - runId/artifact/commit 必须非空 (trim 后, 以 trim 后的值落板)。
 *  - artifact 必须落在 root 内: 拒绝对路径与 `..` 逃逸 —— 板只存相对 root 的指针
 *    (D-3/INV-1), 越界指针会让读板方指向 root 之外。
 *  - artifact/commit 各 ≤100B: serializeEntry 的最后防线是静默截断, 截断后的 commit 是
 *    假指针, 这里改为先拒 (板行 ≤1KB / note ≤500B 由 appendBoard 侧保证)。
 * 板是**指针介质**不是真源: 只记 artifact 相对路径 + commit, 不读不嵌产物内容。
 * 零 LLM、零 daemon (INV-6)。
 */
export function publishEntry(root: string, runId: string, artifact: string, commit: string): void {
  const rid = runId.trim();
  const art = artifact.trim();
  const c = commit.trim();
  if (!rid) throw new Error('runId 不能为空');
  if (!art) throw new Error('artifact 不能为空');
  if (!c) throw new Error('commit 不能为空');
  if (isAbsolute(art) || normalize(art).startsWith('..')) {
    throw new Error(`artifact 必须是 root 内的相对路径: ${art}`);
  }
  if (Buffer.byteLength(art, 'utf8') > 100) {
    throw new Error(`artifact 超 100B (serializeEntry 会静默截断, 拒绝): ${art}`);
  }
  if (Buffer.byteLength(c, 'utf8') > 100) {
    throw new Error(`commit 超 100B (serializeEntry 会静默截断, 拒绝): ${c}`);
  }
  appendBoard(root, {
    v: 1,
    ts: new Date().toISOString(),
    runId: rid,
    event: 'published',
    artifact: art,
    commit: c,
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
    console.error(`[board-publish] ${String(e)}`);
    process.exit(1);
  }
}
