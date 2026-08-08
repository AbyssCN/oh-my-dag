/**
 * scripts/probes/pi-session-probe —— **动手换存储层之前,把 pi 的 Session 族在这台机器上真跑一遍**。
 *
 * ## 四要素(动手前写死)
 *
 * - **假设**:`JsonlSessionRepo` + `NodeExecutionEnv` 能**零手搓**替掉 `ChatStore` 的六个方法
 *   (create / load / save / delete / fork / list),且 append-only 能扛住 `ChatStore` 头注释里
 *   显式接受的那三条脏场景(半截写入 / 并发写 / list 全量读盘)。
 * - **单一变量**:只换存储层,消息内容与顺序不变。
 * - **成败信号**:退出码 0 = 六件事全成 + 三条脏场景各有明确读数;非零 = 某一件在这台机器上不成立
 *   (那就得在 SDD 里写清"这一件仍要手搓",而不是照读源码的印象往下写)。
 * - **下一步收什么数据**:并发两写之后**两条消息是不是都还在**(ChatStore 是 last-write-wins,
 *   会丢一条);fork 出来的分支里源消息**在不在**、`parentSessionId` **记没记**。
 *
 * ⚠ 这是**一次性探针**吗?不是 —— 它是换存储层的**验收基线**:实装改完之后同一条命令要还能过。
 * 所以进 `scripts/probes/`,不留在 /tmp。
 *
 * 用法:`bun run scripts/probes/pi-session-probe.ts`(零模型调用、零网络,只碰临时目录)
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

let bad = 0;
const say = (ok: boolean, msg: string, detail?: unknown): void => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail === undefined ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) bad++;
};

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'omd-pi-session-'));
  const sessionsRoot = join(root, 'chat');
  // ★ 这一行是整个探针的重点:**fs 用 pi 自己的 `NodeExecutionEnv`**,omd 一行 fs 代码都不写。
  //   `JsonlSessionRepoFileSystem = Pick<FileSystem, 11 个方法>`,而 NodeExecutionEnv 全都有。
  const fs = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fs, sessionsRoot });

  // ① create + append
  const s = await repo.create({ id: 'tui', cwd: root, metadata: { title: '第一条会话' } });
  await s.appendMessage(msg('user', 'hej'));
  await s.appendMessage(msg('assistant', 'hej hej'));
  const meta = await s.getMetadata();
  say(meta.id === 'tui', 'create + getMetadata', { id: meta.id, path: (meta as { path?: string }).path });

  // ② list —— 只读第一行 header(ChatStore 是全量读盘解析)
  const listed = await repo.list({ cwd: root });
  say(listed.length === 1 && listed[0]?.id === 'tui', 'list 拿到会话', listed.map((m) => m.id));

  // ③ open + 沿分支读回来
  const reopened = await repo.open(listed[0] as never);
  const entries = await reopened.findEntriesOnBranch({});
  const texts = entries
    .filter((e) => e.type === 'message')
    .map((e) => JSON.stringify((e as { message?: unknown }).message));
  say(entries.length >= 2, 'open + findEntriesOnBranch 读回条目', { 条目数: entries.length });
  say(texts.some((t) => t.includes('hej hej')), '消息内容逐字回得来');
  const withParent = entries.filter((e) => (e as { parentId?: string | null }).parentId != null).length;
  say(withParent >= 1, '★ 条目带 parentId(ChatStore 完全没有这一层)', { 带parentId的条目数: withParent });

  // ④ fork —— ChatStore 是"把源会话全部消息拷进新会话"
  const forked = await repo.fork(listed[0] as never, { id: 'tui-f9', cwd: root });
  const fm = (await forked.getMetadata()) as { id: string; parentSessionId?: string };
  const forkEntries = await forked.findEntriesOnBranch({});
  say(fm.id === 'tui-f9', 'fork 出新会话', fm.id);
  say(fm.parentSessionId === 'tui', '★ fork 记了 parentSessionId(omd 现在只有会话级 parent 字段)', fm.parentSessionId);
  say(forkEntries.length >= 2, 'fork 的分支上看得到源消息', { 条目数: forkEntries.length });

  // ⑤ lane —— 消息级分叉(omd 完全没有)
  const lanesBefore = await reopened.getLanes();
  const leaf = await reopened.getLeafId();
  await reopened.createLane('试验', leaf);
  const lanesAfter = await reopened.getLanes();
  say(lanesAfter.length === lanesBefore.length + 1, '★ createLane 开出第二条 lane', {
    前: lanesBefore.map((l) => l.lane),
    后: lanesAfter.map((l) => l.lane),
  });

  // ⑥ 脏场景 A-1:**同一个 Session 实例**上并发两写 —— 期望两条都在
  //   (`storage.js:194 enqueue` 是一条 promise 链, 同实例内串行)。
  const same = await repo.open(listed[0] as never);
  await Promise.all([same.appendMessage(msg('user', '同实例甲')), same.appendMessage(msg('user', '同实例乙'))]);
  const afterSame = JSON.stringify(await same.findEntries({}));
  const keptSame = ['同实例甲', '同实例乙'].filter((x) => afterSame.includes(x));
  say(keptSame.length === 2, '同一个实例并发两写:两条都在(enqueue 串行化)', { 留下的: keptSame });
  // 写进磁盘之后还读得回来吗(上一条只证明内存态)
  let sameReload = 0;
  try {
    sameReload = (await (await repo.open(listed[0] as never)).findEntries({})).length;
    say(sameReload >= 4, '同一个实例写完, 重新 open 读得回来', { 条目数: sameReload });
  } catch (e) {
    say(false, '同一个实例写完竟然读不回来', (e as Error).message.slice(0, 100));
  }

  // ⑦ 脏场景 A-2:★★ **两个 Session 实例**同时写同一份文件 —— 这条是这支探针最重要的读数
  //   ChatStore 的行为是 last-write-wins(丢一条);pi 这边要量的是**丢一条还是整份坏掉**。
  const twoWriters = await repo.create({ id: 'twowriters', cwd: root });
  await twoWriters.appendMessage(msg('user', '基线'));
  const w1 = await repo.open((await repo.list({ cwd: root })).find((m) => m.id === 'twowriters') as never);
  const w2 = await repo.open((await repo.list({ cwd: root })).find((m) => m.id === 'twowriters') as never);
  await Promise.all([w1.appendMessage(msg('user', '写者甲')), w2.appendMessage(msg('user', '写者乙'))]);
  const twPath = ((await repo.list({ cwd: root })).find((m) => m.id === 'twowriters') as { path: string }).path;
  const twLines = readFileSync(twPath, 'utf-8').trim().split('\n');
  const seqs = twLines.map((l) => (JSON.parse(l) as { seq?: number }).seq).filter((x) => x !== undefined);
  const dupSeq = seqs.length !== new Set(seqs).size;
  let reloadErr: string | null = null;
  try {
    await repo.open((await repo.list({ cwd: root })).find((m) => m.id === 'twowriters') as never);
  } catch (e) {
    reloadErr = (e as Error).message.slice(0, 90);
  }
  say(
    !dupSeq && reloadErr === null,
    '★★ 两个实例并发写之后这份会话还读得出来',
    { seq序列: seqs, 有重复seq: dupSeq, 重新open报错: reloadErr },
  );
  // 能不能修:把重复 seq 的那些行截掉之后是否恢复可读(决定 SDD 里要不要写修复路径)
  if (reloadErr) {
    const seen = new Set<number>();
    const repaired = twLines.filter((l) => {
      const s = (JSON.parse(l) as { seq?: number }).seq;
      if (s === undefined) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
    writeFileSync(twPath, repaired.join('\n') + '\n');
    try {
      const n = (await (await repo.open((await repo.list({ cwd: root })).find((m) => m.id === 'twowriters') as never)).findEntries({})).length;
      console.log(`  · 修复路径存在:去掉重复 seq 的行之后读得回来(${n} 条)⇒ SDD 里要有一条修复命令`);
    } catch (e) {
      console.log(`  · 去重复 seq 之后仍读不出来:${(e as Error).message.slice(0, 90)}`);
    }
  }

  // ⑧ 脏场景 B:**半截写入** —— 往文件尾追加半行, 再 load
  const path = (listed[0] as { path: string }).path;
  const before = readFileSync(path, 'utf-8');
  appendFileSync(path, '{"kind":"entry","tru');
  try {
    const n = (await (await repo.open(listed[0] as never)).findEntries({})).length;
    say(n >= 2, '半截尾行:仍读得到前面的完整条目', { 条目数: n });
  } catch (e) {
    say(false, '半截尾行 ⇒ 整份读不出来(**SDD 要写清怎么处置**)', (e as Error).message.slice(0, 90));
  }
  writeFileSync(path, before);

  // ⑨ 脏场景 C:文件形态 —— 一行一条,人能读
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  say(lines.length >= 3, 'JSONL:一行一条(header + 条目)', { 行数: lines.length, 首行: lines[0]?.slice(0, 60) });

  rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\n全部成立 —— 存储层可以零手搓接上' : `\n${bad} 条不成立 —— SDD 里必须逐条写清怎么处置`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
